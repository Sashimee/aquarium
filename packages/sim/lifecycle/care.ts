import type {
  Biome,
  CareAction,
  Chemistry,
  ChemistryParameters,
  FoodType,
  Water,
} from '@aquarium/shared';
import {
  FUTURE_SKEW_MS,
  HUNGER_PER_PORTION,
  MAX_PORTIONS_PER_FISH_PER_WINDOW,
  MAX_UNEATEN_FOOD,
  WATER_CHANGE_FRACTION,
} from './params.ts';
import type { LifecycleState } from './types.ts';

const FRESHWATER_FOODS: readonly FoodType[] = ['flakes', 'pellets', 'bloodworms', 'algae-wafer'];

const FOODS_BY_BIOME: Record<Biome, readonly FoodType[]> = {
  freshwater: FRESHWATER_FOODS,
  reef: ['flakes', 'pellets', 'brine-shrimp', 'nori', 'algae-wafer'],
  cichlid: FRESHWATER_FOODS,
  blackwater: FRESHWATER_FOODS,
  mangrove: ['flakes', 'pellets', 'brine-shrimp', 'algae-wafer'],
};

export type Rejection = { ok: false; reason: string };
export type Accepted<T> = { ok: true; value: T };

function accept(
  state: LifecycleState,
  patch: Partial<Water>,
  chemistry: Chemistry = state.chemistry,
): Accepted<LifecycleState> {
  return { ok: true, value: { ...state, water: { ...state.water, ...patch }, chemistry } };
}

export function applyCare(
  state: LifecycleState,
  action: CareAction,
  biome: Biome,
  params: ChemistryParameters,
): Accepted<LifecycleState> | Rejection {
  const { water, chemistry } = state;
  switch (action.type) {
    case 'feed': {
      if (!FOODS_BY_BIOME[biome].includes(action.food)) {
        return { ok: false, reason: `${action.food} cannot be fed in a ${biome} tank.` };
      }
      if (water.uneatenFood + action.portion > MAX_UNEATEN_FOOD) {
        return {
          ok: false,
          reason: 'There is already too much uneaten food in the tank. Vacuum the gravel first.',
        };
      }
      return accept(state, { uneatenFood: water.uneatenFood + action.portion });
    }
    case 'water_change':
      return accept(
        state,
        {
          ammonia: water.ammonia * (1 - WATER_CHANGE_FRACTION),
          nitrate: water.nitrate * (1 - WATER_CHANGE_FRACTION),
        },
        {
          ...chemistry,
          nitrite: chemistry.nitrite * (1 - WATER_CHANGE_FRACTION),
          kh:
            chemistry.kh +
            (params.kh.sourceWater[biome] - chemistry.kh) * params.kh.restoredPerWaterChange,
        },
      );
    case 'bottled_bacteria': {
      const dose = params.bacteria.bottledBoost;
      return accept(
        state,
        {},
        {
          ...chemistry,
          bacteria: {
            ammoniaOxidisers: Math.min(1, chemistry.bacteria.ammoniaOxidisers + dose),
            nitriteOxidisers: Math.min(1, chemistry.bacteria.nitriteOxidisers + dose),
          },
        },
      );
    }
    case 'filter_rinse': {
      const kept = params.bacteria.rinseSurvival;
      return accept(
        state,
        {},
        {
          ...chemistry,
          bacteria: {
            ammoniaOxidisers: chemistry.bacteria.ammoniaOxidisers * kept,
            nitriteOxidisers: chemistry.bacteria.nitriteOxidisers * kept,
          },
        },
      );
    }
    case 'gravel_vacuum':
      return accept(state, { uneatenFood: 0 });
    case 'algae_scrape':
      return accept(state, { algae: 0 });
  }
}

export interface EatReport {
  readonly fishId: string;
  readonly portion: number;
  readonly atMs: number;
}

export interface EatingContext {
  readonly nowMs: number;
  readonly windowMs: number;
  readonly fedInWindow: number;
  readonly eatenInWindow: number;
  readonly eatenByFishInWindow: ReadonlyMap<string, number>;
}

/** Consumption must be backed by food that was actually dropped in the window and is still in the tank. */
export function applyEating(
  state: LifecycleState,
  reports: readonly EatReport[],
  ctx: EatingContext,
): Accepted<LifecycleState> | Rejection {
  const alive = new Set(state.fish.filter((f) => f.alive).map((f) => f.id));
  const perFish = new Map(ctx.eatenByFishInWindow);
  const eatenNow = new Map<string, number>();
  let total = 0;

  for (const report of reports) {
    if (!alive.has(report.fishId)) {
      return { ok: false, reason: 'A report names a fish that is not alive in this tank.' };
    }
    if (report.atMs > ctx.nowMs + FUTURE_SKEW_MS) {
      return { ok: false, reason: 'A report is timestamped in the future.' };
    }
    if (report.atMs < ctx.nowMs - ctx.windowMs) {
      return { ok: false, reason: 'A report is older than the feeding window.' };
    }
    total += report.portion;
    perFish.set(report.fishId, (perFish.get(report.fishId) ?? 0) + report.portion);
    eatenNow.set(report.fishId, (eatenNow.get(report.fishId) ?? 0) + report.portion);
  }

  for (const eaten of perFish.values()) {
    if (eaten > MAX_PORTIONS_PER_FISH_PER_WINDOW) {
      return { ok: false, reason: 'A single fish cannot eat that much within the window.' };
    }
  }
  if (ctx.eatenInWindow + total > ctx.fedInWindow + 1e-9) {
    return { ok: false, reason: 'Reported consumption exceeds the food dropped in the window.' };
  }
  if (total > state.water.uneatenFood + 1e-9) {
    return { ok: false, reason: 'Reported consumption exceeds the food left in the tank.' };
  }

  return {
    ok: true,
    value: {
      chemistry: state.chemistry,
      water: { ...state.water, uneatenFood: Math.max(0, state.water.uneatenFood - total) },
      fish: state.fish.map((f) => {
        const eaten = eatenNow.get(f.id);
        return eaten === undefined
          ? f
          : { ...f, hunger: Math.max(0, f.hunger - eaten * HUNGER_PER_PORTION) };
      }),
    },
  };
}

export interface CapacityFish {
  readonly alive: boolean;
  readonly maxBioload: number;
}

export function hasCapacityFor(
  existing: readonly CapacityFish[],
  incomingBioload: number,
  capacity: number,
  maxFish: number,
): boolean {
  const living = existing.filter((f) => f.alive);
  if (living.length + 1 > maxFish) return false;
  const load = living.reduce((sum, f) => sum + f.maxBioload, 0);
  return load + incomingBioload <= capacity + 1e-9;
}
