import type { EngineEventBus } from '../events';
import { DEFAULT_CONTROLLER_CONFIG, TierController } from './controller';
import { gpuTimeSpansFrames, median, selectInitialTier, type TimingSignal } from './probe';
import {
  frameTimedMaxTier,
  lowerTier,
  TIER_SETTINGS,
  TIERS,
  tierAt,
  tierIndex,
  type Tier,
  type TierChangeReason,
  type TierSettings,
} from './tiers';

export type ApplyTier = (settings: Readonly<TierSettings>, tier: Tier) => void;

export interface QualityOptions {
  /** Whether the backend can time GPU work (timestamp queries). */
  gpuTiming: boolean;
  /** Pins the tier: no probe, no adaptation. */
  pinned: Tier | null;
  adaptive: boolean;
  targetMs: number;
  /** The display's frame interval; defaults to `targetMs`. */
  refreshMs?: number;
  probeTier?: Tier;
  /** The highest tier the probe and adaptation may choose; a pinned or manual tier may exceed it. */
  maxTier?: Tier;
  /** Caps every tier's `textureSize`, pinned and manual tiers included; defaults to 2048. */
  maxTextureSize?: 1024 | 2048;
  probeMs?: number;
  /** Frames right after start-up include pipeline compiles and are not representative. */
  warmupMs?: number;
  /**
   * GPU timestamps the probe needs before trusting them. Only one resolve is in flight
   * at a time, so on a GPU-bound device results arrive every few frames.
   */
  minGpuSamples?: number;
  /**
   * Probe twice. The first probe times the empty tank and announces the starting tier, which may
   * only drop from `probeTier`, so the scene is built once at a tier the device can at least draw
   * empty. The second waits for `contentReady()`, since timing an empty tank picks a tier that is
   * too high, and corrects it. `contentTimeoutMs` after `start()` it probes anyway, so a scene or
   * fish that never loads cannot stall it.
   */
  awaitContent?: boolean;
  contentTimeoutMs?: number;
  /**
   * A frame at least this long, and `STALL_RATIO` times the probe's fastest quarter, is a stall
   * (a pipeline compile or texture upload) rather than the tier's cost. A probe that saw one runs
   * again; from `maxProbeMs` after it began it drops the stalls and decides instead. A device that
   * is that slow on every frame has no fast quarter to stand out from, so it is timed as it is.
   */
  stallMs?: number;
  maxProbeMs?: number;
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'waiting'; deadline: number }
  | {
      kind: 'probing';
      content: boolean;
      startedAt: number;
      deadline: number;
      gpu: number[];
      frame: number[];
    }
  | { kind: 'running' };

/**
 * Owns the active quality tier. Every tier-dependent feature registers an apply callback
 * here, so nothing expensive runs unconditionally.
 */
export class QualityManager {
  private readonly features = new Map<string, ApplyTier>();
  private current: Tier;
  private phase: Phase = { kind: 'idle' };
  private controller: TierController | null = null;
  private readonly probeTier: Tier;
  private readonly maxTier: Tier;
  private readonly refreshMs: number;
  private readonly probeMs: number;
  private readonly warmupMs: number;
  private readonly minGpuSamples: number;
  private readonly contentTimeoutMs: number;
  private readonly stallMs: number;
  private readonly maxProbeMs: number;
  private hasContent: boolean;
  private contentDeadline = Infinity;
  private tierAnnounced = false;
  private signal: TimingSignal | null = null;
  private readonly table: Readonly<Record<Tier, Readonly<TierSettings>>>;

  constructor(
    private readonly events: EngineEventBus,
    private readonly options: QualityOptions,
  ) {
    if (!(options.targetMs > 0)) throw new RangeError('QualityManager: targetMs must be > 0');
    this.maxTier = options.maxTier ?? 'ultra';
    this.probeTier = options.probeTier ?? 'high';
    if (tierIndex(this.probeTier) > tierIndex(this.maxTier)) {
      throw new RangeError('QualityManager: probeTier is above maxTier');
    }
    this.refreshMs = options.refreshMs ?? options.targetMs;
    this.probeMs = options.probeMs ?? 2000;
    this.warmupMs = options.warmupMs ?? 300;
    this.minGpuSamples = options.minGpuSamples ?? 10;
    this.contentTimeoutMs = options.contentTimeoutMs ?? 15_000;
    this.stallMs = options.stallMs ?? 100;
    this.maxProbeMs = options.maxProbeMs ?? 10_000;
    this.hasContent = !(options.awaitContent ?? false);
    this.current = options.pinned ?? this.probeTier;
    this.table = cappedSettings(options.maxTextureSize ?? 2048);
  }

  get tier(): Tier {
    return this.current;
  }

  get settings(): Readonly<TierSettings> {
    return this.table[this.current];
  }

  /** True from `start()` until the probe picks a tier, including any wait for content. */
  get probing(): boolean {
    return this.phase.kind === 'waiting' || this.phase.kind === 'probing';
  }

  get timingSignal(): TimingSignal | null {
    return this.signal;
  }

  get adaptive(): boolean {
    return this.controller !== null;
  }

  /**
   * Registers a feature and applies the current tier to it immediately; not kept if that throws.
   * A tier change reaches the features in the order they registered.
   */
  register(name: string, apply: ApplyTier): () => void {
    if (this.features.has(name)) {
      throw new Error(`QualityManager: feature "${name}" is already registered`);
    }
    this.features.set(name, apply);
    try {
      apply(this.settings, this.current);
    } catch (error) {
      this.features.delete(name);
      throw error;
    }
    return () => this.features.delete(name);
  }

  featureNames(): string[] {
    return [...this.features.keys()];
  }

  start(nowMs: number): void {
    if (this.phase.kind !== 'idle') throw new Error('QualityManager: already started');
    if (this.options.pinned !== null) {
      this.phase = { kind: 'running' };
      this.announce(null, this.options.pinned, 'override');
      return;
    }
    this.contentDeadline = nowMs + this.contentTimeoutMs;
    this.beginProbe(nowMs, this.hasContent);
  }

  /**
   * The first scene and fish are in; the content probe's warm-up starts now, or as soon as the
   * empty-tank probe ends. Later calls do nothing.
   */
  contentReady(nowMs: number): void {
    if (this.hasContent) return;
    this.hasContent = true;
    if (this.phase.kind === 'waiting') this.beginProbe(nowMs, true);
  }

  /**
   * Feeds one frame's timings. `gpuMs` is null when the backend cannot time the GPU;
   * GPU results may arrive a frame or two late, which does not matter for a median or
   * rolling mean.
   */
  sample(frameMs: number, gpuMs: number | null, nowMs: number): void {
    const phase = this.phase;
    if (phase.kind === 'waiting') {
      if (nowMs >= phase.deadline) this.beginProbe(nowMs, true);
      return;
    }
    if (phase.kind === 'probing') {
      if (nowMs < phase.startedAt) return;
      if (gpuMs !== null && gpuMs > 0) phase.gpu.push(gpuMs);
      if (frameMs > 0) phase.frame.push(frameMs);
      if (nowMs - phase.startedAt >= this.probeMs) this.finishProbe(phase, nowMs);
      return;
    }
    if (phase.kind !== 'running' || this.controller === null) return;
    const ms = this.signal === 'gpu' ? gpuMs : frameMs;
    if (ms === null) return;
    const change = this.controller.sample(ms, nowMs);
    if (change) this.apply(this.current, change.to, change.reason);
  }

  /**
   * A load or pipeline compile is stalling frames from now on. A probe in progress starts its
   * warm-up again, unless it has run for `maxProbeMs`; the controller ignores the next samples.
   */
  stall(nowMs: number): void {
    const phase = this.phase;
    if (phase.kind === 'probing') {
      if (nowMs < phase.deadline) this.restartProbe(phase, nowMs);
      return;
    }
    if (phase.kind === 'running') this.controller?.pause(nowMs);
  }

  /**
   * Manual override from the dev panel or settings; adaptation restarts from there. A pick above
   * `maxTier` is shown as picked, but the controller restarts clamped to `maxTier`, so its first
   * step over budget lands one below the cap: on a phone, ultra drops straight to medium.
   */
  setTier(tier: Tier, nowMs: number): void {
    if (this.probing) this.phase = { kind: 'running' };
    this.controller?.reset(tier, nowMs);
    const from = this.current;
    if (from !== tier) this.apply(from, tier, 'manual');
  }

  private beginProbe(nowMs: number, content: boolean): void {
    this.phase = {
      kind: 'probing',
      content,
      startedAt: nowMs + this.warmupMs,
      deadline: nowMs + this.maxProbeMs,
      gpu: [],
      frame: [],
    };
  }

  private restartProbe(phase: Extract<Phase, { kind: 'probing' }>, nowMs: number): void {
    phase.startedAt = nowMs + this.warmupMs;
    phase.gpu.length = 0;
    phase.frame.length = 0;
  }

  private finishProbe(phase: Extract<Phase, { kind: 'probing' }>, nowMs: number): void {
    const stall = stallThreshold(phase.frame, this.stallMs);
    if (phase.frame.some((ms) => ms >= stall)) {
      if (nowMs < phase.deadline) {
        this.restartProbe(phase, nowMs);
        return;
      }
      phase.frame = phase.frame.filter((ms) => ms < stall);
    }
    const signal: TimingSignal = this.trustsGpu(phase) ? 'gpu' : 'frame';
    this.signal = signal;
    const measured = this.current;
    const maxTier = signal === 'gpu' ? this.maxTier : frameTimedMaxTier(this.maxTier);
    const result = selectInitialTier({
      samples: signal === 'gpu' ? phase.gpu : phase.frame,
      signal,
      probeTier: measured,
      targetMs: this.options.targetMs,
      refreshMs: this.refreshMs,
      // The empty tank runs faster than the furnished one will, so it may only lower the tier.
      maxTier: phase.content ? maxTier : lowerTier(measured, maxTier),
    });
    if (!phase.content) {
      this.settle(result.tier);
      if (this.hasContent || nowMs >= this.contentDeadline) this.beginProbe(nowMs, true);
      else this.phase = { kind: 'waiting', deadline: this.contentDeadline };
      return;
    }
    this.phase = { kind: 'running' };
    if (this.options.adaptive) {
      const controller = new TierController(result.tier, {
        ...DEFAULT_CONTROLLER_CONFIG,
        targetMs: this.options.targetMs,
        refreshMs: this.refreshMs,
        maxTier,
        signal,
      });
      controller.reset(result.tier, nowMs);
      // The furnished tank measured too slow for the tiers above its pick: no climbing straight
      // back into them, which rebuilds every pipeline twice for nothing.
      if (tierIndex(result.tier) < tierIndex(measured)) {
        controller.holdBelow(
          tierAt(tierIndex(result.tier) + 1),
          nowMs + controller.config.reentryHoldMs,
        );
      }
      this.controller = controller;
    }
    this.settle(result.tier);
  }

  private trustsGpu(phase: Extract<Phase, { kind: 'probing' }>): boolean {
    if (!this.options.gpuTiming || phase.gpu.length < this.minGpuSamples) return false;
    const gpuMs = median(phase.gpu);
    const frameMs = median(phase.frame);
    return gpuMs !== null && (frameMs === null || !gpuTimeSpansFrames(gpuMs, frameMs));
  }

  /** Applies a probe's pick; the first pick is announced even when it keeps the probe tier. */
  private settle(tier: Tier): void {
    const from = this.current;
    this.current = tier;
    if (from !== tier) this.applyFeatures();
    if (!this.tierAnnounced) this.announce(null, tier, 'probe');
    else if (from !== tier) this.announce(from, tier, 'probe');
  }

  private apply(from: Tier, to: Tier, reason: TierChangeReason): void {
    this.current = to;
    this.applyFeatures();
    this.announce(from, to, reason);
  }

  private applyFeatures(): void {
    const settings = this.settings;
    for (const apply of this.features.values()) apply(settings, this.current);
  }

  private announce(from: Tier | null, to: Tier, reason: TierChangeReason): void {
    this.tierAnnounced = true;
    this.events.emit('quality:tier-changed', { from, to, reason });
  }
}

const STALL_RATIO = 3;

function stallThreshold(frames: readonly number[], stallMs: number): number {
  const sorted = [...frames].sort((a, b) => a - b);
  const fastQuarter = sorted[Math.floor((sorted.length - 1) / 4)] ?? 0;
  return Math.max(stallMs, fastQuarter * STALL_RATIO);
}

function cappedSettings(
  maxTextureSize: 1024 | 2048,
): Readonly<Record<Tier, Readonly<TierSettings>>> {
  const table = { ...TIER_SETTINGS };
  for (const tier of TIERS) {
    const settings = TIER_SETTINGS[tier];
    if (settings.textureSize > maxTextureSize) {
      table[tier] = { ...settings, textureSize: maxTextureSize };
    }
  }
  return table;
}
