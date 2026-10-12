import type { EngineEventBus } from '../events';
import { DEFAULT_CONTROLLER_CONFIG, TierController } from './controller';
import { selectInitialTier, type TimingSignal } from './probe';
import { TIER_SETTINGS, type Tier, type TierChangeReason, type TierSettings } from './tiers';

export type ApplyTier = (settings: Readonly<TierSettings>, tier: Tier) => void;

export interface QualityOptions {
  /** Pins the tier: no probe, no adaptation. */
  pinned: Tier | null;
  adaptive: boolean;
  targetMs: number;
  probeTier?: Tier;
  probeMs?: number;
  /** Frames right after start-up include pipeline compiles and are not representative. */
  warmupMs?: number;
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'probing'; startedAt: number; gpu: number[]; frame: number[] }
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
  private readonly probeMs: number;
  private readonly warmupMs: number;
  private signal: TimingSignal | null = null;

  constructor(
    private readonly events: EngineEventBus,
    private readonly options: QualityOptions,
  ) {
    if (!(options.targetMs > 0)) throw new RangeError('QualityManager: targetMs must be > 0');
    this.probeTier = options.probeTier ?? 'high';
    this.probeMs = options.probeMs ?? 2000;
    this.warmupMs = options.warmupMs ?? 300;
    this.current = options.pinned ?? this.probeTier;
  }

  get tier(): Tier {
    return this.current;
  }

  get settings(): Readonly<TierSettings> {
    return TIER_SETTINGS[this.current];
  }

  get probing(): boolean {
    return this.phase.kind === 'probing';
  }

  get timingSignal(): TimingSignal | null {
    return this.signal;
  }

  get adaptive(): boolean {
    return this.controller !== null;
  }

  /** Registers a feature and applies the current tier to it immediately. */
  register(name: string, apply: ApplyTier): () => void {
    if (this.features.has(name)) {
      throw new Error(`QualityManager: feature "${name}" is already registered`);
    }
    this.features.set(name, apply);
    apply(this.settings, this.current);
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
    this.phase = { kind: 'probing', startedAt: nowMs + this.warmupMs, gpu: [], frame: [] };
  }

  /**
   * Feeds one frame's timings. `gpuMs` is null when the backend cannot time the GPU;
   * GPU results may arrive a frame or two late, which does not matter for a median or
   * rolling mean.
   */
  sample(frameMs: number, gpuMs: number | null, nowMs: number): void {
    const phase = this.phase;
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
    if (change) this.apply(change.from, change.to, change.reason);
  }

  /** Manual override from the dev panel or settings; adaptation restarts from there. */
  setTier(tier: Tier, nowMs: number): void {
    if (this.phase.kind === 'probing') this.phase = { kind: 'running' };
    this.controller?.reset(tier, nowMs);
    const from = this.current;
    if (from !== tier) this.apply(from, tier, 'manual');
  }

  private finishProbe(phase: Extract<Phase, { kind: 'probing' }>, nowMs: number): void {
    // Without timer queries every gpu sample is missing, so half the frames is a safe bar.
    const signal: TimingSignal = phase.gpu.length >= phase.frame.length / 2 ? 'gpu' : 'frame';
    this.signal = signal;
    const result = selectInitialTier({
      samples: signal === 'gpu' ? phase.gpu : phase.frame,
      signal,
      probeTier: this.probeTier,
      targetMs: this.options.targetMs,
    });
    this.phase = { kind: 'running' };
    if (this.options.adaptive) {
      this.controller = new TierController(result.tier, {
        ...DEFAULT_CONTROLLER_CONFIG,
        targetMs: this.options.targetMs,
        signal,
      });
      this.controller.reset(result.tier, nowMs);
    }
    const from = this.current;
    this.current = result.tier;
    if (from !== result.tier) this.applyFeatures();
    this.announce(null, result.tier, 'probe');
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
    this.events.emit('quality:tier-changed', { from, to, reason });
  }
}
