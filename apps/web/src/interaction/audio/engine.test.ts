import { describe, expect, it, vi, type Mock } from 'vitest';
import { EventBus } from '../../engine/events';
import type { InteractionEvents } from '../events';
import {
  AUDIO_STORAGE_KEY,
  AudioEngine,
  type AudioDeps,
  type BufferLike,
  type CompressorLike,
  type ContextLike,
  type FilterLike,
  type GainLike,
  type ParamLike,
  type SourceLike,
} from './engine';
import { parseSoundCatalog } from './catalog';

interface FakeParam extends ParamLike {
  target: number;
}

interface FakeNode {
  connections: unknown[];
  connect(d: unknown): unknown;
  disconnect(): void;
}

type FakeGain = GainLike & FakeNode & { gain: FakeParam };
type FakeFilter = FilterLike & FakeNode & { frequency: FakeParam };
type FakeCompressor = CompressorLike & FakeNode & { threshold: FakeParam; ratio: FakeParam };

function at<T>(list: readonly T[], i: number): T {
  const item = list[i];
  if (item === undefined) throw new Error(`no node at ${i}`);
  return item;
}

function param(): FakeParam {
  const p = {
    value: 0,
    target: 0,
    setTargetAtTime(target: number) {
      p.target = target;
      p.value = target;
    },
  };
  return p;
}

function node(): FakeNode {
  const connections: unknown[] = [];
  return { connections, connect: (d: unknown) => connections.push(d), disconnect: vi.fn() };
}

const INDEX = {
  assets: [
    { id: 'angelfish', kind: 'fish' },
    audioAsset('filter-hum', 'filter-hum', true, 576000),
    audioAsset('underwater-bed', 'underwater-ambience', true, 768000),
    audioAsset('air-bubbles', 'air-bubbles', true, 391958),
    audioAsset('glass-tap', 'glass-tap', false, 11305),
  ],
};

function audioAsset(id: string, role: string, loop: boolean, frames: number) {
  return {
    id,
    kind: 'audio',
    audio: { role, loop, frames, sampleRate: 48000, file: `audio/${id}/${id}.m4a` },
  };
}

function setup(over: Partial<AudioDeps> = {}, index: unknown = INDEX, stored?: string) {
  const gains: FakeGain[] = [];
  const sources: (SourceLike & { start: Mock<(when?: number) => void> })[] = [];
  const filters: FakeFilter[] = [];
  const compressors: FakeCompressor[] = [];
  const state = { value: 'suspended' };
  const ctx: ContextLike = {
    currentTime: 0,
    get state() {
      return state.value;
    },
    destination: node(),
    resume: vi.fn(async () => {
      state.value = 'running';
    }),
    suspend: vi.fn(async () => {
      state.value = 'suspended';
    }),
    close: vi.fn(async () => {
      state.value = 'closed';
    }),
    decodeAudioData: vi.fn(async (): Promise<BufferLike> => ({ duration: 100 })),
    createGain: () => {
      const g = { ...node(), gain: param() };
      gains.push(g);
      return g;
    },
    createBiquadFilter: () => {
      const f = { ...node(), type: '', frequency: param() };
      filters.push(f);
      return f;
    },
    createDynamicsCompressor: () => {
      const c = { ...node(), threshold: param(), ratio: param() };
      compressors.push(c);
      return c;
    },
    createBufferSource: () => {
      const s = {
        ...node(),
        buffer: null,
        loop: false,
        loopStart: 0,
        loopEnd: 0,
        start: vi.fn(),
        stop: vi.fn(),
      };
      sources.push(s);
      return s;
    },
  };
  const store = new Map<string, string>(stored ? [[AUDIO_STORAGE_KEY, stored]] : []);
  let hidden = false;
  let gesture: (() => void) | null = null;
  let visibility: (() => void) | null = null;
  const warn = vi.fn();
  const deps: AudioDeps = {
    createContext: () => ctx,
    fetchBytes: vi.fn(async () => new ArrayBuffer(8)),
    fetchIndex: async () => index,
    assetRoot: '/assets/',
    storage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v) },
    isHidden: () => hidden,
    onVisibility: (l) => {
      visibility = l;
      return () => {
        visibility = null;
      };
    },
    onGesture: (l) => {
      gesture = l;
      return () => {
        gesture = null;
      };
    },
    defer: (work) => queueMicrotask(work),
    random: () => 0,
    warn,
    ...over,
  };
  const engine = new AudioEngine(deps);
  const bus = new EventBus<InteractionEvents>();
  engine.attach(bus);
  engine.start();
  return {
    engine,
    bus,
    ctx,
    deps,
    store,
    warn,
    gains,
    sources,
    filters,
    compressors,
    state,
    gesture: async () => {
      gesture?.();
      await new Promise((r) => setTimeout(r, 0));
    },
    hasGestureListener: () => gesture !== null,
    setHidden: (value: boolean) => {
      hidden = value;
      visibility?.();
    },
  };
}

describe('parseSoundCatalog', () => {
  it('groups by role, not id, and ignores other kinds', () => {
    const catalog = parseSoundCatalog(INDEX, '/a/');
    expect(catalog.get('underwater-ambience')?.[0]?.id).toBe('underwater-bed');
    expect(catalog.has('underwater-bed')).toBe(false);
    expect(catalog.get('glass-tap')?.[0]?.url).toBe('/a/audio/glass-tap/glass-tap.m4a');
    expect(catalog.has('angelfish')).toBe(false);
  });

  it('names the broken field', () => {
    const bad = { assets: [{ id: 'x', kind: 'audio', audio: { role: 'r' } }] };
    expect(() => parseSoundCatalog(bad, '/a/')).toThrow(/assets\[0\]\.audio\.file/);
  });
});

describe('AudioEngine unlock', () => {
  it('stays silent and creates nothing before a gesture', () => {
    const t = setup();
    expect(t.engine.status).toBe('locked');
    expect(t.sources).toHaveLength(0);
    expect(t.ctx.resume).not.toHaveBeenCalled();
    expect(t.hasGestureListener()).toBe(true);
  });

  it('resumes on the first gesture, starts the loops and drops the listener', async () => {
    const t = setup();
    await t.gesture();
    expect(t.engine.status).toBe('running');
    expect(t.ctx.resume).toHaveBeenCalledTimes(1);
    expect(t.hasGestureListener()).toBe(false);
    const loops = t.sources.filter((s) => s.loop);
    expect(loops).toHaveLength(3);
    expect(loops.every((s) => s.start.mock.calls.length === 1)).toBe(true);
  });

  it('loops exactly the pipeline frame count', async () => {
    const t = setup();
    await t.gesture();
    const loopEnds = t.sources.filter((s) => s.loop).map((s) => s.loopEnd);
    expect(loopEnds).toContain(576000 / 48000);
    expect(loopEnds).toContain(768000 / 48000);
  });

  it('unlocks on a later gesture when the first resume never settles', async () => {
    const t = setup();
    vi.mocked(t.ctx.resume).mockImplementationOnce(() => new Promise<void>(() => {}));
    await t.gesture();
    expect(t.engine.status).toBe('locked');
    expect(t.hasGestureListener()).toBe(true);
    await t.gesture();
    expect(t.ctx.resume).toHaveBeenCalledTimes(2);
    expect(t.engine.status).toBe('running');
    expect(t.sources.filter((s) => s.loop)).toHaveLength(3);
  });

  it('suspends a context that resolves after the tab went hidden', async () => {
    const t = setup();
    let release: () => void = () => {};
    vi.mocked(t.ctx.resume).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await t.gesture();
    t.setHidden(true);
    expect(t.ctx.suspend).toHaveBeenCalledTimes(1);
    release();
    await new Promise((r) => setTimeout(r, 0));
    expect(t.ctx.suspend).toHaveBeenCalledTimes(2);
  });

  it('fetches nothing while muted, and loads once unmuted', async () => {
    const t = setup({}, INDEX, JSON.stringify({ muted: true, volume: 0.6, quiet: false }));
    await t.gesture();
    expect(t.engine.status).toBe('running');
    expect(t.deps.fetchBytes).not.toHaveBeenCalled();
    expect(t.sources).toHaveLength(0);
    t.engine.setMuted(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(t.deps.fetchBytes).toHaveBeenCalled();
    expect(t.sources.filter((s) => s.loop)).toHaveLength(3);
  });

  it('stops the loops and closes the context on stop', async () => {
    const t = setup();
    await t.gesture();
    const loops = t.sources.filter((s) => s.loop);
    t.engine.stop();
    expect(loops.every((s) => vi.mocked(s.stop).mock.calls.length === 1)).toBe(true);
    expect(t.ctx.close).toHaveBeenCalledTimes(1);
    expect(t.engine.status).toBe('locked');
    expect(t.engine.glassTap(1)).toBe(false);
  });

  it('reports no support without throwing', async () => {
    const t = setup({ createContext: () => null });
    await t.gesture();
    expect(t.engine.status).toBe('unsupported');
    expect(t.engine.glassTap(1)).toBe(false);
    expect(() => t.engine.setMuted(true)).not.toThrow();
  });
});

describe('AudioEngine gain routing', () => {
  it('routes hum and bed to the filter, effects through the compressor, then master', async () => {
    const t = setup();
    await t.gesture();
    const master = at(t.gains, 0);
    const hum = at(t.gains, 1);
    const bed = at(t.gains, 2);
    const effects = at(t.gains, 3);
    const tone = at(t.filters, 0);
    const compressor = at(t.compressors, 0);
    expect(hum.connections).toContain(tone);
    expect(bed.connections).toContain(tone);
    expect(effects.connections).toContain(compressor);
    expect(tone.connections).toContain(master);
    expect(master.connections).toContain(t.ctx.destination);
  });

  it('applies volume as a taper and mute as zero', async () => {
    const t = setup();
    await t.gesture();
    const master = at(t.gains, 0);
    t.engine.setVolume(0.5);
    expect(master.gain.target).toBeCloseTo(0.25);
    t.engine.setMuted(true);
    expect(master.gain.target).toBe(0);
    t.engine.setMuted(false);
    expect(master.gain.target).toBeCloseTo(0.25);
  });

  it('softens effects and compresses them in quiet mode', async () => {
    const t = setup();
    await t.gesture();
    const effects = at(t.gains, 3);
    const compressor = at(t.compressors, 0);
    t.engine.setQuiet(true);
    expect(effects.gain.target).toBeLessThan(1);
    expect(compressor.ratio.target).toBeGreaterThan(1);
    t.engine.setQuiet(false);
    expect(effects.gain.target).toBe(1);
    expect(compressor.ratio.target).toBe(1);
  });

  it('maps a non-finite volume or tap intensity to zero', async () => {
    const t = setup();
    await t.gesture();
    t.engine.setVolume(Number.NaN);
    expect(t.engine.settings.volume).toBe(0);
    expect(() => t.engine.glassTap(Number.NaN)).not.toThrow();
  });

  it('clamps an out-of-range volume', () => {
    const t = setup();
    t.engine.setVolume(7);
    expect(t.engine.settings.volume).toBe(1);
    t.engine.setVolume(-1);
    expect(t.engine.settings.volume).toBe(0);
  });
});

describe('AudioEngine dive', () => {
  it('muffles and crossfades to the underwater bed, and back', async () => {
    const t = setup();
    await t.gesture();
    const tone = at(t.filters, 0);
    const hum = at(t.gains, 1);
    const bed = at(t.gains, 2);
    expect(bed.gain.target).toBe(0);
    expect(hum.gain.target).toBe(1);
    const open = tone.frequency.target;

    t.bus.emit('camera:mode-changed', { mode: 'dive' });
    expect(tone.frequency.target).toBeLessThan(open / 10);
    expect(bed.gain.target).toBe(1);
    expect(hum.gain.target).toBeLessThan(1);

    t.bus.emit('camera:mode-changed', { mode: 'focus' });
    expect(tone.frequency.target).toBe(open);
    expect(bed.gain.target).toBe(0);
    expect(hum.gain.target).toBe(1);
  });

  it('is already muffled when the first gesture comes while diving', async () => {
    const t = setup();
    t.bus.emit('camera:mode-changed', { mode: 'dive' });
    await t.gesture();
    const bed = at(t.gains, 2);
    expect(bed.gain.target).toBe(1);
  });
});

describe('AudioEngine hidden tab', () => {
  it('suspends when hidden and resumes when visible again', async () => {
    const t = setup();
    await t.gesture();
    t.setHidden(true);
    expect(t.ctx.suspend).toHaveBeenCalledTimes(1);
    t.setHidden(false);
    expect(t.ctx.resume).toHaveBeenCalledTimes(2);
  });

  it('does nothing while still locked', () => {
    const t = setup();
    t.setHidden(true);
    expect(t.ctx.suspend).not.toHaveBeenCalled();
  });

  it('does not resume the context for a gesture in a hidden tab', async () => {
    const t = setup({ isHidden: () => true });
    t.engine.start();
    await t.gesture();
    expect(t.ctx.resume).not.toHaveBeenCalled();
  });
});

describe('AudioEngine effects and failure', () => {
  it('plays the glass tap by role on the effects bus, louder when harder', async () => {
    const t = setup();
    await t.gesture();
    const before = t.sources.length;
    t.bus.emit('glass:tapped', { intensity: 0.5 });
    t.bus.emit('glass:tapped', { intensity: 1 });
    const shots = t.sources.slice(before);
    expect(shots).toHaveLength(2);
    const levels = t.gains.slice(-2).map((g) => g.gain.value);
    expect(levels[0]).toBeLessThan(levels[1] ?? 0);
    expect(levels[1]).toBe(1);
  });

  it('is silent for taps while muted or locked', async () => {
    const t = setup();
    expect(t.engine.glassTap(1)).toBe(false);
    await t.gesture();
    t.engine.setMuted(true);
    expect(t.engine.glassTap(1)).toBe(false);
  });

  it('returns false for a role nothing has', async () => {
    const t = setup();
    await t.gesture();
    expect(t.engine.play('no-such-role')).toBe(false);
  });

  it('warns about a missing role and keeps the other sounds', async () => {
    const index = { assets: INDEX.assets.filter((a) => a.id !== 'underwater-bed') };
    const t = setup({}, index);
    await t.gesture();
    expect(t.engine.missing.has('underwater-ambience')).toBe(true);
    expect(t.warn).toHaveBeenCalledWith(expect.stringContaining('underwater-ambience'));
    expect(t.sources.filter((s) => s.loop)).toHaveLength(2);
    expect(t.engine.glassTap(1)).toBe(true);
  });

  it('survives a failed decode and plays nothing for that sound', async () => {
    const t = setup();
    vi.mocked(t.ctx.decodeAudioData).mockImplementation(async (): Promise<BufferLike> => {
      throw new Error('EncodingError');
    });
    await t.gesture();
    expect(t.engine.status).toBe('running');
    expect(t.engine.missing.has('glass-tap')).toBe(true);
    expect(t.engine.glassTap(1)).toBe(false);
    expect(t.sources).toHaveLength(0);
  });

  it('survives an unreachable catalog', async () => {
    const t = setup({
      fetchIndex: async () => {
        throw new Error('HTTP 404');
      },
    });
    await t.gesture();
    expect(t.engine.status).toBe('running');
    expect(t.warn).toHaveBeenCalledWith(expect.stringContaining('HTTP 404'));
    expect(t.engine.glassTap(1)).toBe(false);
  });
});

describe('AudioEngine settings', () => {
  it('persists and restores mute, volume and quiet', () => {
    const first = setup();
    first.engine.setMuted(true);
    first.engine.setVolume(0.3);
    first.engine.setQuiet(true);
    const second = setup({}, INDEX, first.store.get(AUDIO_STORAGE_KEY));
    expect(second.engine.settings).toEqual({ muted: true, volume: 0.3, quiet: true });
  });

  it('keeps each user their own settings', () => {
    const t = setup();
    t.engine.setUser('ana');
    t.engine.setMuted(true);
    t.engine.setUser('ben');
    expect(t.engine.settings.muted).toBe(false);
    t.engine.setUser('ana');
    expect(t.engine.settings.muted).toBe(true);
    expect(t.store.has(`${AUDIO_STORAGE_KEY}.ana`)).toBe(true);
  });

  it('falls back to defaults on corrupt storage', () => {
    const t = setup({}, INDEX, '{nope');
    expect(t.engine.settings).toEqual({ muted: false, volume: 0.6, quiet: false });
  });

  it('keeps working when storage throws', () => {
    const t = setup({
      storage: {
        getItem: () => {
          throw new Error('blocked');
        },
        setItem: () => {
          throw new Error('full');
        },
      },
    });
    expect(() => t.engine.setMuted(true)).not.toThrow();
    expect(t.engine.settings.muted).toBe(true);
  });

  it('notifies subscribers', () => {
    const t = setup();
    const listener = vi.fn();
    t.engine.subscribe(listener);
    t.engine.setMuted(true);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
