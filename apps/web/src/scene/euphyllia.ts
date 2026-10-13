import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshStandardNodeMaterial,
} from 'three/webgpu';
import { vertexColor } from 'three/tsl';
import type { DecorItem } from '@aquarium/shared';
import type { Tier } from '../engine/quality/tiers';
import { SWAY_ATTRIBUTE, swayPositionNode } from './anemone';
import type { CapsuleCollider } from './colliders';
import type { CurrentField, CurrentParameters } from './current';
import { decorMatrix } from './hardscape';
import { mulberry32 } from './placement';

export type EuphylliaVariant = 'hammer' | 'torch';
export type EuphylliaDetail = 0 | 1 | 2;
type Vec3 = [number, number, number];

export interface EuphylliaMesh {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly colors: Float32Array;
  readonly sway: Float32Array;
  readonly indices: Uint32Array;
  readonly bounds: { readonly min: Vec3; readonly max: Vec3 };
  readonly heads: number;
}

export const EUPHYLLIA_DETAIL: Readonly<Record<Tier, EuphylliaDetail>> = {
  low: 0,
  medium: 1,
  high: 2,
  ultra: 2,
};

/** Most triangles one colony may cost at each detail, so a reef with several colonies stays inside the draw and fill budget. */
export const EUPHYLLIA_TRIANGLE_BUDGET: Readonly<Record<EuphylliaDetail, number>> = {
  0: 2500,
  1: 8000,
  2: 18000,
};

const ID_PATTERN = /^euphyllia-(hammer|torch)-(0|[1-9]\d{0,8})$/;
const WAVE_METRES = 0.0035;
const LEAN_SECONDS = 0.5;
const COLONY_HEIGHT = 0.1;

export function euphylliaId(variant: EuphylliaVariant, seed: number): string {
  return `euphyllia-${variant}-${seed}`;
}

export function parseEuphylliaId(
  id: string,
): { readonly variant: EuphylliaVariant; readonly seed: number } | null {
  const match = ID_PATTERN.exec(id);
  if (!match) return null;
  return { variant: match[1] as EuphylliaVariant, seed: Number(match[2]) };
}

interface Palette {
  readonly skeleton: Vec3;
  readonly flesh: Vec3;
  readonly tip: Vec3;
}

const PALETTES: Readonly<Record<EuphylliaVariant, readonly Palette[]>> = {
  hammer: [
    { skeleton: [0.36, 0.3, 0.22], flesh: [0.2, 0.42, 0.22], tip: [0.5, 0.78, 0.4] },
    { skeleton: [0.36, 0.3, 0.22], flesh: [0.14, 0.4, 0.38], tip: [0.4, 0.8, 0.7] },
    { skeleton: [0.36, 0.3, 0.22], flesh: [0.34, 0.36, 0.14], tip: [0.8, 0.7, 0.25] },
  ],
  torch: [
    { skeleton: [0.36, 0.3, 0.22], flesh: [0.36, 0.3, 0.12], tip: [0.82, 0.7, 0.3] },
    { skeleton: [0.36, 0.3, 0.22], flesh: [0.3, 0.38, 0.2], tip: [0.6, 0.8, 0.35] },
    { skeleton: [0.36, 0.3, 0.22], flesh: [0.42, 0.26, 0.12], tip: [0.85, 0.55, 0.2] },
  ],
};

const TENTACLE_RINGS: Readonly<Record<EuphylliaVariant, readonly (readonly number[])[]>> = {
  torch: [[7], [10, 7], [14, 11, 7]],
  hammer: [[7], [10, 6], [14, 10, 6]],
};
const TENTACLE_SEGMENTS = [2, 3, 4] as const;
const TENTACLE_SIDES = [3, 4, 5] as const;
const SKELETON_SIDES = [4, 5, 6] as const;

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const lerp3 = (a: Vec3, b: Vec3, t: number): Vec3 => add(scale(a, 1 - t), scale(b, t));

function normalise(a: Vec3): Vec3 {
  const l = Math.hypot(a[0], a[1], a[2]);
  return l > 1e-9 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 1, 0];
}

/** Two unit vectors perpendicular to `d` and each other. */
function frame(d: Vec3): [Vec3, Vec3] {
  const ref: Vec3 = Math.abs(d[1]) < 0.95 ? [0, 1, 0] : [1, 0, 0];
  const u = normalise(cross(d, ref));
  return [u, normalise(cross(d, u))];
}

class MeshBuilder {
  readonly positions: number[] = [];
  readonly normals: number[] = [];
  readonly colors: number[] = [];
  readonly sway: number[] = [];
  readonly indices: number[] = [];

  get vertexCount(): number {
    return this.positions.length / 3;
  }

  vertex(p: Vec3, n: Vec3, color: Vec3, sway: number): number {
    this.positions.push(...p);
    this.normals.push(...n);
    this.colors.push(...color);
    this.sway.push(sway);
    return this.vertexCount - 1;
  }

  /** A tapered tube along `path`; the last ring closes onto an apex so no tip is left open. */
  tube(
    path: readonly Vec3[],
    radii: readonly number[],
    sides: number,
    color: (t: number) => Vec3,
    sway: (t: number) => number,
  ): void {
    const last = path.length - 1;
    const first = this.vertexCount;
    path.forEach((p, i) => {
      const before = path[Math.max(0, i - 1)] as Vec3;
      const after = path[Math.min(last, i + 1)] as Vec3;
      const [u, v] = frame(normalise(sub(after, before)));
      const t = i / last;
      for (let s = 0; s < sides; s++) {
        const a = (s / sides) * Math.PI * 2;
        const n = add(scale(u, Math.cos(a)), scale(v, Math.sin(a)));
        this.vertex(add(p, scale(n, radii[i] as number)), n, color(t), sway(t));
      }
    });
    const end = path[last] as Vec3;
    const prev = path[Math.max(0, last - 1)] as Vec3;
    const apex = this.vertex(end, normalise(sub(end, prev)), color(1), sway(1));
    for (let i = 0; i < last; i++) {
      for (let s = 0; s < sides; s++) {
        const a = first + i * sides + s;
        const b = first + i * sides + ((s + 1) % sides);
        this.indices.push(a, a + sides, b, b, a + sides, b + sides);
      }
    }
    const ring = first + last * sides;
    for (let s = 0; s < sides; s++) this.indices.push(ring + s, apex, ring + ((s + 1) % sides));
  }

  ellipsoid(
    centre: Vec3,
    axes: readonly [Vec3, Vec3, Vec3],
    radii: Vec3,
    lon: number,
    lat: number,
    color: Vec3,
    sway: number,
  ): void {
    const first = this.vertexCount;
    for (let i = 0; i <= lat; i++) {
      const phi = (i / lat) * Math.PI;
      for (let j = 0; j < lon; j++) {
        const theta = (j / lon) * Math.PI * 2;
        const local: Vec3 = [
          Math.sin(phi) * Math.cos(theta),
          Math.cos(phi),
          Math.sin(phi) * Math.sin(theta),
        ];
        let p = centre;
        let n: Vec3 = [0, 0, 0];
        for (let k = 0; k < 3; k++) {
          p = add(p, scale(axes[k] as Vec3, (local[k] as number) * (radii[k] as number)));
          n = add(n, scale(axes[k] as Vec3, (local[k] as number) / (radii[k] as number)));
        }
        this.vertex(p, normalise(n), color, sway);
      }
    }
    for (let i = 0; i < lat; i++) {
      for (let j = 0; j < lon; j++) {
        const a = first + i * lon + j;
        const b = first + i * lon + ((j + 1) % lon);
        this.indices.push(a, a + lon, b, b, a + lon, b + lon);
      }
    }
  }
}

interface Branch {
  readonly tip: Vec3;
  readonly dir: Vec3;
  readonly length: number;
  readonly radius: number;
}

function drawBranch(
  out: MeshBuilder,
  rng: () => number,
  start: Vec3,
  dir: Vec3,
  length: number,
  radius: number,
  sides: number,
  palette: Palette,
): Branch {
  const segments = 3;
  const path: Vec3[] = [start];
  let at = start;
  let heading = dir;
  for (let i = 0; i < segments; i++) {
    const wobble: Vec3 = [rng() - 0.5, (rng() - 0.5) * 0.3, rng() - 0.5];
    heading = normalise(add(heading, scale(wobble, 0.35)));
    at = add(at, scale(heading, length / segments));
    path.push(at);
  }
  const radii = path.map((_, i) => radius * (1 - 0.3 * (i / segments)));
  out.tube(
    path,
    radii,
    sides,
    () => palette.skeleton,
    () => 0,
  );
  return { tip: at, dir: heading, length, radius: radius * 0.7 };
}

function buildHead(
  out: MeshBuilder,
  variant: EuphylliaVariant,
  rng: () => number,
  head: Branch,
  detail: EuphylliaDetail,
  palette: Palette,
): void {
  const [u, v] = frame(head.dir);
  const hammer = variant === 'hammer';
  const discRadius = (hammer ? 0.017 : 0.013) * (0.85 + 0.3 * rng());
  const base = head.tip;
  out.ellipsoid(
    add(base, scale(head.dir, discRadius * 0.15)),
    [u, head.dir, v],
    [discRadius, discRadius * 0.45, discRadius],
    detail === 0 ? 6 : 8,
    detail === 0 ? 2 : 3,
    palette.flesh,
    0.15,
  );
  const sides = TENTACLE_SIDES[detail];
  const segments = TENTACLE_SEGMENTS[detail];
  const rings = TENTACLE_RINGS[variant][detail] as readonly number[];
  rings.forEach((count, ringIndex) => {
    const ringFraction = rings.length === 1 ? 1 : (ringIndex + 1) / rings.length;
    const spin = rng() * Math.PI * 2;
    for (let i = 0; i < count; i++) {
      const angle = spin + (i / count) * Math.PI * 2 + (rng() - 0.5) * 0.25;
      const radial = add(scale(u, Math.cos(angle)), scale(v, Math.sin(angle)));
      const root = add(
        add(base, scale(radial, discRadius * 0.85 * ringFraction)),
        scale(head.dir, discRadius * 0.2),
      );
      const elevation = hammer ? 0.5 + 0.7 * ringFraction : 0.15 + 0.5 * ringFraction;
      const jitter = 0.85 + 0.3 * rng();
      const length = (hammer ? 0.026 : 0.042) * jitter * (1.1 - 0.25 * ringFraction);
      const heading = normalise(
        add(scale(head.dir, Math.cos(elevation)), scale(radial, Math.sin(elevation))),
      );
      const curl = hammer ? 0.35 : 0.12;
      const path: Vec3[] = [];
      for (let s = 0; s <= segments; s++) {
        const t = s / segments;
        path.push(
          add(add(root, scale(heading, length * t)), scale(head.dir, curl * length * t * t)),
        );
      }
      const stem = hammer ? 0.0016 : 0.002;
      const radii = path.map((_, s) => {
        const t = s / segments;
        const flare = !hammer && t > 0.7 ? 1.35 : 1;
        return stem * (1 - 0.45 * t) * flare;
      });
      out.tube(
        path,
        radii,
        sides,
        (t) => lerp3(palette.flesh, palette.tip, t * t),
        (t) => 0.25 + 0.75 * t,
      );
      if (hammer) {
        const end = path[segments] as Vec3;
        const prev = path[segments - 1] as Vec3;
        const axis = normalise(sub(end, prev));
        const [a, b] = frame(axis);
        const anvil = 0.0026 * (0.85 + 0.3 * rng());
        out.ellipsoid(
          add(end, scale(axis, anvil * 0.4)),
          [a, axis, b],
          [anvil * 1.3, anvil * 0.6, anvil * 1.3],
          detail === 0 ? 5 : 6,
          detail === 0 ? 2 : 3,
          palette.tip,
          1,
        );
      }
    }
  });
}

/**
 * A deterministic Euphyllia colony: a branching limestone skeleton ending in fleshy polyp heads.
 * The skeleton and head placement depend on `seed` alone; `detail` only thins tentacles and sides,
 * so a tier change never rearranges the colony. Metres, origin at the base, +Y up.
 */
export function generateEuphyllia(
  variant: EuphylliaVariant,
  seed: number,
  detail: EuphylliaDetail,
): EuphylliaMesh {
  const out = new MeshBuilder();
  const skeletonRng = mulberry32(seed);
  const palette = PALETTES[variant][
    Math.floor(skeletonRng() * PALETTES[variant].length)
  ] as Palette;
  const headCount = 4 + Math.floor(skeletonRng() * 4);
  const sides = SKELETON_SIDES[detail];

  const lean = (skeletonRng() - 0.5) * 0.4;
  const trunkDir = normalise([Math.sin(lean), 1, Math.cos(lean) * 0.2]);
  const trunkLength = COLONY_HEIGHT * (0.38 + 0.1 * skeletonRng());
  const trunk = drawBranch(
    out,
    skeletonRng,
    [0, 0, 0],
    trunkDir,
    trunkLength,
    0.0042,
    sides,
    palette,
  );

  const frontier: Branch[] = [trunk];
  while (frontier.length < headCount) {
    const parent = frontier.shift() as Branch;
    const room = headCount - frontier.length;
    const children = Math.min(room, skeletonRng() < 0.3 ? 3 : 2);
    const azimuth = skeletonRng() * Math.PI * 2;
    const [u, v] = frame(parent.dir);
    for (let i = 0; i < children; i++) {
      const a = azimuth + (i / children) * Math.PI * 2;
      const outward = add(scale(u, Math.cos(a)), scale(v, Math.sin(a)));
      const dir = normalise(add(parent.dir, scale(outward, 0.55 + 0.25 * skeletonRng())));
      const length = parent.length * (0.62 + 0.15 * skeletonRng());
      frontier.push(
        drawBranch(out, skeletonRng, parent.tip, dir, length, parent.radius, sides, palette),
      );
    }
  }

  frontier.forEach((head, index) => {
    buildHead(out, variant, mulberry32(seed * 7919 + index * 104729 + 1), head, detail, palette);
  });

  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < out.positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const value = out.positions[i + k] as number;
      if (value < (min[k] as number)) min[k] = value;
      if (value > (max[k] as number)) max[k] = value;
    }
  }
  return {
    positions: Float32Array.from(out.positions),
    normals: Float32Array.from(out.normals),
    colors: Float32Array.from(out.colors),
    sway: Float32Array.from(out.sway),
    indices: Uint32Array.from(out.indices),
    bounds: { min, max },
    heads: headCount,
  };
}

export function euphylliaTriangles(mesh: EuphylliaMesh): number {
  return mesh.indices.length / 3;
}

function horizontalRadius(bounds: EuphylliaMesh['bounds']): number {
  return Math.max(
    ...[bounds.min[0], bounds.max[0]].flatMap((x) =>
      [bounds.min[2], bounds.max[2]].map((z) => Math.hypot(x, z)),
    ),
  );
}

function footprint(bounds: EuphylliaMesh['bounds']): number {
  return Math.max(
    Math.abs(bounds.min[0]),
    Math.abs(bounds.max[0]),
    Math.abs(bounds.min[2]),
    Math.abs(bounds.max[2]),
  );
}

/** Soft, like the anemone: fish may brush the tentacles but steering still avoids the colony. */
export function euphylliaCollider(
  bounds: EuphylliaMesh['bounds'],
  item: DecorItem,
): CapsuleCollider {
  const [x, y, z] = item.position;
  const radius = footprint(bounds) * item.scale * 0.6;
  const top = Math.max(radius, bounds.max[1] * item.scale * 0.85);
  return { kind: 'capsule', hard: false, a: [x, y + radius, z], b: [x, y + top, z], radius };
}

/** Furthest a tentacle tip strays horizontally from the item's position over the whole gust cycle. */
export function euphylliaReach(
  bounds: EuphylliaMesh['bounds'],
  item: DecorItem,
  current: CurrentParameters,
): number {
  const peakFlow = current.speed * (1 + current.gustDepth);
  return (horizontalRadius(bounds) + WAVE_METRES) * item.scale + peakFlow * LEAN_SECONDS;
}

export function euphylliaGeometry(mesh: EuphylliaMesh): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(mesh.positions, 3));
  geometry.setAttribute('normal', new BufferAttribute(mesh.normals, 3));
  geometry.setAttribute('color', new BufferAttribute(mesh.colors, 3));
  geometry.setAttribute(SWAY_ATTRIBUTE, new BufferAttribute(mesh.sway, 1));
  geometry.setIndex(new BufferAttribute(mesh.indices, 1));
  return geometry;
}

/** One coral colony: a single mesh whose tentacles stream in the shared current on the GPU. */
export class EuphylliaGroup {
  readonly object = new Group();
  private readonly geometry: BufferGeometry;
  private readonly material: MeshStandardNodeMaterial;

  constructor(mesh: EuphylliaMesh, item: DecorItem, current: CurrentField) {
    this.object.name = `euphyllia:${item.assetId}`;
    this.geometry = euphylliaGeometry(mesh);
    this.material = new MeshStandardNodeMaterial();
    this.material.name = 'euphyllia-sway';
    this.material.roughness = 0.55;
    this.material.metalness = 0;
    this.material.side = DoubleSide;
    this.material.colorNode = vertexColor().pow(1.8);
    this.material.emissiveNode = vertexColor().pow(1.8).mul(0.06);
    this.material.positionNode = swayPositionNode(item, current, WAVE_METRES, LEAN_SECONDS);
    const colony = new Mesh(this.geometry, this.material);
    colony.name = this.object.name;
    colony.matrixAutoUpdate = false;
    colony.matrix.copy(decorMatrix(item));
    colony.castShadow = true;
    colony.receiveShadow = true;
    colony.frustumCulled = false;
    this.object.add(colony);
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.object.removeFromParent();
    this.object.clear();
  }
}
