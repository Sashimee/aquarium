import type { Collider, DecorItem } from '@aquarium/shared';
import { footprintOf } from './footprint';
import { hasShelterParts, shelterColliders } from './shelterColliders';
import type { DecorSpec } from './spec';

export const COLLIDER_PREFIX = 'decor:';

type Vec3 = readonly [number, number, number];
const UPRIGHT: Vec3 = [0, 1, 0];
const MIN_PLANT_COLLIDER_HEIGHT = 0.15;
const MIN_PLANT_COLLIDER_RADIUS = 0.04;

/** Mirrors the scene's soft plant capsule so the sim and the render agree on where a plant pushes fish. */
function plantCollider(colliderId: string, spec: DecorSpec, item: DecorItem, up: Vec3): Collider[] {
  const s = item.scale;
  const height = spec.box.max[1] * s;
  if (height < MIN_PLANT_COLLIDER_HEIGHT) return [];
  const radius = Math.max(
    MIN_PLANT_COLLIDER_RADIUS,
    Math.max(spec.box.max[0], spec.box.max[2]) * s * 0.5,
  );
  const reach = Math.max(radius, height * 0.8);
  const [x, y, z] = item.position;
  return [
    {
      id: colliderId,
      hard: false,
      kind: 'capsule',
      a: [x + up[0] * radius, y + up[1] * radius, z + up[2] * radius],
      b: [x + up[0] * reach, y + up[1] * reach, z + up[2] * reach],
      radius,
    },
  ];
}

/**
 * Sim collision proxies for one placed piece, in tank space. Long thin driftwood becomes a
 * capsule so fish can swim under a raised end; shelters are convex parts that keep their opening
 * clear; everything else is a rounded box.
 */
export function collidersFor(
  id: string,
  spec: DecorSpec,
  item: DecorItem,
  up: Vec3 = UPRIGHT,
): Collider[] {
  const f = footprintOf(spec, item);
  const height = f.yMax - f.yMin;
  const cy = f.yMin + height / 2;
  const colliderId = `${COLLIDER_PREFIX}${id}`;
  if (spec.kind === 'plant') return plantCollider(colliderId, spec, item, up);
  if (hasShelterParts(spec.assetId)) return shelterColliders(colliderId, item);
  if (spec.kind === 'driftwood') {
    const upright = height / 2 > Math.max(f.hx, f.hz);
    if (upright) {
      const radius = Math.max(f.hx, f.hz);
      return [
        {
          id: colliderId,
          hard: true,
          kind: 'capsule',
          a: [f.cx, f.yMin + radius, f.cz],
          b: [f.cx, f.yMax - radius, f.cz],
          radius,
        },
      ];
    }
    const alongX = f.hx >= f.hz;
    const half = alongX ? f.hx : f.hz;
    const radius = Math.min(half, Math.max(alongX ? f.hz : f.hx, height / 2));
    const dx = alongX ? f.cos : f.sin;
    const dz = alongX ? -f.sin : f.cos;
    const reach = half - radius;
    return [
      {
        id: colliderId,
        hard: true,
        kind: 'capsule',
        a: [f.cx - dx * reach, cy, f.cz - dz * reach],
        b: [f.cx + dx * reach, cy, f.cz + dz * reach],
        radius,
      },
    ];
  }
  return [
    {
      id: colliderId,
      hard: true,
      kind: 'box',
      center: [f.cx, cy, f.cz],
      halfExtents: [f.hx, height / 2, f.hz],
      rotationY: item.rotationY,
      rounding: Math.min(f.hx, f.hz, height / 2) * 0.4,
    },
  ];
}
