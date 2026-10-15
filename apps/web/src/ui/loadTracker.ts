import type { EventBus } from '../engine/events';
import type { InteractionEvents, LoadState } from '../interaction/events';

export type LoadReason = 'boot' | 'switch';
export type Milestone = 'code' | 'renderer' | 'scene' | 'fish' | 'warmup';

const BOOT_WEIGHTS: Record<Milestone, number> = {
  code: 0.08,
  renderer: 0.07,
  scene: 0.3,
  fish: 0.3,
  warmup: 0.25,
};

const SWITCH_WEIGHTS: Record<Milestone, number> = {
  code: 0,
  renderer: 0,
  scene: 0.35,
  fish: 0.4,
  warmup: 0.25,
};

const LABELS: Record<Milestone, string> = {
  code: 'Loading the aquarium',
  renderer: 'Starting the renderer',
  scene: 'Building the tank',
  fish: 'Loading fish',
  warmup: 'Preparing water',
};

const ORDER: readonly Milestone[] = ['code', 'renderer', 'scene', 'fish', 'warmup'];

/** How much of a pending milestone's weight the asset share may fill before it completes. */
const PARTIAL_SHARE = 0.9;
const STALL_MESSAGE = 'Loading is taking longer than expected.';

export interface LoadTrackerOptions {
  /** How long without any signal before the load counts as stuck. */
  stallMs?: number;
}

/**
 * Turns real load signals into one monotone progress value and a stage label. Each milestone
 * (code, renderer, scene, fish, first frames) is reported when it happens; between milestones
 * the share of asset requests that finished stands for the pending ones. Nothing here is
 * time-driven except the stall check, which turns a load that has gone quiet into an error.
 */
export class LoadTracker {
  private state: LoadState = { active: false, reason: 'boot', progress: 0, stage: '', error: null };
  private weights = BOOT_WEIGHTS;
  private done = new Set<Milestone>();
  private assetFraction = 0;
  private stallTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly stallMs: number;

  constructor(
    private readonly bus: EventBus<InteractionEvents>,
    options: LoadTrackerOptions = {},
  ) {
    this.stallMs = options.stallMs ?? 90_000;
    this.publish();
  }

  get current(): LoadState {
    return this.state;
  }

  get running(): boolean {
    return this.state.active && this.state.error === null;
  }

  /** Starts a load. Milestones in `skip` count as already done. */
  begin(reason: LoadReason, skip: readonly Milestone[] = []): void {
    this.weights = reason === 'boot' ? BOOT_WEIGHTS : SWITCH_WEIGHTS;
    this.done = new Set(skip);
    for (const milestone of ORDER) if (this.weights[milestone] === 0) this.done.add(milestone);
    this.assetFraction = 0;
    this.state = { active: true, reason, progress: 0, stage: '', error: null };
    this.recompute();
    this.armStall();
  }

  reach(milestone: Milestone): void {
    if (!this.running || this.done.has(milestone)) return;
    this.done.add(milestone);
    this.recompute();
    this.armStall();
  }

  /** The share of asset requests finished since the load began, 0..1. */
  assets(fraction: number): void {
    if (!this.running) return;
    const next = Math.min(1, Math.max(0, fraction));
    if (next <= this.assetFraction) return;
    this.assetFraction = next;
    this.recompute();
    this.armStall();
  }

  finish(): void {
    if (!this.running) return;
    this.clearStall();
    this.state = { ...this.state, active: false, progress: 1 };
    this.publish();
  }

  fail(message: string): void {
    if (!this.running) return;
    this.clearStall();
    this.state = { ...this.state, error: message };
    this.publish();
  }

  dispose(): void {
    this.clearStall();
  }

  private recompute(): void {
    let progress = 0;
    let pending = 0;
    for (const milestone of ORDER) {
      if (this.done.has(milestone)) progress += this.weights[milestone];
      else if (milestone === 'scene' || milestone === 'fish') pending += this.weights[milestone];
    }
    progress += pending * this.assetFraction * PARTIAL_SHARE;
    const stage = LABELS[ORDER.find((milestone) => !this.done.has(milestone)) ?? 'warmup'];
    this.state = {
      ...this.state,
      progress: Math.min(0.99, Math.max(this.state.progress, progress)),
      stage,
    };
    this.publish();
  }

  private armStall(): void {
    this.clearStall();
    this.stallTimer = setTimeout(() => this.fail(STALL_MESSAGE), this.stallMs);
  }

  private clearStall(): void {
    clearTimeout(this.stallTimer);
    this.stallTimer = undefined;
  }

  private publish(): void {
    this.bus.emit('load:state', this.state);
  }
}
