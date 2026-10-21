import type { WaterAlertMetric } from '@aquarium/shared';
import type { LifecycleState } from './types.ts';

export const AMMONIA_ALERT = 0.1;
export const NITRITE_ALERT = 0.1;
export const ALGAE_ALERT = 0.6;
/** A metric reads "normal" again only once it falls to this share of its alert level. */
export const ALERT_CLEAR_FRACTION = 0.5;
export const SICK_BELOW_HEALTH = 0.6;
export const RECOVERED_ABOVE_HEALTH = 0.8;
/** One catch-up never records more transitions than this, so a flapping tank cannot flood the table. */
export const MAX_TIMELINE_ENTRIES = 200;

export type TimelineEntry =
  | { readonly kind: 'sick'; readonly atMs: number; readonly fishId: string }
  | {
      readonly kind: 'water_alert';
      readonly atMs: number;
      readonly metric: WaterAlertMetric;
      readonly state: 'high' | 'normal';
    };

export interface TimelineFlags {
  readonly waterHigh: ReadonlySet<WaterAlertMetric>;
  readonly sick: ReadonlySet<string>;
}

const METRICS: readonly WaterAlertMetric[] = ['ammonia', 'nitrite', 'algae'];
const LEVELS: Readonly<Record<WaterAlertMetric, (s: LifecycleState) => number>> = {
  ammonia: (s) => s.water.ammonia,
  nitrite: (s) => s.chemistry.nitrite,
  algae: (s) => s.water.algae,
};
const ALERT_AT: Readonly<Record<WaterAlertMetric, number>> = {
  ammonia: AMMONIA_ALERT,
  nitrite: NITRITE_ALERT,
  algae: ALGAE_ALERT,
};

export function initialFlags(state: LifecycleState): TimelineFlags {
  const waterHigh = new Set<WaterAlertMetric>();
  for (const metric of METRICS) {
    if (LEVELS[metric](state) >= ALERT_AT[metric]) waterHigh.add(metric);
  }
  const sick = new Set<string>();
  for (const f of state.fish)
    if (f.alive && (f.health < SICK_BELOW_HEALTH || f.disease)) sick.add(f.id);
  return { waterHigh, sick };
}

/** Compares the state after a step with the flags before it; returns the transitions and the new flags. */
export function detectTransitions(
  state: LifecycleState,
  flags: TimelineFlags,
  atMs: number,
): { entries: TimelineEntry[]; flags: TimelineFlags } {
  const entries: TimelineEntry[] = [];
  const waterHigh = new Set(flags.waterHigh);
  for (const metric of METRICS) {
    const level = LEVELS[metric](state);
    const limit = ALERT_AT[metric];
    if (!waterHigh.has(metric) && level >= limit) {
      waterHigh.add(metric);
      entries.push({ kind: 'water_alert', atMs, metric, state: 'high' });
    } else if (waterHigh.has(metric) && level <= limit * ALERT_CLEAR_FRACTION) {
      waterHigh.delete(metric);
      entries.push({ kind: 'water_alert', atMs, metric, state: 'normal' });
    }
  }
  const sick = new Set(flags.sick);
  for (const f of state.fish) {
    if (!f.alive) {
      sick.delete(f.id);
    } else if (!sick.has(f.id) && (f.health < SICK_BELOW_HEALTH || f.disease)) {
      sick.add(f.id);
      entries.push({ kind: 'sick', atMs, fishId: f.id });
    } else if (sick.has(f.id) && !f.disease && f.health > RECOVERED_ABOVE_HEALTH) {
      sick.delete(f.id);
    }
  }
  return { entries, flags: { waterHigh, sick } };
}

/**
 * Appends entries up to the cap. A `normal` that closes an alert already in the list is always kept,
 * so a capped timeline never ends on an alert that appears never to clear.
 */
export function appendCapped(
  timeline: TimelineEntry[],
  openAlerts: Set<WaterAlertMetric>,
  entries: readonly TimelineEntry[],
): void {
  for (const entry of entries) {
    const closesRecordedAlert =
      entry.kind === 'water_alert' && entry.state === 'normal' && openAlerts.has(entry.metric);
    if (timeline.length >= MAX_TIMELINE_ENTRIES && !closesRecordedAlert) continue;
    timeline.push(entry);
    if (entry.kind === 'water_alert') {
      if (entry.state === 'high') openAlerts.add(entry.metric);
      else openAlerts.delete(entry.metric);
    }
  }
}
