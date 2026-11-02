import { describe, expect, it } from 'vitest';
import {
  Box3,
  DataTexture,
  DepthTexture,
  HalfFloatType,
  LinearFilter,
  Mesh,
  MeshBasicNodeMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  RenderTarget,
  RGBAFormat,
  Vector3,
} from 'three/webgpu';
import { float, texture, vec4 } from 'three/tsl';
import { buildShaders, evaluate, type ShaderBackend } from '../shaderFixtures';
import { Caustics } from '../water/caustics';
import { WaterMedium } from '../water/medium';
import { DENOISE_TAPS, DEPTH_TOLERANCE, upscaleWeight, WaterShafts } from './shafts';

function shafts(): WaterShafts {
  const medium = new WaterMedium(new Box3(new Vector3(-0.5, 0, -0.2), new Vector3(0.5, 0.5, 0.2)), {
    cdom440: 0,
    turbidity: 0.1,
  });
  return new WaterShafts(new PerspectiveCamera(), medium, new Caustics(medium));
}

/** A scene pass's depth, as the post chain hands it over: owned by its render target. */
function sceneDepth(): DepthTexture {
  return new RenderTarget(8, 8, { depthTexture: new DepthTexture(8, 8) })
    .depthTexture as DepthTexture;
}

function upscaleShader(backend: ShaderBackend): string {
  const rays = new DataTexture(new Uint16Array(4 * 4 * 4), 4, 4, RGBAFormat, HalfFloatType);
  rays.minFilter = LinearFilter;
  rays.magFilter = LinearFilter;
  const material = new MeshBasicNodeMaterial();
  material.colorNode = vec4(shafts().upscale(texture(rays), texture(sceneDepth())), 1);
  return buildShaders(new Mesh(new PlaneGeometry(), material), backend).fragment;
}

describe('WaterShafts.upscale', () => {
  it('reads the shaft texture size and four texels on WebGPU', () => {
    const fragment = upscaleShader('webgpu');
    expect(fragment).toMatch(/textureDimensions\(/);
    expect(fragment.match(/textureSample(Level)?\(/g)).toHaveLength(4);
  });

  it('builds the same upscale for the WebGL 2 fallback', () => {
    const fragment = upscaleShader('webgl');
    expect(fragment).toMatch(/textureSize\(/);
    // Four shaft texels and the pixel's own depth: GLSL samples depth with texture() too.
    expect(fragment.match(/\btexture\(/g)).toHaveLength(5);
  });
});

describe('WaterShafts.denoise', () => {
  function denoiseShader(backend: ShaderBackend): string {
    const rays = new DataTexture(new Uint16Array(4 * 4 * 4), 4, 4, RGBAFormat, HalfFloatType);
    rays.minFilter = LinearFilter;
    rays.magFilter = LinearFilter;
    const material = new MeshBasicNodeMaterial();
    material.colorNode = shafts().denoise(texture(rays));
    return buildShaders(new Mesh(new PlaneGeometry(), material), backend).fragment;
  }

  it('gathers the shaft texels around each one on WebGPU', () => {
    const fragment = denoiseShader('webgpu');
    expect(fragment).toMatch(/textureDimensions\(/);
    expect(fragment.match(/textureSample(Level)?\(/g)).toHaveLength(DENOISE_TAPS.length);
  });

  it('builds the same gather for the WebGL 2 fallback', () => {
    const fragment = denoiseShader('webgl');
    expect(fragment).toMatch(/textureSize\(/);
    expect(fragment.match(/\btexture\(/g)).toHaveLength(DENOISE_TAPS.length);
  });

  /** three's `interleavedGradientNoise`, which offsets the march per pixel. */
  function ign(x: number, y: number): number {
    const fract = (v: number) => v - Math.floor(v);
    return fract(52.9829189 * fract(0.06711056 * x + 0.00583715 * y));
  }

  it('averages the march jitter out to a small share of its screen-locked lattice (#1542)', () => {
    // The march error of a smooth integrand follows its jitter's offset from the mean, 0.5.
    let raw = 0;
    let cleaned = 0;
    let worst = 0;
    let n = 0;
    for (let x = 0.5; x < 256; x++) {
      for (let y = 0.5; y < 256; y++) {
        let sum = 0;
        for (const [dx, dy] of DENOISE_TAPS) sum += ign(x + dx, y + dy);
        const residual = sum / DENOISE_TAPS.length - 0.5;
        raw += (ign(x, y) - 0.5) ** 2;
        cleaned += residual ** 2;
        worst = Math.max(worst, Math.abs(residual));
        n++;
      }
    }
    expect(Math.sqrt(cleaned / n)).toBeLessThan(Math.sqrt(raw / n) / 5);
    expect(worst).toBeLessThan(0.1);
  });
});

describe('upscaleWeight', () => {
  function weight(bilinear: number, tapDepth: number, here: number): number {
    const [w] = evaluate(upscaleWeight(float(bilinear), float(tapDepth), float(here)));
    if (w === undefined) throw new Error('upscaleWeight evaluated to nothing');
    return w;
  }

  /**
   * Share of the left of two low-resolution texels, one apart, in a pixel `x` of the way to the
   * right one at view depth `here`, on a plane whose inverse depth changes by `slope` per texel to
   * the right: inverse depth is affine across the screen on any plane.
   */
  function leftShare(x: number, here: number, slope: number): number {
    const left = 1 / (1 / here - slope * x);
    const right = 1 / (1 / here + slope * (1 - x));
    const a = weight(1 - x, left, here);
    const b = weight(x, right, here);
    return a / (a + b);
  }

  it("gives a tap at the pixel's depth its bilinear weight over the tolerance", () => {
    expect(weight(0.4, 2, 2)).toBeCloseTo(0.4 / DEPTH_TOLERANCE, 9);
    expect(weight(0, 2, 2)).toBe(0);
  });

  it('is plain bilinear on a surface facing the camera', () => {
    for (const x of [0, 0.2, 0.5, 0.9]) expect(leftShare(x, 0.4, 0)).toBeCloseTo(1 - x, 9);
  });

  it('does not lean towards the nearer texel on a surface seen at a grazing angle', () => {
    for (const slope of [0.05, 0.3, 0.6]) {
      for (const x of [0.1, 0.3, 0.5, 0.6, 0.9]) {
        const receding = leftShare(x, 1, -slope);
        expect(receding, `slope ${slope} at ${x}`).toBeCloseTo(leftShare(x, 1, slope), 9);
        const nearestOnScreen = x < 0.5 ? receding : 1 - receding;
        expect(nearestOnScreen, `slope ${slope} at ${x}`).toBeGreaterThanOrEqual(
          Math.max(x, 1 - x) - 1e-9,
        );
      }
    }
  });

  it('splits evenly midway between a near and a far texel, whichever side is nearer', () => {
    for (const [near, far] of [
      [0.3, 0.9],
      [1, 3],
      [0.5, 0.55],
    ] as const) {
      const here = 2 / (1 / near + 1 / far);
      const a = weight(0.5, near, here);
      const b = weight(0.5, far, here);
      expect(a / (a + b), `${near}-${far} m`).toBeCloseTo(0.5, 9);
    }
  });

  it('keeps the shafts behind a fish from bleeding onto it, and the fish from the glass', () => {
    const fish = 0.3;
    const glass = 0.6;
    const onGlass = weight(0.25, glass, glass);
    const fishTap = weight(0.75, fish, glass);
    expect(onGlass / (onGlass + fishTap)).toBeGreaterThan(0.9);
    const onFish = weight(0.25, fish, fish);
    const glassTap = weight(0.75, glass, fish);
    expect(onFish / (onFish + glassTap)).toBeGreaterThan(0.9);
  });

  it('survives a tap with no depth', () => {
    expect(Number.isFinite(weight(0.5, 0, 1))).toBe(true);
  });
});

describe('WaterShafts.node', () => {
  it('builds the march with its depth in alpha on both backends', () => {
    for (const backend of ['webgpu', 'webgl'] as const) {
      const material = new MeshBasicNodeMaterial();
      material.colorNode = shafts().node(texture(sceneDepth()));
      expect(() => buildShaders(new Mesh(new PlaneGeometry(), material), backend)).not.toThrow();
    }
  });
});
