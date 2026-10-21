import type {
  Equipment,
  PlantParameters,
  PlantSpecies,
  StoredPlant,
  Water,
} from '@aquarium/shared';
import { unitHash } from './breeding.ts';
import { REFERENCE_TANK_LITRES } from './params.ts';
import { lampIsOn } from './water.ts';

export type PlantState = StoredPlant;

export interface PlantTable {
  readonly params: PlantParameters;
  readonly species: ReadonlyMap<string, PlantSpecies>;
}

/** The substrate's half extents in metres, x along the glass and z front to back. */
export interface PlantBounds {
  readonly halfX: number;
  readonly halfZ: number;
}

export interface PlantStepContext {
  readonly nowMs: number;
  readonly dtHours: number;
  readonly litres: number;
  readonly equipment: Equipment;
  readonly table: PlantTable;
  readonly bounds: PlantBounds;
}

export const START_SIZE = 1;
const PLACEMENT_ATTEMPTS = 8;

function specOf(table: PlantTable, assetId: string): PlantSpecies {
  const spec = table.species.get(assetId);
  if (!spec)
    throw new Error(`plants: no growth content for "${assetId}"; add it to content/plants.json`);
  return spec;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

function placeOffset(
  parent: PlantState,
  spec: PlantSpecies,
  occupied: readonly (readonly [number, number])[],
  ctx: PlantStepContext,
): [number, number] {
  const { params } = ctx.table;
  const spread = spec.spread;
  if (!spread || !parent.position) throw new Error(`plants: "${parent.key}" cannot root an offset`);
  const [px, pz] = parent.position;
  const limitX = Math.max(0, ctx.bounds.halfX - params.edgeMarginM);
  const limitZ = Math.max(0, ctx.bounds.halfZ - params.edgeMarginM);
  let candidate: [number, number] = [px, pz];
  for (let attempt = 0; attempt < PLACEMENT_ATTEMPTS; attempt++) {
    const seed = `${parent.key}:${parent.spawned}:${attempt}`;
    const angle = unitHash(`${seed}:a`) * 2 * Math.PI;
    const reach = spread.radiusM * (0.4 + 0.6 * unitHash(`${seed}:r`));
    candidate = [
      clamp(px + Math.cos(angle) * reach, -limitX, limitX),
      clamp(pz + Math.sin(angle) * reach, -limitZ, limitZ),
    ];
    const [cx, cz] = candidate;
    if (occupied.every(([x, z]) => Math.hypot(x - cx, z - cz) >= params.offsetSpacingM)) break;
  }
  return candidate;
}

/**
 * One step of the planting: growth from light, nitrate and CO2, the nitrate that growth takes up,
 * offsets from runner and carpet plants, and the algae the active plants hold back. Pure and
 * step-local, so splitting a catch-up anywhere gives the same result as running it whole.
 */
export function stepPlants(
  plants: readonly PlantState[],
  water: Water,
  ctx: PlantStepContext,
): { plants: PlantState[]; water: Water } {
  if (plants.length === 0) return { plants: [], water };
  const { params } = ctx.table;
  const { light, co2 } = ctx.equipment;
  const lit = lampIsOn(ctx.nowMs, ctx.dtHours, light.onHour, light.offHour);
  const lightLevel = lit ? light.tier * light.intensity : 0;
  const co2Growth = params.co2GrowthPerTier[co2.tier];
  if (co2Growth === undefined) throw new Error(`plants: no CO2 growth value for tier ${co2.tier}`);
  const volume = ctx.litres / REFERENCE_TANK_LITRES;

  const offsetCounts = new Map<string, number>();
  let offsets = 0;
  for (const p of plants) {
    if (p.parentKey === null) continue;
    offsets++;
    offsetCounts.set(p.parentKey, (offsetCounts.get(p.parentKey) ?? 0) + 1);
  }

  let nitrate = water.nitrate;
  let competition = 0;
  const next: PlantState[] = [];
  const born: PlantState[] = [];
  for (const p of plants) {
    const spec = specOf(ctx.table, p.assetId);
    const lightFactor = Math.min(1, lightLevel / spec.lightDemand);
    const nutrientFactor = nitrate / (nitrate + spec.nitrateHalfSaturation);
    const activity = lightFactor * nutrientFactor;
    const co2Factor = 1 + spec.co2Response * (co2Growth - 1);
    const wanted =
      (spec.growthPerDay / 24) *
      co2Factor *
      activity *
      p.size *
      Math.max(0, 1 - p.size / spec.maxSize) *
      ctx.dtHours;
    const nitratePerSize = spec.nitratePerSize / volume;
    const affordable = nitratePerSize > 0 ? nitrate / nitratePerSize : Infinity;
    const grown = Math.max(0, Math.min(wanted, affordable, spec.maxSize - p.size));
    nitrate = Math.max(0, nitrate - grown * nitratePerSize);
    const size = p.size + grown;
    competition += spec.coverage * size * activity;

    let spreadProgress = p.spreadProgress;
    let spawned = p.spawned;
    if (spec.spread && p.parentKey === null && size >= spec.spread.minParentSize) {
      spreadProgress = Math.min(
        1,
        spreadProgress + (activity * ctx.dtHours) / (24 * spec.spread.intervalDays),
      );
      const own = offsetCounts.get(p.key) ?? 0;
      if (spreadProgress >= 1 && own < spec.spread.cap && offsets < params.maxOffsetsPerTank) {
        const occupied = [...plants, ...born].flatMap((o) => (o.position ? [o.position] : []));
        const position = placeOffset({ ...p, spawned }, spec, occupied, ctx);
        spawned++;
        spreadProgress = 0;
        offsets++;
        offsetCounts.set(p.key, own + 1);
        born.push({
          key: `${p.key}.${spawned}`,
          assetId: p.assetId,
          parentKey: p.key,
          position,
          size: params.offsetStartSize,
          spreadProgress: 0,
          spawned: 0,
        });
      }
    }
    next.push({ ...p, size, spreadProgress, spawned });
  }

  const suppression = Math.exp(
    -(params.algaeSuppressionPerHour * competition * ctx.dtHours) / volume,
  );
  return {
    plants: [...next, ...born],
    water: { ...water, nitrate, algae: water.algae * suppression },
  };
}

export interface LayoutPlant {
  readonly assetId: string;
  readonly position: readonly [number, number, number];
  readonly tintSeed: number;
}

export function layoutPlantKeys(layout: readonly LayoutPlant[]): string[] {
  const seen = new Map<string, number>();
  return layout.map((item) => {
    const base = `s${item.tintSeed}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}-${n}`;
  });
}

/**
 * Lines the stored growth state up with the decor layout: a plant new to the layout starts at size 1,
 * one that left it takes its offsets with it, and a moved one keeps its size.
 */
export function reconcilePlants(
  layout: readonly LayoutPlant[],
  stored: readonly PlantState[],
  table: PlantTable,
): PlantState[] {
  const plantLayout = layout.filter((item) => table.species.has(item.assetId));
  const keys = layoutPlantKeys(plantLayout);
  const byKey = new Map(stored.map((p) => [p.key, p]));
  const roots = plantLayout.map((item, i): PlantState => {
    const key = keys[i];
    if (key === undefined) throw new Error('plants: layoutPlantKeys lost a key');
    const position: [number, number] = [item.position[0], item.position[2]];
    const kept = byKey.get(key);
    return kept && kept.assetId === item.assetId && kept.parentKey === null
      ? { ...kept, position }
      : {
          key,
          assetId: item.assetId,
          parentKey: null,
          position,
          size: START_SIZE,
          spreadProgress: 0,
          spawned: 0,
        };
  });
  const rootKeys = new Set(keys);
  const offsets = stored.filter(
    (p) => p.parentKey !== null && rootKeys.has(p.parentKey) && table.species.has(p.assetId),
  );
  return [...roots, ...offsets];
}

export type TrimResult =
  | { readonly ok: true; readonly plants: PlantState[] }
  | { readonly ok: false; readonly reason: 'unknown' | 'below_minimum' | 'not_grown' };

/** The cut mass simply leaves: nothing is returned to the water. */
export function trimPlant(
  plants: readonly PlantState[],
  key: string,
  size: number,
  table: PlantTable,
): TrimResult {
  const plant = plants.find((p) => p.key === key);
  if (!plant) return { ok: false, reason: 'unknown' };
  const spec = specOf(table, plant.assetId);
  if (size < spec.minSize) return { ok: false, reason: 'below_minimum' };
  if (size >= plant.size) return { ok: false, reason: 'not_grown' };
  return { ok: true, plants: plants.map((p) => (p.key === key ? { ...p, size } : p)) };
}
