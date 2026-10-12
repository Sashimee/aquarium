const SOFT_TAP = 0.5;
const HARD_TAP = 1;
const REPEAT_WINDOW_MS = 450;

/** A second tap right after the first reads as knocking: hard. */
export class TapIntensity {
  private lastMs = -Infinity;

  next(nowMs: number): number {
    const knock = nowMs - this.lastMs < REPEAT_WINDOW_MS;
    this.lastMs = nowMs;
    return knock ? HARD_TAP : SOFT_TAP;
  }
}
