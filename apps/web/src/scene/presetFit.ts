import {
  MIN_FIT_SCALE,
  fitPresetDecor,
  keptPresetDecor,
  presetFit,
  type DecorItem,
  type PlantPatch,
  type PresetLayout,
  type TankSize,
} from '@aquarium/shared';
import { DEFAULT_TANK, type TankDimensions } from '../engine/tank/dimensions';
import { substrateHeight } from '../engine/tank/substrate';
import type { AssetCatalog } from './assets';
import { anemoneReach } from './anemone';
import {
  BANK_CLEARANCE,
  BANK_RIM_MARGIN,
  BANK_TOPS,
  isPerch,
  PERCH_GROWTH,
  PERCH_MIN_FIT,
} from './bank';
import type { CurrentParameters } from './current';
import { euphylliaReach, generateEuphyllia, parseEuphylliaId } from './euphyllia';
import { isMudBankId, mudBankBounds } from './mudBank';
import { GLASS_SHRINK_FLOOR } from './placement';
import { SURFACE_MARGIN } from './plants';

const WALL_MARGIN = 0.005;
/** A nano patch crowded against the front glass shrinks its disc to fit, but never below this share, so it stays a patch. */
const MIN_PATCH_RADIUS_SHARE = 0.45;
const MIN_HEIGHT_SHARE = 0.6;
const EDGE_ROOM_SHARE = 0.5;
const PERCH_SETTLE_PASSES = 4;

interface Footprint {
  readonly min: readonly number[];
  readonly max: readonly number[];
}

export interface FitModel {
  readonly bounds: Footprint;
  /** Radius a swaying item reaches in the current at `item.scale`, null for rigid ones. */
  readonly swayReach: ((item: DecorItem) => number) | null;
}

const MIN_KEPT_PATCH = 3;
/**
 * Plants shrink with the tank only down to this share of their authored size; a smaller tank holds
 * fewer of them instead. Below it a plant would be miniature next to the life-size fish.
 */
export const MIN_PLANT_FIT = 0.6;

/** Share of the standard tank's floor a tank offers, never above 1. */
export function footprintShare(size: TankSize): number {
  const { lengthRatio, depthRatio } = presetFit(size);
  return Math.min(1, lengthRatio * depthRatio);
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
    if (isMudBankId(assetId)) return { bounds: mudBankBounds(), swayReach: null };
    const entry = catalog.get(assetId);
    if (!entry.bounds) return null;
    return {
      bounds: entry.bounds,
      swayReach: entry.kind === 'anemone' ? (item) => anemoneReach(entry, item, current) : null,
    };
  };
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

/**
 * The largest scale an item can take at its own position and yaw before it crosses the glass or
 * the waterline, by the same reach model `fitPresetToTank` places it with. Rigid items reach in
 * proportion to scale; swaying ones add their lean.
 */
export function maxScaleAt(
  item: DecorItem,
  dimensions: TankDimensions,
  model: FitModel | null,
): number {
  if (!model) return Infinity;
  const halfL = dimensions.length / 2 - dimensions.glass - WALL_MARGIN;
  const halfD = dimensions.depth / 2 - dimensions.glass - WALL_MARGIN;
  const waterTop = dimensions.height - dimensions.freeboard;
  const height = model.bounds.max[1] ?? 0;
  const footprint = rotatedReach(model.bounds, item.rotationY);
  const { swayReach } = model;
  const reachAt = (axis: 'x' | 'z', scale: number) =>
    swayReach ? swayReach({ ...item, scale }) : footprint[axis] * scale;
  const growth = (room: number, axis: 'x' | 'z') => {
    const base = reachAt(axis, 0);
    const slope = reachAt(axis, 1) - base;
    return slope > 0 ? (room - base) / slope : Infinity;
  };
  const ceiling = isPerch(item) ? dimensions.height - BANK_RIM_MARGIN : waterTop - SURFACE_MARGIN;
  const surface = height > 0 ? (ceiling - item.position[1]) / height : Infinity;
  return Math.max(
    0,
    Math.min(
      surface,
      growth(halfL - Math.abs(item.position[0]), 'x'),
      growth(halfD - Math.abs(item.position[2]), 'z'),
    ),
  );
}

function standsClear(assetId: string, y: number, scale: number, waterTop: number): boolean {
  const point = BANK_TOPS[assetId]?.position[1] ?? 0;
  return scale >= PERCH_MIN_FIT && y + point * scale >= waterTop + BANK_CLEARANCE;
}

function fitItem(
  item: DecorItem,
  stretched: DecorItem,
  size: TankSize,
  dimensions: TankDimensions,
  boundsOf: BoundsOf,
  perch = isPerch(item),
): DecorItem {
  const { decorScale: k } = presetFit(size);
  const halfL = dimensions.length / 2 - dimensions.glass - WALL_MARGIN;
  const halfD = dimensions.depth / 2 - dimensions.glass - WALL_MARGIN;
  const waterTop = dimensions.height - dimensions.freeboard;

  let x = stretched.position[0];
  let z = stretched.position[2];
  const seatOffset =
    item.position[1] - substrateHeight(DEFAULT_TANK, item.position[0], item.position[2]);
  let y = substrateHeight(dimensions, x, z) + seatOffset * k;
  const wanted = perch ? item.scale * PERCH_GROWTH : stretched.scale;
  let scale = wanted;
  const ceiling = perch ? dimensions.height - BANK_RIM_MARGIN : waterTop - SURFACE_MARGIN;

  const model = boundsOf(item.assetId);
  if (model) {
    const height = model.bounds.max[1] ?? 0;
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
    // Nudging a perch off the glass moves it down the sloping bed, which lets it grow back toward
    // the rim; settle that before judging its clearance.
    for (let pass = 0; pass < (perch ? PERCH_SETTLE_PASSES : 1); pass++) {
      if (pass > 0) scale = wanted;
      if (height > 0) scale = Math.min(scale, (ceiling - y) / height);
      scale = Math.min(scale, growth(halfL, reachX), growth(halfD, reachZ));
      const limitX = Math.max(0, halfL - reachX(scale));
      const limitZ = Math.max(0, halfD - reachZ(scale));
      x = Math.max(-limitX, Math.min(limitX, x));
      z = Math.max(-limitZ, Math.min(limitZ, z));
      y = substrateHeight(dimensions, x, z) + seatOffset * k;
      if (height > 0) scale = Math.min(scale, (ceiling - y) / height);
    }
  }
  if (perch && !standsClear(item.assetId, y, scale, waterTop)) {
    const ordinary: DecorItem = { ...item };
    delete ordinary.perch;
    const fittedOrdinary: DecorItem = { ...stretched, scale: ordinary.scale * k };
    delete fittedOrdinary.perch;
    return fitItem(ordinary, fittedOrdinary, size, dimensions, boundsOf, false);
  }
  return {
    ...stretched,
    position: [x, y, z],
    scale: Math.max(scale, MIN_FIT_SCALE),
  };
}

/**
 * Where a patch of `radius` centred `z` from the middle sits against a depth limit that plants
 * cannot root past. One that stays inside it is left alone; one that crosses it shrinks to the room
 * it has, down to `MIN_PATCH_RADIUS_SHARE` of its radius, and slides inwards for the rest, so its
 * roots spread over the strip the glass leaves instead of piling onto the limit line.
 */
export function fitDepth(
  radius: number,
  z: number,
  limit: number,
): { radius: number; depth: number } {
  if (Math.abs(z) + radius <= limit) return { radius, depth: z };
  const fitted = Math.max(radius * MIN_PATCH_RADIUS_SHARE, Math.min(radius, limit - Math.abs(z)));
  const inner = Math.max(0, limit - fitted);
  return { radius: fitted, depth: Math.sign(z) * Math.min(Math.abs(z), inner) };
}

function fitPatch(
  patch: PlantPatch,
  size: TankSize,
  dimensions: TankDimensions,
  reachOf: (patch: PlantPatch, axis: 'x' | 'z') => number,
): PlantPatch {
  const { lengthRatio, depthRatio, scale: k } = presetFit(size);
  const share = footprintShare(size);
  const plantScale = Math.max(k, MIN_PLANT_FIT);
  const halfL = dimensions.length / 2 - dimensions.glass - WALL_MARGIN;
  const halfD = dimensions.depth / 2 - dimensions.glass - WALL_MARGIN;
  const scale: [number, number] = [
    Math.max(MIN_FIT_SCALE, patch.scale[0] * plantScale),
    Math.max(MIN_FIT_SCALE, patch.scale[1] * plantScale),
  ];
  const count = Math.min(
    patch.count,
    Math.max(MIN_KEPT_PATCH, Math.round((patch.count * share) / (plantScale * plantScale))),
  );
  const radiusShare = Math.min(share, depthRatio);
  const nominal = { ...patch, scale, count, radius: patch.radius * Math.sqrt(radiusShare) };
  const x = patch.center[0] * lengthRatio;
  const z = patch.center[1] * depthRatio;
  // Plants held above the tank's scale by MIN_PLANT_FIT are the ones the glass can squeeze.
  const held = plantScale > k;

  const limitsAt = (shrink: number) => {
    const smallest = scale[0] * GLASS_SHRINK_FLOOR * shrink;
    const probe = { ...nominal, scale: [smallest, smallest] as [number, number] };
    return {
      x: Math.max(0, halfL - reachOf(probe, 'x')),
      z: Math.max(0, halfD - reachOf(probe, 'z')),
    };
  };

  // Plants root up to the glass minus their reach, which grows with their height, so a patch whose
  // authored depth is beyond that gets lower plants before it gets a smaller or shifted disc.
  let shrink = 1;
  if (held && Math.abs(z) + nominal.radius > limitsAt(1).z) {
    const base = reachOf({ ...nominal, scale: [0, 0] }, 'z');
    const slope = reachOf({ ...nominal, scale: [1, 1] }, 'z') - base;
    const room = halfD - Math.abs(z) - nominal.radius * EDGE_ROOM_SHARE - base;
    const wanted = slope > 0 ? room / slope : Infinity;
    shrink = Math.max(MIN_HEIGHT_SHARE, Math.min(1, wanted / (scale[0] * GLASS_SHRINK_FLOOR)));
  }
  const limit = limitsAt(shrink);
  const fitted =
    held && z > 0 ? fitDepth(nominal.radius, z, limit.z) : { radius: nominal.radius, depth: z };
  const kept = fitted.radius / nominal.radius;
  return {
    ...nominal,
    scale: [scale[0] * shrink, scale[1] * shrink],
    radius: fitted.radius,
    count: Math.min(count, Math.max(MIN_KEPT_PATCH, Math.round(count * kept * kept))),
    center: [
      Math.max(-limit.x, Math.min(limit.x, x)),
      Math.max(-limit.z, Math.min(limit.z, fitted.depth)),
    ],
  };
}

/**
 * Presets are authored for the standard tank. Positions stretch with the glass and decor scales
 * with the smaller of its length and depth, held at `DECOR_MIN_SCALE`; a tank too small for all of
 * it keeps the head of the preset and drops the tail (`keptPresetDecor`). Anything that would
 * still cross the glass or break the waterline is scaled or nudged back inside. Plant patches
 * shrink in count and radius with the floor instead of being dropped.
 */
export function fitPresetToTank(
  preset: PresetLayout,
  size: TankSize,
  dimensions: TankDimensions,
  boundsOf: BoundsOf,
  patchReach: (patch: PlantPatch, axis: 'x' | 'z') => number,
): PresetLayout {
  const kept = keptPresetDecor(preset.decor, size);
  const stretched = fitPresetDecor(preset.decor, size);
  return {
    ...preset,
    decor: kept.map((item, i) => {
      const fitted = stretched[i];
      if (!fitted) throw new Error(`${item.assetId} is missing from the server decor fit`);
      return fitItem(item, fitted, size, dimensions, boundsOf);
    }),
    plantPatches:
      size === 'standard'
        ? preset.plantPatches
        : preset.plantPatches.map((patch) => fitPatch(patch, size, dimensions, patchReach)),
  };
}
