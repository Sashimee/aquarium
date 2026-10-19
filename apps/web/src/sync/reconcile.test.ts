import { describe, expect, it } from 'vitest';
import { FISH_1, FISH_2, FISH_3, TANK_B, fishFixture, tankFixture } from './fixtures';
import { diffFish, isStaleSnapshot, upsertTank } from './reconcile';

describe('diffFish', () => {
  it('treats every fish as added on first sight, dead ones included', () => {
    const dead = fishFixture(FISH_2, {
      status: 'dead',
      diedAt: '2026-02-01T00:00:00.000Z',
      cause: 'starvation',
    });
    const diff = diffFish(undefined, [fishFixture(FISH_1), dead]);
    expect(diff.added.map((f) => f.id)).toEqual([FISH_1, FISH_2]);
    expect(diff.died).toEqual([]);
  });

  it('reports a fish that died since the last snapshot, once', () => {
    const alive = fishFixture(FISH_1);
    const dead = {
      ...alive,
      status: 'dead' as const,
      diedAt: '2026-02-01T00:00:00.000Z',
      cause: 'ammonia' as const,
    };
    expect(diffFish([alive], [dead]).died).toEqual([dead]);
    expect(diffFish([dead], [dead]).died).toEqual([]);
  });

  it('reports fish gone from the server, such as one netted on another device', () => {
    const diff = diffFish(
      [fishFixture(FISH_1), fishFixture(FISH_2)],
      [fishFixture(FISH_2), fishFixture(FISH_3)],
    );
    expect(diff.removed.map((f) => f.id)).toEqual([FISH_1]);
    expect(diff.added.map((f) => f.id)).toEqual([FISH_3]);
  });

  it('reports a living fish whose hunger or health changed as updated', () => {
    const before = fishFixture(FISH_1, { hunger: 0.1, health: 1 });
    const hungrier = { ...before, hunger: 0.9 };
    const sicker = { ...before, health: 0.5 };
    expect(diffFish([before], [hungrier]).updated).toEqual([hungrier]);
    expect(diffFish([before], [sicker]).updated).toEqual([sicker]);
  });

  it('reports a living fish whose stage or size alone changed as updated', () => {
    const fry = fishFixture(FISH_1, { stage: 'fry', size: 0.01 });
    const juvenile = { ...fry, stage: 'juvenile' as const };
    const bigger = { ...fry, size: 0.012 };
    expect(diffFish([fry], [juvenile]).updated).toEqual([juvenile]);
    expect(diffFish([fry], [bigger]).updated).toEqual([bigger]);
    expect(diffFish([fry], [fry]).updated).toEqual([]);
  });

  it('does not report a stage change on a fish that died', () => {
    const fry = fishFixture(FISH_1, { stage: 'fry' });
    const dead = {
      ...fry,
      stage: 'juvenile' as const,
      status: 'dead' as const,
      diedAt: '2026-02-01T00:00:00.000Z',
      cause: 'starvation' as const,
    };
    const diff = diffFish([fry], [dead]);
    expect(diff.updated).toEqual([]);
    expect(diff.died).toEqual([dead]);
  });

  it('ignores changes that need no scene action', () => {
    const before = fishFixture(FISH_1);
    const diff = diffFish([before], [{ ...before, name: 'Renamed' }]);
    expect(diff).toEqual({ added: [], removed: [], died: [], updated: [] });
  });

  it('does not report a dying fish as updated', () => {
    const before = fishFixture(FISH_1);
    const diff = diffFish([before], [{ ...before, status: 'dead', health: 0 }]);
    expect(diff.updated).toEqual([]);
  });
});

describe('isStaleSnapshot', () => {
  const held = tankFixture({ lastTickAt: '2026-02-01T12:00:00.000Z' });

  it('refuses a snapshot ticked before the one we hold', () => {
    expect(isStaleSnapshot(held, tankFixture({ lastTickAt: '2026-02-01T11:50:00.000Z' }))).toBe(
      true,
    );
  });

  it('accepts the same or a later tick', () => {
    expect(isStaleSnapshot(held, tankFixture({ lastTickAt: held.lastTickAt }))).toBe(false);
    expect(isStaleSnapshot(held, tankFixture({ lastTickAt: '2026-02-01T12:10:00.000Z' }))).toBe(
      false,
    );
  });

  it('accepts anything for a tank we do not hold', () => {
    expect(isStaleSnapshot(undefined, held)).toBe(false);
    expect(
      isStaleSnapshot(held, tankFixture({ id: TANK_B, lastTickAt: '2020-01-01T00:00:00.000Z' })),
    ).toBe(false);
  });
});

describe('upsertTank', () => {
  it('replaces in place and appends new tanks', () => {
    const a = tankFixture();
    const b = tankFixture({ id: TANK_B, name: 'Second' });
    const renamed = { ...a, name: 'Renamed' };
    expect(upsertTank([a, b], renamed).map((t) => t.name)).toEqual(['Renamed', 'Second']);
    expect(upsertTank([a], b).map((t) => t.name)).toEqual(['Home tank', 'Second']);
  });
});
