import type { DecorItem, PlantPatch, PresetLayout } from '@aquarium/shared';
import { DEFAULT_TANK, sameTank, type TankDimensions } from '../engine/tank/dimensions';
import { substrateHeight } from '../engine/tank/substrate';
import type { AssetCatalog } from './assets';
import { anemoneReach } from './anemone';
import type { CurrentParameters } from './current';
import { euphylliaReach, generateEuphyllia, parseEuphylliaId } from './euphyllia';
import { SURFACE_MARGIN } from './plants';

const MIN_PLANT_SCALE = 0.05;
const WALL_MARGIN = 0.005;

interface Footprint {
  readonly min: readonly number[];
  readonly max: readonly number[];
}

export interface FitModel {
  readonly bounds: Footprint;
  /** Radius a swaying item reaches in the current at `item.scale`, null for rigid ones. */
  readonly swayReach: ((item: DecorItem) => number) | null;
}

/** The model of an asset at scale 1, or null when the catalog has no bounds for it. */
export type BoundsOf = (assetId: string) => FitModel | null;

export function boundsFromCatalog(
  catalog: Pick<AssetCatalog, 'get'>,
  current: CurrentParameters,
): BoundsOf {
  return (assetId) => {
    const procedural = parseEuphylliaId(assetId);
    if (procedural) {
      const { bounds } = generateEuphyllia(procedural.variant, procedural.seed, 2);
      return { bounds, swayReach: (item) => euphylliaReach(bounds, item, current) };
    }
    const entry = catalog.get(assetId);
    if (!entry.bounds) return null;
    return {
      bounds: entry.bounds,
      swayReach: entry.kind === 'anemone' ? (item) => anemoneReach(entry, item, current) : null,
    };
  };
}

/** How the standard-tank layouts the presets are authored in shrink to fit a smaller tank. */
export function layoutScale(dimensions: TankDimensions): number {
  return Math.min(
    1,
    dimensions.length / DEFAULT_TANK.length,
    dimensions.depth / DEFAULT_TANK.depth,
  );
}

function rotatedReach(bounds: Footprint, rotationY: number): { x: number; z: number } {
  const [x0 = 0, , z0 = 0] = bounds.min;
  const [x1 = 0, , z1 = 0] = bounds.max;
  const cos = Math.cos(rotationY);
  const sin = Math.sin(rotationY);
  let x = 0;
  let z = 0;
  for (const [px, pz] of [
    [x0, z0],
    [x0, z1],
    [x1, z0],
    [x1, z1],
  ] as const) {
    x = Math.max(x, Math.abs(px * cos + pz * sin));
    z = Math.max(z, Math.abs(-px * sin + pz * cos));
  }
  return { x, z };
}

function fitItem(item: DecorItem, dimensions: TankDimensions, boundsOf: BoundsOf): DecorItem {
  const lenR = dimensions.length / DEFAULT_TANK.length;
  const depR = dimensions.depth / DEFAULT_TANK.depth;
  const k = layoutScale(dimensions);
  const halfL = dimensions.length / 2 - dimensions.glass - WALL_MARGIN;
  const halfD = dimensions.depth / 2 - dimensions.glass - WALL_MARGIN;
  const waterTop = dimensions.height - dimensions.freeboard;

  let x = item.position[0] * lenR;
  let z = item.position[2] * depR;
  const seatOffset =
    item.position[1] - substrateHeight(DEFAULT_TANK, item.position[0], item.position[2]);
  let y = substrateHeight(dimensions, x, z) + seatOffset * k;
  let scale = item.scale * k;

  const model = boundsOf(item.assetId);
  if (model) {
    const height = model.bounds.max[1] ?? 0;
    if (height > 0) scale = Math.min(scale, (waterTop - SURFACE_MARGIN - y) / height);
    const footprint = rotatedReach(model.bounds, item.rotationY);
    let reachX = (s: number) => footprint.x * s;
    let reachZ = (s: number) => footprint.z * s;
    const { swayReach } = model;
    if (swayReach) {
      const base = swayReach({ ...item, scale: 0 });
      const slope = swayReach({ ...item, scale: 1 }) - base;
      reachX = (s) => base + slope * s;
      reachZ = reachX;
    }
    const growth = (room: number, reach: (s: number) => number) => {
      const base = reach(0);
      const slope = reach(1) - base;
      return slope > 0 ? (room - base) / slope : Infinity;
    };
    scale = Math.min(scale, growth(halfL, reachX), growth(halfD, reachZ));
    const limitX = Math.max(0, halfL - reachX(scale));
    const limitZ = Math.max(0, halfD - reachZ(scale));
    x = Math.max(-limitX, Math.min(limitX, x));
    z = Math.max(-limitZ, Math.min(limitZ, z));
    y = substrateHeight(dimensions, x, z) + seatOffset * k;
    if (height > 0) scale = Math.min(scale, (waterTop - SURFACE_MARGIN - y) / height);
  }
  return { ...item, position: [x, y, z], scale: Math.max(scale, MIN_PLANT_SCALE) };
}

function fitPatch(
  patch: PlantPatch,
  dimensions: TankDimensions,
  reachOf: (patch: PlantPatch) => number,
): PlantPatch {
  const k = layoutScale(dimensions);
  const halfL = dimensions.length / 2 - dimensions.glass - WALL_MARGIN;
  const halfD = dimensions.depth / 2 - dimensions.glass - WALL_MARGIN;
  const scale: [number, number] = [
    Math.max(MIN_PLANT_SCALE, patch.scale[0] * k),
    Math.max(MIN_PLANT_SCALE, patch.scale[1] * k),
  ];
  const fitted = { ...patch, scale, radius: patch.radius * k };
  const reach = reachOf(fitted);
  const limitX = Math.max(0, halfL - reach);
  const limitZ = Math.max(0, halfD - reach);
  const x = (patch.center[0] * dimensions.length) / DEFAULT_TANK.length;
  const z = (patch.center[1] * dimensions.depth) / DEFAULT_TANK.depth;
  return {
    ...fitted,
    center: [Math.max(-limitX, Math.min(limitX, x)), Math.max(-limitZ, Math.min(limitZ, z))],
  };
}

/**
 * Presets are authored for the standard tank. Positions stretch with the glass, sizes shrink with
 * the smaller of its length and depth, and anything that would still cross the glass or break the
 * waterline is scaled or nudged back inside.
 */
export function fitPresetToTank(
  preset: PresetLayout,
  dimensions: TankDimensions,
  boundsOf: BoundsOf,
  patchReach: (patch: PlantPatch) => number,
): PresetLayout {
  return {
    ...preset,
    decor: preset.decor.map((item) => fitItem(item, dimensions, boundsOf)),
    plantPatches: sameTank(dimensions, DEFAULT_TANK)
      ? preset.plantPatches
      : preset.plantPatches.map((patch) => fitPatch(patch, dimensions, patchReach)),
  };
}
