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
import { texture, vec4 } from 'three/tsl';
import { buildShaders, type ShaderBackend } from '../shaderFixtures';
import { Caustics } from '../water/caustics';
import { WaterMedium } from '../water/medium';
import { WaterShafts } from './shafts';

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

describe('WaterShafts.node', () => {
  it('builds the march with its depth in alpha on both backends', () => {
    for (const backend of ['webgpu', 'webgl'] as const) {
      const material = new MeshBasicNodeMaterial();
      material.colorNode = shafts().node(texture(sceneDepth()));
      expect(() => buildShaders(new Mesh(new PlaneGeometry(), material), backend)).not.toThrow();
    }
  });
});
