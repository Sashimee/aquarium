/**
 * Two copies of a moving, non-periodic pattern, half a period apart. Each copy's phase wraps once a
 * period, at the moment its weight reaches zero, so the blend moves forever with no jump while the
 * shader only ever sees phases in [0, 1), which f32 holds exactly enough.
 */
export interface Crossfade {
  phaseA: number;
  phaseB: number;
  /** Weight of copy A; copy B has the rest. */
  weightA: number;
  /** Whole periods copy A has run; it changes only while A is invisible. */
  cycleA: number;
  cycleB: number;
}

export function crossfade(): Crossfade {
  return { phaseA: 0, phaseB: 0.5, weightA: 0, cycleA: 0, cycleB: 0 };
}

/** Writes the cross-fade at `seconds` for a pattern that restarts every `periodSeconds` into `out`. */
export function crossfadeAt(seconds: number, periodSeconds: number, out: Crossfade): Crossfade {
  if (!Number.isFinite(seconds) || !(periodSeconds > 0)) {
    throw new RangeError(
      `crossfadeAt: need a finite time and a positive period, got ${seconds} and ${periodSeconds}`,
    );
  }
  const periods = seconds / periodSeconds;
  out.cycleA = Math.floor(periods);
  out.cycleB = Math.floor(periods + 0.5);
  out.phaseA = periods - out.cycleA;
  out.phaseB = periods + 0.5 - out.cycleB;
  out.weightA = 1 - Math.abs(2 * out.phaseA - 1);
  return out;
}
