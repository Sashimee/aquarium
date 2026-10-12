import { describe, expect, it } from 'vitest';
import { classifyFins, bodyCentreOfMass, orient } from './fins.ts';
import { boundsOf } from './geometry.ts';
import { FIN_ID_ATTRIBUTE, FIN_IDS, FIN_MASK_ATTRIBUTE, SWAY_ATTRIBUTE } from './index-schema.ts';
import { loftFish, signedVolume, sideProjection } from './loft.ts';
import { LOFT_FISH_RECIPES } from './loft-fish.ts';
import { compactPart, normaliseToBase } from './environment.ts';
import { anemonePart } from './anemone.ts';
import {
  createGrid,
  fillSolid,
  open,
  rasteriseSurface,
  squaredDistance,
  toCell,
  voxelIndex,
} from './voxel.ts';
import type { Part } from './parts.ts';

interface Mesh {
  positions: number[];
  indices: number[];
}

function ellipsoid(radii: [number, number, number], rings = 24, sectors = 32): Mesh {
  const positions: number[] = [];
  const indices: number[] = [];
  for (let r = 0; r <= rings; r++) {
    const phi = (Math.PI * r) / rings;
    for (let s = 0; s < sectors; s++) {
      const theta = (2 * Math.PI * s) / sectors;
      positions.push(
        radii[0] * Math.sin(phi) * Math.cos(theta),
        radii[1] * Math.cos(phi),
        radii[2] * Math.sin(phi) * Math.sin(theta),
      );
    }
  }
  for (let r = 0; r < rings; r++)
    for (let s = 0; s < sectors; s++) {
      const a = r * sectors + s;
      const b = r * sectors + ((s + 1) % sectors);
      indices.push(a, a + sectors, b, b, a + sectors, b + sectors);
    }
  return { positions, indices };
}

function box(min: [number, number, number], max: [number, number, number]): Mesh {
  const positions: number[] = [];
  for (const z of [min[2], max[2]])
    for (const y of [min[1], max[1]]) for (const x of [min[0], max[0]]) positions.push(x, y, z);
  const indices = [
    0, 2, 1, 1, 2, 3, 4, 5, 6, 5, 7, 6, 0, 1, 4, 1, 5, 4, 2, 6, 3, 3, 6, 7, 0, 4, 2, 2, 4, 6, 1, 3,
    5, 3, 7, 5,
  ];
  return { positions, indices };
}

function join(...meshes: Mesh[]): {
  positions: Float32Array<ArrayBuffer>;
  indices: Uint32Array<ArrayBuffer>;
} {
  const positions: number[] = [];
  const indices: number[] = [];
  for (const mesh of meshes) {
    const base = positions.length / 3;
    positions.push(...mesh.positions);
    indices.push(...mesh.indices.map((i) => i + base));
  }
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) };
}

describe('classifyFins', () => {
  const fish = join(
    ellipsoid([0.12, 0.16, 0.5]),
    box([-0.006, 0.1, -0.2], [0.006, 0.42, 0.1]),
    box([-0.006, -0.3, -0.62], [0.006, 0.3, -0.45]),
  );
  const result = classifyFins(fish.positions, fish.indices, { resolution: 140 });

  function maskAt(predicate: (x: number, y: number, z: number) => boolean): number[] {
    const out: number[] = [];
    for (let i = 0; i < fish.positions.length / 3; i++) {
      if (predicate(fish.positions[i * 3]!, fish.positions[i * 3 + 1]!, fish.positions[i * 3 + 2]!))
        out.push(i);
    }
    return out;
  }

  it('leaves the rigid body at zero', () => {
    const core = maskAt((x, y, z) => Math.abs(z) < 0.25 && Math.abs(x) > 0.05 && Math.abs(y) < 0.1);
    expect(core.length).toBeGreaterThan(0);
    for (const i of core) {
      expect(result.mask[i]).toBeLessThan(0.15);
      expect(result.id[i]).toBe(0);
    }
  });

  it('marks the tip of a dorsal plate as dorsal fin', () => {
    const tip = maskAt((_x, y, z) => y > 0.4 && z > -0.25 && z < 0.15);
    expect(tip.length).toBeGreaterThan(0);
    for (const i of tip) {
      expect(result.mask[i]).toBeGreaterThan(0.5);
      expect(result.id[i]).toBe(FIN_IDS.dorsal);
    }
  });

  it('marks the plate behind the peduncle as caudal fin', () => {
    const tail = maskAt((_x, _y, z) => z < -0.55);
    expect(tail.length).toBeGreaterThan(0);
    for (const i of tail) expect(result.id[i]).toBe(FIN_IDS.caudal);
  });

  it('keeps every mask value in [0, 1] and every id a known fin', () => {
    for (const value of result.mask) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
    for (const value of result.id) expect([0, 1, 2, 3, 4, 5]).toContain(value);
  });

  it('reports the snout ahead of the tail along +Z', () => {
    expect(result.zSnout).toBeGreaterThan(0.45);
    expect(result.zTail).toBeLessThan(-0.55);
  });
});

describe('classifyFins with shellPectorals', () => {
  const body = ellipsoid([0.12, 0.16, 0.5]);
  const bodyVertices = body.positions.length / 3;
  const fin = box([0.1, -0.05, 0.1], [0.108, 0.07, 0.3]);
  const fish = join(body, fin);
  const hints = { resolution: 140, shellPectorals: true };
  const result = classifyFins(fish.positions, fish.indices, hints);
  const finVertices = Array.from({ length: fin.positions.length / 3 }, (_, k) => bodyVertices + k);

  it('marks a detached shell on the flank as a pectoral fin', () => {
    for (const i of finVertices) expect(result.id[i]).toBe(FIN_IDS.pectoral);
  });

  it('ramps the mask from the root to the far edge', () => {
    const values = finVertices.map((i) => result.mask[i]!);
    expect(Math.min(...values)).toBeLessThan(0.2);
    expect(Math.max(...values)).toBeCloseTo(1, 5);
  });

  it('leaves the connected body unmarked', () => {
    for (let i = 0; i < bodyVertices; i++) expect(result.id[i]).not.toBe(FIN_IDS.pectoral);
  });

  it('does nothing without the hint', () => {
    const plain = classifyFins(fish.positions, fish.indices, { resolution: 140 });
    expect(finVertices.some((i) => plain.id[i] !== FIN_IDS.pectoral)).toBe(true);
  });
});

describe('orient', () => {
  it('rotates a -X forward, +Z up model onto +Z forward, +Y up', () => {
    const positions = Float32Array.from([-1, 0, 0, 0, 0, 2]);
    orient(positions, null, { forward: '-x', up: '+z' });
    expect([...positions]).toEqual([0, 0, 1, 0, 2, 0].map((v) => (Object.is(v, -0) ? 0 : v)));
  });

  it('applies the same rotation to normals', () => {
    const positions = Float32Array.from([0, 0, 0]);
    const normals = Float32Array.from([-1, 0, 0]);
    orient(positions, normals, { forward: '-x', up: '+y' });
    expect(normals[2]).toBeCloseTo(1);
    expect(Math.abs(normals[0]!)).toBeCloseTo(0);
  });
});

describe('loftFish', () => {
  const recipe = LOFT_FISH_RECIPES.find((r) => r.id === 'bronze-corydoras')!;
  const standardLengthM = 0.065;
  const part = loftFish({ ...recipe.spec, standardLengthM }, () => [0.25, 0.75], 'skin');
  const count = part.positions.length / 3;

  it('is wound outward and centred on the body centre of mass', () => {
    expect(signedVolume(part.positions, part.indices)).toBeGreaterThan(0);
    const centre = bodyCentreOfMass(part.positions, part.indices, part.extra[FIN_ID_ATTRIBUTE]!);
    expect(centre[1]).toBeCloseTo(0, 4);
    expect(centre[2]).toBeCloseTo(0, 4);
  });

  it('points forward along +Z with the snout at about half a standard length', () => {
    const { min, max } = boundsOf(part.positions);
    expect(max[2]).toBeGreaterThan(0);
    expect(max[2] - min[2]).toBeGreaterThan(standardLengthM);
    expect(max[2] - min[2]).toBeLessThan(standardLengthM * 1.5);
    expect(max[1]).toBeGreaterThan(0);
  });

  it('bakes a fin mask in [0, 1], ids for all five fins and zero for the body', () => {
    const mask = part.extra[FIN_MASK_ATTRIBUTE]!;
    const id = part.extra[FIN_ID_ATTRIBUTE]!;
    expect(mask).toHaveLength(count);
    const seen = new Set(id);
    for (const fin of Object.values(FIN_IDS)) expect(seen.has(fin)).toBe(true);
    expect(seen.has(0)).toBe(true);
    for (let i = 0; i < count; i++) {
      expect(mask[i]).toBeGreaterThanOrEqual(0);
      expect(mask[i]).toBeLessThanOrEqual(1);
      if (id[i] === 0) expect(mask[i]).toBe(0);
    }
  });

  it('is deterministic', () => {
    const again = loftFish({ ...recipe.spec, standardLengthM }, () => [0.25, 0.75], 'skin');
    expect(Buffer.from(again.positions.buffer).equals(Buffer.from(part.positions.buffer))).toBe(
      true,
    );
  });

  it('scales linearly with the standard length', () => {
    const doubled = loftFish(
      { ...recipe.spec, standardLengthM: standardLengthM * 2 },
      () => [0.5, 0.5],
      'skin',
    );
    const a = boundsOf(part.positions);
    const b = boundsOf(doubled.positions);
    expect(b.max[2] - b.min[2]).toBeCloseTo((a.max[2] - a.min[2]) * 2, 4);
  });

  it('clamps projected texture coordinates to the unit square', () => {
    const outside = loftFish({ ...recipe.spec, standardLengthM }, () => [-3, 7], 'skin');
    for (const value of outside.uvs) expect(value === 0 || value === 1).toBe(true);
  });
});

describe('sideProjection', () => {
  const projection = sideProjection({
    standardLengthM: 1,
    snoutY: 0,
    tailY: 0,
    snoutPixel: [100, 50],
    tailPixel: [600, 50],
    crop: { left: 0, top: 0, width: 1000, height: 100 },
  });

  it('puts the snout and the end of the peduncle on their pixels', () => {
    expect(projection(0, 0)).toEqual([0.1, 0.5]);
    const [u, v] = projection(1, 0);
    expect(u).toBeCloseTo(0.6);
    expect(v).toBeCloseTo(0.5);
  });

  it('maps up to smaller v', () => {
    expect(projection(0.5, 0.05)[1]).toBeLessThan(0.5);
  });
});

describe('voxel utilities', () => {
  const grid = createGrid([0, 0, 0], [1, 1, 1], 0.1, 2);

  it('indexes cells and converts coordinates', () => {
    expect(voxelIndex(grid, 1, 0, 0)).toBe(1);
    expect(voxelIndex(grid, 0, 1, 0)).toBe(grid.nx);
    expect(toCell(grid, 0, 0)).toBe(2);
  });

  it('fills the inside of a closed surface and opens away thin plates', () => {
    const solid = box([0.2, 0.2, 0.2], [0.8, 0.8, 0.8]);
    const plate = box([0.8, 0.49, 0.2], [1.0, 0.51, 0.8]);
    const mesh = join(solid, plate);
    const g = createGrid([0, 0, 0], [1, 1, 1], 0.05, 4);
    rasteriseSurface(g, mesh.positions, mesh.indices);
    const filled = fillSolid(g);
    const centre = voxelIndex(g, toCell(g, 0.5, 0), toCell(g, 0.5, 1), toCell(g, 0.5, 2));
    expect(filled[centre]).toBe(1);
    const opened = open(g, filled, 3);
    expect(opened[centre]).toBe(1);
    const tip = voxelIndex(g, toCell(g, 0.97, 0), toCell(g, 0.5, 1), toCell(g, 0.5, 2));
    expect(filled[tip]).toBe(1);
    expect(opened[tip]).toBe(0);
  });

  it('computes squared distances to a mask', () => {
    const mask = new Uint8Array(grid.data.length);
    mask[voxelIndex(grid, 3, 3, 3)] = 1;
    const dist = squaredDistance(grid, mask);
    expect(dist[voxelIndex(grid, 3, 3, 3)]).toBe(0);
    expect(dist[voxelIndex(grid, 6, 3, 3)]).toBe(9);
    expect(dist[voxelIndex(grid, 4, 4, 4)]).toBe(3);
  });
});

describe('environment helpers', () => {
  function part(): Part {
    return {
      positions: Float32Array.from([0, 0, 0, 2, 0, 0, 0, 4, 0, 9, 9, 9]),
      normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
      uvs: Float32Array.from([0, 0, 1, 0, 0, 1, 1, 1]),
      indices: Uint32Array.from([0, 1, 2]),
      material: 'm',
      extra: { _SWAY: Float32Array.from([0, 0.5, 1, 1]) },
    };
  }

  it('compactPart drops unreferenced vertices and keeps attributes aligned', () => {
    const out = compactPart(part());
    expect(out.positions).toHaveLength(9);
    expect([...out.uvs]).toEqual([0, 0, 1, 0, 0, 1]);
    expect([...out.extra._SWAY!]).toEqual([0, 0.5, 1]);
    expect([...out.indices]).toEqual([0, 1, 2]);
  });

  it('normaliseToBase puts the base centre at the origin and scales the longest edge', () => {
    const p = compactPart(part());
    normaliseToBase([p], 0.5);
    const { min, max } = boundsOf(p.positions);
    expect(min[1]).toBeCloseTo(0);
    expect((min[0] + max[0]) / 2).toBeCloseTo(0);
    expect(Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2])).toBeCloseTo(0.5);
  });
});

describe('anemonePart', () => {
  const part = anemonePart();

  it('is deterministic for a seed and differs between seeds', () => {
    expect(
      Buffer.from(anemonePart().positions.buffer).equals(Buffer.from(part.positions.buffer)),
    ).toBe(true);
    expect(
      Buffer.from(anemonePart(8).positions.buffer).equals(Buffer.from(part.positions.buffer)),
    ).toBe(false);
  });

  it('spreads 0.3 m, stands on y = 0 and sways more towards the tips', () => {
    const { min, max } = boundsOf(part.positions);
    expect(Math.max(max[0] - min[0], max[2] - min[2])).toBeCloseTo(0.3, 3);
    expect(min[1]).toBeCloseTo(0, 5);
    const sway = part.extra[SWAY_ATTRIBUTE]!;
    expect(Math.min(...sway)).toBe(0);
    expect(Math.max(...sway)).toBe(1);
    let tipHeight = 0;
    let tips = 0;
    for (let i = 0; i < sway.length; i++)
      if (sway[i] === 1) {
        tipHeight += part.positions[i * 3 + 1]!;
        tips++;
      }
    expect(tipHeight / tips).toBeGreaterThan(0.03);
  });
});
