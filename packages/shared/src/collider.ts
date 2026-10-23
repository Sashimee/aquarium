import { z } from 'zod';

/**
 * Collision proxies in tank space (see tankSpace.ts), the one format the web scene exports and
 * the sim consumes. A hull is its vertices only. The scene emits the corners of its
 * 54-direction k-DOP, and the scene and the sim both rebuild half-spaces from those same
 * vertices with `fitHullPlanes` below, so both sides evaluate identical planes (rebuilding from
 * the corners matches the original k-DOP only up to rounding). Hard colliders are never
 * penetrated; soft ones (plants) only push fish aside.
 */

export const MAX_HULL_VERTICES = 256;
export const MAX_COLLIDERS = 1024;

const coordinate = z.number().finite().min(-100).max(100);
const length = z.number().finite().positive().max(100);
export const point3Schema = z.tuple([coordinate, coordinate, coordinate]);
export type Point3 = z.infer<typeof point3Schema>;

const base = {
  id: z
    .string()
    .regex(/^[A-Za-z0-9_.:-]{1,64}$/, 'id must be 1-64 characters of A-Z a-z 0-9 _ . : -'),
  hard: z.boolean(),
};

export const sphereColliderSchema = z.strictObject({
  ...base,
  kind: z.literal('sphere'),
  center: point3Schema,
  radius: length,
});

export const boxColliderSchema = z
  .strictObject({
    ...base,
    kind: z.literal('box'),
    center: point3Schema,
    halfExtents: z.tuple([length, length, length]),
    rotationY: z
      .number()
      .finite()
      .min(-100)
      .max(100)
      .default(0)
      .describe('yaw in radians, +Z towards +X'),
    rounding: z
      .number()
      .finite()
      .nonnegative()
      .default(0)
      .describe('edge radius, inside halfExtents'),
  })
  .refine((b) => b.rounding <= Math.min(...b.halfExtents), {
    message: 'rounding must not exceed the smallest half extent',
    path: ['rounding'],
  });

export const capsuleColliderSchema = z.strictObject({
  ...base,
  kind: z.literal('capsule'),
  a: point3Schema,
  b: point3Schema,
  radius: length,
});

const HULL_SPIRAL_DIRECTIONS = 48;

/** The 54 k-DOP directions, packed `x, y, z`: the six axes, then a golden-angle spiral from +Y to -Y. */
export const HULL_DIRECTIONS: Float64Array = (() => {
  const out = [1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < HULL_SPIRAL_DIRECTIONS; i++) {
    const y = 1 - (2 * (i + 0.5)) / HULL_SPIRAL_DIRECTIONS;
    const r = Math.sqrt(1 - y * y);
    out.push(Math.cos(golden * i) * r, y, Math.sin(golden * i) * r);
  }
  return Float64Array.from(out);
})();

/**
 * The support plane of a point cloud (packed `x, y, z`) along each of `HULL_DIRECTIONS`, packed
 * `nx, ny, nz, d`: the hull is every point with `n . p <= d`. Never smaller than the points'
 * convex hull, and the first six planes are their bounding box.
 */
export function fitHullPlanes(points: ArrayLike<number>): Float64Array {
  const count = Math.floor(points.length / 3);
  if (count < 4) throw new RangeError('fitHullPlanes needs at least 4 points');
  const planes = new Float64Array((HULL_DIRECTIONS.length / 3) * 4);
  for (let k = 0, p = 0; k < HULL_DIRECTIONS.length; k += 3, p += 4) {
    const nx = HULL_DIRECTIONS[k] ?? 0;
    const ny = HULL_DIRECTIONS[k + 1] ?? 0;
    const nz = HULL_DIRECTIONS[k + 2] ?? 0;
    let d = -Infinity;
    for (let i = 0; i < count * 3; i += 3) {
      d = Math.max(
        d,
        nx * (points[i] ?? 0) + ny * (points[i + 1] ?? 0) + nz * (points[i + 2] ?? 0),
      );
    }
    planes[p] = nx;
    planes[p + 1] = ny;
    planes[p + 2] = nz;
    planes[p + 3] = d;
  }
  return planes;
}

const HULL_RELATIVE_VOLUME_EPSILON = 1e-6;

/** Volume of a large tetrahedron spanned by the points (not the hull volume); zero means collinear or coplanar. */
export function maxTetrahedronVolume(vertices: readonly Point3[]): number {
  const first = vertices[0];
  if (!first) return 0;
  const sub = (p: Point3, q: Point3): Point3 => [p[0] - q[0], p[1] - q[1], p[2] - q[2]];
  const cross = (u: Point3, v: Point3): Point3 => [
    u[1] * v[2] - u[2] * v[1],
    u[2] * v[0] - u[0] * v[2],
    u[0] * v[1] - u[1] * v[0],
  ];
  const dot = (u: Point3, v: Point3): number => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];

  let second = first;
  let best = 0;
  for (const p of vertices) {
    const d = Math.hypot(...sub(p, first));
    if (d > best) {
      best = d;
      second = p;
    }
  }
  if (best === 0) return 0;
  const edge = sub(second, first);

  let third = first;
  let bestArea = 0;
  for (const p of vertices) {
    const area = Math.hypot(...cross(edge, sub(p, first)));
    if (area > bestArea) {
      bestArea = area;
      third = p;
    }
  }
  if (bestArea === 0) return 0;
  const normal = cross(edge, sub(third, first));

  let bestHeight = 0;
  for (const p of vertices) bestHeight = Math.max(bestHeight, Math.abs(dot(normal, sub(p, first))));
  return bestHeight / 6;
}

function hullExtent(vertices: readonly Point3[]): number {
  const first = vertices[0];
  if (!first) return 0;
  let extent = 0;
  for (const p of vertices) {
    extent = Math.max(extent, Math.hypot(p[0] - first[0], p[1] - first[1], p[2] - first[2]));
  }
  return extent;
}

/** Whether `vertices` span no volume (collinear, coplanar or coincident), as the hull schema rejects. */
export function isDegenerateHull(vertices: readonly Point3[]): boolean {
  return maxTetrahedronVolume(vertices) <= HULL_RELATIVE_VOLUME_EPSILON * hullExtent(vertices) ** 3;
}

export const hullColliderSchema = z
  .strictObject({
    ...base,
    kind: z.literal('hull'),
    vertices: z
      .array(point3Schema)
      .min(4)
      .max(MAX_HULL_VERTICES)
      .describe('points whose convex hull is the collider'),
  })
  .superRefine((h, ctx) => {
    if (isDegenerateHull(h.vertices)) {
      ctx.addIssue({
        code: 'custom',
        path: ['vertices'],
        message: 'hull is degenerate: vertices are collinear, coplanar or coincident',
      });
    }
  });

export const colliderSchema = z.discriminatedUnion('kind', [
  sphereColliderSchema,
  boxColliderSchema,
  capsuleColliderSchema,
  hullColliderSchema,
]);
export type Collider = z.infer<typeof colliderSchema>;
export type SphereCollider = z.infer<typeof sphereColliderSchema>;
export type BoxCollider = z.infer<typeof boxColliderSchema>;
export type CapsuleCollider = z.infer<typeof capsuleColliderSchema>;
export type HullCollider = z.infer<typeof hullColliderSchema>;

export const colliderListSchema = z
  .array(colliderSchema)
  .max(MAX_COLLIDERS)
  .superRefine((list, ctx) => {
    const seen = new Set<string>();
    list.forEach((c, i) => {
      if (seen.has(c.id)) {
        ctx.addIssue({
          code: 'custom',
          path: [i, 'id'],
          message: `collider id "${c.id}" repeats; ids must be unique`,
        });
      }
      seen.add(c.id);
    });
  });
export type ColliderList = z.infer<typeof colliderListSchema>;

export interface BoundingSphere {
  readonly center: Point3;
  readonly radius: number;
}

export function colliderBoundingSphere(c: Collider): BoundingSphere {
  switch (c.kind) {
    case 'sphere':
      return { center: c.center, radius: c.radius };
    case 'box':
      return { center: c.center, radius: Math.hypot(...c.halfExtents) };
    case 'capsule':
      return {
        center: [(c.a[0] + c.b[0]) / 2, (c.a[1] + c.b[1]) / 2, (c.a[2] + c.b[2]) / 2],
        radius: Math.hypot(c.b[0] - c.a[0], c.b[1] - c.a[1], c.b[2] - c.a[2]) / 2 + c.radius,
      };
    case 'hull': {
      const n = c.vertices.length;
      const centre: Point3 = [0, 0, 0];
      for (const v of c.vertices) {
        centre[0] += v[0] / n;
        centre[1] += v[1] / n;
        centre[2] += v[2] / n;
      }
      let radius = 0;
      for (const v of c.vertices) {
        radius = Math.max(radius, Math.hypot(v[0] - centre[0], v[1] - centre[1], v[2] - centre[2]));
      }
      return { center: centre, radius };
    }
  }
}
