import { FOCUS_DISTANCE_RANGE } from '../engine/photo/lens';

const RATIO = FOCUS_DISTANCE_RANGE.max / FOCUS_DISTANCE_RANGE.min;

/** Focus is felt in ratios, not metres: the first metre needs as much travel as the next ten. */
export function focusToSlider(metres: number): number {
  const clamped = Math.min(FOCUS_DISTANCE_RANGE.max, Math.max(FOCUS_DISTANCE_RANGE.min, metres));
  return Math.log(clamped / FOCUS_DISTANCE_RANGE.min) / Math.log(RATIO);
}

export function sliderToFocus(position: number): number {
  const t = Math.min(1, Math.max(0, position));
  return FOCUS_DISTANCE_RANGE.min * RATIO ** t;
}

export function describeFocus(metres: number): string {
  return metres < 1 ? `${Math.round(metres * 100)} cm` : `${metres.toFixed(1)} m`;
}

/** Mirrors `FOV_RANGE` in the engine photo mode, which this chunk cannot import without three. */
export const FOV_DEGREES = { min: 15, max: 75 } as const;
