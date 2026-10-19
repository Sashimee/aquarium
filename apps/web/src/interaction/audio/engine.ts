import type { EventBus } from '../../engine/events';
import type { InteractionEvents } from '../events';
import { parseSoundCatalog, type SoundCatalog, type SoundEntry } from './catalog';

export const AUDIO_STORAGE_KEY = 'aquarium.audio';

export const ROLE = {
  hum: 'filter-hum',
  underwater: 'underwater-ambience',
  bubbles: 'air-bubbles',
  glassTap: 'glass-tap',
} as const;

const PRELOAD_ROLES: readonly string[] = Object.values(ROLE);

const DEFAULT_VOLUME = 0.6;
const FADE_S = 0.08;
const DIVE_FADE_S = 0.35;
const SURFACE_CUTOFF_HZ = 20000;
const DIVE_CUTOFF_HZ = 700;
const TOPSIDE_HUM = 1;
const DIVE_HUM = 0.25;
const BUBBLES = 0.45;
const QUIET_EFFECTS = 0.4;
const TAP_BASE = 0.7;

export interface ParamLike {
  value: number;
  setTargetAtTime(target: number, startTime: number, timeConstant: number): unknown;
}

export interface NodeLike {
  connect(destination: NodeLike): unknown;
  disconnect(): void;
}

export interface GainLike extends NodeLike {
  readonly gain: ParamLike;
}

export interface FilterLike extends NodeLike {
  type: string;
  readonly frequency: ParamLike;
}

export interface CompressorLike extends NodeLike {
  readonly threshold: ParamLike;
  readonly ratio: ParamLike;
}

export interface BufferLike {
  readonly duration: number;
}

export interface SourceLike extends NodeLike {
  buffer: BufferLike | null;
  loop: boolean;
  loopStart: number;
  loopEnd: number;
  start(when?: number): void;
  stop(when?: number): void;
}

export interface ContextLike {
  readonly currentTime: number;
  readonly state: string;
  readonly destination: NodeLike;
  resume(): Promise<void>;
  suspend(): Promise<void>;
  decodeAudioData(bytes: ArrayBuffer): Promise<BufferLike>;
  createGain(): GainLike;
  createBiquadFilter(): FilterLike;
  createDynamicsCompressor(): CompressorLike;
  createBufferSource(): SourceLike;
}

export interface AudioDeps {
  /** Null where there is no Web Audio at all. */
  createContext(): ContextLike | null;
  fetchBytes(url: string): Promise<ArrayBuffer>;
  fetchIndex(): Promise<unknown>;
  assetRoot: string;
  storage: Pick<Storage, 'getItem' | 'setItem'> | null;
  isHidden(): boolean;
  /** Calls back on each visibility change; returns the unsubscribe. */
  onVisibility(listener: () => void): () => void;
  /** Calls back on each user gesture; returns the unsubscribe. */
  onGesture(listener: () => void): () => void;
  random(): number;
  warn(message: string): void;
}

export type AudioStatus = 'locked' | 'running' | 'unsupported';

export interface AudioSettings {
  muted: boolean;
  volume: number;
  quiet: boolean;
}

interface Graph {
  ctx: ContextLike;
  master: GainLike;
  tone: FilterLike;
  humGain: GainLike;
  underwaterGain: GainLike;
  effects: GainLike;
  compressor: CompressorLike;
}

export function storageKey(userId: string | null): string {
  return userId ? `${AUDIO_STORAGE_KEY}.${userId}` : AUDIO_STORAGE_KEY;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function reason(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function parseSettings(raw: string | null): AudioSettings {
  const fallback: AudioSettings = { muted: false, volume: DEFAULT_VOLUME, quiet: false };
  if (raw === null) return fallback;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return fallback;
    const { muted, volume, quiet } = parsed as Record<string, unknown>;
    return {
      muted: muted === true,
      volume:
        typeof volume === 'number' && Number.isFinite(volume) ? clamp01(volume) : fallback.volume,
      quiet: quiet === true,
    };
  } catch {
    return fallback;
  }
}

export class AudioEngine {
  private settingsValue: AudioSettings;
  private user: string | null = null;
  private statusValue: AudioStatus = 'locked';
  private graph: Graph | null = null;
  private catalog: SoundCatalog | null = null;
  private readonly buffers = new Map<SoundEntry, BufferLike>();
  private readonly failed = new Set<string>();
  private dived = false;
  private started = false;
  private unlocking: Promise<void> | null = null;
  private version = 0;
  private readonly listeners = new Set<() => void>();
  private offGesture: (() => void) | null = null;
  private offVisibility: (() => void) | null = null;

  constructor(private readonly deps: AudioDeps) {
    this.settingsValue = this.read();
  }

  get settings(): AudioSettings {
    return this.settingsValue;
  }

  get status(): AudioStatus {
    return this.statusValue;
  }

  get diving(): boolean {
    return this.dived;
  }

  /** Roles and ids that could not be found or decoded; the rest of the sound still plays. */
  get missing(): ReadonlySet<string> {
    return this.failed;
  }

  /** Waits for the first gesture, then builds the graph; also pauses with the tab. */
  start(): () => void {
    if (this.statusValue === 'locked')
      this.offGesture ??= this.deps.onGesture(() => void this.unlock());
    this.offVisibility ??= this.deps.onVisibility(() => this.syncVisibility());
    return () => this.stop();
  }

  stop(): void {
    this.offGesture?.();
    this.offVisibility?.();
    this.offGesture = null;
    this.offVisibility = null;
  }

  attach(bus: EventBus<InteractionEvents>): () => void {
    const offs = [
      bus.on('camera:mode-changed', ({ mode }) => this.setDiving(mode === 'dive')),
      bus.on('glass:tapped', ({ intensity }) => this.glassTap(intensity)),
    ];
    return () => {
      for (const off of offs) off();
    };
  }

  setUser(userId: string | null): void {
    if (userId === this.user) return;
    this.user = userId;
    this.settingsValue = this.read();
    this.applySettings();
    this.changed();
  }

  setMuted(muted: boolean): void {
    this.update({ ...this.settingsValue, muted });
  }

  setVolume(volume: number): void {
    this.update({ ...this.settingsValue, volume: clamp01(volume) });
  }

  setQuiet(quiet: boolean): void {
    this.update({ ...this.settingsValue, quiet });
  }

  setDiving(dived: boolean): void {
    if (dived === this.dived) return;
    this.dived = dived;
    this.applyDive(false);
    this.changed();
  }

  /** Plays a one-shot by role; false when there is nothing to play it with. */
  play(role: string, gain = 1): boolean {
    const graph = this.graph;
    if (!graph || graph.ctx.state !== 'running' || this.settingsValue.muted) return false;
    const entry = this.pick(role, false);
    const buffer = entry && this.buffers.get(entry);
    if (!buffer) return false;
    const source = graph.ctx.createBufferSource();
    const level = graph.ctx.createGain();
    level.gain.value = clamp01(gain);
    source.buffer = buffer;
    source.connect(level);
    level.connect(graph.effects);
    source.start();
    return true;
  }

  glassTap(intensity: number): boolean {
    return this.play(ROLE.glassTap, TAP_BASE + (1 - TAP_BASE) * clamp01(intensity));
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getVersion = (): number => this.version;

  private pick(role: string, loop: boolean): SoundEntry | undefined {
    const entries = this.catalog?.get(role)?.filter((e) => e.loop === loop && this.buffers.has(e));
    if (!entries || entries.length === 0) return undefined;
    return entries[Math.min(entries.length - 1, Math.floor(this.deps.random() * entries.length))];
  }

  private unlock(): Promise<void> {
    this.unlocking ??= this.doUnlock().catch((cause: unknown) => {
      this.unlocking = null;
      this.deps.warn(`Sound could not start: ${reason(cause)}`);
    });
    return this.unlocking;
  }

  private async doUnlock(): Promise<void> {
    if (!this.graph) {
      const ctx = this.deps.createContext();
      if (!ctx) {
        this.statusValue = 'unsupported';
        this.offGesture?.();
        this.offGesture = null;
        this.changed();
        return;
      }
      this.graph = this.buildGraph(ctx);
      this.applySettings();
      this.applyDive(true);
    }
    if (!this.deps.isHidden()) await this.graph.ctx.resume();
    this.statusValue = 'running';
    this.offGesture?.();
    this.offGesture = null;
    this.changed();
    await this.loadSounds();
    this.startLoops();
  }

  private buildGraph(ctx: ContextLike): Graph {
    const master = ctx.createGain();
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = SURFACE_CUTOFF_HZ;
    const humGain = ctx.createGain();
    const underwaterGain = ctx.createGain();
    const effects = ctx.createGain();
    const compressor = ctx.createDynamicsCompressor();
    humGain.connect(tone);
    underwaterGain.connect(tone);
    effects.connect(compressor);
    compressor.connect(tone);
    tone.connect(master);
    master.connect(ctx.destination);
    return { ctx, master, tone, humGain, underwaterGain, effects, compressor };
  }

  private async loadSounds(): Promise<void> {
    const ctx = this.graph?.ctx;
    if (!ctx) return;
    try {
      this.catalog ??= parseSoundCatalog(await this.deps.fetchIndex(), this.deps.assetRoot);
    } catch (cause) {
      this.deps.warn(`Sound catalog unavailable: ${reason(cause)}`);
      return;
    }
    const catalog = this.catalog;
    await Promise.all(
      PRELOAD_ROLES.flatMap((role) => {
        const entries = catalog.get(role);
        if (!entries) {
          this.failed.add(role);
          this.deps.warn(`No sound has the role "${role}"; check assets/index.json.`);
          return [];
        }
        return entries.map(async (entry) => {
          try {
            const bytes = await this.deps.fetchBytes(entry.url);
            this.buffers.set(entry, await ctx.decodeAudioData(bytes));
          } catch (cause) {
            this.failed.add(entry.id);
            this.deps.warn(`Sound "${entry.id}" failed to load: ${reason(cause)}`);
          }
        });
      }),
    );
    this.changed();
  }

  private startLoops(): void {
    const graph = this.graph;
    if (!graph || this.started) return;
    this.started = true;
    const loops: [string, GainLike, number][] = [
      [ROLE.hum, graph.humGain, 1],
      [ROLE.underwater, graph.underwaterGain, 1],
      [ROLE.bubbles, graph.effects, BUBBLES],
    ];
    for (const [role, bus, level] of loops) {
      const entry = this.pick(role, true);
      const buffer = entry && this.buffers.get(entry);
      if (!entry || !buffer) continue;
      const source = graph.ctx.createBufferSource();
      const gain = graph.ctx.createGain();
      gain.gain.value = level;
      source.buffer = buffer;
      source.loop = true;
      source.loopStart = 0;
      source.loopEnd = Math.min(entry.frames / entry.sampleRate, buffer.duration);
      source.connect(gain);
      gain.connect(bus);
      source.start();
    }
  }

  private update(next: AudioSettings): void {
    this.settingsValue = next;
    try {
      this.deps.storage?.setItem(storageKey(this.user), JSON.stringify(next));
    } catch {
      // Storage can be full or blocked; the choice then lasts for this session only.
    }
    this.applySettings();
    this.changed();
  }

  private applySettings(): void {
    const graph = this.graph;
    if (!graph) return;
    const { muted, volume, quiet } = this.settingsValue;
    const now = graph.ctx.currentTime;
    graph.master.gain.setTargetAtTime(muted ? 0 : volume * volume, now, FADE_S);
    graph.effects.gain.setTargetAtTime(quiet ? QUIET_EFFECTS : 1, now, FADE_S);
    graph.compressor.threshold.setTargetAtTime(quiet ? -36 : 0, now, FADE_S);
    graph.compressor.ratio.setTargetAtTime(quiet ? 12 : 1, now, FADE_S);
  }

  private applyDive(immediate: boolean): void {
    const graph = this.graph;
    if (!graph) return;
    const now = graph.ctx.currentTime;
    const tc = immediate ? 0.001 : DIVE_FADE_S;
    graph.tone.frequency.setTargetAtTime(this.dived ? DIVE_CUTOFF_HZ : SURFACE_CUTOFF_HZ, now, tc);
    graph.humGain.gain.setTargetAtTime(this.dived ? DIVE_HUM : TOPSIDE_HUM, now, tc);
    graph.underwaterGain.gain.setTargetAtTime(this.dived ? 1 : 0, now, tc);
  }

  private syncVisibility(): void {
    const ctx = this.graph?.ctx;
    if (!ctx || this.statusValue !== 'running') return;
    const hidden = this.deps.isHidden();
    (hidden ? ctx.suspend() : ctx.resume()).catch((cause: unknown) =>
      this.deps.warn(`Sound could not ${hidden ? 'pause' : 'resume'}: ${reason(cause)}`),
    );
  }

  private read(): AudioSettings {
    try {
      return parseSettings(this.deps.storage?.getItem(storageKey(this.user)) ?? null);
    } catch {
      return parseSettings(null);
    }
  }

  private changed(): void {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }
}

function localStorageOrNull(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function browserAudioDeps(): AudioDeps {
  const root = `${import.meta.env.BASE_URL}assets/`;
  const doc = typeof document === 'undefined' ? null : document;
  const Ctor: typeof AudioContext | undefined =
    typeof window === 'undefined'
      ? undefined
      : (window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext);
  const get = async (url: string): Promise<Response> => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    return response;
  };
  return {
    createContext: () =>
      Ctor ? (new Ctor({ latencyHint: 'playback' }) as unknown as ContextLike) : null,
    fetchBytes: async (url) => (await get(url)).arrayBuffer(),
    fetchIndex: async () => (await get(`${root}index.json`)).json(),
    assetRoot: root,
    storage: localStorageOrNull(),
    isHidden: () => doc?.hidden ?? false,
    onVisibility: (listener) => {
      doc?.addEventListener('visibilitychange', listener);
      return () => doc?.removeEventListener('visibilitychange', listener);
    },
    onGesture: (listener) => {
      const events = ['pointerdown', 'keydown', 'touchend'] as const;
      for (const type of events) doc?.addEventListener(type, listener, { capture: true });
      return () => {
        for (const type of events) doc?.removeEventListener(type, listener, { capture: true });
      };
    },
    random: Math.random,
    warn: (message) => console.warn(message),
  };
}

export const audio = new AudioEngine(browserAudioDeps());
