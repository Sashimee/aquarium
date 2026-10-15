import { recomputeNormals, relax, weldByPosition } from './bristles.ts';
import { mergeParts, type MaterialDef, type Part } from './parts.ts';
import type { Rgba } from './textures.ts';

export interface GlossyEyeSpec {
  /** Distance of each eye from the midline, as a fraction of the body length. */
  sideways: number;
  /** Distance of each eye behind the snout tip, as a fraction of the body length. */
  behindSnout: number;
  /** Eye radius as a fraction of the body length. */
  radius: number;
  /** How far the eye centre sits above the skin it rests on, as a fraction of the radius. */
  lift: number;
  /** Radius, as a fraction of the body length, of the patch around each eye that is smoothed flat so the source bead leaves no trace. */
  flatten: number;
}

export interface EyeSphere {
  centre: [number, number, number];
  radius: number;
  /** Direction the iris faces, away from the head. */
  axis?: [number, number, number];
}

type V3 = [number, number, number];

function unit(a: V3): V3 {
  const length = Math.hypot(a[0], a[1], a[2]);
  return [a[0] / length, a[1] / length, a[2] / length];
}

function cross(a: V3, b: V3): V3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function medianX(positions: Float32Array): number {
  const xs = Array.from({ length: positions.length / 3 }, (_, i) => positions[i * 3]!);
  xs.sort((a, b) => a - b);
  return xs[Math.floor(xs.length / 2)]!;
}

/**
 * Smooths the patch of skin around each eye bead flat, in place, by harmonic fill from the skin around it. The
 * bead is a fused part of the mesh, so it cannot be cut out; this leaves the eye sphere alone to make the eye.
 */
export function flattenEyeBeads(parts: Part[], spec: GlossyEyeSpec): void {
  const body = mergeParts(parts, parts[0]!.material);
  const spheres = eyeSpheres(body, spec);
  let zMin = Infinity;
  let zMax = -Infinity;
  for (let i = 2; i < body.positions.length; i += 3) {
    zMin = Math.min(zMin, body.positions[i]!);
    zMax = Math.max(zMax, body.positions[i]!);
  }
  const reach = spec.flatten * (zMax - zMin);
  for (const part of parts) {
    const welded = weldByPosition(part);
    const { positions, neighbours } = welded;
    const free = new Uint8Array(neighbours.length);
    for (const s of spheres) {
      const anchor = [s.centre[0], s.centre[1] - spec.lift * s.radius, s.centre[2]];
      for (let v = 0; v < neighbours.length; v++)
        if (
          Math.hypot(
            positions[v * 3]! - anchor[0]!,
            positions[v * 3 + 1]! - anchor[1]!,
            positions[v * 3 + 2]! - anchor[2]!,
          ) < reach
        )
          free[v] = 1;
    }
    const filled = relax(positions, neighbours, (v) => free[v] === 1, 400);
    const touched = new Set<number>();
    for (let v = 0; v < neighbours.length; v++) {
      if (!free[v]) continue;
      touched.add(v);
      for (const n of neighbours[v]!) touched.add(n);
      for (let a = 0; a < 3; a++) positions[v * 3 + a] = filled[v * 3 + a]!;
    }
    for (let i = 0; i < welded.canon.length; i++) {
      const v = welded.canon[i]!;
      if (!free[v]) continue;
      for (let a = 0; a < 3; a++) part.positions[i * 3 + a] = positions[v * 3 + a]!;
    }
    recomputeNormals(part, welded, touched);
    snapStrayUvs(part, welded.canon, positions, free, spheres);
  }
}

/**
 * The source atlas gives the bead and its surround to a scatter of tiny islands. Once the bead is flattened away
 * the triangles that kept those islands' texels show as dark shards, so any texel far from the patch's own island
 * takes the texel of the nearest skin vertex outside the patch.
 */
function snapStrayUvs(
  part: Part,
  canon: Uint32Array | number[],
  positions: Float32Array,
  free: Uint8Array,
  spheres: EyeSphere[],
): void {
  const nearest = (v: number): number => {
    let best = 0;
    let bestDistance = Infinity;
    spheres.forEach((s, k) => {
      const d = Math.hypot(
        positions[v * 3]! - s.centre[0],
        positions[v * 3 + 1]! - s.centre[1],
        positions[v * 3 + 2]! - s.centre[2],
      );
      if (d < bestDistance) [best, bestDistance] = [k, d];
    });
    return best;
  };
  spheres.forEach((_, k) => {
    const copies: number[] = [];
    for (let i = 0; i < canon.length; i++)
      if (free[canon[i]!] && nearest(canon[i]!) === k) copies.push(i);
    if (copies.length === 0) return;
    const median = (axis: number): number => {
      const values = copies.map((i) => part.uvs[i * 2 + axis]!).sort((a, b) => a - b);
      return values[values.length >> 1]!;
    };
    const [mu, mv] = [median(0), median(1)];
    const strays = copies.filter(
      (i) => Math.abs(part.uvs[i * 2]! - mu) + Math.abs(part.uvs[i * 2 + 1]! - mv) > STRAY_UV,
    );
    if (strays.length === 0) return;
    const skin: number[] = [];
    for (let i = 0; i < canon.length; i++) if (!free[canon[i]!]) skin.push(i);
    if (skin.length === 0)
      throw new Error(
        `snapStrayUvs: part "${part.material}" has no skin outside the patch around the ${k === 0 ? 'left' : 'right'} eye to take texels from; lower the recipe's glossyEyes.flatten`,
      );
    for (const i of strays) {
      let best = skin[0]!;
      let bestDistance = Infinity;
      for (const j of skin) {
        const d = Math.hypot(
          positions[canon[j]! * 3]! - positions[canon[i]! * 3]!,
          positions[canon[j]! * 3 + 1]! - positions[canon[i]! * 3 + 1]!,
          positions[canon[j]! * 3 + 2]! - positions[canon[i]! * 3 + 2]!,
        );
        if (d < bestDistance) [best, bestDistance] = [j, d];
      }
      part.uvs[i * 2] = part.uvs[best * 2]!;
      part.uvs[i * 2 + 1] = part.uvs[best * 2 + 1]!;
    }
  });
}

const STRAY_UV = 0.05;

/**
 * The spheres that cover the eye beads a source fused into its single head mesh, one per side, -X first. The
 * recipe says where the eyes are; the skin height under each is read off the mesh so the sphere sits on it.
 */
export function eyeSpheres(body: Part, spec: GlossyEyeSpec): EyeSphere[] {
  const { positions } = body;
  const count = positions.length / 3;
  let zMin = Infinity;
  let zMax = -Infinity;
  for (let v = 0; v < count; v++) {
    zMin = Math.min(zMin, positions[v * 3 + 2]!);
    zMax = Math.max(zMax, positions[v * 3 + 2]!);
  }
  const length = zMax - zMin;
  const midline = medianX(positions);
  const radius = spec.radius * length;
  const z = zMax - spec.behindSnout * length;
  return [-1, 1].map((side) => {
    const x = midline + side * spec.sideways * length;
    let skin = -Infinity;
    for (let v = 0; v < count; v++)
      if (Math.hypot(positions[v * 3]! - x, positions[v * 3 + 2]! - z) <= radius)
        skin = Math.max(skin, positions[v * 3 + 1]!);
    if (skin === -Infinity)
      throw new Error(
        `eyeSpheres: no skin within ${radius.toFixed(3)} of the eye at the ${side < 0 ? 'left' : 'right'}; check sideways and behindSnout`,
      );
    return {
      centre: [x, skin + spec.lift * radius, z],
      radius,
      axis: unit([side * 0.55, 0.8, 0.2]),
    };
  });
}

/** A UV sphere with outward normals and CCW front faces. */
export function sphereMesh(
  sphere: EyeSphere,
  segments: number,
  rings: number,
  material: string,
): Part {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const axis = sphere.axis ?? [0, 1, 0];
  const helper: V3 = Math.abs(axis[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
  const across = unit(cross(helper, axis));
  const around = cross(across, axis);
  for (let r = 0; r <= rings; r++) {
    const phi = (r / rings) * Math.PI;
    for (let s = 0; s <= segments; s++) {
      const theta = (s / segments) * Math.PI * 2;
      const local: V3 = [
        Math.sin(phi) * Math.cos(theta),
        Math.cos(phi),
        Math.sin(phi) * Math.sin(theta),
      ];
      const n: V3 = [0, 1, 2].map(
        (k) => local[0] * across[k]! + local[1] * axis[k]! + local[2] * around[k]!,
      ) as V3;
      positions.push(
        sphere.centre[0] + n[0] * sphere.radius,
        sphere.centre[1] + n[1] * sphere.radius,
        sphere.centre[2] + n[2] * sphere.radius,
      );
      normals.push(...n);
      uvs.push(s / segments, r / rings);
    }
  }
  const ring = segments + 1;
  for (let r = 0; r < rings; r++)
    for (let s = 0; s < segments; s++) {
      const a = r * ring + s;
      if (r > 0) indices.push(a, a + 1, a + ring);
      if (r < rings - 1) indices.push(a + 1, a + ring + 1, a + ring);
    }
  return {
    positions: Float32Array.from(positions),
    normals: Float32Array.from(normals),
    uvs: Float32Array.from(uvs),
    indices: Uint32Array.from(indices),
    material,
    extra: {},
  };
}

const EYE_TEXTURE_SIZE = 128;

/** Polar iris texture, pole at v = 0: a black pupil, a dark grey-brown iris, a faint bronze ring, dark surround. */
function eyeImage(): Rgba {
  const data = new Uint8Array(EYE_TEXTURE_SIZE * EYE_TEXTURE_SIZE * 4);
  for (let y = 0; y < EYE_TEXTURE_SIZE; y++) {
    const v = (y + 0.5) / EYE_TEXTURE_SIZE;
    let colour: V3;
    if (v < 0.1) colour = [6, 5, 5];
    else if (v < 0.26) {
      const t = (v - 0.1) / 0.16;
      colour = [40 + 22 * t, 32 + 17 * t, 25 + 12 * t];
    } else if (v < 0.33) colour = [92, 72, 40];
    else colour = [26, 22, 20];
    for (let x = 0; x < EYE_TEXTURE_SIZE; x++) {
      const at = (y * EYE_TEXTURE_SIZE + x) * 4;
      data.set([...colour, 255], at);
    }
  }
  return { width: EYE_TEXTURE_SIZE, height: EYE_TEXTURE_SIZE, data };
}

export const GLOSSY_EYE_MATERIAL: MaterialDef = {
  name: 'Eye',
  baseColorFactor: [1, 1, 1, 1],
  baseColor: { role: 'baseColor', codec: 'etc1s', image: eyeImage() },
  roughness: 0.25,
  metallic: 0,
  alphaMode: 'OPAQUE',
  doubleSided: false,
  normalScale: 1,
};

const EYE_DETAIL: readonly { segments: number; rings: number }[] = [
  { segments: 12, rings: 8 },
  { segments: 8, rings: 6 },
  { segments: 6, rings: 4 },
];

/** One part per detail level holding both eyes, tagged so the emit step keeps each for its own level only. */
export function glossyEyeParts(body: Part, spec: GlossyEyeSpec): Part[] {
  const spheres = eyeSpheres(body, spec);
  return EYE_DETAIL.map(({ segments, rings }, level) => ({
    ...mergeParts(
      spheres.map((s) => sphereMesh(s, segments, rings, GLOSSY_EYE_MATERIAL.name)),
      GLOSSY_EYE_MATERIAL.name,
    ),
    lods: [level],
  }));
}
