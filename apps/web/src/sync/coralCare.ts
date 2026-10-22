import { coralSpeciesId, type Coral, type CoralContent, type Equipment } from '@aquarium/shared';
import { ApiRequestError } from '../ui/api';

export const DEFAULT_MAX_BLEACH = 0.3;

export function coralLabel(assetId: string): string {
  const name = assetId
    .replace(/^coral[-_]/, '')
    .replace(/[-_]+/g, ' ')
    .trim();
  return name === '' ? 'coral' : name;
}

export interface FragChoice {
  readonly coral: Coral;
  readonly label: string;
  readonly enabled: boolean;
  /** Why the coral cannot be fragged yet; null when it can. */
  readonly why: string | null;
}

const percent = (value: number): string => `${Math.round(value * 100)}%`;

/** A colony can be cut once it has grown to its `fragMinSize` and is not bleached past `maxBleach`. */
export function fragWhy(coral: Coral, maxBleach: number): string | null {
  if (coral.bleach > maxBleach) {
    return `Too bleached to cut (${percent(coral.bleach)}). Fix the water and the lamp and let it recover.`;
  }
  if (coral.size < coral.fragMinSize) {
    return `Not grown enough yet: ${percent(coral.size)} of its bought size, it needs ${percent(coral.fragMinSize)}.`;
  }
  return null;
}

/**
 * The colonies of the tank as a picker: layout corals first, fragments after, each with whether it
 * can be fragged. A repeated species is numbered so two of a kind can be told apart.
 */
export function fragChoices(
  corals: readonly Coral[] | undefined,
  maxBleach: number = DEFAULT_MAX_BLEACH,
): FragChoice[] {
  const ordered = [...(corals ?? [])].sort(
    (a, b) => Number(a.parentKey !== null) - Number(b.parentKey !== null),
  );
  const pieceOf = (c: Coral): string =>
    c.parentKey === null ? coralLabel(c.assetId) : `${coralLabel(c.assetId)} fragment`;
  const total = new Map<string, number>();
  for (const c of ordered) total.set(pieceOf(c), (total.get(pieceOf(c)) ?? 0) + 1);
  const seen = new Map<string, number>();
  return ordered.map((coral) => {
    const piece = pieceOf(coral);
    const n = (seen.get(piece) ?? 0) + 1;
    seen.set(piece, n);
    const label = (total.get(piece) ?? 0) > 1 ? `${piece} ${n}` : piece;
    const why = fragWhy(coral, maxBleach);
    return { coral, label, enabled: why === null, why };
  });
}

export type BleachLevel = 'healthy' | 'pale' | 'bleaching' | 'bleached';

export function bleachLevel(bleach: number): BleachLevel {
  if (bleach < 0.05) return 'healthy';
  if (bleach <= DEFAULT_MAX_BLEACH) return 'pale';
  if (bleach <= 0.7) return 'bleaching';
  return 'bleached';
}

const LEVEL_TEXT: Readonly<Record<BleachLevel, string>> = {
  healthy: 'healthy colour',
  pale: 'slightly pale',
  bleaching: 'bleaching',
  bleached: 'badly bleached',
};

export function describeBleach(bleach: number): string {
  return `${LEVEL_TEXT[bleachLevel(bleach)]}, ${percent(bleach)} bleached`;
}

/**
 * Names the lamp when it is set above what a coral in the tank takes: the server bleaches a species
 * once the lamp's tier times intensity passes its `lightMax`. Null when no coral is over the limit.
 */
export function lampWarning(
  corals: readonly Coral[] | undefined,
  light: Equipment['light'],
  content: CoralContent,
): string | null {
  const setting = light.tier * light.intensity;
  const over = new Set<string>();
  const byId = new Map(content.corals.map((s) => [s.id, s]));
  for (const coral of corals ?? []) {
    const spec = byId.get(coralSpeciesId(coral.assetId));
    if (spec && setting > spec.lightMax) over.add(coralLabel(coral.assetId));
  }
  if (over.size === 0) return null;
  return `The lamp is too bright for the ${[...over].join(', ')}. Lower its intensity in the shop's lamp settings or the corals keep bleaching.`;
}

export function reefIsBleaching(corals: readonly Coral[] | undefined): boolean {
  return (corals ?? []).some((c) => c.bleach > DEFAULT_MAX_BLEACH);
}

export function sameCorals(
  a: readonly Coral[] | undefined,
  b: readonly Coral[] | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((c, i) => {
    const d = b[i];
    return (
      d !== undefined &&
      c.key === d.key &&
      c.assetId === d.assetId &&
      c.parentKey === d.parentKey &&
      c.size === d.size &&
      c.minSize === d.minSize &&
      c.maxSize === d.maxSize &&
      c.fragMinSize === d.fragMinSize &&
      c.bleach === d.bleach &&
      c.tintSeed === d.tintSeed &&
      c.position?.[0] === d.position?.[0] &&
      c.position?.[1] === d.position?.[1]
    );
  });
}

export function fragRefusalText(error: unknown, label: string): string | null {
  if (!(error instanceof ApiRequestError)) return null;
  if (error.code === 'rate_limited') {
    return error.retryAfterSeconds === null
      ? 'Too many cuts in a short time. Wait a moment and try again.'
      : `Too many cuts in a short time. Try again in ${error.retryAfterSeconds} seconds.`;
  }
  if (error.status === 404) return `The ${label} is no longer in this tank.`;
  if (error.status !== 409) return null;
  const reason: string | null = error.reason;
  switch (reason) {
    case 'coral_not_grown':
      return `The ${label} has not grown enough to cut a fragment yet.`;
    case 'coral_bleached':
      return `The ${label} is too bleached to cut. Fix the water and the lamp and let it recover.`;
    case 'coral_limit':
      return 'The tank already holds as many fragments as it can.';
    case 'coral_no_room':
      return `There is no room on the substrate near the ${label} for another fragment. Clear some space around it.`;
    case 'key_reused':
      return 'That cut clashed with an earlier one. Press the button again to cut the fragment.';
    default:
      return error.message;
  }
}
