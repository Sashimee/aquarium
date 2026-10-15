import { describe, expect, it } from 'vitest';
import { eyeSpheres, glossyEyeParts, GLOSSY_EYE_MATERIAL, sphereMesh } from './glossy-eyes.ts';
import type { Part } from './parts.ts';

const RADIUS = 0.4;
const HALF_LENGTH = 1;

function ellipsoid(): Part {
  const rings = 40;
  const around = 32;
  const positions: number[] = [];
  for (let r = 0; r <= rings; r++) {
    const phi = (r / rings) * Math.PI;
    for (let a = 0; a < around; a++) {
      const theta = (a / around) * Math.PI * 2;
      positions.push(
        RADIUS * Math.sin(phi) * Math.cos(theta),
        RADIUS * Math.sin(phi) * Math.sin(theta),
        HALF_LENGTH * Math.cos(phi),
      );
    }
  }
  return {
    positions: Float32Array.from(positions),
    normals: new Float32Array(positions.length),
    uvs: new Float32Array((positions.length / 3) * 2),
    indices: new Uint32Array(0),
    material: 'skin',
    extra: {},
  };
}

const spec = { sideways: 0.1, behindSnout: 0.25, radius: 0.04, lift: -0.5 };

describe('eyeSpheres', () => {
  const body = ellipsoid();
  const [left, right] = eyeSpheres(body, spec) as [
    ReturnType<typeof eyeSpheres>[number],
    ReturnType<typeof eyeSpheres>[number],
  ];

  it('returns one eye per side, mirrored about the midline', () => {
    expect(left.centre[0]).toBeLessThan(0);
    expect(right.centre[0]).toBeGreaterThan(0);
    expect(left.centre[0]).toBeCloseTo(-right.centre[0], 4);
    expect(left.centre[2]).toBeCloseTo(right.centre[2], 6);
  });

  it('scales the position and radius by the body length', () => {
    const length = 2 * HALF_LENGTH;
    expect(right.radius).toBeCloseTo(spec.radius * length, 6);
    expect(right.centre[0]).toBeCloseTo(spec.sideways * length, 4);
    expect(right.centre[2]).toBeCloseTo(HALF_LENGTH - spec.behindSnout * length, 6);
  });

  it('rests on the skin under the eye, lifted by the given fraction of the radius', () => {
    const skin = Math.sqrt(RADIUS ** 2 - right.centre[0] ** 2);
    expect(right.centre[1]).toBeGreaterThan(skin - right.radius);
    expect(right.centre[1]).toBeLessThanOrEqual(skin + 0.05);
    const raised = eyeSpheres(body, { ...spec, lift: 0.5 })[1]!;
    expect(raised.centre[1] - right.centre[1]).toBeCloseTo(right.radius, 6);
  });

  it('fails loudly when there is no skin where the eye should be', () => {
    expect(() => eyeSpheres(body, { ...spec, sideways: 5 })).toThrow(/no skin/);
  });
});

describe('sphereMesh', () => {
  const sphere = { centre: [1, 2, 3] as [number, number, number], radius: 0.5 };
  const mesh = sphereMesh(sphere, 10, 6, 'Eye');

  it('puts every vertex on the sphere with unit outward normals', () => {
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const offset = [0, 1, 2].map((a) => mesh.positions[i + a]! - sphere.centre[a]!);
      expect(Math.hypot(...offset)).toBeCloseTo(sphere.radius, 5);
      const normal = [0, 1, 2].map((a) => mesh.normals[i + a]!);
      expect(Math.hypot(...normal)).toBeCloseTo(1, 5);
      expect(offset.reduce((sum, o, a) => sum + o * normal[a]!, 0)).toBeGreaterThan(0);
    }
  });

  it('winds every triangle counter-clockwise seen from outside, with no degenerate ones', () => {
    for (let t = 0; t < mesh.indices.length; t += 3) {
      const [a, b, c] = [0, 1, 2].map((k) => mesh.indices[t + k]! * 3) as [number, number, number];
      const edge = (from: number, to: number): number[] =>
        [0, 1, 2].map((k) => mesh.positions[to + k]! - mesh.positions[from + k]!);
      const [e1, e2] = [edge(a, b), edge(a, c)] as [number[], number[]];
      const face = [
        e1[1]! * e2[2]! - e1[2]! * e2[1]!,
        e1[2]! * e2[0]! - e1[0]! * e2[2]!,
        e1[0]! * e2[1]! - e1[1]! * e2[0]!,
      ];
      expect(Math.hypot(...face)).toBeGreaterThan(1e-9);
      const outward = [0, 1, 2].map((k) => mesh.positions[a + k]! - sphere.centre[k]!);
      expect(face.reduce((sum, f, k) => sum + f * outward[k]!, 0)).toBeGreaterThan(0);
    }
  });

  it('spends no triangles on the poles: 2 * segments * (rings - 1) in total', () => {
    expect(mesh.indices.length / 3).toBe(2 * 10 * (6 - 1));
  });
});

describe('glossyEyeParts', () => {
  const parts = glossyEyeParts(ellipsoid(), spec);

  it('makes one part per level, each holding both eyes on the eye material', () => {
    expect(parts.map((p) => p.lods)).toEqual([[0], [1], [2]]);
    for (const part of parts) expect(part.material).toBe(GLOSSY_EYE_MATERIAL.name);
  });

  it('gets coarser at every level', () => {
    const triangles = parts.map((p) => p.indices.length / 3);
    expect(triangles[0]!).toBeGreaterThan(triangles[1]!);
    expect(triangles[1]!).toBeGreaterThan(triangles[2]!);
    expect(triangles[2]!).toBeGreaterThan(0);
  });

  it('keeps the eye dark and glossy, apart from the rough body', () => {
    expect(GLOSSY_EYE_MATERIAL.roughness).toBeLessThan(0.3);
    expect(Math.max(...GLOSSY_EYE_MATERIAL.baseColorFactor.slice(0, 3))).toBeLessThan(0.1);
    expect(GLOSSY_EYE_MATERIAL.baseColor).toBeUndefined();
  });
});
