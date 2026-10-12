import type { TimingSignal } from './probe';
import { TIER_COST, tierAt, tierIndex, type Tier } from './tiers';

export interface ControllerConfig {
  targetMs: number;
  signal: TimingSignal;
  windowSize: number;
  /** Step down when the rolling mean exceeds `targetMs * downRatio`. */
  downRatio: number;
  /** GPU signal: step up when the next tier's predicted cost fits in `targetMs * upFitRatio`. */
  upFitRatio: number;
  /** Frame signal: step up when the rolling mean stays within `targetMs * frameUpRatio`. */
  frameUpRatio: number;
  downHoldMs: number;
  upHoldMs: number;
  maxUpHoldMs: number;
  /** After any change, samples are ignored for this long so the new tier settles. */
  cooldownMs: number;
  /** A step down this soon after stepping up doubles the hold needed to retry that tier. */
  probationMs: number;
  /** Larger samples are hitches (tab switch, GC, shader compile) and are dropped. */
  ignoreAboveMs: number;
  minTier: Tier;
  maxTier: Tier;
}

export const DEFAULT_CONTROLLER_CONFIG: Omit<ControllerConfig, 'targetMs' | 'signal'> = {
  windowSize: 60,
  downRatio: 1.2,
  upFitRatio: 0.8,
  frameUpRatio: 1.08,
  downHoldMs: 2000,
  upHoldMs: 8000,
  maxUpHoldMs: 120_000,
  cooldownMs: 3000,
  probationMs: 20_000,
  ignoreAboveMs: 250,
  minTier: 'low',
  maxTier: 'ultra',
};

export interface TierChange {
  from: Tier;
  to: Tier;
  reason: 'over-budget' | 'headroom';
  meanMs: number;
}

export class TierController {
  readonly config: ControllerConfig;
  private current: Tier;
  private readonly window: number[] = [];
  private overSince: number | null = null;
  private underSince: number | null = null;
  private lastChangeAt = Number.NEGATIVE_INFINITY;
  private lastUpgrade: { tier: Tier; at: number } | null = null;
  private readonly upHold = new Map<Tier, number>();

  constructor(initial: Tier, config: ControllerConfig) {
    if (!(config.targetMs > 0)) throw new RangeError('TierController: targetMs must be > 0');
    if (config.windowSize < 1) throw new RangeError('TierController: windowSize must be >= 1');
    if (tierIndex(config.minTier) > tierIndex(config.maxTier)) {
      throw new RangeError('TierController: minTier is above maxTier');
    }
    this.config = config;
    this.current = this.clamp(initial);
  }

  get tier(): Tier {
    return this.current;
  }

  /** Hold (ms) of sustained headroom needed before stepping up into `tier`. */
  upHoldFor(tier: Tier): number {
    return this.upHold.get(tier) ?? this.config.upHoldMs;
  }

  /** Resets the measurement state, e.g. after a manual tier change. */
  reset(tier: Tier, nowMs: number): void {
    this.current = this.clamp(tier);
    this.restartWindow(nowMs);
    this.lastUpgrade = null;
  }

  sample(ms: number, nowMs: number): TierChange | null {
    const c = this.config;
    if (!Number.isFinite(ms) || ms <= 0 || ms > c.ignoreAboveMs) return null;
    if (nowMs - this.lastChangeAt < c.cooldownMs) return null;

    this.window.push(ms);
    if (this.window.length > c.windowSize) this.window.shift();
    if (this.window.length < c.windowSize) return null;

    const meanMs = this.window.reduce((sum, v) => sum + v, 0) / this.window.length;

    if (meanMs > c.targetMs * c.downRatio) {
      this.underSince = null;
      this.overSince ??= nowMs;
      if (nowMs - this.overSince >= c.downHoldMs && this.current !== c.minTier) {
        return this.stepDown(meanMs, nowMs);
      }
      return null;
    }

    this.overSince = null;
    const next = this.nextUp();
    if (next !== null && this.hasHeadroomFor(next, meanMs)) {
      this.underSince ??= nowMs;
      if (nowMs - this.underSince >= this.upHoldFor(next)) {
        return this.stepUp(next, meanMs, nowMs);
      }
      return null;
    }

    this.underSince = null;
    return null;
  }

  private hasHeadroomFor(next: Tier, meanMs: number): boolean {
    const c = this.config;
    if (c.signal === 'gpu') {
      const predicted = (meanMs * TIER_COST[next]) / TIER_COST[this.current];
      return predicted <= c.targetMs * c.upFitRatio;
    }
    return meanMs <= c.targetMs * c.frameUpRatio;
  }

  private nextUp(): Tier | null {
    if (this.current === this.config.maxTier) return null;
    return tierAt(tierIndex(this.current) + 1);
  }

  private stepDown(meanMs: number, nowMs: number): TierChange {
    const from = this.current;
    if (
      this.lastUpgrade !== null &&
      this.lastUpgrade.tier === from &&
      nowMs - this.lastUpgrade.at <= this.config.probationMs
    ) {
      this.upHold.set(from, Math.min(this.upHoldFor(from) * 2, this.config.maxUpHoldMs));
    }
    this.lastUpgrade = null;
    this.current = tierAt(tierIndex(from) - 1);
    this.restartWindow(nowMs);
    return { from, to: this.current, reason: 'over-budget', meanMs };
  }

  private stepUp(next: Tier, meanMs: number, nowMs: number): TierChange {
    const from = this.current;
    this.current = next;
    this.lastUpgrade = { tier: next, at: nowMs };
    this.restartWindow(nowMs);
    return { from, to: next, reason: 'headroom', meanMs };
  }

  private restartWindow(nowMs: number): void {
    this.window.length = 0;
    this.overSince = null;
    this.underSince = null;
    this.lastChangeAt = nowMs;
  }

  private clamp(tier: Tier): Tier {
    const i = tierIndex(tier);
    const lo = tierIndex(this.config.minTier);
    const hi = tierIndex(this.config.maxTier);
    return tierAt(Math.min(hi, Math.max(lo, i)));
  }
}
