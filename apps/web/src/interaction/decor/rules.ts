import {
  decorPositionLimits,
  isDecorAssetForBiome,
  type Biome,
  type DecorItem,
} from '@aquarium/shared';
import { SURFACE_MARGIN } from '../../scene/plants';
import { VACATION_FEEDER_ASSET_ID } from './spec';
import {
  containsPoint,
  corners,
  extentOf,
  footprintOf,
  insideTank,
  OVERLAP_SHRINK,
  overlaps,
  type Footprint,
} from './footprint';
import type { DecorSpec } from './spec';

export const MAX_PIECES = 40;
/** How far a piece sinks into the substrate, so it never seems to hover on a dune. */
export const EMBED = 0.008;
export const LIFT = 0.05;
export const MIN_PLANT_SCALE = 0.4;
const GAP = 0.005;
const SPIRAL_STEP = 0.04;

export type Rejection =
  | 'outside'
  | 'overlap'
  | 'full'
  | 'feeder-exists'
  | 'unknown-asset'
  | 'wrong-biome'
  | 'no-room'
  | 'too-tall';

const MESSAGES: Record<Rejection, string> = {
  outside: 'That would push it through the glass.',
  overlap: 'Pieces cannot overlap. Move it to clear space.',
  full: `The tank holds at most ${MAX_PIECES} pieces.`,
  'feeder-exists': 'One vacation feeder is enough.',
  'unknown-asset': 'That piece is not available in this tank.',
  'wrong-biome': 'That piece belongs in a different kind of tank.',
  'no-room': 'There is no clear space left for another piece.',
  'too-tall': 'That plant would reach out of the water.',
};

export function describeRejection(reason: Rejection): string {
  return MESSAGES[reason];
}

export interface TankLimits {
  readonly halfLength: number;
  readonly halfDepth: number;
  /** Water surface height; plants must stay this far below it. Unset skips the check. */
  readonly waterTop?: number;
}

export interface Obstacle {
  readonly spec: DecorSpec;
  readonly item: DecorItem;
}

export type GroundHeight = (x: number, z: number) => number;

/** Where the piece's origin rests: its footprint's highest ground point, less a small embed. */
export function restHeight(spec: DecorSpec, item: DecorItem, ground: GroundHeight): number {
  const f = footprintOf(spec, item);
  let top = ground(f.cx, f.cz);
  for (const [x, z] of corners(f)) top = Math.max(top, ground(x, z));
  return top - EMBED - spec.box.min[1] * item.scale;
}

function insidePiece(f: Footprint, limits: TankLimits): boolean {
  return insideTank(f, limits.halfLength, limits.halfDepth);
}

/** Whether a plant resting at `item` would poke through the surface. */
export function reachesSurface(spec: DecorSpec, item: DecorItem, limits: TankLimits): boolean {
  if (spec.kind !== 'plant' || limits.waterTop === undefined) return false;
  return item.position[1] + spec.box.max[1] * item.scale > limits.waterTop - SURFACE_MARGIN;
}

export function check(
  spec: DecorSpec,
  item: DecorItem,
  others: readonly Obstacle[],
  limits: TankLimits,
): Rejection | null {
  if (!insidePiece(footprintOf(spec, item), limits)) return 'outside';
  if (reachesSurface(spec, item, limits)) return 'too-tall';
  const mine = footprintOf(spec, item, OVERLAP_SHRINK);
  for (const other of others) {
    // Leaves give way to a neighbour's edge, but a stem inside another piece would be hidden in it.
    if (spec.kind === 'plant' || other.spec.kind === 'plant') {
      if (spec.kind === other.spec.kind) continue;
      const plant = spec.kind === 'plant' ? mine : footprintOf(other.spec, other.item);
      const solid =
        spec.kind === 'plant' ? footprintOf(other.spec, other.item, OVERLAP_SHRINK) : mine;
      if (containsPoint(solid, plant.cx, plant.cz)) return 'overlap';
      continue;
    }
    if (overlaps(mine, footprintOf(other.spec, other.item, OVERLAP_SHRINK), GAP)) return 'overlap';
  }
  return null;
}

/** The assets of `specs` the server accepts in a `biome` tank; the vacation feeder fits any. */
export function paletteSpecs(specs: ReadonlyMap<string, DecorSpec>, biome: Biome): DecorSpec[] {
  return [...specs.values()].filter(
    (s) => s.assetId === VACATION_FEEDER_ASSET_ID || isDecorAssetForBiome(biome, s.assetId),
  );
}

/** Holds a position inside the interior the server accepts for a saved layout. */
export function withinServerBounds(item: DecorItem): DecorItem {
  const limits = decorPositionLimits();
  const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
  const [x, y, z] = item.position;
  return {
    ...item,
    position: [
      clamp(x, -limits.x, limits.x),
      clamp(y, 0, limits.yMax),
      clamp(z, -limits.z, limits.z),
    ],
  };
}

/** Slides the piece along x and z just far enough to be inside the glass. */
export function keepInside(spec: DecorSpec, item: DecorItem, limits: TankLimits): DecorItem {
  const f = footprintOf(spec, item);
  const e = extentOf(f);
  const clamp = (v: number, bound: number) => Math.min(Math.max(v, -bound), bound);
  const dx = clamp(f.cx, Math.max(0, limits.halfLength - e.x)) - f.cx;
  const dz = clamp(f.cz, Math.max(0, limits.halfDepth - e.z)) - f.cz;
  return withinServerBounds({
    ...item,
    position: [item.position[0] + dx, item.position[1], item.position[2] + dz],
  });
}

export function admit(
  spec: DecorSpec | undefined,
  existing: readonly { item: DecorItem }[],
  biome: Biome,
): Rejection | null {
  if (!spec) return 'unknown-asset';
  if (spec.assetId !== VACATION_FEEDER_ASSET_ID && !isDecorAssetForBiome(biome, spec.assetId)) {
    return 'wrong-biome';
  }
  if (existing.length >= MAX_PIECES) return 'full';
  if (
    spec.assetId === VACATION_FEEDER_ASSET_ID &&
    existing.some((p) => p.item.assetId === VACATION_FEEDER_ASSET_ID)
  ) {
    return 'feeder-exists';
  }
  return null;
}

/** The clear spot nearest `preferred`, searching outwards in rings; null when the tank is full. */
export function findFreeSpot(
  spec: DecorSpec,
  template: DecorItem,
  preferred: readonly [number, number],
  others: readonly Obstacle[],
  limits: TankLimits,
): DecorItem | null {
  const plan: TankLimits = { halfLength: limits.halfLength, halfDepth: limits.halfDepth };
  const reach = Math.hypot(limits.halfLength, limits.halfDepth) * 2;
  for (let radius = 0; radius <= reach; radius += SPIRAL_STEP) {
    const steps = radius === 0 ? 1 : Math.max(8, Math.ceil((2 * Math.PI * radius) / SPIRAL_STEP));
    for (let k = 0; k < steps; k++) {
      const angle = (k / steps) * Math.PI * 2;
      const candidate = keepInside(
        spec,
        {
          ...template,
          position: [
            preferred[0] + Math.cos(angle) * radius,
            template.position[1],
            preferred[1] + Math.sin(angle) * radius,
          ],
        },
        plan,
      );
      if (check(spec, candidate, others, plan) === null) return candidate;
    }
  }
  return null;
}
