import {
  coralSpeciesId,
  type Chemistry,
  type CoralParameters,
  type CoralSpecies,
  type Equipment,
  type StoredCoral,
} from '@aquarium/shared';
import { unitHash } from './breeding.ts';
import { layoutPlantKeys, START_SIZE, type LayoutPlant, type PlantBounds } from './plants.ts';
import { lampIsOn } from './water.ts';

export type CoralState = StoredCoral;

export interface CoralTable {
  readonly params: CoralParameters;
  readonly species: ReadonlyMap<string, CoralSpecies>;
}

export interface CoralStepContext {
  readonly nowMs: number;
  readonly dtHours: number;
  readonly equipment: Equipment;
  readonly table: CoralTable;
}

const PLACEMENT_ATTEMPTS = 8;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export function coralSpecOf(table: CoralTable, assetId: string): CoralSpecies {
  const spec = table.species.get(coralSpeciesId(assetId));
  if (!spec)
    throw new Error(`corals: no growth content for "${assetId}"; add it to content/corals.json`);
  return spec;
}

const outside = (value: number, [lo, hi]: readonly [number, number], span: number): number =>
  Math.max(lo - value, value - hi, 0) / span;

/**
 * How far the water and light are from what a coral takes, 0 (fine) to 1 (every colony of the
 * species bleaches fully in the end). The worst single factor decides. Light counts at the lamp's
 * setting, not by the hour, so a coral does not bleach by day and recover by night.
 */
export function coralStress(
  spec: CoralSpecies,
  chemistry: Chemistry,
  equipment: Equipment,
): number {
  const lightSetting = equipment.light.tier * equipment.light.intensity;
  return clamp(
    Math.max(
      outside(chemistry.temperatureC, spec.temperatureC, spec.temperatureSpanC),
      outside(chemistry.salinity, spec.salinity, spec.salinitySpan),
      outside(chemistry.kh, spec.kh, spec.khSpan),
      outside(chemistry.ph, spec.ph, spec.phSpan),
      Math.max(0, lightSetting - spec.lightMax) / spec.lightMaxSpan,
    ),
    0,
    1,
  );
}

/**
 * One step of the reef: bleaching towards the stress the water puts on each coral and recovery back
 * out of it, and growth from light and flow, scaled by how healthy the colony is. Pure and
 * step-local, so splitting a catch-up anywhere gives the same result as running it whole.
 */
export function stepCorals(
  corals: readonly CoralState[],
  chemistry: Chemistry,
  ctx: CoralStepContext,
): CoralState[] {
  if (corals.length === 0) return [];
  const { params } = ctx.table;
  const { light, waveMaker } = ctx.equipment;
  const lit = lampIsOn(ctx.nowMs, ctx.dtHours, light.onHour, light.offHour);
  const lightLevel = lit ? light.tier * light.intensity : 0;
  const flow = params.flowPerWaveMakerTier[waveMaker.tier];
  if (flow === undefined) {
    throw new Error(`corals: no flow value for wave maker tier ${waveMaker.tier}`);
  }

  const stressOf = new Map<string, number>();
  return corals.map((c) => {
    const spec = coralSpecOf(ctx.table, c.assetId);
    let stress = stressOf.get(spec.id);
    if (stress === undefined) {
      stress = coralStress(spec, chemistry, ctx.equipment);
      stressOf.set(spec.id, stress);
    }
    const rate = stress > c.bleach ? params.bleachPerHour : params.recoverPerHour;
    const bleach = clamp(stress + (c.bleach - stress) * Math.exp(-rate * ctx.dtHours), 0, 1);

    const health = 1 - Math.max(bleach, stress);
    const grown =
      (spec.growthPerDay / 24) *
      Math.min(1, lightLevel / spec.lightDemand) *
      Math.min(1, flow / spec.flowDemand) *
      health *
      c.size *
      Math.max(0, 1 - c.size / spec.maxSize) *
      ctx.dtHours;
    return { ...c, bleach, size: c.size + Math.min(grown, spec.maxSize - c.size) };
  });
}

/**
 * Lines the stored coral state up with the decor layout: a coral new to the layout starts at size 1
 * and unbleached, one that left it takes its fragments with it, and a moved one keeps its state.
 */
export function reconcileCorals(
  layout: readonly LayoutPlant[],
  stored: readonly CoralState[],
  table: CoralTable,
): CoralState[] {
  const coralLayout = layout.filter((item) => table.species.has(coralSpeciesId(item.assetId)));
  const keys = layoutPlantKeys(coralLayout);
  const byKey = new Map(stored.map((c) => [c.key, c]));
  const keptKeys = new Set<string>();
  const roots = coralLayout.map((item, i): CoralState => {
    const key = keys[i];
    if (key === undefined) throw new Error('corals: layoutPlantKeys lost a key');
    const position: [number, number] = [item.position[0], item.position[2]];
    const kept = byKey.get(key);
    if (kept && kept.assetId === item.assetId && kept.parentKey === null) {
      keptKeys.add(key);
      return { ...kept, position };
    }
    return {
      key,
      assetId: item.assetId,
      parentKey: null,
      position,
      size: START_SIZE,
      bleach: 0,
      spawned: 0,
    };
  });
  const alive = new Set(keptKeys);
  const frags = stored.filter(
    (c) => c.parentKey !== null && table.species.has(coralSpeciesId(c.assetId)),
  );
  for (let grew = true; grew;) {
    grew = false;
    for (const f of frags) {
      if (!alive.has(f.key) && f.parentKey !== null && alive.has(f.parentKey)) {
        alive.add(f.key);
        grew = true;
      }
    }
  }
  return [...roots, ...stored.filter((c) => c.parentKey !== null && alive.has(c.key))];
}

function rootOf(corals: readonly CoralState[], coral: CoralState): CoralState {
  let current = coral;
  while (current.parentKey !== null) {
    const parentKey: string = current.parentKey;
    const next = corals.find((c) => c.key === parentKey);
    if (!next) throw new Error(`corals: "${current.key}" lost its parent "${parentKey}"`);
    current = next;
  }
  return current;
}

function fragPosition(
  parent: CoralState,
  fragKey: string,
  corals: readonly CoralState[],
  table: CoralTable,
  bounds: PlantBounds,
): [number, number] {
  const { params } = table;
  if (!parent.position) throw new Error(`corals: "${parent.key}" has no position to cut beside`);
  const [px, pz] = parent.position;
  const limitX = Math.max(0, bounds.halfX - params.edgeMarginM);
  const limitZ = Math.max(0, bounds.halfZ - params.edgeMarginM);
  const occupied = corals.flatMap((o) => (o.position ? [o.position] : []));
  let candidate: [number, number] = [px, pz];
  for (let attempt = 0; attempt < PLACEMENT_ATTEMPTS; attempt++) {
    const seed = `${fragKey}:${attempt}`;
    const angle = unitHash(`${seed}:a`) * 2 * Math.PI;
    const reach = params.fragRadiusM * (0.4 + 0.6 * unitHash(`${seed}:r`));
    candidate = [
      clamp(px + Math.cos(angle) * reach, -limitX, limitX),
      clamp(pz + Math.sin(angle) * reach, -limitZ, limitZ),
    ];
    const [cx, cz] = candidate;
    if (occupied.every(([x, z]) => Math.hypot(x - cx, z - cz) >= params.fragSpacingM)) break;
  }
  return candidate;
}

export type FragResult =
  | { readonly ok: true; readonly corals: CoralState[]; readonly fragKey: string }
  | {
      readonly ok: false;
      readonly reason: 'unknown' | 'not_grown' | 'bleached' | 'limit';
    };

/** The fragment is cut from the colony's mass: the colony loses what the fragment starts with. */
export function fragCoral(
  corals: readonly CoralState[],
  key: string,
  table: CoralTable,
  bounds: PlantBounds,
): FragResult {
  const parent = corals.find((c) => c.key === key);
  if (!parent) return { ok: false, reason: 'unknown' };
  const spec = coralSpecOf(table, parent.assetId);
  const { params } = table;
  if (parent.size < spec.fragMinSize) return { ok: false, reason: 'not_grown' };
  if (parent.bleach > params.fragMaxBleach) return { ok: false, reason: 'bleached' };
  if (corals.filter((c) => c.parentKey !== null).length >= params.maxFragsPerTank) {
    return { ok: false, reason: 'limit' };
  }
  const root = rootOf(corals, parent);
  const spawned = root.spawned + 1;
  const fragKey = `${root.key}.${spawned}`;
  const frag: CoralState = {
    key: fragKey,
    assetId: parent.assetId,
    parentKey: parent.key,
    position: fragPosition(parent, fragKey, corals, table, bounds),
    size: params.fragStartSize,
    bleach: 0,
    spawned: 0,
  };
  return {
    ok: true,
    fragKey,
    corals: [
      ...corals.map((c) => {
        const cut = c.key === key ? { size: c.size - params.fragStartSize } : {};
        const counted = c.key === root.key ? { spawned } : {};
        return { ...c, ...cut, ...counted };
      }),
      frag,
    ],
  };
}
