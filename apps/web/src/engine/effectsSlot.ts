import type { PhotoLook } from './photo/look';

/** What photo mode asks of the post chain. */
export interface PhotoPost {
  readonly look: PhotoLook;
  /** Wanted by the photographer; tiers without depth of field still go without. */
  readonly depthOfField: boolean;
  /** Whether the filter changes the picture; without a grade or depth of field, no post pass. */
  readonly graded: boolean;
}

/** What the engine needs from the lazily loaded render effects. */
export interface FrameEffects {
  /** Whether the frames drawn now go through a temporal resolve (TRAA). */
  readonly temporal: boolean;
  /** Draws the whole frame, restoring the renderer state it changed even when it throws. */
  render(): void;
  setFocusMode(on: boolean): void;
  /** The tank's water box changed size. */
  tankResized(): void;
  setPhoto(photo: PhotoPost | null): void;
  /** Resolves once the pipeline the settings ask for is built, or has failed. */
  ready(): Promise<void>;
  /** Whether the effects draw with material `id` (three's runtime material id). */
  ownsMaterial(id: number): boolean;
  dispose(): void;
}

export type ReportError = (message: string, cause: unknown) => void;
export type TemporalChanged = (on: boolean) => void;
export type EffectsDropped = (cause: unknown) => void;

/**
 * A submit that used a freed resource fails the frame, not a pipeline, though an async compile
 * whose error scope was open reports it as its own failure. Built again, the effects can work.
 */
const TRANSIENT_GPU_FAILURE = /used in a submit|Destroyed (?:texture|buffer)/i;

export function isTransientFailure(cause: unknown): boolean {
  return cause instanceof Error && TRANSIENT_GPU_FAILURE.test(cause.message);
}

export type Schedule = (run: () => void, delayMs: number) => () => void;

/**
 * Rebuilds effects dropped for a transient failure, after each of `delaysMs` in turn; a failure
 * that is not transient, or one past the last delay, leaves them dropped for the session.
 */
export class EffectsRecovery {
  private attempts = 0;
  private cancel: (() => void) | null = null;

  constructor(
    private readonly rebuild: () => void,
    private readonly schedule: Schedule,
    private readonly delaysMs: readonly number[] = [1000, 5000, 30_000],
  ) {}

  /** Whether a rebuild is scheduled for this drop. */
  dropped(cause: unknown): boolean {
    if (this.cancel !== null || !isTransientFailure(cause)) return false;
    const delay = this.delaysMs[this.attempts];
    if (delay === undefined) return false;
    this.attempts++;
    this.cancel = this.schedule(() => {
      this.cancel = null;
      this.rebuild();
    }, delay);
    return true;
  }

  dispose(): void {
    this.cancel?.();
    this.cancel = null;
  }
}

/**
 * Holds the optional effects and keeps a failure in them from stopping the scene. Their node
 * graphs build lazily on first use, so a shader error surfaces in `render()`: it is reported once,
 * the effects are torn down, and frames take the plain render path until effects attach again.
 */
export class EffectsSlot {
  private effects: FrameEffects | null = null;
  private focus = false;
  private photo: PhotoPost | null = null;
  private temporalOn = false;

  /**
   * `temporalChanged` hears every change of `temporal`, whatever caused it; `dropped` hears each
   * failure that tore the effects down, once they are gone.
   */
  constructor(
    private readonly report: ReportError,
    private readonly temporalChanged: TemporalChanged = () => undefined,
    private readonly dropped: EffectsDropped = () => undefined,
  ) {}

  get active(): boolean {
    return this.effects !== null;
  }

  /** Whether frames go through a temporal resolve; false without effects. */
  get temporal(): boolean {
    return this.temporalOn;
  }

  attach(effects: FrameEffects): void {
    if (this.effects !== null) throw new Error('EffectsSlot: effects are already attached');
    this.effects = effects;
    this.guard(() => {
      effects.setFocusMode(this.focus);
      effects.setPhoto(this.photo);
    });
    this.refresh();
  }

  setFocusMode(on: boolean): void {
    this.focus = on;
    const effects = this.effects;
    if (effects !== null) this.guard(() => effects.setFocusMode(on));
    this.refresh();
  }

  tankResized(): void {
    const effects = this.effects;
    if (effects !== null) this.guard(() => effects.tankResized());
  }

  setPhoto(photo: PhotoPost | null): void {
    this.photo = photo;
    const effects = this.effects;
    if (effects !== null) this.guard(() => effects.setPhoto(photo));
    this.refresh();
  }

  /** Resolves once the attached effects draw what was last asked of them; at once without any. */
  async ready(): Promise<void> {
    await this.effects?.ready();
  }

  /** True when the effects drew the frame; false means the caller must render it plainly. */
  render(): boolean {
    const effects = this.effects;
    if (effects === null) return false;
    const drawn =
      this.guard(() => {
        effects.render();
        return true;
      }) ?? false;
    this.refresh();
    return drawn;
  }

  ownsMaterial(id: number): boolean {
    return this.effects?.ownsMaterial(id) ?? false;
  }

  /** Drops the effects for a failure found outside their calls: a pipeline that failed to build. */
  fail(cause: unknown): void {
    if (this.effects !== null) this.drop(cause);
  }

  /** Rereads `temporal` from the effects, which change it on their own with the tier. */
  refresh(): void {
    const on = this.effects?.temporal ?? false;
    if (on === this.temporalOn) return;
    this.temporalOn = on;
    this.temporalChanged(on);
  }

  dispose(): void {
    const effects = this.effects;
    this.effects = null;
    try {
      effects?.dispose();
    } finally {
      this.refresh();
    }
  }

  private guard<T>(call: () => T): T | null {
    try {
      return call();
    } catch (cause) {
      this.drop(cause);
      return null;
    }
  }

  private drop(cause: unknown): void {
    this.report('Render effects failed; continuing without them', cause);
    try {
      this.dispose();
    } catch (disposeCause) {
      this.report('Disposing the failed render effects failed', disposeCause);
    }
    this.dropped(cause);
  }
}
