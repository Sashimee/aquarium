import { describe, expect, it } from 'vitest';
import { DEFAULT_CONTROLLER_CONFIG, TierController, type ControllerConfig } from './controller';
import type { Tier } from './tiers';

const TARGET = 1000 / 60;

function controller(initial: Tier, overrides: Partial<ControllerConfig> = {}): TierController {
  return new TierController(initial, {
    ...DEFAULT_CONTROLLER_CONFIG,
    targetMs: TARGET,
    refreshMs: TARGET,
    signal: 'gpu',
    windowSize: 10,
    cooldownMs: 1000,
    ...overrides,
  });
}

/** Feeds `ms` once per 1/60 s from `startMs` for `durationMs`, returning changes and the end time. */
function run(c: TierController, ms: number, startMs: number, durationMs: number) {
  const changes = [];
  let t = startMs;
  for (; t < startMs + durationMs; t += TARGET) {
    const change = c.sample(ms, t);
    if (change) changes.push({ ...change, at: t });
  }
  return { changes, end: t };
}

function feedUntil(c: TierController, ms: number, startMs: number, tier: Tier): number {
  let t = startMs;
  for (let guard = 0; guard < 100_000; guard++) {
    t += TARGET;
    if (c.sample(ms, t)?.to === tier) return t;
  }
  throw new Error(`controller never reached ${tier}`);
}

describe('TierController', () => {
  it('rejects invalid configuration', () => {
    expect(() => controller('high', { targetMs: 0 })).toThrow(RangeError);
    expect(() => controller('high', { refreshMs: 0 })).toThrow(RangeError);
    expect(() => controller('high', { windowSize: 0 })).toThrow(RangeError);
    expect(() => controller('high', { minTier: 'ultra', maxTier: 'low' })).toThrow(RangeError);
  });

  it('clamps the initial tier into [minTier, maxTier]', () => {
    expect(controller('ultra', { maxTier: 'medium' }).tier).toBe('medium');
    expect(controller('low', { minTier: 'medium' }).tier).toBe('medium');
  });

  it('holds the tier while timing sits between the up and down thresholds', () => {
    const c = controller('high');
    // 15 ms at high predicts 25.5 ms at ultra (no room) yet is under 1.2 x target.
    const { changes } = run(c, 15, 0, 60_000);
    expect(changes).toEqual([]);
    expect(c.tier).toBe('high');
  });

  it('steps down only after the budget is exceeded for the down hold', () => {
    const c = controller('high');
    const { changes } = run(c, 30, 0, 10_000);
    const first = changes[0];
    expect(first).toMatchObject({ from: 'high', to: 'medium', reason: 'over-budget' });
    // Window fills after 10 samples, then the 2 s hold must elapse.
    expect(first?.at).toBeGreaterThanOrEqual(2000);
    expect(first?.at).toBeLessThan(2500);
  });

  it('does not react to a short burst of slow frames', () => {
    const c = controller('high');
    let { end } = run(c, 10, 0, 2000);
    ({ end } = run(c, 40, end, 1500));
    const { changes } = run(c, 10, end, 2000);
    expect(changes.filter((ch) => ch.reason === 'over-budget')).toEqual([]);
    expect(c.tier).toBe('high');
  });

  it('ignores hitches above ignoreAboveMs and non-finite samples', () => {
    const c = controller('high');
    expect(c.sample(1000, 0)).toBeNull();
    expect(c.sample(Number.NaN, 1)).toBeNull();
    expect(c.sample(-5, 2)).toBeNull();
    const { changes } = run(c, 300, 3, 10_000);
    expect(changes).toEqual([]);
    expect(c.tier).toBe('high');
  });

  it('steps up after sustained headroom, which takes longer than stepping down', () => {
    const c = controller('medium');
    const { changes } = run(c, 4, 0, 20_000);
    const first = changes[0];
    expect(first).toMatchObject({ from: 'medium', to: 'high', reason: 'headroom' });
    expect(first?.at).toBeGreaterThanOrEqual(DEFAULT_CONTROLLER_CONFIG.upHoldMs);
  });

  it('predicts the next tier cost from the gpu signal before stepping up', () => {
    const c = controller('high');
    // ultra costs 1.7 x high: 8 ms -> 13.6 ms > 0.8 x 16.7 ms, so no room.
    expect(run(c, 8, 0, 30_000).changes).toEqual([]);
    // 7 ms -> 11.9 ms fits.
    expect(run(c, 7, 30_000, 30_000).changes[0]).toMatchObject({ to: 'ultra' });
  });

  it('steps up on the frame signal only while frames keep up with the target', () => {
    const c = controller('medium', { signal: 'frame' });
    expect(run(c, 20, 0, 20_000).changes).toEqual([]);
    expect(run(c, TARGET, 20_000, 20_000).changes[0]).toMatchObject({ to: 'high' });
  });

  it('does not read a frame rate at the target as headroom when the display runs faster', () => {
    const mobileTarget = 1000 / 36;
    const c = controller('medium', {
      signal: 'frame',
      targetMs: mobileTarget,
      refreshMs: 1000 / 60,
      maxTier: 'ultra',
    });
    expect(run(c, 1000 / 31, 0, 60_000).changes).toEqual([]);
    expect(c.tier).toBe('medium');
    expect(run(c, 1000 / 60, 60_000, 20_000).changes[0]).toMatchObject({ to: 'high' });
  });

  it('steps a 30 fps budget device down once it falls under 30 fps', () => {
    const c = controller('medium', {
      signal: 'frame',
      targetMs: 1000 / 36,
      refreshMs: 1000 / 60,
    });
    expect(run(c, 1000 / 32, 0, 10_000).changes).toEqual([]);
    expect(run(c, 1000 / 27, 10_000, 10_000).changes[0]).toMatchObject({
      from: 'medium',
      to: 'low',
      reason: 'over-budget',
    });
  });

  it('ignores samples during the cooldown after a change', () => {
    const c = controller('high', { cooldownMs: 5000 });
    const { changes } = run(c, 40, 0, 12_000);
    expect(changes.map((ch) => ch.to)).toEqual(['medium', 'low']);
    const gap = (changes[1]?.at ?? 0) - (changes[0]?.at ?? 0);
    expect(gap).toBeGreaterThanOrEqual(5000);
  });

  it('never goes below minTier or above maxTier', () => {
    const slow = controller('medium', { minTier: 'medium' });
    expect(run(slow, 100, 0, 30_000).changes).toEqual([]);
    const fast = controller('high', { maxTier: 'high' });
    expect(run(fast, 1, 0, 60_000).changes).toEqual([]);
  });

  it('doubles the hold for a tier that failed during probation', () => {
    const c = controller('medium', { minTier: 'medium' });
    const base = c.upHoldFor('high');
    let { changes, end } = run(c, 4, 0, 10_000);
    expect(changes[0]).toMatchObject({ to: 'high' });
    // High turns out to be too heavy.
    ({ changes, end } = run(c, 30, end, 6000));
    expect(changes[0]).toMatchObject({ from: 'high', to: 'medium' });
    expect(c.upHoldFor('high')).toBe(base * 2);

    // The retry now needs the longer hold.
    const retry = run(c, 4, end, 30_000).changes[0];
    expect(retry).toMatchObject({ to: 'high' });
    expect((retry?.at ?? 0) - end).toBeGreaterThanOrEqual(base * 2);
  });

  it('caps the backoff at maxUpHoldMs', () => {
    const c = controller('medium', { minTier: 'medium', maxTier: 'high', maxUpHoldMs: 40_000 });
    let t = 0;
    const holds: number[] = [];
    for (let i = 0; i < 4; i++) {
      t = feedUntil(c, 4, t, 'high');
      t = feedUntil(c, 30, t, 'medium');
      holds.push(c.upHoldFor('high'));
    }
    expect(holds).toEqual([16_000, 32_000, 40_000, 40_000]);
  });

  it('does not penalise a step down long after the upgrade', () => {
    const c = controller('medium', { minTier: 'medium', probationMs: 5000 });
    let { end } = run(c, 4, 0, 10_000);
    expect(c.tier).toBe('high');
    ({ end } = run(c, 10, end, 10_000));
    run(c, 30, end, 6000);
    expect(c.tier).toBe('medium');
    expect(c.upHoldFor('high')).toBe(DEFAULT_CONTROLLER_CONFIG.upHoldMs);
  });

  it('reset() applies a manual tier and restarts measurement', () => {
    const c = controller('high');
    run(c, 30, 0, 1900);
    c.reset('low', 1900);
    expect(c.tier).toBe('low');
    expect(run(c, 30, 1900, 2000).changes).toEqual([]);
  });
});
