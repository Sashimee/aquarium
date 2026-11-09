import type { TimingSignal } from './probe';
import { TIER_COST, TIER_GPU_SHARE, tierAt, tierIndex, type Tier } from './tiers';

export interface ControllerConfig {
  targetMs: number;
  /** The display's frame interval: frame intervals only show headroom when they reach it. */
  refreshMs: number;
  signal: TimingSignal;
  windowSize: number;
  /**
   * Step down when the rolling mean exceeds `targetMs * downRatio`; on the GPU signal, times the
   * current tier's `TIER_GPU_SHARE`.
   */
  downRatio: number;
  /**
   * GPU signal: step up when the next tier's predicted cost fits in `targetMs * upFitRatio` times
   * that tier's `TIER_GPU_SHARE`.
   */
  upFitRatio: number;
  /** Frame signal: step up when the rolling mean stays within `refreshMs * frameUpRatio`. */
  frameUpRatio: number;
  downHoldMs: number;
  upHoldMs: number;
  maxUpHoldMs: number;
  /** After any change, samples are ignored for this long so the new tier settles. */
  cooldownMs: number;
  /** A step down this soon after stepping up doubles the hold needed to retry that tier. */
  probationMs: number;
  /**
   * A tier just stepped down from may not be re-entered for this long, so a device whose timings
   * sit near a threshold settles instead of rebuilding its pipelines back and forth.
   */
  reentryHoldMs: number;
  /**
   * Larger samples are hitches (tab switch, GC, shader compile) and are dropped, unless nothing
   * but hitches arrives for `downHoldMs`: then the device is overloaded, not hitching (#1456).
   */
  ignoreAboveMs: number;
  /**
   * The longest a step up that came due waits behind `holdUpgrades`, so a camera that never rests
   * cannot keep a device below the tier it has headroom for.
   */
  maxUpgradeDelayMs: number;
  minTier: Tier;
  maxTier: Tier;
}

export const DEFAULT_CONTROLLER_CONFIG: Omit<
  ControllerConfig,
  'targetMs' | 'refreshMs' | 'signal'
> = {
  windowSize: 60,
  downRatio: 1.2,
  upFitRatio: 0.8,
  frameUpRatio: 1.08,
  downHoldMs: 2000,
  upHoldMs: 8000,
  maxUpHoldMs: 120_000,
  cooldownMs: 3000,
  probationMs: 20_000,
  reentryHoldMs: 60_000,
  ignoreAboveMs: 250,
  maxUpgradeDelayMs: 20_000,
  minTier: 'low',
  maxTier: 'ultra',
};

/** Fewer hitches in a row than this are a stall, however long they take together. */
const SUSTAINED_HITCHES = 4;

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
  /** When each tier above the current one last began to have headroom, and has had it since. */
  private readonly headroomSince = new Map<Tier, number>();
  private dueSince: number | null = null;
  private hitches: { since: number; count: number } | null = null;
  private lastChangeAt = Number.NEGATIVE_INFINITY;
  private lastUpgrade: { tier: Tier; at: number } | null = null;
  private readonly upHold = new Map<Tier, number>();
  private readonly blockedUntil = new Map<Tier, number>();
  private pausedUntil = Number.NEGATIVE_INFINITY;
  private upgradesHeldUntil = Number.NEGATIVE_INFINITY;
  private heldAtPause: { overMs: number | null; headroomMs: Map<Tier, number> } | null = null;

  constructor(initial: Tier, config: ControllerConfig) {
    if (!(config.targetMs > 0)) throw new RangeError('TierController: targetMs must be > 0');
    if (!(config.refreshMs > 0)) throw new RangeError('TierController: refreshMs must be > 0');
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

  /** Keeps the controller from stepping up into `tier` or above it before `untilMs`. */
  holdBelow(tier: Tier, untilMs: number): void {
    for (let i = tierIndex(tier); i <= tierIndex(this.config.maxTier); i++) {
      const held = tierAt(i);
      this.blockedUntil.set(
        held,
        Math.max(this.blockedUntil.get(held) ?? Number.NEGATIVE_INFINITY, untilMs),
      );
    }
  }

  /**
   * Keeps a step up that comes due from being taken before `untilMs`, while headroom is still
   * measured: a step up rebuilds pipelines, which stalls the frames of a camera on the move. It is
   * taken as soon as the hold ends if the headroom lasted, or once it has waited
   * `maxUpgradeDelayMs`. Steps down are not held.
   */
  holdUpgrades(untilMs: number): void {
    this.upgradesHeldUntil = Math.max(this.upgradesHeldUntil, untilMs);
  }

  /**
   * A load or pipeline compile is stalling frames now: they say nothing about the tier, so samples
   * are ignored for a cooldown. The window keeps the samples taken before, and the holds resume
   * where they stood, so periodic stalls cannot keep an overloaded device from stepping down.
   * Holds saved by an earlier pause that no sample has resumed yet are kept as they are.
   */
  pause(nowMs: number): void {
    if (this.heldAtPause === null) {
      this.heldAtPause = {
        overMs: this.overSince === null ? null : nowMs - this.overSince,
        headroomMs: new Map([...this.headroomSince].map(([tier, since]) => [tier, nowMs - since])),
      };
      this.overSince = null;
      this.headroomSince.clear();
    }
    this.pausedUntil = Math.max(this.pausedUntil, nowMs + this.config.cooldownMs);
  }

  sample(ms: number, nowMs: number): TierChange | null {
    const c = this.config;
    if (!Number.isFinite(ms) || ms <= 0) return null;
    if (nowMs - this.lastChangeAt < c.cooldownMs || nowMs < this.pausedUntil) {
      this.hitches = null;
      return null;
    }
    if (ms > c.ignoreAboveMs) return this.hitch(ms, nowMs);
    this.hitches = null;
    this.resumeHolds(nowMs);

    this.window.push(ms);
    if (this.window.length > c.windowSize) this.window.shift();
    if (this.window.length < c.windowSize) return null;

    const meanMs = this.window.reduce((sum, v) => sum + v, 0) / this.window.length;

    if (meanMs > c.targetMs * c.downRatio * this.share(this.current)) {
      this.loseHeadroom();
      this.overSince ??= nowMs;
      if (nowMs - this.overSince >= c.downHoldMs && this.current !== c.minTier) {
        return this.stepDown(meanMs, nowMs);
      }
      return null;
    }

    this.overSince = null;
    const next = this.nextUp(nowMs);
    if (next === null || !this.hasHeadroomFor(next, meanMs)) {
      this.loseHeadroom();
      return null;
    }
    this.trackHeadroom(next, meanMs, nowMs);
    const target = this.upTarget(next, nowMs);
    if (target === null) {
      this.dueSince = null;
      return null;
    }
    this.dueSince ??= nowMs;
    if (nowMs < this.upgradesHeldUntil && nowMs - this.dueSince < c.maxUpgradeDelayMs) return null;
    return this.stepUp(target, meanMs, nowMs);
  }

  private loseHeadroom(): void {
    this.headroomSince.clear();
    this.dueSince = null;
  }

  /**
   * GPU timing predicts every tier, so it tracks the headroom of each tier above the current one:
   * a step goes straight to the highest whose own headroom has lasted, as each step rebuilds every
   * pipeline and two in a row stall twice. Frame intervals only show that the current tier keeps
   * up, so they track the next tier alone and climb one at a time.
   */
  private trackHeadroom(next: Tier, meanMs: number, nowMs: number): void {
    const top = this.config.signal === 'gpu' ? tierIndex(this.config.maxTier) : tierIndex(next);
    for (let i = tierIndex(next); i <= tierIndex(this.config.maxTier); i++) {
      const tier = tierAt(i);
      if (i <= top && this.hasHeadroomFor(tier, meanMs)) {
        if (!this.headroomSince.has(tier)) this.headroomSince.set(tier, nowMs);
      } else {
        this.headroomSince.delete(tier);
      }
    }
  }

  /** The highest unblocked tier whose own headroom has lasted its up hold, if any. */
  private upTarget(next: Tier, nowMs: number): Tier | null {
    for (let i = tierIndex(this.config.maxTier); i >= tierIndex(next); i--) {
      const tier = tierAt(i);
      if (nowMs < (this.blockedUntil.get(tier) ?? Number.NEGATIVE_INFINITY)) continue;
      const since = this.headroomSince.get(tier);
      if (since !== undefined && nowMs - since >= this.upHoldFor(tier)) return tier;
    }
    return null;
  }

  /**
   * A frame that took seconds is drawn every few hundred milliseconds, so the window never fills
   * while the GPU is that far behind; a run of nothing else for the down hold steps down at once.
   */
  private hitch(ms: number, nowMs: number): TierChange | null {
    const hitches = (this.hitches ??= { since: nowMs, count: 0 });
    hitches.count++;
    if (
      hitches.count < SUSTAINED_HITCHES ||
      nowMs - hitches.since < this.config.downHoldMs ||
      this.current === this.config.minTier
    ) {
      return null;
    }
    return this.stepDown(ms, nowMs);
  }

  private resumeHolds(nowMs: number): void {
    const held = this.heldAtPause;
    if (held === null) return;
    this.heldAtPause = null;
    this.overSince = held.overMs === null ? null : nowMs - held.overMs;
    this.headroomSince.clear();
    for (const [tier, heldMs] of held.headroomMs) this.headroomSince.set(tier, nowMs - heldMs);
  }

  private hasHeadroomFor(next: Tier, meanMs: number): boolean {
    const c = this.config;
    if (c.signal === 'gpu') {
      const predicted = (meanMs * TIER_COST[next]) / TIER_COST[this.current];
      return predicted <= c.targetMs * c.upFitRatio * this.share(next);
    }
    return meanMs <= c.refreshMs * c.frameUpRatio;
  }

  private share(tier: Tier): number {
    return this.config.signal === 'gpu' ? TIER_GPU_SHARE[tier] : 1;
  }

  private nextUp(nowMs: number): Tier | null {
    if (this.current === this.config.maxTier) return null;
    const next = tierAt(tierIndex(this.current) + 1);
    return nowMs < (this.blockedUntil.get(next) ?? Number.NEGATIVE_INFINITY) ? null : next;
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
    this.holdBelow(from, nowMs + this.config.reentryHoldMs);
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
    this.hitches = null;
    this.overSince = null;
    this.loseHeadroom();
    this.heldAtPause = null;
    this.lastChangeAt = nowMs;
  }

  private clamp(tier: Tier): Tier {
    const i = tierIndex(tier);
    const lo = tierIndex(this.config.minTier);
    const hi = tierIndex(this.config.maxTier);
    return tierAt(Math.min(hi, Math.max(lo, i)));
  }
}
