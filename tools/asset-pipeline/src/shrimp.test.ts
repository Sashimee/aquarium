import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  FIN_ID_ATTRIBUTE,
  FIN_MASK_ATTRIBUTE,
  LEG_ATTRIBUTE,
  SHRIMP_PART_IDS,
} from './index-schema.ts';
import { buildDocument } from './emit.ts';
import {
  LEG_PAIRS,
  PLEOPOD_PAIRS,
  SHRIMP_RECIPES,
  buildShrimpGeometry,
  SHRIMP_LOD_PLAN,
  shrimpMaterial,
  shrimpTexture,
} from './shrimp.ts';

const LENGTH_M = 0.03;

function hashOf(geometry: ReturnType<typeof buildShrimpGeometry>): string {
  const h = createHash('sha256');
  const { part } = geometry;
  h.update(part.positions).update(part.uvs).update(part.indices);
  for (const key of Object.keys(part.extra).sort()) h.update(part.extra[key]!);
  return h.digest('hex');
}

describe.each(SHRIMP_RECIPES)('shrimp geometry $id', (recipe) => {
  const geometry = buildShrimpGeometry(recipe, LENGTH_M);
  const { part } = geometry;
  const id = part.extra[FIN_ID_ATTRIBUTE]!;
  const weight = part.extra[FIN_MASK_ATTRIBUTE]!;
  const limb = part.extra[LEG_ATTRIBUTE]!;
  const count = part.positions.length / 3;

  it('is deterministic', () => {
    expect(hashOf(buildShrimpGeometry(recipe, LENGTH_M))).toBe(hashOf(geometry));
  });

  it('keeps the eye stalks on the rigid body weight', () => {
    for (let i = 0; i < count; i++) if (id[i] === SHRIMP_PART_IDS.body) expect(weight[i]).toBe(0);
  });

  it('keeps every attribute aligned, finite and in range', () => {
    expect(id.length).toBe(count);
    expect(weight.length).toBe(count);
    expect(limb.length).toBe(count);
    expect(part.uvs.length).toBe(count * 2);
    const valid = new Set<number>(Object.values(SHRIMP_PART_IDS));
    for (let i = 0; i < count; i++) {
      expect(valid.has(id[i]!)).toBe(true);
      expect(weight[i]!).toBeGreaterThanOrEqual(0);
      expect(weight[i]!).toBeLessThanOrEqual(1);
      expect(
        Number.isFinite(
          part.positions[i * 3]! + part.positions[i * 3 + 1]! + part.positions[i * 3 + 2]!,
        ),
      ).toBe(true);
      expect(part.uvs[i * 2]!).toBeGreaterThanOrEqual(0);
      expect(part.uvs[i * 2]!).toBeLessThanOrEqual(1);
      expect(part.uvs[i * 2 + 1]!).toBeGreaterThanOrEqual(0);
      expect(part.uvs[i * 2 + 1]!).toBeLessThanOrEqual(1);
    }
    for (const index of part.indices) expect(index).toBeLessThan(count);
  });

  it('points +Z forward with rostrum to telson equal to the standard length', () => {
    let maxZ = -Infinity;
    let minBodyZ = Infinity;
    for (let i = 0; i < count; i++) {
      const z = part.positions[i * 3 + 2]!;
      if (id[i] === SHRIMP_PART_IDS.body) maxZ = Math.max(maxZ, z);
      if (id[i] === SHRIMP_PART_IDS.abdomen) minBodyZ = Math.min(minBodyZ, z);
    }
    expect(maxZ - minBodyZ).toBeGreaterThan(LENGTH_M * 0.98);
    expect(maxZ - minBodyZ).toBeLessThan(LENGTH_M * 1.06);
    expect(geometry.telsonZ).toBeLessThan(0);
    expect(geometry.hinge.z).toBeGreaterThan(geometry.telsonZ);
    expect(geometry.hinge.z).toBeLessThan(maxZ);
  });

  it('is mirror symmetric in x and centred on the body', () => {
    let sum = 0;
    for (let i = 0; i < count; i++) sum += part.positions[i * 3]!;
    expect(Math.abs(sum / count)).toBeLessThan(1e-6);
  });

  it('has legs that reach the walking surface below the origin', () => {
    expect(geometry.standoff).toBeGreaterThan(0.09 * LENGTH_M);
    expect(geometry.standoff).toBeLessThan(0.2 * LENGTH_M);
    let lowest = Infinity;
    for (let i = 0; i < count; i++) {
      if (id[i] === SHRIMP_PART_IDS.leg) lowest = Math.min(lowest, part.positions[i * 3 + 1]!);
    }
    expect(lowest).toBeCloseTo(-geometry.standoff, 9);
  });

  it('carries every limb exactly once per side', () => {
    const limbsOf = (partId: number): Set<number> => {
      const seen = new Set<number>();
      for (let i = 0; i < count; i++) if (id[i] === partId) seen.add(limb[i]!);
      return seen;
    };
    expect(limbsOf(SHRIMP_PART_IDS.leg)).toEqual(
      new Set(Array.from({ length: LEG_PAIRS * 2 }, (_, k) => k)),
    );
    expect(limbsOf(SHRIMP_PART_IDS.pleopod)).toEqual(
      new Set(Array.from({ length: PLEOPOD_PAIRS * 2 }, (_, k) => k)),
    );
    expect(limbsOf(SHRIMP_PART_IDS.antenna)).toEqual(new Set([0, 1, 2, 3]));
  });

  it('grows the abdomen weight from the hinge to the telson tip', () => {
    for (let i = 0; i < count; i++) {
      if (id[i] !== SHRIMP_PART_IDS.abdomen) continue;
      const z = part.positions[i * 3 + 2]!;
      const expected = Math.min(
        1,
        Math.max(0, (geometry.hinge.z - z) / (geometry.hinge.z - geometry.telsonZ)),
      );
      expect(Math.abs(weight[i]! - expected)).toBeLessThan(0.05);
    }
  });

  it('winds the body triangles outward', () => {
    const p = part.positions;
    let volume = 0;
    for (let t = 0; t < part.indices.length; t += 3) {
      const a = part.indices[t]! * 3;
      const b = part.indices[t + 1]! * 3;
      const c = part.indices[t + 2]! * 3;
      const partId = id[part.indices[t]!];
      if (partId !== SHRIMP_PART_IDS.body && partId !== SHRIMP_PART_IDS.abdomen) continue;
      volume +=
        p[a]! * (p[b + 1]! * p[c + 2]! - p[b + 2]! * p[c + 1]!) -
        p[a + 1]! * (p[b]! * p[c + 2]! - p[b + 2]! * p[c]!) +
        p[a + 2]! * (p[b]! * p[c + 1]! - p[b + 1]! * p[c]!);
    }
    expect(volume).toBeGreaterThan(0);
  });

  it('stays inside the LOD0 triangle budget', () => {
    const triangles = part.indices.length / 3;
    expect(triangles).toBeGreaterThan(1500);
    expect(triangles).toBeLessThan(4500);
  });
});

describe('shrimp LOD preparation', () => {
  it.each(SHRIMP_RECIPES)('removes every pleopod triangle only from LOD2 for $id', (recipe) => {
    const geometry = buildShrimpGeometry(recipe, LENGTH_M);
    const material = shrimpMaterial(recipe, shrimpTexture(recipe));
    const pleopodTriangles = (level: number): number => {
      const built = buildDocument(recipe.id, [geometry.part], [material]);
      const prim = built.doc.getRoot().listMeshes()[0]!.listPrimitives()[0]!;
      SHRIMP_LOD_PLAN.prepare!(prim, level);
      const ids = prim.getAttribute(FIN_ID_ATTRIBUTE)!;
      const indices = prim.getIndices()!.getArray()!;
      let count = 0;
      for (let t = 0; t < indices.length; t += 3)
        if (ids.getScalar(indices[t]!) === SHRIMP_PART_IDS.pleopod) count++;
      return count;
    };
    expect(pleopodTriangles(1)).toBeGreaterThan(0);
    expect(pleopodTriangles(2)).toBe(0);
  });
});

describe('shrimp texture', () => {
  it('is deterministic and opaque', () => {
    for (const recipe of SHRIMP_RECIPES) {
      const a = shrimpTexture(recipe);
      const b = shrimpTexture(recipe);
      expect(Buffer.compare(a.data, b.data)).toBe(0);
      const alpha = Array.from({ length: a.data.length / 4 }, (_, i) => a.data[i * 4 + 3]);
      expect(alpha.findIndex((v) => v !== 255)).toBe(-1);
    }
  });

  it('paints the cleaner dorsal stripe white and the cherry dorsal red', () => {
    const [cherry, cleaner] = [
      SHRIMP_RECIPES.find((r) => r.kind === 'cherry')!,
      SHRIMP_RECIPES.find((r) => r.kind === 'cleaner')!,
    ];
    const pixel = (recipe: typeof cherry, u: number): number[] => {
      const image = shrimpTexture(recipe);
      const x = Math.floor(u * image.width);
      const y = Math.floor(0.35 * image.height);
      const o = (y * image.width + x) * 4;
      return [image.data[o]!, image.data[o + 1]!, image.data[o + 2]!];
    };
    const stripe = pixel(cleaner, 0.5);
    expect(Math.min(...stripe)).toBeGreaterThan(150);
    const red = pixel(cherry, 0.5);
    expect(red[0]!).toBeGreaterThan(red[1]! * 3);
  });
});
