import {
  DEFAULT_EQUIPMENT,
  NEUTRAL_PERSONALITY,
  newTankChemistry,
  breedingSchema,
  speciesChemistrySchema,
  type Fish,
  type SpeciesSummary,
  type Tank,
} from '@aquarium/shared';
import { EventBus } from '../engine/events';
import type { InteractionEvents } from '../interaction/events';
import { ApiRequestError } from '../ui/api';

export const TANK_A = '00000000-0000-4000-8000-00000000000a';
export const TANK_B = '00000000-0000-4000-8000-00000000000b';
export const TANK_C = '00000000-0000-4000-8000-00000000000c';
export const FISH_1 = '10000000-0000-4000-8000-000000000001';
export const FISH_2 = '10000000-0000-4000-8000-000000000002';
export const FISH_3 = '10000000-0000-4000-8000-000000000003';

export function speciesFixture(overrides: Partial<SpeciesSummary> = {}): SpeciesSummary {
  return {
    id: 'neon-tetra',
    commonName: 'Neon tetra',
    scientificName: 'Paracheirodon innesi',
    biome: 'freshwater',
    lifecycle: {
      hungerPerHour: 0.01,
      healthLossPerHourStarving: 0.01,
      healthRecoveryPerHour: 0.01,
      starvationHungerThreshold: 0.75,
      ammoniaTolerance: 0.2,
      birthSizeM: 0.01,
      maxSizeM: 0.04,
      growthPerDay: 0.001,
      lifespanDays: 700,
      diet: ['flakes'],
      bioload: 0.25,
      ammoniaPerBioloadPerHour: 0.01,
    },
    chemistry: speciesChemistrySchema.parse({}),
    breeding: breedingSchema.parse({}),
    ...overrides,
  };
}

export function fishFixture(id: string, overrides: Partial<Fish> = {}): Fish {
  return {
    id,
    tankId: TANK_A,
    species: 'neon-tetra',
    name: `Fish ${id.slice(-1)}`,
    sex: 'female',
    stage: 'adult',
    personality: NEUTRAL_PERSONALITY,
    disease: null,
    bornAt: '2026-01-01T00:00:00.000Z',
    size: 0.02,
    hunger: 0.1,
    health: 1,
    status: 'alive',
    diedAt: null,
    cause: null,
    ...overrides,
  };
}

export function tankFixture(overrides: Partial<Tank> = {}): Tank {
  return {
    id: TANK_A,
    name: 'Home tank',
    biome: 'freshwater',
    decorLayout: [],
    decorEdited: (overrides.decorLayout?.length ?? 0) > 0,
    backgroundId: 'bg-fw-planted-stream',
    water: { ammonia: 0, nitrate: 0, algae: 0, uneatenFood: 0 },
    lastTickAt: '2026-02-01T00:00:00.000Z',
    chemistry: newTankChemistry('freshwater'),
    size: 'standard',
    quarantine: false,
    shared: false,
    shareToken: null,
    equipment: DEFAULT_EQUIPMENT,
    recentVisitDays: 0,
    fish: [],
    memorials: [],
    ...overrides,
  };
}

export function apiError(status: number, code: ApiRequestError['code'], retryAfter?: number) {
  return new ApiRequestError(status, code, `${code} (${status})`, {}, retryAfter ?? null);
}

export function recordBus() {
  const bus = new EventBus<InteractionEvents>();
  const seen: { type: string; payload: unknown }[] = [];
  const types: (keyof InteractionEvents)[] = [
    'tank:loaded',
    'tank:unloaded',
    'tank:none',
    'tank:fish-added',
    'tank:fish-released',
    'tank:fish-died',
    'tank:fish-updated',
    'tank:fish-removed',
    'tank:water',
    'tank:care',
    'tank:decor',
    'tank:background',
    'decor:save-state',
  ];
  for (const type of types) bus.on(type, (payload) => seen.push({ type, payload }));
  return {
    bus,
    seen,
    of: (type: string) => seen.filter((e) => e.type === type).map((e) => e.payload),
  };
}
