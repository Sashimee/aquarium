import { legacyTintSeed, type Collider, type DecorItem, type Plant } from '@aquarium/shared';
import { Euler, Vector3 } from 'three';
import { layoutPlantKeys } from '@aquarium/sim/lifecycle';
import {
  grownItem,
  offsetEntries,
  type GrowthContext,
  type LayoutPlantRef,
  type OffsetEntry,
} from '../../scene/plantGrowth';
import { collidersFor } from './colliders';
import type { Piece } from './layout';
import type { DecorSpec } from './spec';

export interface PlantColliderInput {
  readonly pieces: readonly Piece[];
  readonly specs: ReadonlyMap<string, DecorSpec>;
  readonly plants: readonly Plant[];
  readonly ground: (x: number, z: number) => number;
  readonly waterTop: number;
}

export interface GrownPlants {
  /** The pieces with each layout plant at its grown size. */
  readonly pieces: readonly Piece[];
  /** One collider per offset (runner or carpet daughter), which the pieces do not carry. */
  readonly extra: readonly Collider[];
}

/** The offset's stem direction, tilted the way the scene writes its instance matrix (Euler YXZ). */
function standingUp(entry: OffsetEntry): [number, number, number] {
  const up = new Vector3(0, 1, 0).applyEuler(new Euler(entry.tiltX, entry.yaw, entry.tiltZ, 'YXZ'));
  return [up.x, up.y, up.z];
}

/**
 * What the sim must collide with once plants have grown: the layout plants at the size the scene
 * draws them, and the offsets standing around them. Keys are numbered the way the scene and the
 * server number repeated tint seeds, so the same plant is grown here and there.
 */
export function growPlants(input: PlantColliderInput): GrownPlants {
  const { pieces, specs, plants, ground, waterTop } = input;
  if (plants.length === 0) return { pieces, extra: [] };

  const growing = new Set(plants.map((p) => p.assetId));
  const layout: { index: number; piece: Piece; spec: DecorSpec }[] = [];
  pieces.forEach((piece, index) => {
    const spec = specs.get(piece.item.assetId);
    if (spec?.kind === 'plant') layout.push({ index, piece, spec });
  });
  const growers = layout.filter(({ piece }) => growing.has(piece.item.assetId));
  const keys = new Map(
    layoutPlantKeys(
      growers.map(({ piece }) => ({
        assetId: piece.item.assetId,
        position: piece.item.position,
        tintSeed: piece.item.tintSeed ?? legacyTintSeed(piece.item),
      })),
    ).map((key, i) => [growers[i]?.index, key]),
  );

  const refs: LayoutPlantRef[] = layout.map(({ index, piece, spec }) => ({
    key: keys.get(index) ?? `unkeyed:${index}`,
    item: piece.item,
    height: spec.box.max[1],
    halfWidth: Math.max(spec.box.max[0], spec.box.max[2]),
  }));
  const context: GrowthContext = {
    plants: new Map(plants.map((p) => [p.key, p])),
    ground,
    waterTop,
  };

  const grownPieces = [...pieces];
  layout.forEach(({ index, piece }, i) => {
    const ref = refs[i];
    if (ref) grownPieces[index] = { ...piece, item: grownItem(ref, context) };
  });

  const extra: Collider[] = [];
  for (const [assetId, entries] of offsetEntries(refs, context)) {
    const spec = specs.get(assetId);
    if (!spec) continue;
    for (const entry of entries) {
      const item: DecorItem = {
        assetId,
        position: [entry.x, entry.y, entry.z],
        rotationY: 0,
        scale: entry.scale,
      };
      extra.push(...collidersFor(`plant:${entry.key}`, spec, item, standingUp(entry)));
    }
  }
  return { pieces: grownPieces, extra };
}
