import { MeshoptSimplifier } from 'meshoptimizer';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  boundaryLoops,
  fillSmallHoles,
  growMask,
  inpaintColours,
  smoothMasked,
} from './dense-edit.ts';
import { uvStretchShare, type Dense } from './rebake.ts';
import { bakeScanPart } from './scan-bake.ts';

function sphere(rings: number, segments: number): Dense {
  const positions: number[] = [0, 1, 0];
  const colours: number[] = [0.9, 0.4, 0.4];
  const indices: number[] = [];
  for (let r = 1; r < rings; r++)
    for (let k = 0; k < segments; k++) {
      const phi = (r / rings) * Math.PI;
      const theta = (k / segments) * Math.PI * 2;
      positions.push(
        Math.sin(phi) * Math.cos(theta),
        Math.cos(phi),
        Math.sin(phi) * Math.sin(theta),
      );
      colours.push(Math.cos(phi) > 0 ? 0.9 : 0.1, 0.4, 0.4);
    }
  const south = positions.length / 3;
  positions.push(0, -1, 0);
  colours.push(0.1, 0.4, 0.4);
  const at = (r: number, k: number): number => 1 + (r - 1) * segments + (k % segments);
  for (let k = 0; k < segments; k++) indices.push(0, at(1, k), at(1, k + 1));
  for (let r = 1; r < rings - 1; r++)
    for (let k = 0; k < segments; k++)
      indices.push(
        at(r, k),
        at(r + 1, k),
        at(r, k + 1),
        at(r, k + 1),
        at(r + 1, k),
        at(r + 1, k + 1),
      );
  for (let k = 0; k < segments; k++) indices.push(south, at(rings - 1, k + 1), at(rings - 1, k));
  return {
    positions: Float32Array.from(positions),
    colours: Float32Array.from(colours),
    indices: Uint32Array.from(indices),
    extra: {},
  };
}

function withoutTriangle(dense: Dense, triangle: number): Dense {
  const indices = Array.from(dense.indices);
  indices.splice(triangle * 3, 3);
  return { ...dense, indices: Uint32Array.from(indices) };
}

describe('dense-edit', () => {
  it('finds the boundary loop of a removed triangle and closes it with a fan', () => {
    const open = withoutTriangle(sphere(8, 12), 40);
    const loops = boundaryLoops(open.indices);
    expect(loops.map((l) => l.length)).toEqual([3]);
    const closed = fillSmallHoles(open, 4);
    expect(boundaryLoops(closed.indices)).toEqual([]);
    expect(closed.positions.length / 3).toBe(open.positions.length / 3 + 1);
  });

  it('leaves loops longer than the limit open', () => {
    const open = withoutTriangle(sphere(8, 12), 40);
    expect(boundaryLoops(fillSmallHoles(open, 2).indices).length).toBe(1);
  });

  it('replaces masked colours with what surrounds them', () => {
    const dense = sphere(10, 16);
    const count = dense.positions.length / 3;
    const mask = new Uint8Array(count);
    const target = 1 + 4 * 16 + 3;
    mask[target] = 1;
    dense.colours[target * 3] = 1;
    dense.colours[target * 3 + 1] = 1;
    dense.colours[target * 3 + 2] = 1;
    inpaintColours(dense, growMask(dense, mask, 1));
    expect(dense.colours[target * 3 + 1]!).toBeCloseTo(0.4, 1);
  });

  it('smooths only masked vertices', () => {
    const dense = sphere(10, 16);
    const count = dense.positions.length / 3;
    const before = Float32Array.from(dense.positions);
    const mask = new Uint8Array(count);
    const bump = 1 + 4 * 16 + 3;
    mask[bump] = 1;
    dense.positions[bump * 3] = dense.positions[bump * 3]! * 1.5;
    const lifted = dense.positions[bump * 3]!;
    smoothMasked(dense, mask, 10);
    expect(Math.abs(dense.positions[bump * 3]! - before[bump * 3]!)).toBeLessThan(
      Math.abs(lifted - before[bump * 3]!),
    );
    expect(dense.positions[0]).toBe(before[0]);
    expect(dense.positions[(count - 1) * 3 + 1]).toBe(before[(count - 1) * 3 + 1]);
  });
});

describe('bakeScanPart', { timeout: 30000 }, () => {
  beforeAll(() => MeshoptSimplifier.ready);

  const options = { targetTriangles: 300, atlasSize: 128, gutter: 2, bleed: 3 };

  it('simplifies, unwraps with few stretched triangles and keeps the colour on the right side', () => {
    const dense = sphere(40, 64);
    const { part, image, charts } = bakeScanPart(dense, 'test', options);
    expect(part.indices.length / 3).toBeLessThanOrEqual(400);
    expect(charts).toBeGreaterThan(0);
    expect(part.uvs.every((u) => u >= 0 && u <= 1)).toBe(true);
    expect(uvStretchShare(part)).toBeLessThan(0.1);
    let checked = 0;
    for (let i = 0; i < part.positions.length / 3; i++) {
      const y = part.positions[i * 3 + 1]!;
      if (Math.abs(y) < 0.3) continue;
      const x = Math.min(127, Math.floor(part.uvs[i * 2]! * 128));
      const row = Math.min(127, Math.floor(part.uvs[i * 2 + 1]! * 128));
      const red = image.data[(row * 128 + x) * 4]!;
      if (y > 0) expect(red).toBeGreaterThan(150);
      else expect(red).toBeLessThan(100);
      checked++;
    }
    expect(checked).toBeGreaterThan(50);
  });

  it('is deterministic', () => {
    const a = bakeScanPart(sphere(30, 48), 'test', options);
    const b = bakeScanPart(sphere(30, 48), 'test', options);
    expect(Array.from(a.part.positions)).toEqual(Array.from(b.part.positions));
    expect(Buffer.from(a.image.data).equals(Buffer.from(b.image.data))).toBe(true);
  });
});
