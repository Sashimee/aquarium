import { describe, expect, it } from 'vitest';
import { decorPositionLimits, isDecorAssetForBiome } from '@aquarium/shared';
import { FLAT_GROUND, flat, item, LIMITS, SPECS, spec } from './fixtures';
import {
  admit,
  check,
  describeRejection,
  EMBED,
  findFreeSpot,
  keepInside,
  MAX_PIECES,
  paletteSpecs,
  restHeight,
  withinServerBounds,
} from './rules';
import { FEEDER_SPEC } from './spec';

const rock = spec('boulder-01');
const wood = spec('dead-tree-trunk-02');

describe('restHeight', () => {
  it('sinks the underside slightly into flat ground', () => {
    expect(restHeight(rock, item('boulder-01', 0, 0), flat)).toBeCloseTo(FLAT_GROUND - EMBED, 9);
  });

  it('rests on the highest ground under the footprint', () => {
    const slope = (x: number) => 0.05 + x * 0.1;
    const y = restHeight(rock, item('boulder-01', 0, 0), slope);
    expect(y).toBeGreaterThan(slope(0));
    expect(y).toBeCloseTo(slope(0.12163) - EMBED, 3);
  });
});

describe('check', () => {
  it('passes a clear spot', () => {
    expect(check(rock, item('boulder-01', 0, 0), [], LIMITS)).toBeNull();
  });

  it('refuses a piece through the glass', () => {
    expect(check(rock, item('boulder-01', 0.55, 0), [], LIMITS)).toBe('outside');
  });

  it('refuses overlap with another piece', () => {
    const other = { spec: wood, item: item('dead-tree-trunk-02', 0.1, 0) };
    expect(check(rock, item('boulder-01', 0, 0), [other], LIMITS)).toBe('overlap');
  });

  it('allows pieces that only come near each other', () => {
    const other = { spec: rock, item: item('boulder-01', 0.3, 0) };
    expect(check(rock, item('boulder-01', 0, 0), [other], LIMITS)).toBeNull();
  });
});

describe('keepInside', () => {
  it('slides a piece back from the glass instead of rejecting it', () => {
    const pushed = keepInside(rock, item('boulder-01', 0.9, 0), LIMITS);
    expect(check(rock, pushed, [], LIMITS)).toBeNull();
    expect(pushed.position[0]).toBeCloseTo(0.589 - 0.12163, 3);
  });

  it('leaves a piece that is already inside alone', () => {
    const inside = item('boulder-01', 0.1, 0.05);
    expect(keepInside(rock, inside, LIMITS)).toEqual(inside);
  });

  it('clamps depth separately from length', () => {
    const pushed = keepInside(rock, item('boulder-01', 0.1, -0.9), LIMITS);
    expect(pushed.position[0]).toBeCloseTo(0.1, 6);
    expect(pushed.position[2]).toBeCloseTo(-0.239 + 0.175, 3);
  });
});

describe('admit', () => {
  it('refuses unknown assets', () => {
    expect(admit(undefined, [], 'reef')).toBe('unknown-asset');
  });

  it('refuses a piece from another biome with its own reason', () => {
    const reefArch = spec('reef-arch');
    expect(admit(reefArch, [], 'freshwater')).toBe('wrong-biome');
    expect(describeRejection('wrong-biome')).not.toBe(describeRejection('unknown-asset'));
  });

  it('caps the number of pieces', () => {
    const many = Array.from({ length: MAX_PIECES }, () => ({ item: item('boulder-01', 0, 0) }));
    expect(admit(rock, many, 'reef')).toBe('full');
    expect(admit(rock, many.slice(1), 'reef')).toBeNull();
  });

  it('allows a single vacation feeder', () => {
    expect(admit(FEEDER_SPEC, [], 'reef')).toBeNull();
    expect(admit(FEEDER_SPEC, [{ item: item(FEEDER_SPEC.assetId, 0, 0) }], 'freshwater')).toBe(
      'feeder-exists',
    );
  });
});

describe('findFreeSpot', () => {
  it('uses the preferred spot when it is clear', () => {
    const found = findFreeSpot(rock, item('boulder-01', 0, 0), [0.1, 0.05], [], LIMITS);
    expect(found?.position[0]).toBeCloseTo(0.1, 6);
    expect(found?.position[2]).toBeCloseTo(0.05, 6);
  });

  it('moves out to the nearest clear spot', () => {
    const blocker = { spec: rock, item: item('boulder-01', 0, 0) };
    const found = findFreeSpot(rock, item('boulder-01', 0, 0), [0, 0], [blocker], LIMITS);
    expect(found).not.toBeNull();
    expect(check(rock, found as NonNullable<typeof found>, [blocker], LIMITS)).toBeNull();
  });

  it('gives up when the tank is full', () => {
    const tiny = { halfLength: 0.13, halfDepth: 0.18 };
    const blocker = { spec: rock, item: item('boulder-01', 0, 0) };
    expect(findFreeSpot(rock, item('boulder-01', 0, 0), [0, 0], [blocker], tiny)).toBeNull();
  });
});

describe('describeRejection', () => {
  it('has a sentence for every reason', () => {
    for (const r of [
      'outside',
      'overlap',
      'full',
      'feeder-exists',
      'unknown-asset',
      'wrong-biome',
      'no-room',
    ] as const) {
      expect(describeRejection(r).length).toBeGreaterThan(10);
    }
  });
});

describe('paletteSpecs', () => {
  const ids = (biome: 'freshwater' | 'reef') => paletteSpecs(SPECS, biome).map((s) => s.assetId);

  it('offers only what the server accepts for the biome, plus the feeder', () => {
    for (const biome of ['freshwater', 'reef'] as const) {
      for (const id of ids(biome)) {
        expect(id === FEEDER_SPEC.assetId || isDecorAssetForBiome(biome, id)).toBe(true);
      }
      expect(ids(biome)).toContain(FEEDER_SPEC.assetId);
    }
  });

  it('keeps reef-only pieces out of freshwater and freshwater-only pieces out of the reef', () => {
    expect(ids('freshwater')).not.toContain('reef-arch');
    expect(ids('freshwater')).not.toContain('lambis-shell');
    expect(ids('freshwater')).toContain('driftwood-branch');
    expect(ids('reef')).toContain('reef-arch');
    expect(ids('reef')).not.toContain('driftwood-branch');
  });

  it('shares the rocks between both biomes', () => {
    expect(ids('freshwater')).toContain('boulder-01');
    expect(ids('reef')).toContain('boulder-01');
  });
});

describe('withinServerBounds', () => {
  const limits = decorPositionLimits();
  const at = (x: number, y: number, z: number) =>
    withinServerBounds({ ...item('boulder-01', 0, 0), position: [x, y, z] }).position;

  it('leaves positions on the exact bounds alone', () => {
    expect(at(limits.x, limits.yMax, limits.z)).toEqual([limits.x, limits.yMax, limits.z]);
    expect(at(-limits.x, 0, -limits.z)).toEqual([-limits.x, 0, -limits.z]);
  });

  it('pulls anything past a bound back onto it', () => {
    expect(at(limits.x + 0.01, 0.1, 0)).toEqual([limits.x, 0.1, 0]);
    expect(at(-limits.x - 1, 0.1, 0)).toEqual([-limits.x, 0.1, 0]);
    expect(at(0, 0.1, limits.z + 0.01)).toEqual([0, 0.1, limits.z]);
    expect(at(0, -0.01, 0)).toEqual([0, 0, 0]);
    expect(at(0, limits.yMax + 0.01, 0)).toEqual([0, limits.yMax, 0]);
  });

  it('is applied by keepInside even when the tank limits are wider', () => {
    const wide = { halfLength: 2, halfDepth: 2 };
    const out = keepInside(rock, item('boulder-01', 1.5, -1.5), wide);
    expect(out.position[0]).toBe(limits.x);
    expect(out.position[2]).toBe(-limits.z);
  });
});
