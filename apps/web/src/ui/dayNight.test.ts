import { describe, expect, it } from 'vitest';
import {
  DAY_NIGHT_KEY,
  clockFor,
  initialMode,
  nextMode,
  readMode,
  engineOptionsFor,
  writeMode,
  type DayNightMode,
} from './dayNight';

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const data = new Map(Object.entries(initial));
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => void data.delete(key),
    setItem: (key, value) => void data.set(key, value),
  };
}

const denied = (): Storage => {
  throw new DOMException('denied', 'SecurityError');
};

const throwing: Storage = {
  ...memoryStorage(),
  getItem: () => {
    throw new Error('read failed');
  },
  setItem: () => {
    throw new Error('quota');
  },
};

describe('nextMode', () => {
  it('cycles auto, day, night and back to auto', () => {
    const seen: DayNightMode[] = ['auto'];
    for (let i = 0; i < 3; i++) seen.push(nextMode(seen[i] ?? 'auto'));
    expect(seen).toEqual(['auto', 'day', 'night', 'auto']);
  });
});

describe('clockFor', () => {
  it('follows local time for auto and leaves day and night to the lamp schedule', () => {
    expect(clockFor('auto')).toBeNull();
    expect(clockFor('day')).toBe('day');
    expect(clockFor('night')).toBe('night');
  });
});

describe('persistence', () => {
  it('reads back what was written', () => {
    const store = memoryStorage();
    expect(writeMode('night', () => store)).toBe(true);
    expect(store.getItem(DAY_NIGHT_KEY)).toBe('night');
    expect(readMode(() => store)).toBe('night');
  });

  it('defaults to auto when nothing or something unknown is saved', () => {
    expect(readMode(() => memoryStorage())).toBe('auto');
    expect(readMode(() => memoryStorage({ [DAY_NIGHT_KEY]: 'dusk' }))).toBe('auto');
  });

  it('still works when storage is unavailable or throws', () => {
    expect(readMode(denied)).toBe('auto');
    expect(writeMode('day', denied)).toBe(false);
    expect(readMode(() => throwing)).toBe('auto');
    expect(writeMode('day', () => throwing)).toBe(false);
    expect(readMode(() => null)).toBe('auto');
    expect(writeMode('day', () => null)).toBe(false);
  });
});

describe('?clock= precedence', () => {
  const saved = () => memoryStorage({ [DAY_NIGHT_KEY]: 'night' });

  it('uses the saved mode without the param', () => {
    expect(initialMode('', saved)).toBe('night');
    expect(engineOptionsFor('', saved).clock).toBe('night');
    expect(engineOptionsFor('', () => memoryStorage()).clock).toBeNull();
  });

  it('lets the param beat the saved mode', () => {
    expect(initialMode('?clock=day', saved)).toBe('day');
    expect(initialMode('?clock=13:00', saved)).toBe('day');
    expect(initialMode('?clock=night', () => memoryStorage({ [DAY_NIGHT_KEY]: 'day' }))).toBe(
      'night',
    );
    expect(engineOptionsFor('?clock=day', saved).clock).toBe(13 * 60);
  });

  it('keeps the button usable on a bad param, while the engine options reject it', () => {
    expect(initialMode('?clock=soon', saved)).toBe('night');
    expect(() => engineOptionsFor('?clock=soon', saved)).toThrow(/clock/i);
  });
});
