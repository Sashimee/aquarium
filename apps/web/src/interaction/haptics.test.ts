import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../engine/events';
import type { InteractionEvents } from './events';
import { Haptics, HAPTICS_STORAGE_KEY, vibratorOf, type HapticsDeps } from './haptics';

const DROP = { food: 'flakes', portion: 0.5, particles: 4 } as const;

function setup(over: Partial<HapticsDeps> = {}, stored?: string) {
  const vibrate = vi.fn<(pattern: number | number[]) => boolean>(() => true);
  const store = new Map<string, string>(stored ? [[HAPTICS_STORAGE_KEY, stored]] : []);
  let now = 1000;
  const haptics = new Haptics({
    vibrator: { vibrate },
    storage: {
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => void store.set(k, v),
    },
    now: () => now,
    userHasActivated: () => true,
    ...over,
  });
  const bus = new EventBus<InteractionEvents>();
  haptics.attach(bus);
  return {
    haptics,
    vibrate,
    bus,
    store,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('vibratorOf', () => {
  it('detects the API by feature, not by browser', () => {
    expect(vibratorOf({ vibrate: () => true })).not.toBeNull();
    expect(vibratorOf({})).toBeNull();
    expect(vibratorOf({ vibrate: 'nope' })).toBeNull();
    expect(vibratorOf(undefined)).toBeNull();
  });
});

describe('Haptics', () => {
  it('buzzes on glass tap, longer for a harder knock', () => {
    const t = setup();
    t.bus.emit('glass:tapped', { intensity: 0.5 });
    t.advance(500);
    t.bus.emit('glass:tapped', { intensity: 1 });
    const [soft = 0, hard = 0] = t.vibrate.mock.calls.map(([p]) => p as number);
    expect(soft).toBeGreaterThan(0);
    expect(hard).toBeGreaterThan(soft);
  });

  it('buzzes a short pattern when food drops', () => {
    const t = setup();
    t.bus.emit('feed:dropped', DROP);
    expect(t.vibrate).toHaveBeenCalledWith([10, 40, 10]);
  });

  it('buzzes on a net catch but not when a fish was removed elsewhere', () => {
    const t = setup();
    t.bus.emit('tank:fish-removed', { tankId: 't', fishId: 'f1', reason: 'gone' });
    expect(t.vibrate).not.toHaveBeenCalled();
    t.bus.emit('tank:fish-removed', { tankId: 't', fishId: 'f1', reason: 'netted' });
    expect(t.vibrate).toHaveBeenCalledWith([30, 50, 60]);
  });

  it('does nothing where the Vibration API is missing (iOS)', () => {
    const t = setup({ vibrator: null });
    expect(t.haptics.supported).toBe(false);
    t.bus.emit('feed:dropped', DROP);
    expect(t.vibrate).not.toHaveBeenCalled();
  });

  it('stays quiet when switched off and remembers the choice', () => {
    const t = setup();
    t.haptics.setEnabled(false);
    t.bus.emit('feed:dropped', DROP);
    expect(t.vibrate).not.toHaveBeenCalled();
    expect(t.store.get(HAPTICS_STORAGE_KEY)).toBe('off');
    expect(setup({}, 'off').haptics.enabled).toBe(false);
    expect(setup().haptics.enabled).toBe(true);
  });

  it('is silent under reduced motion and resumes when it ends', () => {
    const t = setup();
    t.haptics.setReducedMotion(true);
    expect(t.haptics.active).toBe(false);
    t.bus.emit('feed:dropped', DROP);
    expect(t.vibrate).not.toHaveBeenCalled();
    t.haptics.setReducedMotion(false);
    t.bus.emit('feed:dropped', DROP);
    expect(t.vibrate).toHaveBeenCalledTimes(1);
  });

  it('waits for a user gesture so Chrome does not block the call', () => {
    const t = setup({ userHasActivated: () => false });
    t.bus.emit('feed:dropped', DROP);
    expect(t.vibrate).not.toHaveBeenCalled();
  });

  it('coalesces buzzes that arrive within a few milliseconds', () => {
    const t = setup();
    t.bus.emit('glass:tapped', { intensity: 1 });
    t.bus.emit('feed:dropped', DROP);
    expect(t.vibrate).toHaveBeenCalledTimes(1);
    t.advance(100);
    t.bus.emit('feed:dropped', DROP);
    expect(t.vibrate).toHaveBeenCalledTimes(2);
  });

  it('notifies subscribers of changes and stops listening after detach', () => {
    const t = setup();
    const seen = vi.fn();
    t.haptics.subscribe(seen);
    t.haptics.setEnabled(false);
    t.haptics.setEnabled(true);
    expect(seen).toHaveBeenCalledTimes(2);
    const bus = new EventBus<InteractionEvents>();
    t.haptics.attach(bus)();
    bus.emit('feed:dropped', DROP);
    expect(t.vibrate).not.toHaveBeenCalled();
  });
});
