import { z } from 'zod';

/**
 * Collision proxies in tank space (see tankSpace.ts), the one format the web scene exports and
 * the sim consumes. The sphere, box and capsule members use the field names of the sim's
 * `DecorShape` (`hard` is its `solid`), and the hull carries what the scene's `HullCollider`
 * is built from. Hard colliders are never penetrated; soft ones (plants) only push fish aside.
 */

export const MAX_HULL_VERTICES = 256;
export const MAX_HULL_PLANES = 128;
export const MAX_COLLIDERS = 1024;

const coordinate = z.number().finite().min(-100).max(100);
const length = z.number().finite().positive().max(100);
export const point3Schema = z.tuple([coordinate, coordinate, coordinate]);
export type Point3 = z.infer<typeof point3Schema>;

const base = {
  id: z.string().min(1).max(128),
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

const HULL_VOLUME_EPSILON = 1e-9;

/** Largest tetrahedron volume found among the points; zero means collinear or coplanar. */
export function hullVolume(vertices: readonly Point3[]): number {
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

export const hullColliderSchema = z
  .strictObject({
    ...base,
    kind: z.literal('hull'),
    vertices: z
      .array(point3Schema)
      .min(4)
      .max(MAX_HULL_VERTICES)
      .describe('points whose convex hull is the collider'),
    planes: z
      .array(z.number().finite().min(-100).max(100))
      .max(MAX_HULL_PLANES * 4)
      .refine((p) => p.length % 4 === 0, 'planes must be groups of n.x, n.y, n.z, d')
      .optional()
      .describe('optional precomputed half-spaces n . p <= d with unit n; same solid as the hull'),
  })
  .superRefine((h, ctx) => {
    if (hullVolume(h.vertices) <= HULL_VOLUME_EPSILON) {
      ctx.addIssue({
        code: 'custom',
        path: ['vertices'],
        message: 'hull is degenerate: vertices are collinear, coplanar or coincident',
      });
    }
    const p = h.planes;
    if (!p) return;
    for (let i = 0; i < p.length; i += 4) {
      const len = Math.hypot(p[i] ?? 0, p[i + 1] ?? 0, p[i + 2] ?? 0);
      if (Math.abs(len - 1) > 1e-3) {
        ctx.addIssue({
          code: 'custom',
          path: ['planes', i],
          message: `plane ${i / 4} normal must be unit length, got ${len}`,
        });
        return;
      }
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
