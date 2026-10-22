import {
  REPLAY_MAX_LIMIT,
  type AwaySummary,
  type CareEvent,
  type Fish,
  type FoodType,
} from '@aquarium/shared';
import type { ApiClient } from '../ui/api';
import { CAUSE_TEXT, formatDuration, speciesName, type SpeciesNames } from './life';

export const MAX_REPLAY_PAGES = 10;
export const REPLAY_STEP_MS = 700;
export const REPLAY_SPEEDS = [1, 2, 4] as const;
export type ReplaySpeed = (typeof REPLAY_SPEEDS)[number];

export type ReplayApi = Pick<ApiClient, 'replay'>;

export interface Timeline {
  events: CareEvent[];
  /** More events exist than were loaded; the page budget ran out. */
  truncated: boolean;
}

export function orderEvents(events: readonly CareEvent[]): CareEvent[] {
  const seen = new Set<string>();
  const unique = events.filter((e) => !seen.has(e.id) && seen.add(e.id));
  return unique.sort((a, b) => {
    const dt = Date.parse(a.at) - Date.parse(b.at);
    if (dt !== 0) return dt;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

function withoutMoveKey(event: CareEvent): CareEvent {
  if (event.kind !== 'fish_moved') return event;
  const { fishId, direction, otherTankId } = event.payload;
  return { ...event, payload: { fishId, direction, otherTankId } };
}

export async function loadTimeline(
  api: ReplayApi,
  tankId: string,
  since: string,
  options: { pageSize?: number; maxPages?: number; until?: string; signal?: AbortSignal } = {},
): Promise<Timeline> {
  const limit = options.pageSize ?? REPLAY_MAX_LIMIT;
  const maxPages = options.maxPages ?? MAX_REPLAY_PAGES;
  const collected: CareEvent[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page += 1) {
    options.signal?.throwIfAborted();
    const res = await api.replay(
      tankId,
      {
        since,
        limit,
        ...(options.until ? { until: options.until } : {}),
        ...(cursor ? { cursor } : {}),
      },
      options.signal,
    );
    collected.push(...res.events.map(withoutMoveKey));
    if (res.nextCursor === null) return { events: orderEvents(collected), truncated: false };
    cursor = res.nextCursor;
  }
  return { events: orderEvents(collected), truncated: true };
}

export type FishNames = ReadonlyMap<string, string>;

/** Names for the fish in the tank, plus those the away summary names that have since been netted. */
export function fishNamesFor(fish: readonly Fish[], away: AwaySummary | undefined): FishNames {
  const names = new Map<string, string>();
  for (const d of away?.deaths ?? []) names.set(d.fishId, d.name);
  for (const b of away?.births ?? []) names.set(b.fishId, b.name);
  for (const f of fish) names.set(f.id, f.name);
  return names;
}

const FOOD_TEXT: Record<FoodType, string> = {
  flakes: 'flakes',
  pellets: 'pellets',
  bloodworms: 'bloodworms',
  'brine-shrimp': 'brine shrimp',
  nori: 'nori',
  'algae-wafer': 'an algae wafer',
};

const METRIC_TEXT = { ammonia: 'Ammonia', nitrite: 'Nitrite', algae: 'Algae' } as const;

export type ReplayTone = 'calm' | 'good' | 'warn' | 'loss';

export interface ReplayLine {
  id: string;
  at: string;
  text: string;
  tone: ReplayTone;
}

function fishLabel(fish: FishNames, id: string): string {
  return fish.get(id) ?? 'A fish';
}

export function describeEvent(event: CareEvent, fish: FishNames, names: SpeciesNames): ReplayLine {
  const base = { id: event.id, at: event.at };
  switch (event.kind) {
    case 'feed':
      return { ...base, text: `Fed ${FOOD_TEXT[event.payload.food]}.`, tone: 'calm' };
    case 'ate':
      return { ...base, text: `${fishLabel(fish, event.payload.fishId)} ate.`, tone: 'calm' };
    case 'water_change':
      return { ...base, text: 'Water changed.', tone: 'good' };
    case 'gravel_vacuum':
      return { ...base, text: 'Gravel vacuumed.', tone: 'good' };
    case 'algae_scrape':
      return { ...base, text: 'Algae scraped off the glass.', tone: 'good' };
    case 'bottled_bacteria':
      return { ...base, text: 'Bottled bacteria added to the filter.', tone: 'good' };
    case 'salt_dose':
      return { ...base, text: 'Salt mix dissolved into the water.', tone: 'good' };
    case 'buffer_dose':
      return { ...base, text: 'Buffer dissolved into the water.', tone: 'good' };
    case 'add_botanicals':
      return { ...base, text: 'Botanicals added to the water.', tone: 'good' };
    case 'filter_rinse':
      return { ...base, text: 'Filter rinsed.', tone: 'good' };
    case 'born':
      return {
        ...base,
        text: `A ${speciesName(names, event.payload.species)} fry was born.`,
        tone: 'good',
      };
    case 'sick':
      return { ...base, text: `${fishLabel(fish, event.payload.fishId)} fell ill.`, tone: 'warn' };
    case 'death':
      return {
        ...base,
        text: `${fishLabel(fish, event.payload.fishId)} ${CAUSE_TEXT[event.payload.cause]}.`,
        tone: 'loss',
      };
    case 'fish_moved': {
      const who = fishLabel(fish, event.payload.fishId);
      return {
        ...base,
        text:
          event.payload.direction === 'out'
            ? `${who} was moved to another tank.`
            : `${who} was moved here from another tank.`,
        tone: 'calm',
      };
    }
    case 'water_alert': {
      const metric = METRIC_TEXT[event.payload.metric];
      return event.payload.state === 'high'
        ? { ...base, text: `${metric} rose too high.`, tone: 'warn' }
        : { ...base, text: `${metric} came back to normal.`, tone: 'good' };
    }
  }
}

export function offsetLabel(since: string, at: string): string {
  const minutes = (Date.parse(at) - Date.parse(since)) / 60_000;
  if (minutes < 1) return 'right away';
  return `${formatDuration(minutes)} in`;
}

export function replayFailureText(error: unknown, online: boolean): string {
  if (!online) return 'You are offline. Reconnect to watch the replay.';
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? (error as { code: unknown }).code
      : null;
  if (code === 'network' || code === 'timeout') {
    return 'The replay could not be reached. Check your connection and try again.';
  }
  if (code === 'rate_limited') return 'The replay was asked for too often. Try again in a minute.';
  return 'The replay could not be loaded. You can skip it or try again.';
}
