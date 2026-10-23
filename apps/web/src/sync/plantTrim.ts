import type { Plant, Tank } from '@aquarium/shared';
import type { EventBus } from '../engine/events';
import type { InteractionEvents } from '../interaction/events';
import type { TrimOutcome } from './session';
import { ApiRequestError } from '../ui/api';

const PER_UNIT = 100;
const EPSILON = 1e-9;

export interface TrimRange {
  min: number;
  max: number;
  step: number;
  suggested: number;
}

const hundredths = (value: number): number => Math.round(value * PER_UNIT);

/** The sizes a trim can leave: from the species minimum up to just under today's size. Null when nothing can be cut. */
export function trimRange(pick: Pick<Plant, 'size' | 'minSize'>): TrimRange | null {
  const min = Math.ceil(pick.minSize * PER_UNIT - EPSILON);
  const max = Math.ceil(pick.size * PER_UNIT - EPSILON) - 1;
  if (max < min) return null;
  const mid = Math.round((min + pick.size * PER_UNIT) / 2);
  return {
    min: min / PER_UNIT,
    max: max / PER_UNIT,
    step: 1 / PER_UNIT,
    suggested: Math.min(max, Math.max(min, mid)) / PER_UNIT,
  };
}

export function clampTrimSize(range: TrimRange, size: number): number {
  const cents = hundredths(size);
  return Math.min(hundredths(range.max), Math.max(hundredths(range.min), cents)) / PER_UNIT;
}

export function trimmablePlants(tank: Pick<Tank, 'plants'> | null): Plant[] {
  return (tank?.plants ?? []).filter((p) => trimRange(p) !== null);
}

export function plantLabel(assetId: string): string {
  const name = assetId
    .replace(/^plant[-_]/, '')
    .replace(/[-_]+/g, ' ')
    .trim();
  return name === '' ? 'plant' : name;
}

export function describePlantSize(plant: Pick<Plant, 'size' | 'minSize' | 'maxSize'>): string {
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  return `${pct(plant.size)} of its bought size (smallest ${pct(plant.minSize)}, largest ${pct(plant.maxSize)})`;
}

export function samePlants(
  a: readonly Plant[] | undefined,
  b: readonly Plant[] | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((p, i) => {
    const q = b[i];
    return (
      q !== undefined &&
      p.key === q.key &&
      p.size === q.size &&
      p.assetId === q.assetId &&
      p.minSize === q.minSize &&
      p.maxSize === q.maxSize &&
      p.parentKey === q.parentKey &&
      p.position?.[0] === q.position?.[0] &&
      p.position?.[1] === q.position?.[1]
    );
  });
}

/** Text for a refused trim, or null when the failure is not one the player can act on. */
export function trimRefusalText(error: unknown, label: string): string | null {
  if (!(error instanceof ApiRequestError)) return null;
  if (error.code === 'rate_limited') {
    return error.retryAfterSeconds === null
      ? 'Too many trims in a short time. Wait a moment and try again.'
      : `Too many trims in a short time. Try again in ${error.retryAfterSeconds} seconds.`;
  }
  if (error.status === 404) return `The ${label} is no longer in this tank.`;
  if (error.status === 400) return `The ${label} cannot be cut back that far. Pick a larger size.`;
  if (error.status !== 409) return null;
  switch (error.reason) {
    case 'plant_not_grown':
      return `The ${label} has not grown past that size. Pick a smaller size.`;
    case 'key_reused':
      return 'That trim clashed with an earlier one. Press the button again to trim the plant.';
    default:
      return error.message;
  }
}

/** Follows the plant the player picked; a tank load drops it, since keys can repeat between tanks. */
export function followTrimTarget(
  interaction: EventBus<InteractionEvents>,
  set: (key: string | null) => void,
): () => void {
  const offPicked = interaction.on('plant:picked', ({ pick }) => set(pick?.key ?? null));
  const offLoaded = interaction.on('tank:loaded', () => set(null));
  return () => {
    offPicked();
    offLoaded();
  };
}

/** What the dialog shows after a trim: null means it worked and the dialog closes. */
export function trimRefusalShown(outcome: TrimOutcome, sessionError: string | null): string | null {
  if (outcome.ok) return null;
  return outcome.refusal ?? sessionError ?? 'The trim did not go through. Try again.';
}
