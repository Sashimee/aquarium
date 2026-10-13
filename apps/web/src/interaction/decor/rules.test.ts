import { describe, expect, it } from 'vitest';
import { FLAT_GROUND, flat, item, LIMITS, spec } from './fixtures';
import {
  admit,
  check,
  describeRejection,
  EMBED,
  findFreeSpot,
  keepInside,
  MAX_PIECES,
  restHeight,
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
    expect(admit(undefined, [])).toBe('unknown-asset');
  });

  it('caps the number of pieces', () => {
    const many = Array.from({ length: MAX_PIECES }, () => ({ item: item('boulder-01', 0, 0) }));
    expect(admit(rock, many)).toBe('full');
    expect(admit(rock, many.slice(1))).toBeNull();
  });

  it('allows a single vacation feeder', () => {
    expect(admit(FEEDER_SPEC, [])).toBeNull();
    expect(admit(FEEDER_SPEC, [{ item: item(FEEDER_SPEC.assetId, 0, 0) }])).toBe('feeder-exists');
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
      'no-room',
    ] as const) {
      expect(describeRejection(r).length).toBeGreaterThan(10);
    }
  });
});
