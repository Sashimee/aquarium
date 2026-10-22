import { newTankChemistry } from '@aquarium/shared';
import { describe, expect, it } from 'vitest';
import {
  AMMONIA_ALERT,
  appendCapped,
  MAX_TIMELINE_ENTRIES,
  type TimelineEntry,
  detectTransitions,
  initialFlags,
  SICK_BELOW_HEALTH,
  type LifecycleFish,
  type LifecycleState,
} from './index.ts';

const fish = (id: string, over: Partial<LifecycleFish> = {}): LifecycleFish => ({
  id,
  species: 'neon-tetra',
  bornAtMs: 0,
  size: 0.03,
  hunger: 0,
  health: 1,
  alive: true,
  diedAtMs: null,
  cause: null,
  sex: 'female',
  stage: 'adult',
  lastBroodAtMs: null,
  disease: null,
  introducedAtMs: null,
  ...over,
});

const tank = (ammonia: number, fishList: LifecycleFish[] = []): LifecycleState => ({
  water: { ammonia, nitrate: 0, algae: 0, tannin: 0, uneatenFood: 0 },
  chemistry: newTankChemistry('freshwater'),
  fish: fishList,
  medicine: null,
});

describe('timeline transitions', () => {
  it('records nothing for a clean tank', () => {
    const state = tank(0, [fish('a')]);
    expect(detectTransitions(state, initialFlags(state), 1).entries).toEqual([]);
  });

  it('records a water alert once on the way up and once on the way down, with hysteresis', () => {
    const high = detectTransitions(tank(AMMONIA_ALERT), initialFlags(tank(0)), 10);
    expect(high.entries).toEqual([
      { kind: 'water_alert', atMs: 10, metric: 'ammonia', state: 'high' },
    ]);
    expect(detectTransitions(tank(AMMONIA_ALERT * 0.9), high.flags, 20).entries).toEqual([]);
    expect(detectTransitions(tank(AMMONIA_ALERT * 0.6), high.flags, 30).entries).toEqual([]);
    expect(detectTransitions(tank(AMMONIA_ALERT * 0.5), high.flags, 40).entries).toEqual([
      { kind: 'water_alert', atMs: 40, metric: 'ammonia', state: 'normal' },
    ]);
  });

  it('does not re-announce a condition that was already present when the window began', () => {
    const state = tank(AMMONIA_ALERT * 2);
    expect(detectTransitions(state, initialFlags(state), 1).entries).toEqual([]);
  });

  it('records a fish falling sick once, not again until it has recovered', () => {
    const ill = tank(0, [fish('a', { health: SICK_BELOW_HEALTH - 0.01 })]);
    const first = detectTransitions(ill, initialFlags(tank(0, [fish('a')])), 10);
    expect(first.entries).toEqual([{ kind: 'sick', atMs: 10, fishId: 'a' }]);
    expect(detectTransitions(ill, first.flags, 20).entries).toEqual([]);
    const better = detectTransitions(tank(0, [fish('a', { health: 0.9 })]), first.flags, 30);
    expect(better.entries).toEqual([]);
    expect(detectTransitions(ill, better.flags, 40).entries).toHaveLength(1);
  });

  it('does not report a dead fish as sick', () => {
    const dead = tank(0, [fish('a', { health: 0, alive: false })]);
    expect(detectTransitions(dead, initialFlags(tank(0, [fish('a')])), 1).entries).toEqual([]);
  });

  it('keeps the normal that closes a recorded high even when the cap is full', () => {
    const timeline: TimelineEntry[] = [];
    const open = new Set<'ammonia' | 'nitrite' | 'algae'>();
    appendCapped(timeline, open, [
      { kind: 'water_alert', atMs: 0, metric: 'ammonia', state: 'high' },
    ]);
    const sick = (i: number): TimelineEntry => ({ kind: 'sick', atMs: i, fishId: `f${i}` });
    appendCapped(
      timeline,
      open,
      Array.from({ length: MAX_TIMELINE_ENTRIES + 10 }, (_, i) => sick(i + 1)),
    );
    expect(timeline).toHaveLength(MAX_TIMELINE_ENTRIES);
    appendCapped(timeline, open, [
      { kind: 'water_alert', atMs: 999, metric: 'ammonia', state: 'normal' },
      { kind: 'water_alert', atMs: 1000, metric: 'nitrite', state: 'normal' },
      sick(1001),
    ]);
    expect(timeline).toHaveLength(MAX_TIMELINE_ENTRIES + 1);
    expect(timeline.at(-1)).toEqual({
      kind: 'water_alert',
      atMs: 999,
      metric: 'ammonia',
      state: 'normal',
    });
  });

  it('drops a high that arrives over the cap, and so its later normal too', () => {
    const timeline: TimelineEntry[] = Array.from({ length: MAX_TIMELINE_ENTRIES }, (_, i) => ({
      kind: 'sick',
      atMs: i,
      fishId: `f${i}`,
    }));
    const open = new Set<'ammonia' | 'nitrite' | 'algae'>();
    appendCapped(timeline, open, [
      { kind: 'water_alert', atMs: 1, metric: 'algae', state: 'high' },
      { kind: 'water_alert', atMs: 2, metric: 'algae', state: 'normal' },
    ]);
    expect(timeline).toHaveLength(MAX_TIMELINE_ENTRIES);
  });
});
