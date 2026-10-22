import type { Collider, Coral, DecorItem } from '@aquarium/shared';
import type { TankDimensions } from '../../engine/tank/dimensions';
import {
  grownCoralItem,
  matchLayoutCorals,
  placeFragments,
  type CoralSlot,
  type ScaleCap,
} from '../../scene/coralGrowth';
import { euphylliaCollider, parseEuphylliaId } from '../../scene/euphyllia';
import { maxScaleAt } from '../../scene/presetFit';
import { collidersFor } from './colliders';
import type { Piece } from './layout';
import type { DecorSpec } from './spec';

type CoralBounds = Parameters<typeof euphylliaCollider>[0];

export interface CoralColliderInput {
  readonly pieces: readonly Piece[];
  /** Anemones and procedural corals, which stay where the preset put them. */
  readonly fixed: readonly DecorItem[];
  readonly specs: ReadonlyMap<string, DecorSpec>;
  readonly corals: readonly Coral[];
  readonly dimensions: TankDimensions;
  readonly ground: (x: number, z: number) => number;
  /** Model-space bounds of a coral asset at scale 1, or null when unknown. */
  readonly boundsOf: (assetId: string) => CoralBounds | null;
}

export interface GrownCorals {
  /** The pieces with each layout coral at its grown size. */
  readonly pieces: readonly Piece[];
  /** Grown procedural corals and every fragment, which the pieces do not carry. */
  readonly extra: readonly Collider[];
}

type Origin = { readonly piece: number } | { readonly fixed: number };

function softCapsule(id: string, item: DecorItem, bounds: CoralBounds): Collider {
  const { kind, a, b, radius } = euphylliaCollider(bounds, item);
  return { id, kind, hard: false, a: [...a], b: [...b], radius };
}

/**
 * What the sim must collide with once corals have grown: the layout corals at their grown size (so
 * a colony that outgrew its placed box is not swum through), procedural corals that grew or
 * shrank, and the fragments standing around the colonies. Growth is held to the same glass and
 * surface limit the scene draws it with.
 */
export function growCorals(input: CoralColliderInput): GrownCorals {
  const { pieces, fixed, specs, corals, dimensions, ground, boundsOf } = input;
  if (corals.length === 0) return { pieces, extra: [] };

  const slots: CoralSlot[] = [];
  const origins: Origin[] = [];
  fixed.forEach((item, i) => {
    if (parseEuphylliaId(item.assetId) === null) return;
    slots.push({ assetId: item.assetId, item });
    origins.push({ fixed: i });
  });
  pieces.forEach((piece, i) => {
    if (specs.get(piece.item.assetId)?.kind !== 'coral') return;
    slots.push({ assetId: piece.item.assetId, item: piece.item });
    origins.push({ piece: i });
  });

  const cap: ScaleCap = (item) => {
    const bounds = boundsOf(item.assetId);
    return maxScaleAt(item, dimensions, bounds && { bounds, swayReach: null });
  };
  const matched = matchLayoutCorals(slots, corals);
  const grownPieces = [...pieces];
  const extra: Collider[] = [];
  slots.forEach((slot, s) => {
    const origin = origins[s];
    const coral = matched.get(s);
    if (!origin || !coral) return;
    const grown = grownCoralItem(slot.item, coral, cap);
    if ('piece' in origin) {
      const piece = pieces[origin.piece];
      if (piece) grownPieces[origin.piece] = { ...piece, item: grown };
      return;
    }
    const bounds = boundsOf(slot.assetId);
    if (grown.scale !== slot.item.scale && bounds) {
      extra.push(softCapsule(`decor:coral:${coral.key}`, grown, bounds));
    }
  });

  for (const { coral, item } of placeFragments(slots, corals, ground, cap)) {
    const spec = specs.get(item.assetId);
    if (spec) {
      extra.push(...collidersFor(`coral:${coral.key}`, spec, item));
      continue;
    }
    const bounds = parseEuphylliaId(item.assetId) ? boundsOf(item.assetId) : null;
    if (bounds) extra.push(softCapsule(`decor:coral:${coral.key}`, item, bounds));
  }
  return { pieces: grownPieces, extra };
}
