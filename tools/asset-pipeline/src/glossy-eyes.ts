import { mergeParts, type MaterialDef, type Part } from './parts.ts';

export interface GlossyEyeSpec {
  /** Distance of each eye from the midline, as a fraction of the body length. */
  sideways: number;
  /** Distance of each eye behind the snout tip, as a fraction of the body length. */
  behindSnout: number;
  /** Eye radius as a fraction of the body length. */
  radius: number;
  /** How far the eye centre sits above the skin it rests on, as a fraction of the radius. */
  lift: number;
}

export interface EyeSphere {
  centre: [number, number, number];
  radius: number;
}

type V3 = [number, number, number];

function medianX(positions: Float32Array): number {
  const xs = Array.from({ length: positions.length / 3 }, (_, i) => positions[i * 3]!);
  xs.sort((a, b) => a - b);
  return xs[Math.floor(xs.length / 2)]!;
}

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
    return { centre: [x, skin + spec.lift * radius, z], radius };
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
  for (let r = 0; r <= rings; r++) {
    const phi = (r / rings) * Math.PI;
    for (let s = 0; s <= segments; s++) {
      const theta = (s / segments) * Math.PI * 2;
      const n: V3 = [
        Math.sin(phi) * Math.cos(theta),
        Math.cos(phi),
        Math.sin(phi) * Math.sin(theta),
      ];
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

export const GLOSSY_EYE_MATERIAL: MaterialDef = {
  name: 'Eye',
  baseColorFactor: [0.02, 0.02, 0.025, 1],
  roughness: 0.12,
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
