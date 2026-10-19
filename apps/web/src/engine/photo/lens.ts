/** Metres in front of the lens; the near end is the camera's near plane. */
export const FOCUS_DISTANCE_RANGE = { min: 0.05, max: 20 } as const;
/** f-numbers a photo-mode aperture may take, from a fast prime to a stopped-down macro lens. */
export const F_STOP_RANGE = { min: 1.4, max: 22 } as const;
export const DEFAULT_F_STOP = 2.8;
export const DEFAULT_FOCUS_DISTANCE = 0.45;

/**
 * At this aperture and focus distance the photo lens matches focus mode's fixed one: full blur
 * 0.12 m off the focal plane and a 2.5 px bokeh at 1080 lines.
 */
const REFERENCE = { fStop: 2.8, focusDistance: 0.35, focalRange: 0.12, bokehPx: 2.5 } as const;
/** Bokeh radii are given for this drawing-buffer height and scale with the real one. */
export const REFERENCE_LINES = 1080;

/** The two knobs three's depth-of-field node takes, for one aperture and focus distance. */
export interface LensBlur {
  /** Metres off the focal plane, along the view axis, at which the blur is full. */
  focalRange: number;
  /** Bokeh radius in drawing-buffer pixels at full blur (DepthOfFieldNode's `bokehScale`). */
  bokehScale: number;
}

function finite(name: string, value: number): number {
  if (!Number.isFinite(value))
    throw new RangeError(`photo lens: ${name} must be finite, got ${value}`);
  return value;
}

export function clampFocusDistance(metres: number): number {
  const d = finite('focus distance', metres);
  return Math.min(FOCUS_DISTANCE_RANGE.max, Math.max(FOCUS_DISTANCE_RANGE.min, d));
}

export function clampFStop(fStop: number): number {
  const n = finite('f-stop', fStop);
  return Math.min(F_STOP_RANGE.max, Math.max(F_STOP_RANGE.min, n));
}

/**
 * A thin lens focused at `s` blurs a point at depth `d` by a circle that grows with |d - s| / s and
 * shrinks with the f-number N. Three's node ramps the blur linearly up to `focalRange` and caps it
 * at `bokehScale`, so the zone in focus widens with N·s and the largest bokeh shrinks with 1/N.
 * `lines` is the drawing buffer's height, so a 2x capture blurs as much of the picture as the
 * preview does.
 */
export function lensBlur(focusDistance: number, fStop: number, lines: number): LensBlur {
  const s = clampFocusDistance(focusDistance);
  const n = clampFStop(fStop);
  if (!(finite('lines', lines) > 0))
    throw new RangeError(`photo lens: lines must be > 0, got ${lines}`);
  const closed = n / REFERENCE.fStop;
  const focalRange = REFERENCE.focalRange * closed * (s / REFERENCE.focusDistance);
  return { focalRange, bokehScale: (REFERENCE.bokehPx / closed) * (lines / REFERENCE_LINES) };
}

/** Depth of a world point along the view axis: what the depth-of-field node calls distance. */
export function viewDepth(
  point: { x: number; y: number; z: number },
  eye: { x: number; y: number; z: number },
  forward: { x: number; y: number; z: number },
): number {
  return (
    (point.x - eye.x) * forward.x + (point.y - eye.y) * forward.y + (point.z - eye.z) * forward.z
  );
}
