import type { DecorItem } from '@aquarium/shared';
import { VACATION_FEEDER_ASSET_ID } from './spec';
import {
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
const GAP = 0.005;
const SPIRAL_STEP = 0.04;

export type Rejection =
  'outside' | 'overlap' | 'full' | 'feeder-exists' | 'unknown-asset' | 'no-room';

const MESSAGES: Record<Rejection, string> = {
  outside: 'That would push it through the glass.',
  overlap: 'Pieces cannot overlap. Move it to clear space.',
  full: `The tank holds at most ${MAX_PIECES} pieces.`,
  'feeder-exists': 'One vacation feeder is enough.',
  'unknown-asset': 'That piece is not available in this tank.',
  'no-room': 'There is no clear space left for another piece.',
};

export function describeRejection(reason: Rejection): string {
  return MESSAGES[reason];
}

export interface TankLimits {
  readonly halfLength: number;
  readonly halfDepth: number;
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

export function check(
  spec: DecorSpec,
  item: DecorItem,
  others: readonly Obstacle[],
  limits: TankLimits,
): Rejection | null {
  if (!insidePiece(footprintOf(spec, item), limits)) return 'outside';
  const mine = footprintOf(spec, item, OVERLAP_SHRINK);
  for (const other of others) {
    if (overlaps(mine, footprintOf(other.spec, other.item, OVERLAP_SHRINK), GAP)) return 'overlap';
  }
  return null;
}

/** Slides the piece along x and z just far enough to be inside the glass. */
export function keepInside(spec: DecorSpec, item: DecorItem, limits: TankLimits): DecorItem {
  const f = footprintOf(spec, item);
  const e = extentOf(f);
  const clamp = (v: number, bound: number) => Math.min(Math.max(v, -bound), bound);
  const dx = clamp(f.cx, Math.max(0, limits.halfLength - e.x)) - f.cx;
  const dz = clamp(f.cz, Math.max(0, limits.halfDepth - e.z)) - f.cz;
  return { ...item, position: [item.position[0] + dx, item.position[1], item.position[2] + dz] };
}

export function admit(
  spec: DecorSpec | undefined,
  existing: readonly { item: DecorItem }[],
): Rejection | null {
  if (!spec) return 'unknown-asset';
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
        limits,
      );
      if (check(spec, candidate, others, limits) === null) return candidate;
    }
  }
  return null;
}
