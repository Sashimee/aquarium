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
    feed(quality, TARGET, 4, 300, 2400);
    expect(quality.tier).toBe('ultra');
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

  it('keeps a phone that holds the display rate at its tier cap however fast it runs', () => {
    const { quality, announced } = setup({ ...MOBILE_PROFILE, gpuTiming: false });
    expect(quality.tier).toBe('medium');
    quality.start(0);
    const t = feed(quality, TARGET, null, 0, 2400);
    expect(quality.tier).toBe('medium');
    feed(quality, TARGET, null, t, t + 60_000);
    expect(quality.tier).toBe('medium');
    expect(announced).toEqual([{ from: null, to: 'medium', reason: 'probe' }]);
  });

  it('starts a phone stuck at 30 fps on low', () => {
    const { quality } = setup({ ...MOBILE_PROFILE, gpuTiming: false });
    quality.start(0);
    feed(quality, 1000 / 30, null, 0, 2400);
    expect(quality.tier).toBe('low');
  });

  it('caps gpu-timed phones at maxTier', () => {
    const { quality } = setup({ ...MOBILE_PROFILE });
    quality.start(0);
    feed(quality, TARGET, 1, 0, 2400);
    expect(quality.timingSignal).toBe('gpu');
    expect(quality.tier).toBe('medium');
  });

  it('keeps a manual tier above the cap until it runs over budget', () => {
    const { quality, announced } = setup({ ...MOBILE_PROFILE, gpuTiming: false });
    quality.start(0);
    let t = feed(quality, TARGET, null, 0, 2400);
    quality.setTier('ultra', t);
    t = feed(quality, TARGET, null, t, t + 30_000);
    expect(quality.tier).toBe('ultra');
    feed(quality, 50, null, t, t + 15_000);
    expect(announced.slice(2)[0]).toEqual({ from: 'ultra', to: 'low', reason: 'over-budget' });
  });

  it('rejects a probe tier above the tier cap', () => {
    expect(() => setup({ probeTier: 'high', maxTier: 'medium' })).toThrow(/above maxTier/);
  });

  it('holds the probe until the content is ready, then warms up and times the full tank', () => {
    const { quality, announced } = setup({ awaitContent: true });
    quality.start(0);
    feed(quality, TARGET, 4, 0, 5000);
    expect(quality.probing).toBe(true);
    expect(announced).toEqual([]);
    quality.contentReady(5000);
    feed(quality, 200, 200, 5000, 5299);
    expect(quality.probing).toBe(true);
    feed(quality, TARGET, 14, 5300, 7400);
    expect(quality.probing).toBe(false);
    expect(quality.tier).toBe('medium');
    expect(announced).toEqual([{ from: null, to: 'medium', reason: 'probe' }]);
  });

  it('probes at once when the content was ready before start', () => {
    const { quality } = setup({ awaitContent: true });
    quality.contentReady(0);
    quality.start(0);
    feed(quality, TARGET, 14, 0, 2400);
    expect(quality.probing).toBe(false);
    expect(quality.tier).toBe('medium');
  });

  it('probes anyway once the content wait times out', () => {
    const { quality } = setup({ awaitContent: true, contentTimeoutMs: 10_000 });
    quality.start(0);
    const t = feed(quality, TARGET, 14, 0, 9990);
    expect(quality.probing).toBe(true);
    feed(quality, TARGET, 14, t, 12_400);
    expect(quality.probing).toBe(false);
    expect(quality.tier).toBe('medium');
  });

  it('ignores content readiness after the probe has finished', () => {
    const { quality, announced } = setup({ awaitContent: true, contentTimeoutMs: 1000 });
    quality.start(0);
    const t = feed(quality, TARGET, 14, 0, 3400);
    quality.contentReady(t);
    expect(quality.probing).toBe(false);
    expect(announced).toHaveLength(1);
  });

  it('setTier while waiting for content ends the wait and keeps the manual choice', () => {
    const { quality, announced } = setup({ awaitContent: true });
    quality.start(0);
    quality.setTier('low', 100);
    expect(quality.probing).toBe(false);
    quality.contentReady(200);
    feed(quality, TARGET, 4, 200, 3000);
    expect(quality.probing).toBe(false);
    expect(announced).toEqual([{ from: 'high', to: 'low', reason: 'manual' }]);
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
