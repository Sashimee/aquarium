/**
 * Display frames are drawn this early, in ms, so timestamp jitter on a display at the cap's own
 * rate never drops one; on a faster display it lets a frame through at most this much early.
 */
const SLACK_MS = 2;

/**
 * Caps how often the render loop draws. The animation loop ticks at the display's rate, and a tick
 * draws once the cap's interval has passed since the last drawn one. Late draws keep the
 * interval's phase, so a 144 Hz display draws 60 times a second on alternating gaps of two and
 * three ticks; an early draw within the slack takes its own time as the phase, so a display a
 * little faster than the cap, such as a 60.5 Hz one, still draws every tick.
 */
export class FrameCap {
  private intervalMs = 0;
  /** Where the cap's schedule stands: the last draw, or the interval boundary it was late for. */
  private phase = 0;
  private drawnAt: number | null = null;
  private skipped = false;

  constructor(fps: number | null) {
    this.setFps(fps);
  }

  get fps(): number | null {
    return this.intervalMs > 0 ? 1000 / this.intervalMs : null;
  }

  /** Null draws every tick. */
  setFps(fps: number | null): void {
    if (fps !== null && !(Number.isFinite(fps) && fps > 0)) {
      throw new RangeError(`FrameCap: fps must be a positive number or null, got ${fps}`);
    }
    this.intervalMs = fps === null ? 0 : 1000 / fps;
    this.skipped = false;
  }

  /**
   * Whether the tick at `nowMs` draws: null when it does not, else the frame time the quality
   * system should see for it, 0 on the first. A frame that had a tick to spare kept up, so it
   * reads as exactly the cap's interval, and none reads as less: the uneven gaps on a display
   * that is not a multiple of the cap would otherwise look like missed frames.
   */
  tick(nowMs: number): number | null {
    const drawnAt = this.drawnAt;
    const interval = this.intervalMs;
    if (drawnAt === null) return this.draw(nowMs, nowMs, 0);
    const sinceDraw = nowMs - drawnAt;
    if (interval === 0) return this.draw(nowMs, nowMs, sinceDraw);
    const elapsed = nowMs - this.phase;
    if (elapsed < interval - SLACK_MS) {
      this.skipped = true;
      return null;
    }
    const frameMs = this.skipped ? interval : Math.max(sinceDraw, interval);
    return this.draw(nowMs, elapsed < interval ? nowMs : nowMs - (elapsed % interval), frameMs);
  }

  private draw(nowMs: number, phase: number, frameMs: number): number {
    this.drawnAt = nowMs;
    this.phase = phase;
    this.skipped = false;
    return frameMs;
  }
}
