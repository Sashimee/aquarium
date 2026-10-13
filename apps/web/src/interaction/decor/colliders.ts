import type { DecorCollider } from '@aquarium/sim';
import type { DecorItem } from '@aquarium/shared';
import { footprintOf } from './footprint';
import type { DecorSpec } from './spec';

export const COLLIDER_PREFIX = 'decor:';

/**
 * Sim collision proxies for one placed piece, in tank space. Long thin driftwood becomes a
 * capsule so fish can swim under a raised end; everything else is a rounded box.
 */
export function collidersFor(id: string, spec: DecorSpec, item: DecorItem): DecorCollider[] {
  const f = footprintOf(spec, item);
  const height = f.yMax - f.yMin;
  const cy = f.yMin + height / 2;
  const colliderId = `${COLLIDER_PREFIX}${id}`;
  if (spec.kind === 'driftwood') {
    const upright = height / 2 > Math.max(f.hx, f.hz);
    if (upright) {
      const radius = Math.max(f.hx, f.hz);
      return [
        {
          id: colliderId,
          solid: true,
          shape: {
            kind: 'capsule',
            a: [f.cx, f.yMin + radius, f.cz],
            b: [f.cx, f.yMax - radius, f.cz],
            radius,
          },
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
        solid: true,
        shape: {
          kind: 'capsule',
          a: [f.cx - dx * reach, cy, f.cz - dz * reach],
          b: [f.cx + dx * reach, cy, f.cz + dz * reach],
          radius,
        },
      },
    ];
  }
  return [
    {
      id: colliderId,
      solid: true,
      shape: {
        kind: 'box',
        center: [f.cx, cy, f.cz],
        halfExtents: [f.hx, height / 2, f.hz],
        rotationY: item.rotationY,
        rounding: Math.min(f.hx, f.hz, height / 2) * 0.4,
      },
    },
  ];
}
