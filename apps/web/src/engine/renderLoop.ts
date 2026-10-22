export interface LoopRenderer {
  setAnimationLoop(callback: ((time: number) => void) | null): Promise<void> | void;
}

/**
 * The renderer's frame loop. A halt is for good: after the device is lost, drawing on would only
 * flood errors, and the loss can arrive while the engine is still starting, before `start()`.
 */
export class RenderLoop {
  private halted = false;
  private running = false;
  private hidden = false;

  constructor(
    private readonly renderer: LoopRenderer,
    private readonly frame: (time: number) => void,
  ) {}

  get isHalted(): boolean {
    return this.halted;
  }

  /** Returns false, and draws nothing, once the loop was halted. */
  start(): boolean {
    if (this.halted) return false;
    if (this.running) return true;
    this.running = true;
    if (!this.hidden) void this.renderer.setAnimationLoop(this.frame);
    return true;
  }

  /**
   * A hidden page draws nothing until it is shown again. Browsers mostly stop animation frames in
   * a hidden tab already, but not every embedding does, and three keeps its own loop ticking.
   */
  setHidden(hidden: boolean): void {
    if (hidden === this.hidden) return;
    this.hidden = hidden;
    if (this.running && !this.halted) {
      void this.renderer.setAnimationLoop(hidden ? null : this.frame);
    }
  }

  stop(): void {
    this.running = false;
    void this.renderer.setAnimationLoop(null);
  }

  halt(): void {
    this.halted = true;
    this.stop();
  }
}
