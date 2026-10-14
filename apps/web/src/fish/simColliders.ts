import { colliderListSchema, type Collider, type Point3 } from '@aquarium/shared';
import type { DecorCollider } from '@aquarium/sim';
import type { Collider as SceneCollider } from '../scene/colliders';

const ON_PLANE_M = 1e-7;
const SAME_CORNER_M = 1e-6;
const PARALLEL = 1e-9;

/**
 * Corners of the convex polytope `n . p <= d` given as packed `[nx, ny, nz, d]` planes. A
 * 3-polytope has at most 2F - 4 vertices, so the scene's 54-plane k-DOPs stay well under the
 * shared 256-vertex limit.
 */
export function hullCorners(planes: readonly number[]): Point3[] {
  const normals: Point3[] = [];
  const offsets: number[] = [];
  for (let o = 0; o + 3 < planes.length; o += 4) {
    normals.push([planes[o] ?? 0, planes[o + 1] ?? 0, planes[o + 2] ?? 0]);
    offsets.push(planes[o + 3] ?? 0);
  }
  const inside = (q: Point3): boolean =>
    normals.every((nm, m) => dot(nm, q) - (offsets[m] ?? 0) <= ON_PLANE_M);
  const out: Point3[] = [];
  const n = normals.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      for (let k = j + 1; k < n; k++) {
        const a = normals[i] as Point3;
        const b = normals[j] as Point3;
        const c = normals[k] as Point3;
        const bc = cross(b, c);
        const det = dot(a, bc);
        if (Math.abs(det) < PARALLEL) continue;
        const ca = cross(c, a);
        const ab = cross(a, b);
        const da = offsets[i] ?? 0;
        const db = offsets[j] ?? 0;
        const dc = offsets[k] ?? 0;
        const q: Point3 = [
          (da * bc[0] + db * ca[0] + dc * ab[0]) / det,
          (da * bc[1] + db * ca[1] + dc * ab[1]) / det,
          (da * bc[2] + db * ca[2] + dc * ab[2]) / det,
        ];
        if (!inside(q)) continue;
        if (out.some((v) => Math.hypot(v[0] - q[0], v[1] - q[1], v[2] - q[2]) < SAME_CORNER_M)) {
          continue;
        }
        out.push(q);
      }
    }
  }
  return out;
}

function dot(a: Point3, b: Point3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: Point3, b: Point3): Point3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/** The scene's colliders in the shared format. Ids follow list order, so a rebuilt scene keeps them. */
export function sceneCollidersToSim(colliders: readonly SceneCollider[]): Collider[] {
  return colliders.map((c, i): Collider => {
    const id = `scene:${i}`;
    return c.kind === 'hull'
      ? { id, kind: 'hull', hard: c.hard, vertices: hullCorners(c.planes) }
      : { id, kind: 'capsule', hard: c.hard, a: [...c.a], b: [...c.b], radius: c.radius };
  });
}

export function decorCollidersToSim(colliders: readonly DecorCollider[]): Collider[] {
  return colliders.map(({ id, solid, shape }): Collider => {
    switch (shape.kind) {
      case 'sphere':
        return { id, hard: solid, kind: 'sphere', center: [...shape.center], radius: shape.radius };
      case 'capsule':
        return {
          id,
          hard: solid,
          kind: 'capsule',
          a: [...shape.a],
          b: [...shape.b],
          radius: shape.radius,
        };
      case 'box':
        return {
          id,
          hard: solid,
          kind: 'box',
          center: [...shape.center],
          halfExtents: [...shape.halfExtents],
          rotationY: shape.rotationY ?? 0,
          rounding: shape.rounding ?? 0,
        };
    }
  });
}

/**
 * What the sim collides with. The scene's soft colliders (plants, anemones, corals) always count.
 * Its hard ones are the preset's rocks and wood, which the decor layer may move: once that layer
 * has reported the placed pieces, they replace the scene's hard colliders, as the
 * `decor:colliders` event contract says.
 */
export class SimColliders {
  private sceneSoft: readonly Collider[] = [];
  private current: readonly Collider[] = [];

  get list(): readonly Collider[] {
    return this.current;
  }

  /** A new scene also has a new decor layer, so the old layer's pieces are dropped. */
  setScene(colliders: readonly SceneCollider[]): readonly Collider[] {
    const converted = sceneCollidersToSim(colliders);
    const hard = converted.filter((c) => c.hard);
    const soft = converted.filter((c) => !c.hard);
    this.current = validated([...soft, ...hard]);
    this.sceneSoft = soft;
    return this.current;
  }

  setDecor(colliders: readonly DecorCollider[]): readonly Collider[] {
    const decor = decorCollidersToSim(colliders);
    this.current = validated([...this.sceneSoft, ...decor]);
    return this.current;
  }
}

/** Throws before anything changes when `list` breaks the shared collider contract. */
function validated(list: Collider[]): readonly Collider[] {
  const parsed = colliderListSchema.safeParse(list);
  if (parsed.success) return list;
  const issue = parsed.error.issues[0];
  throw new Error(
    `Sim colliders are invalid at ${issue?.path.map(String).join('.') ?? '?'}: ${issue?.message ?? 'unknown'}`,
  );
}
