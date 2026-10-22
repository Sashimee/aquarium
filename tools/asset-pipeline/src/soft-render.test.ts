import { describe, expect, it } from 'vitest';
import { buildMips, renderScene, type SceneMesh, type SceneSpec } from './soft-render.ts';

const white = buildMips({ width: 2, height: 2, data: new Uint8Array(16).fill(255) });

function quad(z: number): SceneMesh {
  return {
    positions: Float32Array.from([-1, -1, z, 1, -1, z, 1, 1, z, -1, 1, z]),
    normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
    uvs: Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1]),
    indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
    texture: white,
    castsShadow: false,
  };
}

function horizontal(half: number, y: number, castsShadow: boolean): SceneMesh {
  return {
    positions: Float32Array.from([-half, y, -half, half, y, -half, half, y, half, -half, y, half]),
    normals: Float32Array.from([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
    uvs: Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1]),
    indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
    texture: white,
    castsShadow,
  };
}

function spec(instances: SceneSpec['instances']): SceneSpec {
  return {
    width: 32,
    height: 16,
    camera: { position: [0, 0, 5], pitchDeg: 0, hfovDeg: 60, near: 0.1 },
    lighting: { toLight: [0, 0, 1], ambient: 0, diffuse: 1, shadowStrength: 0 },
    instances,
    empty: [1, 2, 3],
    far: 22,
  };
}

describe('buildMips', () => {
  it('halves down to one texel and averages', () => {
    const data = new Uint8Array(16);
    for (let i = 0; i < 4; i++) data.set([i === 0 ? 200 : 0, 0, 0, 255], i * 4);
    const mips = buildMips({ width: 2, height: 2, data });
    expect(mips.levels).toHaveLength(2);
    expect(mips.levels[1]?.data[0]).toBe(50);
  });
});

describe('renderScene', () => {
  it('leaves uncovered pixels at the empty colour and the far depth', () => {
    const { rgb, depth } = renderScene(spec([]), 64);
    expect([...rgb.slice(0, 3)]).toEqual([1, 2, 3]);
    expect(depth[0]).toBe(22);
  });

  it('draws a facing quad lit by a head-on light, at its distance', () => {
    const { rgb, depth } = renderScene(
      spec([{ mesh: quad(0), position: [0, 0, 0], yawDeg: 0, scale: 1 }]),
      64,
    );
    const centre = 8 * 32 + 16;
    expect(depth[centre]).toBeCloseTo(5, 3);
    expect(rgb[centre * 3]).toBeGreaterThan(240);
  });

  it('keeps the nearer surface regardless of draw order', () => {
    const near = { mesh: quad(2), position: [0, 0, 0] as const, yawDeg: 0, scale: 1 };
    const far = { mesh: quad(-3), position: [0, 0, 0] as const, yawDeg: 0, scale: 1 };
    const a = renderScene(spec([near, far]), 64).depth;
    const b = renderScene(spec([far, near]), 64).depth;
    expect(a[8 * 32 + 16]).toBeCloseTo(3, 3);
    expect([...b]).toEqual([...a]);
  });

  it('drops triangles that reach behind the camera', () => {
    const { depth } = renderScene(
      spec([{ mesh: quad(6), position: [0, 0, 0], yawDeg: 0, scale: 1 }]),
      64,
    );
    expect(depth[8 * 32 + 16]).toBe(22);
  });

  it('darkens a floor under an occluder when shadows are on', () => {
    const scene = (shadowStrength: number): SceneSpec => ({
      width: 32,
      height: 32,
      camera: { position: [0, 3, 3], pitchDeg: 45, hfovDeg: 60, near: 0.1 },
      lighting: { toLight: [0, 1, 0], ambient: 0, diffuse: 1, shadowStrength },
      instances: [
        { mesh: horizontal(1, 0, false), position: [0, 0, 0], yawDeg: 0, scale: 1 },
        { mesh: horizontal(0.3, 1, true), position: [0, 0, 0], yawDeg: 0, scale: 1 },
      ],
      empty: [0, 0, 0],
      far: 22,
    });
    const sum = (rgb: Uint8Array): number => rgb.reduce((total, v) => total + v, 0);
    const unshadowed = sum(renderScene(scene(0), 256).rgb);
    const shadowed = sum(renderScene(scene(1), 256).rgb);
    expect(shadowed).toBeLessThan(unshadowed * 0.97);
  });
});
