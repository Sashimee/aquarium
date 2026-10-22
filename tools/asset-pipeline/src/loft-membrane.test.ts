import { describe, expect, it } from 'vitest';
import { FIN_ID_ATTRIBUTE, FIN_IDS } from './index-schema.ts';
import { loftFish, type FinTexture } from './loft.ts';
import { LOFT_FISH_RECIPES, fitPhotoToLoft, peduncleColour } from './loft-fish.ts';
import type { Rgba } from './textures.ts';

function finIds(part: ReturnType<typeof loftFish>): Float32Array {
  const ids = part.extra[FIN_ID_ATTRIBUTE];
  if (!ids) throw new Error('part has no fin id attribute');
  return ids;
}

function at(values: ArrayLike<number>, index: number): number {
  const value = values[index];
  if (value === undefined) throw new Error(`index ${index} out of range`);
  return value;
}

const recipes = LOFT_FISH_RECIPES.filter((r) => r.spec.membrane);
const finTexture: FinTexture = (fin, u, v, variant) => [
  fin / 10 + variant / 100,
  u * 0.5 + v * 0.01,
];

describe('membrane lofts', () => {
  it('covers the nine roster lofts', () => {
    expect(recipes).toHaveLength(9);
  });

  for (const recipe of recipes) {
    describe(recipe.id, () => {
      const spec = { ...recipe.spec, standardLengthM: 0.05 };
      const build = (): ReturnType<typeof loftFish> =>
        loftFish(spec, () => [0.3, 0.4], 'skin', undefined, finTexture);

      it('samples the fin texture for fin vertices and the projection for the body', () => {
        const part = build();
        const id = finIds(part);
        let finVertices = 0;
        for (let i = 0; i < id.length; i++) {
          if (id[i] === 0) {
            expect(part.uvs[i * 2]).toBeCloseTo(0.3);
            continue;
          }
          finVertices++;
          expect(part.uvs[i * 2]).toBeCloseTo(at(id, i) / 10, 1);
        }
        expect(finVertices).toBeGreaterThan(200);
      });

      it('builds the caudal on a fine grid', () => {
        const id = finIds(build());
        expect(Array.from(id).filter((v) => v === FIN_IDS.caudal).length).toBeGreaterThanOrEqual(
          24 * 6,
        );
      });

      it('is deterministic', () => {
        const a = build();
        const b = build();
        expect(Array.from(a.positions)).toEqual(Array.from(b.positions));
        expect(Array.from(a.uvs)).toEqual(Array.from(b.uvs));
      });

      it('roots the caudal inside the peduncle instead of starting past it', () => {
        const part = build();
        const id = finIds(part);
        let rearBody = Infinity;
        let rearCaudal = Infinity;
        for (let i = 0; i < id.length; i++) {
          const z = at(part.positions, i * 3 + 2);
          if (id[i] === 0) rearBody = Math.min(rearBody, z);
          else if (id[i] === FIN_IDS.caudal) rearCaudal = Math.min(rearCaudal, z);
        }
        expect(rearCaudal).toBeLessThan(rearBody + spec.standardLengthM * 0.1);
        expect(rearCaudal).toBeGreaterThan(rearBody - spec.standardLengthM * 0.5);
      });
    });
  }
});

describe('fitPhotoToLoft', () => {
  const loft = [
    { t: 0, top: 0.1, bottom: -0.1, halfWidth: 0.05 },
    { t: 1, top: 0.2, bottom: -0.2, halfWidth: 0.05 },
  ];
  const photo = [
    { t: 0, top: 0.3, bottom: 0, halfWidth: 0.05 },
    { t: 1, top: 0.3, bottom: 0, halfWidth: 0.05 },
  ];
  const identity = (_behind: number, y: number): [number, number] => [0, y];

  it('maps the loft belly and back onto the traced belly and back', () => {
    const fitted = fitPhotoToLoft(identity, loft, photo);
    expect(fitted(0, -0.1)[1]).toBeCloseTo(0);
    expect(fitted(0, 0.1)[1]).toBeCloseTo(0.3);
    expect(fitted(1, 0)[1]).toBeCloseTo(0.15);
  });

  it('clamps past the ends of the body', () => {
    const fitted = fitPhotoToLoft(identity, loft, photo);
    expect(fitted(-0.5, 0.1)[1]).toBeCloseTo(0.3);
    expect(fitted(2, -0.2)[1]).toBeCloseTo(0);
  });
});

describe('peduncleColour', () => {
  const photo: Rgba = { width: 40, height: 40, data: new Uint8Array(40 * 40 * 4) };
  for (let i = 0; i < 40 * 40; i++) photo.data.set([100, 50, 200, 255], i * 4);

  it('averages the photo around the tail pixel', () => {
    expect(peduncleColour(photo, [20, 20])).toEqual([100, 50, 200]);
  });

  it('copes with a tail pixel near the edge', () => {
    expect(peduncleColour(photo, [1, 1])).toEqual([100, 50, 200]);
  });

  it('fails when the tail pixel lies outside the photo', () => {
    expect(() => peduncleColour(photo, [500, 500])).toThrow(/outside the photo/);
  });
});
