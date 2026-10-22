import { describe, expect, it } from 'vitest';
import { EventBus, type EngineEvents } from '../events';
import { QualityManager, type QualityOptions } from './QualityManager';
import { MOBILE_PROFILE } from './profile';
import { TIER_SETTINGS, type Tier } from './tiers';

const TARGET = 1000 / 60;

function setup(options: Partial<QualityOptions> = {}) {
  const events = new EventBus<EngineEvents>();
  const announced: EngineEvents['quality:tier-changed'][] = [];
  events.on('quality:tier-changed', (e) => announced.push(e));
  const quality = new QualityManager(events, {
    gpuTiming: true,
    pinned: null,
    adaptive: true,
    targetMs: TARGET,
    probeMs: 2000,
    warmupMs: 300,
    ...options,
  });
  const applied: Tier[] = [];
  quality.register('recorder', (_s, tier) => applied.push(tier));
  return { quality, announced, applied };
}

function feed(q: QualityManager, frameMs: number, gpuMs: number | null, from: number, to: number) {
  let t = from;
  for (; t <= to; t += TARGET) q.sample(frameMs, gpuMs, t);
  return t;
}

describe('QualityManager', () => {
  it('applies the current tier to a feature on registration', () => {
    const { applied } = setup();
    expect(applied).toEqual(['high']);
  });

  it('rejects duplicate feature names and allows unregistering', () => {
    const { quality } = setup();
    expect(() => quality.register('recorder', () => undefined)).toThrow(/already registered/);
    const off = quality.register('other', () => undefined);
    expect(quality.featureNames()).toEqual(['recorder', 'other']);
    off();
    expect(quality.featureNames()).toEqual(['recorder']);
  });

  it('applies a tier change to the features in the order they registered', () => {
    const { quality } = setup();
    const order: string[] = [];
    quality.register('effects', () => order.push('effects'));
    quality.register('fish', () => order.push('fish'));
    order.length = 0;
    quality.setTier('ultra', 0);
    expect(order).toEqual(['effects', 'fish']);
  });

  it('does not keep a feature whose first application throws', () => {
    const { quality } = setup();
    const broken = new Error('shader build failed');
    expect(() =>
      quality.register('broken', () => {
        throw broken;
      }),
    ).toThrow(broken);
    expect(quality.featureNames()).toEqual(['recorder']);
    expect(() => quality.register('broken', () => undefined)).not.toThrow();
  });

  it('pins the tier without probing or adapting', () => {
    const { quality, announced, applied } = setup({ pinned: 'low', adaptive: false });
    quality.start(0);
    expect(quality.probing).toBe(false);
    expect(announced).toEqual([{ from: null, to: 'low', reason: 'override' }]);
    feed(quality, 100, 100, 0, 30_000);
    expect(quality.tier).toBe('low');
    expect(applied).toEqual(['low']);
  });

  it('probes for the configured time after the warm-up, then picks a tier from gpu timings', () => {
    const { quality, announced, applied } = setup();
    quality.start(0);
    expect(quality.probing).toBe(true);
    feed(quality, TARGET, 14, 0, 2200);
    expect(quality.probing).toBe(true);
    feed(quality, TARGET, 14, 2201, 2400);
    expect(quality.probing).toBe(false);
    expect(quality.timingSignal).toBe('gpu');
    expect(quality.tier).toBe('medium');
    expect(applied).toEqual(['high', 'medium']);
    expect(announced).toEqual([{ from: null, to: 'medium', reason: 'probe' }]);
  });

  it('discards warm-up frames, which include pipeline compiles', () => {
    const { quality } = setup();
    quality.start(0);
    feed(quality, 200, 200, 0, 299);
    feed(quality, TARGET, 3, 300, 2400);
    expect(quality.tier).toBe('ultra');
  });

  it('keeps a desktop on high when its gpu would run ultra over half the frame', () => {
    const { quality } = setup();
    quality.start(0);
    feed(quality, TARGET, 6, 0, 2400);
    expect(quality.tier).toBe('high');
    feed(quality, TARGET, 6, 2400, 120_000);
    expect(quality.tier).toBe('high');
  });

  it('never climbs to ultra on frame intervals alone, however well they keep up', () => {
    const { quality, announced } = setup({ gpuTiming: false });
    quality.start(0);
    feed(quality, TARGET, null, 0, 120_000);
    expect(quality.timingSignal).toBe('frame');
    expect(quality.tier).toBe('high');
    expect(announced).toEqual([{ from: null, to: 'high', reason: 'probe' }]);
  });

  it('falls back to frame intervals when the gpu cannot be timed', () => {
    const { quality } = setup();
    quality.start(0);
    feed(quality, 1000 / 30, null, 0, 2400);
    expect(quality.timingSignal).toBe('frame');
    expect(quality.tier).toBe('low');
  });

  it('uses gpu timing on a GPU-bound device whose timestamps arrive every third frame', () => {
    const { quality } = setup();
    quality.start(0);
    let frame = 0;
    for (let t = 0; t <= 2400; t += 50) {
      quality.sample(50, frame++ % 3 === 0 ? 14 : null, t);
    }
    expect(quality.timingSignal).toBe('gpu');
    expect(quality.tier).toBe('medium');
  });

  it('needs a minimum number of gpu samples before trusting them', () => {
    const { quality } = setup({ minGpuSamples: 50 });
    quality.start(0);
    let frame = 0;
    for (let t = 0; t <= 2400; t += TARGET) {
      quality.sample(1000 / 30, frame++ % 3 === 0 ? 5 : null, t);
    }
    expect(quality.timingSignal).toBe('frame');
    expect(quality.tier).toBe('low');
  });

  it('ignores gpu samples when the backend reports no timer support', () => {
    const { quality } = setup({ gpuTiming: false });
    quality.start(0);
    feed(quality, 1000 / 30, 5, 0, 2400);
    expect(quality.timingSignal).toBe('frame');
    expect(quality.tier).toBe('low');
  });

  it('adapts after the probe and announces each step', () => {
    const { quality, announced } = setup();
    quality.start(0);
    const t = feed(quality, TARGET, 12, 0, 2400);
    expect(quality.tier).toBe('high');
    feed(quality, 40, 30, t, t + 15_000);
    expect(quality.tier).toBe('low');
    expect(announced.slice(1)).toEqual([
      { from: 'high', to: 'medium', reason: 'over-budget' },
      { from: 'medium', to: 'low', reason: 'over-budget' },
    ]);
  });

  it('does not adapt when adaptive is off', () => {
    const { quality } = setup({ adaptive: false });
    quality.start(0);
    const t = feed(quality, TARGET, 12, 0, 2400);
    feed(quality, 40, 30, t, t + 30_000);
    expect(quality.tier).toBe('high');
    expect(quality.adaptive).toBe(false);
  });

  it('setTier during the probe ends it and applies the manual choice', () => {
    const { quality, announced } = setup();
    quality.start(0);
    feed(quality, TARGET, 5, 0, 1000);
    quality.setTier('low', 1000);
    expect(quality.probing).toBe(false);
    expect(quality.tier).toBe('low');
    expect(quality.settings).toBe(TIER_SETTINGS.low);
    expect(announced).toEqual([{ from: 'high', to: 'low', reason: 'manual' }]);
  });

  it('climbs a phone that holds the display rate on medium to high, and no further', () => {
    const { quality, announced } = setup({ ...MOBILE_PROFILE, gpuTiming: false });
    expect(quality.tier).toBe('medium');
    quality.start(0);
    const t = feed(quality, TARGET, null, 0, 2400);
    expect(quality.tier).toBe('medium');
    feed(quality, TARGET, null, t, t + 60_000);
    expect(quality.tier).toBe('high');
    expect(announced).toEqual([
      { from: null, to: 'medium', reason: 'probe' },
      { from: 'medium', to: 'high', reason: 'headroom' },
    ]);
  });

  it('keeps a phone on high while it holds 30 fps there', () => {
    const { quality } = setup({ ...MOBILE_PROFILE, gpuTiming: false });
    quality.start(0);
    let t = feed(quality, TARGET, null, 0, 2400);
    t = feed(quality, TARGET, null, t, t + 20_000);
    expect(quality.tier).toBe('high');
    feed(quality, 1000 / 32, null, t, t + 30_000);
    expect(quality.tier).toBe('high');
  });

  it('steps a phone on high down once it falls under 30 fps', () => {
    const { quality, announced } = setup({ ...MOBILE_PROFILE, gpuTiming: false });
    quality.start(0);
    let t = feed(quality, TARGET, null, 0, 2400);
    t = feed(quality, TARGET, null, t, t + 20_000);
    expect(quality.tier).toBe('high');
    feed(quality, 1000 / 25, null, t, t + 8000);
    expect(announced.at(-1)).toEqual(
      expect.objectContaining({ from: 'high', to: 'medium', reason: 'over-budget' }),
    );
  });

  it('starts a phone stuck at 30 fps on low', () => {
    const { quality } = setup({ ...MOBILE_PROFILE, gpuTiming: false });
    quality.start(0);
    feed(quality, 1000 / 30, null, 0, 2400);
    expect(quality.tier).toBe('low');
  });

  it('adapts a phone on frame time even when its timestamps read over budget', () => {
    const { quality } = setup({ ...MOBILE_PROFILE });
    quality.start(0);
    const t = feed(quality, TARGET, 45, 0, 2400);
    expect(quality.timingSignal).toBe('frame');
    expect(quality.tier).toBe('medium');
    feed(quality, TARGET, 45, t, t + 60_000);
    expect(quality.tier).toBe('high');
  });

  it('distrusts gpu timestamps that add up to more than the frame interval', () => {
    const { quality } = setup();
    quality.start(0);
    feed(quality, TARGET, 40, 0, 2400);
    expect(quality.timingSignal).toBe('frame');
    expect(quality.tier).toBe('high');
  });

  it('keeps a manual tier above the cap until it runs over budget', () => {
    const { quality, announced } = setup({ ...MOBILE_PROFILE, gpuTiming: false });
    quality.start(0);
    let t = feed(quality, TARGET, null, 0, 2400);
    quality.setTier('ultra', t);
    t = feed(quality, TARGET, null, t, t + 30_000);
    expect(quality.tier).toBe('ultra');
    feed(quality, 50, null, t, t + 15_000);
    expect(announced.slice(2)[0]).toEqual({ from: 'ultra', to: 'medium', reason: 'over-budget' });
  });

  it('rejects a probe tier above the tier cap', () => {
    expect(() => setup({ probeTier: 'high', maxTier: 'medium' })).toThrow(/above maxTier/);
  });

  it('times the empty tank first, then corrects the tier once the content is in', () => {
    const { quality, announced, applied } = setup({ awaitContent: true });
    quality.start(0);
    feed(quality, TARGET, 4, 0, 2400);
    expect(quality.probing).toBe(true);
    expect(quality.tier).toBe('high');
    expect(announced).toEqual([{ from: null, to: 'high', reason: 'probe' }]);
    feed(quality, TARGET, 4, 2401, 5000);
    quality.contentReady(5000);
    feed(quality, 200, 200, 5000, 5299);
    expect(quality.probing).toBe(true);
    feed(quality, TARGET, 14, 5300, 7400);
    expect(quality.probing).toBe(false);
    expect(quality.tier).toBe('medium');
    expect(applied).toEqual(['high', 'medium']);
    expect(announced).toEqual([
      { from: null, to: 'high', reason: 'probe' },
      { from: 'high', to: 'medium', reason: 'probe' },
    ]);
  });

  it('settles a slow device on its tier before the content is built, and keeps it', () => {
    const { quality, announced, applied } = setup({ awaitContent: true });
    quality.start(0);
    const t = feed(quality, 200, null, 0, 2400);
    expect(quality.tier).toBe('low');
    expect(announced).toEqual([{ from: null, to: 'low', reason: 'probe' }]);
    quality.contentReady(t);
    feed(quality, 400, null, t, t + 2400);
    expect(quality.probing).toBe(false);
    expect(quality.tier).toBe('low');
    expect(applied).toEqual(['high', 'low']);
    expect(announced).toHaveLength(1);
  });

  it('never raises the tier from the empty tank, but may from the full one', () => {
    const { quality, announced } = setup({ awaitContent: true });
    quality.start(0);
    const t = feed(quality, TARGET, 2, 0, 2400);
    expect(quality.tier).toBe('high');
    quality.contentReady(t);
    feed(quality, TARGET, 3, t, t + 2400);
    expect(quality.tier).toBe('ultra');
    expect(announced.at(-1)).toEqual({ from: 'high', to: 'ultra', reason: 'probe' });
  });

  it('times the content straight after the empty tank when it arrived meanwhile', () => {
    const { quality, announced } = setup({ awaitContent: true });
    quality.start(0);
    const t = feed(quality, TARGET, 4, 0, 1000);
    quality.contentReady(t);
    feed(quality, TARGET, 4, t, 2400);
    expect(quality.probing).toBe(true);
    feed(quality, TARGET, 14, 2401, 4800);
    expect(quality.probing).toBe(false);
    expect(announced.map((e) => e.to)).toEqual(['high', 'medium']);
  });

  it('probes once at the probe tier when the content was ready before start', () => {
    const { quality, announced } = setup({ awaitContent: true });
    quality.contentReady(0);
    quality.start(0);
    feed(quality, TARGET, 14, 0, 2400);
    expect(quality.probing).toBe(false);
    expect(quality.tier).toBe('medium');
    expect(announced).toEqual([{ from: null, to: 'medium', reason: 'probe' }]);
  });

  it('probes the content anyway once the wait for it times out', () => {
    const { quality } = setup({ awaitContent: true, contentTimeoutMs: 10_000 });
    quality.start(0);
    const t = feed(quality, TARGET, 4, 0, 9_900);
    expect(quality.probing).toBe(true);
    feed(quality, TARGET, 14, t, 12_400);
    expect(quality.probing).toBe(false);
    expect(quality.tier).toBe('medium');
  });

  it('counts the wait for content from start, not from the end of the empty-tank probe', () => {
    const { quality } = setup({ awaitContent: true, contentTimeoutMs: 3000 });
    quality.start(0);
    const t = feed(quality, TARGET, 4, 0, 2900);
    expect(quality.probing).toBe(true);
    feed(quality, TARGET, 14, t, 5400);
    expect(quality.probing).toBe(false);
    expect(quality.tier).toBe('medium');
  });

  it('probes the content straight away when the wait ran out during the empty-tank probe', () => {
    const { quality } = setup({ awaitContent: true, contentTimeoutMs: 1000 });
    quality.start(0);
    const t = feed(quality, TARGET, 4, 0, 2350);
    expect(quality.tier).toBe('high');
    feed(quality, TARGET, 14, t, 4700);
    expect(quality.probing).toBe(false);
    expect(quality.tier).toBe('medium');
  });

  it('leaves climbing back from a slow empty-tank probe to the controller on frame timing', () => {
    const { quality, announced } = setup({ awaitContent: true, gpuTiming: false });
    quality.start(0);
    let t = feed(quality, 1.5 * TARGET, null, 0, 2400);
    expect(quality.tier).toBe('medium');
    quality.contentReady(t);
    t = feed(quality, TARGET, null, t, t + 2400);
    expect(quality.probing).toBe(false);
    expect(quality.tier).toBe('medium');
    feed(quality, TARGET, null, t, t + 14_000);
    expect(quality.tier).toBe('high');
    expect(announced.at(-1)).toEqual({ from: 'medium', to: 'high', reason: 'headroom' });
  });

  it('ignores content readiness after the probes have finished', () => {
    const { quality, announced } = setup({ awaitContent: true, contentTimeoutMs: 1000 });
    quality.start(0);
    const t = feed(quality, TARGET, 3, 0, 6000);
    expect(quality.probing).toBe(false);
    quality.contentReady(t);
    expect(quality.probing).toBe(false);
    expect(announced.map((e) => e.to)).toEqual(['high', 'ultra']);
  });

  it('setTier during the empty-tank probe ends probing and keeps the manual choice', () => {
    const { quality, announced } = setup({ awaitContent: true });
    quality.start(0);
    quality.setTier('low', 100);
    expect(quality.probing).toBe(false);
    quality.contentReady(200);
    feed(quality, TARGET, 4, 200, 3000);
    expect(quality.probing).toBe(false);
    expect(announced).toEqual([{ from: 'high', to: 'low', reason: 'manual' }]);
  });

  it('setTier while waiting for content ends the wait and keeps the manual choice', () => {
    const { quality, announced } = setup({ awaitContent: true });
    quality.start(0);
    const t = feed(quality, TARGET, 4, 0, 2400);
    quality.setTier('medium', t);
    expect(quality.probing).toBe(false);
    quality.contentReady(t);
    feed(quality, TARGET, 1, t, t + 3000);
    expect(quality.tier).toBe('medium');
    expect(announced.at(-1)).toEqual({ from: 'high', to: 'medium', reason: 'manual' });
  });

  it('pins the tier without waiting for content', () => {
    const { quality, announced } = setup({ pinned: 'low', awaitContent: true });
    quality.start(0);
    expect(quality.probing).toBe(false);
    expect(announced).toEqual([{ from: null, to: 'low', reason: 'override' }]);
  });

  it('cannot be started twice', () => {
    const { quality } = setup();
    quality.start(0);
    expect(() => quality.start(1)).toThrow(/already started/);
  });
});
