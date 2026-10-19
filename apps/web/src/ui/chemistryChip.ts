import type { SpeciesSummary, Tank } from '@aquarium/shared';
import {
  HAZARD_LABEL,
  describeReading,
  padsFor,
  suitability,
  verdictHazard,
  type Hazard,
  type PadId,
} from '../sync/waterTest';
import type { Dip } from './dipStore';

export const STALE_AFTER_MS = 30 * 60_000;

export type ChipStatus = 'none' | 'unread' | 'partial' | 'stale' | 'safe' | 'warning' | 'danger';

export interface ChipValue {
  key: 'ph' | 'ammonia' | 'temperature';
  label: string;
  text: string;
}

export interface ChipState {
  status: ChipStatus;
  verdict: string;
  values: ChipValue[];
  ageText: string;
  ariaLabel: string;
}

const HAZARD_RANK: Record<Hazard, number> = { safe: 0, caution: 1, danger: 2 };
const STATUS_OF: Record<Hazard, ChipStatus> = {
  safe: 'safe',
  caution: 'warning',
  danger: 'danger',
};
const VERDICT: Record<ChipStatus, string> = {
  none: 'No test yet',
  unread: 'Read the pads',
  partial: 'Read the other pads',
  stale: 'Stale reading',
  safe: HAZARD_LABEL.safe,
  warning: 'Warning',
  danger: HAZARD_LABEL.danger,
};

function ageText(at: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return minutes === 1 ? '1 minute ago' : `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
}

export function chipState(
  tank: Tank,
  species: readonly SpeciesSummary[],
  dip: Dip | null,
  now: number,
): ChipState {
  if (!dip) {
    return {
      status: 'none',
      verdict: VERDICT.none,
      values: [],
      ageText: '',
      ariaLabel: 'Water chemistry: no test yet. Open care to dip a test strip.',
    };
  }
  const pads = padsFor(tank.biome);
  const isKnown = (id: PadId) =>
    dip.strip[id] !== undefined && (dip.revealed || dip.guesses[id] !== undefined);
  const knownPads = pads.filter(isKnown);
  let worst: Hazard = 'safe';
  for (const id of knownPads) {
    const reading = dip.strip[id];
    if (!reading) continue;
    const hazard = verdictHazard(tank, species, reading);
    if (HAZARD_RANK[hazard] > HAZARD_RANK[worst]) worst = hazard;
  }
  if (
    worst === 'safe' &&
    suitability(tank, species, 'temperatureC', dip.temperatureC) === 'outside'
  ) {
    worst = 'caution';
  }
  const allRead = knownPads.length === pads.length;
  const judged = worst !== 'safe' || allRead;

  const stale = now - dip.at > STALE_AFTER_MS;
  const status: ChipStatus = stale
    ? 'stale'
    : judged
      ? STATUS_OF[worst]
      : knownPads.length === 0
        ? 'unread'
        : 'partial';

  const value = (id: 'ph' | 'ammonia', label: string): ChipValue | null => {
    if (!pads.includes(id)) return null;
    return { key: id, label, text: isKnown(id) ? describeReading(dip.strip[id]) : '?' };
  };
  const values = [
    value('ph', 'pH'),
    value('ammonia', 'Ammonia'),
    {
      key: 'temperature',
      label: 'Temp',
      text: `${dip.temperatureC.toFixed(1)} °C`,
    } satisfies ChipValue,
  ].filter((v): v is ChipValue => v !== null);

  const age = ageText(dip.at, now);
  const verdict =
    status === 'stale' && judged
      ? `${VERDICT.stale}, was ${VERDICT[STATUS_OF[worst]].toLowerCase()}`
      : VERDICT[status];
  const spoken = values
    .map((v) => `${v.label} ${v.text === '?' ? 'not read yet' : v.text}`)
    .join(', ');
  return {
    status,
    verdict,
    values,
    ageText: age,
    ariaLabel: `Water chemistry: ${verdict}. ${spoken}. Tested ${age}. Open care for the full test kit.`,
  };
}
