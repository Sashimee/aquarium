import { describe, expect, it } from 'vitest';
import {
  atlasDistance,
  drawsAsImpostor,
  effectiveDistance,
  IMPOSTOR_LOD,
  markNearest,
  MOUTH_LODS,
  mouthFade,
  rankMeshes,
  REFERENCE_LENGTH_M,
  selectLod,
  type AtlasFraming,
  type MeshCandidate,
  type MeshRank,
} from './lod';

const thresholds = { midDistance: 1, impostorDistance: 2 };
const L = REFERENCE_LENGTH_M;

describe('selectLod', () => {
  it('picks the level from the distance for a reference-length fish', () => {
    expect(selectLod(0.5, L, thresholds, 0)).toBe(0);
    expect(selectLod(1.5, L, thresholds, 1)).toBe(1);
    expect(selectLod(3, L, thresholds, 2)).toBe(2);
  });

  it('jumps straight to the right level from far away', () => {
    expect(selectLod(3, L, thresholds, 0)).toBe(2);
    expect(selectLod(0.2, L, thresholds, 2)).toBe(0);
  });

  it('holds the current level inside the hysteresis band', () => {
    expect(selectLod(1.05, L, thresholds, 0)).toBe(0);
    expect(selectLod(1.05, L, thresholds, 1)).toBe(1);
    expect(selectLod(0.95, L, thresholds, 1)).toBe(1);
    expect(selectLod(0.95, L, thresholds, 0)).toBe(0);
    expect(selectLod(1.1, L, thresholds, 0)).toBe(1);
    expect(selectLod(0.9, L, thresholds, 1)).toBe(0);
  });

  it('keeps bigger fish detailed for longer', () => {
    expect(selectLod(1.5, L, thresholds, 0)).toBe(1);
    expect(selectLod(1.5, 2 * L, thresholds, 0)).toBe(0);
  });

  it('never asks for a level the model does not have', () => {
    expect(selectLod(10, L, thresholds, 0, 2)).toBe(1);
    expect(selectLod(10, L, thresholds, 0, 1)).toBe(0);
    expect(() => selectLod(1, L, thresholds, 0, 0)).toThrow(RangeError);
  });

  it('rejects a non-positive length', () => {
    expect(() => effectiveDistance(1, 0)).toThrow(RangeError);
    expect(() => selectLod(1, -1, thresholds, 0)).toThrow(RangeError);
  });
});

describe('atlasDistance', () => {
  it('grows with the camera distance and the atlas texels per metre of fish', () => {
    expect(atlasDistance(1, 64, 0.02, 1)).toBeCloseTo(1600);
    expect(atlasDistance(2, 64, 0.02, 1)).toBeCloseTo(3200);
    expect(atlasDistance(1, 128, 0.02, 1)).toBeCloseTo(3200);
    expect(atlasDistance(1, 64, 0.02, 2)).toBeCloseTo(800);
  });

  it('rejects an atlas without area', () => {
    expect(() => atlasDistance(1, 0, 0.02, 1)).toThrow(RangeError);
    expect(() => atlasDistance(1, 64, 0, 1)).toThrow(RangeError);
    expect(() => atlasDistance(1, 64, 0.02, 0)).toThrow(RangeError);
  });

  it('keeps a near 64 px small fish as a mesh before a further 128 px large one', () => {
    const small = { distance: 0, full: false, rankKey: 0 };
    const large = { distance: 0, full: false, rankKey: 0 };
    small.distance = atlasDistance(0.3, 64, 0.02, 1);
    large.distance = atlasDistance(0.5, 128, 0.06, 1);
    markNearest([large, small], 1);
    expect(small.full).toBe(true);
    expect(large.full).toBe(false);
  });

  it('demotes the more distant of two fish with the same atlas', () => {
    const near = { distance: atlasDistance(0.3, 64, 0.02, 1), full: false, rankKey: 0 };
    const far = { distance: atlasDistance(1.2, 64, 0.02, 1), full: true, rankKey: 0 };
    markNearest([far, near], 1);
    expect(near.full).toBe(true);
    expect(far.full).toBe(false);
  });
});

describe('markNearest', () => {
  const ranks = (...distances: number[]): MeshRank[] =>
    distances.map((distance) => ({ distance, full: false, rankKey: 0 }));
  const fullDistances = (items: MeshRank[]): number[] =>
    items.filter((i) => i.full).map((i) => i.distance);

  it('keeps the nearest fish as meshes and nothing past the limit', () => {
    const items = ranks(3, 1, 4, 2, 5);
    markNearest(items, 3);
    expect(fullDistances(items).sort()).toEqual([1, 2, 3]);
  });

  it('meshes everything under the limit, and nothing at a limit of 0', () => {
    const items = ranks(3, 1);
    markNearest(items, 30);
    expect(items.every((i) => i.full)).toBe(true);
    markNearest(items, 0);
    expect(items.some((i) => i.full)).toBe(false);
  });

  it('lets a mesh keep its place until a newcomer is clearly nearer', () => {
    const held = { distance: 1, full: true, rankKey: 0 };
    const rival = { distance: 0.95, full: false, rankKey: 0 };
    markNearest([held, rival], 1);
    expect(held.full).toBe(true);
    expect(rival.full).toBe(false);
    rival.distance = 0.9;
    markNearest([held, rival], 1);
    expect(held.full).toBe(false);
    expect(rival.full).toBe(true);
  });

  it('never exceeds the limit, however the incumbents are spread', () => {
    const items = ranks(1, 1.01, 1.02, 1.03, 1.04, 1.05);
    items.forEach((item, k) => (item.full = k % 2 === 0));
    markNearest(items, 2);
    expect(items.filter((i) => i.full)).toHaveLength(2);
  });

  it('rejects a negative limit', () => {
    expect(() => markNearest(ranks(1), -1)).toThrow(RangeError);
  });
});

describe('rankMeshes', () => {
  interface Fish extends MeshCandidate {
    readonly framing: AtlasFraming;
  }
  const fish = (cameraDistance: number, frameSize: number, radius: number, scale = 1): Fish => ({
    cameraDistance,
    scale,
    framing: { frameSize, radius },
    distance: 0,
    full: false,
    rankKey: 0,
  });
  const framingOf = (f: Fish): AtlasFraming => f.framing;

  it('gives the slot to a near small 64 px fish over a further large 128 px one', () => {
    // Size-adjusted distance puts the large fish nearer (0.21 vs 0.375 reference lengths), but the
    // small one's atlas is coarser per screen pixel (480 vs 533).
    const small = fish(0.3, 64, 0.02);
    const large = fish(0.5, 128, 0.06);
    rankMeshes([large, small], framingOf, 1);
    expect(small.full).toBe(true);
    expect(large.full).toBe(false);
  });

  it('writes each fish its atlas distance and sorts nearest first', () => {
    const scaled = fish(1, 64, 0.02, 2);
    const plain = fish(1, 64, 0.02);
    const items = [plain, scaled];
    rankMeshes(items, framingOf, 1);
    expect(scaled.distance).toBeCloseTo(atlasDistance(1, 64, 0.02, 2));
    expect(plain.distance).toBeCloseTo(atlasDistance(1, 64, 0.02, 1));
    expect(items).toEqual([scaled, plain]);
  });

  it('marks nothing full with no slots, and throws on a bad atlas', () => {
    const items = [fish(0.3, 64, 0.02), fish(0.5, 128, 0.06)];
    rankMeshes(items, framingOf, 0);
    expect(items.every((f) => !f.full)).toBe(true);
    expect(() => rankMeshes([fish(1, 0, 0.02)], framingOf, 1)).toThrow(RangeError);
  });
});

describe('drawsAsImpostor', () => {
  const swimmerOnImpostorTier = {
    tierImpostors: true,
    available: true,
    lod: 0,
    full: true,
    castsShadow: false,
    display: 0,
  };
  const choose = (overrides: Partial<typeof swimmerOnImpostorTier>): boolean =>
    drawsAsImpostor({ ...swimmerOnImpostorTier, ...overrides });

  it('swaps a fish past the impostor level, shadow or not', () => {
    expect(choose({ lod: IMPOSTOR_LOD })).toBe(true);
    expect(choose({ lod: IMPOSTOR_LOD, castsShadow: true })).toBe(true);
  });

  it('swaps a near fish outside the nearest few at lod0 and lod1', () => {
    expect(choose({ lod: 0, full: false })).toBe(true);
    expect(choose({ lod: 1, full: false })).toBe(true);
  });

  it('keeps one of the nearest few as a mesh', () => {
    expect(choose({ lod: 0 })).toBe(false);
    expect(choose({ lod: 1 })).toBe(false);
  });

  it('keeps a near shadow caster as a mesh, so its shadow does not pop', () => {
    expect(choose({ lod: 0, full: false, castsShadow: true })).toBe(false);
    expect(choose({ lod: 1, full: false, castsShadow: true })).toBe(false);
  });

  it('draws the mesh when the species has no impostor', () => {
    expect(choose({ available: false, lod: IMPOSTOR_LOD })).toBe(false);
    expect(choose({ available: false, lod: 0, full: false })).toBe(false);
  });

  it('keeps a fish in display as a mesh at any distance, as its atlas has the fins at rest', () => {
    expect(choose({ display: 0.5, lod: IMPOSTOR_LOD })).toBe(false);
    expect(choose({ display: 0.05, lod: 0, full: false })).toBe(false);
  });

  it('lets a fish whose display has eased to almost nothing go back to its impostor', () => {
    expect(choose({ display: 0.005, lod: IMPOSTOR_LOD })).toBe(true);
    expect(choose({ display: 0, lod: IMPOSTOR_LOD })).toBe(true);
  });

  it('never swaps on a tier without impostors', () => {
    expect(choose({ tierImpostors: false, lod: IMPOSTOR_LOD })).toBe(false);
    expect(choose({ tierImpostors: false, lod: 0, full: false })).toBe(false);
  });
});

describe('mouthFade', () => {
  it('moves the mouth fully up close and through lod0', () => {
    expect(mouthFade(0, L, thresholds)).toBe(1);
    expect(mouthFade(1, L, thresholds)).toBe(1);
  });

  it('fades out monotonically across the mid band', () => {
    let last = 1;
    for (let d = 1; d <= 2; d += 0.05) {
      const fade = mouthFade(d, L, thresholds);
      expect(fade).toBeLessThanOrEqual(last);
      last = fade;
    }
    expect(mouthFade(1.4, L, thresholds)).toBeGreaterThan(0);
    expect(mouthFade(1.4, L, thresholds)).toBeLessThan(1);
  });

  it('is gone wherever a fish could be drawn at a level without a moving mouth', () => {
    for (let d = 0; d < 6; d += 0.01) {
      for (const current of [0, 1, 2]) {
        if (selectLod(d, L, thresholds, current) >= MOUTH_LODS) {
          expect(mouthFade(d, L, thresholds), `at ${d} from lod${current}`).toBe(0);
        }
      }
    }
  });

  it('keeps bigger fish moving their mouths further away', () => {
    expect(mouthFade(1.5, 2 * L, thresholds)).toBe(1);
    expect(mouthFade(1.5, L, thresholds)).toBeLessThan(1);
  });

  it('cuts at the lod2 switch when the mid band is too narrow to fade across', () => {
    const narrow = { midDistance: 2, impostorDistance: 2 };
    expect(mouthFade(1.8, L, narrow)).toBe(1);
    expect(mouthFade(1.9, L, narrow)).toBe(0);
  });
});
