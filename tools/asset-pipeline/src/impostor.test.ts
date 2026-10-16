import { describe, expect, it } from 'vitest';
import { bakeAtlas, boundingSphere, type BakeMesh } from './impostor.ts';
import { cellDirection, decodeViewNormal, viewBasis } from './octahedral.ts';

const GRID = 5;
const FRAME = 16;
const SIZE = GRID * FRAME;

/** Right triangle in the z = 0 plane covering the lower-left half of [0,1]^2, facing +Z. */
function triangle(finMask = 0): BakeMesh {
  return {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    uvs: new Float32Array(0),
    indices: new Uint32Array([0, 1, 2]),
    finMask: new Float32Array([finMask, finMask, finMask]),
    material: { baseColorFactor: [1, 0, 0, 1], alphaCutoff: 0.5 },
  };
}

type Cell = { i: number; j: number };

function pixel(data: Uint8Array, cell: Cell, x: number, y: number): number[] {
  const at = ((cell.j * FRAME + y) * SIZE + cell.i * FRAME + x) * 4;
  return [data[at]!, data[at + 1]!, data[at + 2]!, data[at + 3]!];
}

describe('bakeAtlas', () => {
  const atlas = bakeAtlas([triangle(1)], GRID, FRAME);
  const front: Cell = { i: 2, j: 4 };
  const back: Cell = { i: 2, j: 0 };
  const side: Cell = { i: 4, j: 2 };
  const lowerLeft = [3, FRAME - 4] as const;
  const lowerRight = [FRAME - 4, FRAME - 4] as const;
  const upperRight = [FRAME - 4, 3] as const;
  const upperLeft = [3, 3] as const;

  it('centres the pivot on the bounds and holds every vertex in the radius', () => {
    expect(atlas.pivot).toEqual([0.5, 0.5, 0]);
    expect(boundingSphere([triangle()]).radius).toBe(atlas.radius);
    expect(atlas.radius).toBeGreaterThan(Math.hypot(0.5, 0.5));
  });

  it('sizes both atlases grid x frame square', () => {
    expect(atlas.albedo.width).toBe(SIZE);
    expect(atlas.normalDepth.height).toBe(SIZE);
  });

  it('draws screen-right as +X and image rows top-down in the +Z frame', () => {
    const covered = pixel(atlas.albedo.data, front, ...lowerLeft);
    expect(covered[3]).toBe(255);
    expect(covered[0]).toBeGreaterThan(200);
    expect(covered[1]).toBe(0);
    expect(pixel(atlas.albedo.data, front, ...upperRight)[3]).toBe(0);
  });

  it('mirrors the silhouette when seen from behind', () => {
    expect(pixel(atlas.albedo.data, back, ...lowerRight)[3]).toBe(255);
    expect(pixel(atlas.albedo.data, back, ...upperLeft)[3]).toBe(0);
  });

  it('stores the normal facing the camera, in fish space', () => {
    const decoded = (cell: Cell) => {
      const [r, g] = pixel(atlas.normalDepth.data, cell, ...lowerLeft);
      return decodeViewNormal(r! / 255, g! / 255, viewBasis(cellDirection(cell.i, cell.j, GRID)));
    };
    const [fx, fy, fz] = decoded(front);
    expect(fz).toBeGreaterThan(0.99);
    expect(Math.abs(fx) + Math.abs(fy)).toBeLessThan(0.05);
    expect(decoded(back)[2]).toBeLessThan(-0.99);
  });

  it('decodes to the fish-space normal in a tilted frame', () => {
    const tilted = bakeAtlas([triangle(0)], GRID, FRAME);
    const cell: Cell = { i: 3, j: 4 };
    const d = cellDirection(cell.i, cell.j, GRID);
    const at = ((cell.j * FRAME + 8) * SIZE + cell.i * FRAME + 8) * 4;
    const n = decodeViewNormal(
      tilted.normalDepth.data[at]! / 255,
      tilted.normalDepth.data[at + 1]! / 255,
      viewBasis(d),
    );
    expect(n[2]).toBeGreaterThan(0.99);
  });

  it('stores depth 0.5 on the pivot plane and the fin mask in blue', () => {
    const [, , fin, depth] = pixel(atlas.normalDepth.data, front, ...lowerLeft);
    expect(fin).toBe(255);
    expect(Math.abs(depth! - 128)).toBeLessThanOrEqual(1);
  });

  it('leaves an edge-on view empty', () => {
    let covered = 0;
    for (let y = 0; y < FRAME; y++)
      for (let x = 0; x < FRAME; x++) if (pixel(atlas.albedo.data, side, x, y)[3]! > 0) covered++;
    expect(covered).toBe(0);
  });

  it('bleeds colour past the silhouette while keeping alpha at zero', () => {
    const [r, , , a] = pixel(atlas.albedo.data, front, FRAME - 7, 6);
    expect(a).toBe(0);
    expect(r).toBeGreaterThan(0);
  });

  it('is deterministic', () => {
    const again = bakeAtlas([triangle(1)], GRID, FRAME);
    expect(Buffer.from(again.albedo.data).equals(Buffer.from(atlas.albedo.data))).toBe(true);
    expect(Buffer.from(again.normalDepth.data).equals(Buffer.from(atlas.normalDepth.data))).toBe(
      true,
    );
  });
});

describe('bakeAtlas albedo encoding', () => {
  it('keeps a mid-grey textured surface at the same sRGB byte', () => {
    const grey = new Uint8Array(4 * 4 * 4).fill(128);
    for (let p = 3; p < grey.length; p += 4) grey[p] = 255;
    const mesh: BakeMesh = {
      ...triangle(),
      uvs: new Float32Array([0, 0, 1, 0, 0, 1]),
      material: {
        baseColorFactor: [1, 1, 1, 1],
        baseColor: { width: 4, height: 4, data: grey },
        alphaCutoff: 0.5,
      },
    };
    const atlas = bakeAtlas([mesh], GRID, FRAME);
    const [r, g, b, a] = pixel(atlas.albedo.data, { i: 2, j: 4 }, 3, FRAME - 4);
    expect(a).toBe(255);
    for (const channel of [r!, g!, b!]) expect(Math.abs(channel - 128)).toBeLessThanOrEqual(1);
  });

  it('applies the linear base colour factor on top of the decoded texture', () => {
    const white = new Uint8Array(4 * 4 * 4).fill(255);
    const mesh: BakeMesh = {
      ...triangle(),
      uvs: new Float32Array([0, 0, 1, 0, 0, 1]),
      material: {
        baseColorFactor: [0.5, 0.5, 0.5, 1],
        baseColor: { width: 4, height: 4, data: white },
        alphaCutoff: 0.5,
      },
    };
    const atlas = bakeAtlas([mesh], GRID, FRAME);
    const [r] = pixel(atlas.albedo.data, { i: 2, j: 4 }, 3, FRAME - 4);
    expect(Math.abs(r! - 188)).toBeLessThanOrEqual(1);
  });
});
