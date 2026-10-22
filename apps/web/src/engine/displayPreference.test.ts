import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_DISPLAY_CHOICE,
  DISPLAY_STORAGE_KEY,
  DisplayPreference,
  type DisplayStorage,
  displayLimits,
  parseDisplayChoice,
} from './displayPreference';
import { DESKTOP_PROFILE, MOBILE_PROFILE } from './quality/profile';

class MemoryStorage implements DisplayStorage {
  readonly items = new Map<string, string>();
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
}

describe('parseDisplayChoice', () => {
  it('reads a stored choice', () => {
    expect(parseDisplayChoice('{"frameRate":"display","pixelRatio":"device"}')).toEqual({
      frameRate: 'display',
      pixelRatio: 'device',
    });
  });

  it('falls back to the capped default for missing, broken or foreign data', () => {
    for (const stored of [null, undefined, '', 'not json', '42', 'null', '[]']) {
      expect(parseDisplayChoice(stored)).toEqual(DEFAULT_DISPLAY_CHOICE);
    }
  });

  it('keeps the valid half of a partly unknown choice', () => {
    expect(parseDisplayChoice('{"frameRate":"display","pixelRatio":"8k"}')).toEqual({
      frameRate: 'display',
      pixelRatio: 'capped',
    });
    expect(parseDisplayChoice('{"frameRate":144}')).toEqual(DEFAULT_DISPLAY_CHOICE);
  });
});

describe('DisplayPreference', () => {
  it('starts from what was stored', () => {
    const storage = new MemoryStorage();
    storage.setItem(DISPLAY_STORAGE_KEY, '{"frameRate":"display"}');
    expect(new DisplayPreference(storage).snapshot()).toEqual({
      frameRate: 'display',
      pixelRatio: 'capped',
    });
  });

  it('saves a change and tells subscribers, once per actual change', () => {
    const storage = new MemoryStorage();
    const preference = new DisplayPreference(storage);
    const listener = vi.fn();
    preference.subscribe(listener);

    preference.set({ pixelRatio: 'device' });
    expect(preference.snapshot()).toEqual({ frameRate: 'capped', pixelRatio: 'device' });
    expect(parseDisplayChoice(storage.getItem(DISPLAY_STORAGE_KEY))).toEqual(preference.snapshot());
    expect(listener).toHaveBeenCalledOnce();

    preference.set({ pixelRatio: 'device' });
    expect(listener).toHaveBeenCalledOnce();
  });

  it('stops notifying after unsubscribe', () => {
    const preference = new DisplayPreference(new MemoryStorage());
    const listener = vi.fn();
    preference.subscribe(listener)();
    preference.set({ frameRate: 'display' });
    expect(listener).not.toHaveBeenCalled();
  });

  it('rejects unknown choices without changing anything', () => {
    const preference = new DisplayPreference(new MemoryStorage());
    const listener = vi.fn();
    preference.subscribe(listener);
    expect(() => preference.set(JSON.parse('{"frameRate":"144"}') as object)).toThrow(RangeError);
    expect(() => preference.set(JSON.parse('{"pixelRatio":3}') as object)).toThrow(RangeError);
    expect(preference.snapshot()).toEqual(DEFAULT_DISPLAY_CHOICE);
    expect(listener).not.toHaveBeenCalled();
  });

  it('keeps working for the session when storage is blocked', () => {
    const blocked: DisplayStorage = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    const preference = new DisplayPreference(blocked);
    expect(preference.snapshot()).toEqual(DEFAULT_DISPLAY_CHOICE);
    preference.set({ frameRate: 'display' });
    expect(preference.snapshot().frameRate).toBe('display');
  });

  it('works without storage at all', () => {
    const preference = new DisplayPreference(null);
    preference.set({ frameRate: 'display' });
    expect(preference.snapshot().frameRate).toBe('display');
  });
});

describe('displayLimits', () => {
  it('keeps the device class limits by default', () => {
    expect(displayLimits(DESKTOP_PROFILE, DEFAULT_DISPLAY_CHOICE)).toEqual({
      frameCapFps: 60,
      pixelRatioCeiling: 1.5,
    });
  });

  it('lifts the frame cap and the ceiling independently on opt-in', () => {
    expect(displayLimits(DESKTOP_PROFILE, { frameRate: 'display', pixelRatio: 'capped' })).toEqual({
      frameCapFps: null,
      pixelRatioCeiling: 1.5,
    });
    expect(displayLimits(DESKTOP_PROFILE, { frameRate: 'capped', pixelRatio: 'device' })).toEqual({
      frameCapFps: 60,
      pixelRatioCeiling: Number.POSITIVE_INFINITY,
    });
  });

  it('leaves phones uncapped whatever is chosen', () => {
    expect(displayLimits(MOBILE_PROFILE, DEFAULT_DISPLAY_CHOICE)).toEqual({
      frameCapFps: null,
      pixelRatioCeiling: Number.POSITIVE_INFINITY,
    });
  });
});
