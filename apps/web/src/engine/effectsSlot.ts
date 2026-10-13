/** What the engine needs from the lazily loaded render effects. */
export interface FrameEffects {
  /** Draws the whole frame, restoring the renderer state it changed even when it throws. */
  render(): void;
  setFocusMode(on: boolean): void;
  dispose(): void;
}

export type ReportError = (message: string, cause: unknown) => void;

/**
 * Holds the optional effects and keeps a failure in them from stopping the scene. Their node
 * graphs build lazily on first use, so a shader error surfaces in `render()`: it is reported once,
 * the effects are torn down, and from then on every frame takes the plain render path.
 */
export class EffectsSlot {
  private effects: FrameEffects | null = null;
  private focus = false;

  constructor(private readonly report: ReportError) {}

  get active(): boolean {
    return this.effects !== null;
  }

  attach(effects: FrameEffects): void {
    if (this.effects !== null) throw new Error('EffectsSlot: effects are already attached');
    this.effects = effects;
    this.guard(() => effects.setFocusMode(this.focus));
  }

  setFocusMode(on: boolean): void {
    this.focus = on;
    const effects = this.effects;
    if (effects !== null) this.guard(() => effects.setFocusMode(on));
  }

  /** True when the effects drew the frame; false means the caller must render it plainly. */
  render(): boolean {
    const effects = this.effects;
    if (effects === null) return false;
    return (
      this.guard(() => {
        effects.render();
        return true;
      }) ?? false
    );
  }

  dispose(): void {
    const effects = this.effects;
    this.effects = null;
    effects?.dispose();
  }

  private guard<T>(call: () => T): T | null {
    try {
      return call();
    } catch (cause) {
      this.report('Render effects failed; continuing without them', cause);
      try {
        this.dispose();
      } catch (disposeCause) {
        this.report('Disposing the failed render effects failed', disposeCause);
      }
      return null;
    }
  }
}
