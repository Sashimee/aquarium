import type { EventBus } from '../engine/events';
import type { InteractionEvents, LoadState } from '../interaction/events';

export type LoadReason = 'boot' | 'switch';
export type Milestone = 'code' | 'renderer' | 'scene' | 'fish' | 'warmup';

type Part = Milestone | 'assets';

/**
 * What each part of a load costs, measured on a software-rendered cold boot: the asset requests
 * go fast, building the tank (fitting plants, compiling materials) and the first frames take
 * most of the time.
 */
const BOOT_WEIGHTS: Record<Part, number> = {
  code: 0.04,
  renderer: 0.1,
  assets: 0.2,
  scene: 0.3,
  fish: 0.06,
  warmup: 0.3,
};

const SWITCH_WEIGHTS: Record<Part, number> = {
  code: 0,
  renderer: 0,
  assets: 0.25,
  scene: 0.3,
  fish: 0.15,
  warmup: 0.3,
};

const LABELS: Record<Milestone, string> = {
  code: 'Loading the aquarium',
  renderer: 'Starting the renderer',
  scene: 'Building the tank',
  fish: 'Loading fish',
  warmup: 'Preparing water',
};

const ORDER: readonly Milestone[] = ['code', 'renderer', 'scene', 'fish', 'warmup'];

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
  private share = new Map<Part, number>();
  private stallTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly stallMs: number;
  private readonly stopDismiss: () => void;

  constructor(
    private readonly bus: EventBus<InteractionEvents>,
    options: LoadTrackerOptions = {},
  ) {
    this.stallMs = options.stallMs ?? 90_000;
    this.stopDismiss = bus.on('load:dismiss', () => this.dismiss());
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
    this.share = new Map();
    for (const milestone of skip) this.share.set(milestone, 1);
    for (const part of [...ORDER, 'assets' as const]) {
      if (this.weights[part] === 0) this.share.set(part, 1);
    }
    this.state = { active: true, reason, progress: 0, stage: '', error: null };
    this.recompute();
    this.armStall();
  }

  reach(milestone: Milestone): void {
    this.part(milestone, 1);
  }

  /** How far a milestone has come, 0..1; it only moves forward. */
  part(part: Part, fraction: number): void {
    if (!this.running) return;
    const next = Math.min(1, Math.max(0, fraction));
    if (next <= (this.share.get(part) ?? 0)) return;
    this.share.set(part, next);
    this.recompute();
    this.armStall();
  }

  /** The share of asset requests finished since the load began, 0..1. */
  assets(fraction: number): void {
    this.part('assets', fraction);
  }

  /** A load that failed and then completes anyway is a success: the failure card goes away. */
  finish(): void {
    if (!this.state.active) return;
    this.clearStall();
    this.state = { ...this.state, active: false, progress: 1, error: null };
    this.publish();
  }

  /** Hides the failure card; the load itself is given up on. */
  dismiss(): void {
    if (!this.state.active || this.state.error === null) return;
    this.clearStall();
    this.state = { ...this.state, active: false, error: null };
    this.publish();
  }

  fail(message: string): void {
    if (!this.running) return;
    this.clearStall();
    this.state = { ...this.state, error: message };
    this.publish();
  }

  dispose(): void {
    this.stopDismiss();
    this.clearStall();
  }

  private recompute(): void {
    const sceneAndFishUp = this.share.get('scene') === 1 && this.share.get('fish') === 1;
    if (sceneAndFishUp) this.share.set('assets', 1);
    let progress = 0;
    for (const [part, fraction] of this.share) progress += this.weights[part] * fraction;
    const pending = ORDER.find((milestone) => (this.share.get(milestone) ?? 0) < 1);
    this.state = {
      ...this.state,
      progress: Math.min(0.99, Math.max(this.state.progress, progress)),
      stage: LABELS[pending ?? 'warmup'],
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
