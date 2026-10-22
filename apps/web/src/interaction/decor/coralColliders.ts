import type { Collider, Coral, DecorItem } from '@aquarium/shared';
import {
  grownCoralItem,
  grownEuphylliaCapsule,
  matchLayoutCorals,
  placeFragments,
  type CoralSlot,
  type ScaleCap,
} from '../../scene/coralGrowth';
import { parseEuphylliaId, type EuphylliaCapsule, type EuphylliaMesh } from '../../scene/euphyllia';
import { collidersFor } from './colliders';
import type { Piece } from './layout';
import type { DecorSpec } from './spec';

type CoralBounds = EuphylliaMesh['bounds'];

export interface CoralColliderInput {
  readonly pieces: readonly Piece[];
  /** Anemones and procedural corals, which stay where the preset put them. */
  readonly fixed: readonly DecorItem[];
  readonly specs: ReadonlyMap<string, DecorSpec>;
  readonly corals: readonly Coral[];
  /** The scene's own cap, so growth stops where the scene stops drawing it. */
  readonly cap: ScaleCap;
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

function softCapsule(id: string, { centre, radius, height, lean }: EuphylliaCapsule): Collider {
  return {
    id,
    kind: 'capsule',
    hard: false,
    a: [centre[0] - lean[0] / 2, centre[1] - height / 2, centre[2] - lean[1] / 2],
    b: [centre[0] + lean[0] / 2, centre[1] + height / 2, centre[2] + lean[1] / 2],
    radius,
  };
}

/**
 * What the sim must collide with once corals have grown: the layout corals at their grown size (so
 * a colony that outgrew its placed box is not swum through), procedural corals that grew or
 * shrank, and the fragments standing around the colonies. Growth is held to the same glass and
 * surface limit the scene draws it with.
 */
export function growCorals(input: CoralColliderInput): GrownCorals {
  const { pieces, fixed, specs, corals, cap, ground, boundsOf } = input;
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
      extra.push(
        softCapsule(
          `decor:coral:${coral.key}`,
          grownEuphylliaCapsule(bounds, slot.item, coral, cap),
        ),
      );
    }
  });

  for (const { coral, item } of placeFragments(slots, corals, ground, cap)) {
    const spec = specs.get(item.assetId);
    if (spec) {
      extra.push(...collidersFor(`coral:${coral.key}`, spec, item));
      continue;
    }
    const bounds = parseEuphylliaId(item.assetId) ? boundsOf(item.assetId) : null;
    if (bounds)
      extra.push(
        softCapsule(
          `decor:coral:${coral.key}`,
          grownEuphylliaCapsule(bounds, item, undefined, cap),
        ),
      );
  }
  return { pieces: grownPieces, extra };
}
