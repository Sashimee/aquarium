import { BufferGeometry, Float32BufferAttribute, Mesh, Vector3, type Material } from 'three/webgpu';
import { MUD_BANK_ASSET_ID, type DecorItem } from '@aquarium/shared';
import type { TankDimensions } from '../engine/tank/dimensions';
import { fitHull, type HullCollider } from './colliders';
import { decorMatrix } from './hardscape';

type Vec3 = [number, number, number];

export const MUD_BANK_ID = MUD_BANK_ASSET_ID;

export function isMudBankId(assetId: string): boolean {
  return assetId === MUD_BANK_ID;
}

/** Height of the flat top above the foot of the bank, in the mesh's own frame (metres at scale 1). */
export const MUD_BANK_TOP = 0.3;
/** Semi-axes of the flat top, which is exactly level and ringed by a rounded shoulder. */
export const MUD_BANK_FLAT = { x: 0.055, z: 0.042 } as const;
/** Semi-axes of the foot where the bank meets the substrate; the real foot is up to 12% inside. */
const BASE = { x: 0.19, z: 0.13 } as const;
const SKIRT_DEPTH = 0.05;
const SEGMENTS = 64;
const RINGS = 18;
const COLLIDER_BANDS: readonly (readonly [number, number])[] = [
  [0, 6],
  [6, 12],
  [12, RINGS + 1],
];

export interface MudBankMesh {
  readonly positions: Float32Array;
  readonly indices: Uint32Array;
  readonly bounds: { readonly min: Vec3; readonly max: Vec3 };
  /** Vertex index ranges: ring `r` (0 = rim of the flat top, `RINGS` = foot, `RINGS + 1` = buried skirt). */
  readonly ringStart: (ring: number) => number;
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

function footReach(theta: number): number {
  return (
    1 -
    0.07 * (0.5 + 0.5 * Math.sin(3 * theta + 0.7)) -
    0.05 * (0.5 + 0.5 * Math.sin(5 * theta + 2.1))
  );
}

function ripple(theta: number, t: number): number {
  return 0.006 * Math.sin(9 * theta + t * 14) * Math.sin(Math.PI * t);
}

/**
 * A mud bank for the mangrove tank: a level top with a rounded shoulder falling in an S-curve to
 * the substrate, so a 7 to 10 cm amphibious fish has a flat patch to haul out on. The foot is a
 * wobbly ellipse; the top stays exactly flat and is the highest point of the mesh.
 */
export function generateMudBank(): MudBankMesh {
  const ringSize = SEGMENTS;
  const ringStart = (ring: number) => 1 + ring * ringSize;
  const count = 1 + (RINGS + 2) * ringSize;
  const positions = new Float32Array(count * 3);
  positions.set([0, MUD_BANK_TOP, 0], 0);
  for (let ring = 0; ring <= RINGS + 1; ring++) {
    const t = Math.min(ring, RINGS) / RINGS;
    for (let s = 0; s < SEGMENTS; s++) {
      const theta = (s / SEGMENTS) * Math.PI * 2;
      const cos = Math.cos(theta);
      const sin = Math.sin(theta);
      const reach = footReach(theta);
      const x = (1 - t) * MUD_BANK_FLAT.x * cos + t * BASE.x * reach * cos;
      const z = (1 - t) * MUD_BANK_FLAT.z * sin + t * BASE.z * reach * sin;
      const y =
        ring === RINGS + 1
          ? -SKIRT_DEPTH
          : Math.min(MUD_BANK_TOP, MUD_BANK_TOP * (1 - smoothstep(t)) + ripple(theta, t));
      positions.set([x, y, z], (ringStart(ring) + s) * 3);
    }
  }
  const indices: number[] = [];
  for (let s = 0; s < SEGMENTS; s++) {
    indices.push(0, ringStart(0) + ((s + 1) % SEGMENTS), ringStart(0) + s);
  }
  for (let ring = 0; ring <= RINGS; ring++) {
    for (let s = 0; s < SEGMENTS; s++) {
      const n = (s + 1) % SEGMENTS;
      const a = ringStart(ring) + s;
      const b = ringStart(ring) + n;
      const c = ringStart(ring + 1) + s;
      const d = ringStart(ring + 1) + n;
      indices.push(a, b, c, b, d, c);
    }
  }
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < count; i++) {
    for (let k = 0; k < 3; k++) {
      const v = positions[i * 3 + k] ?? 0;
      min[k] = Math.min(min[k] ?? v, v);
      max[k] = Math.max(max[k] ?? v, v);
    }
  }
  return { positions, indices: Uint32Array.from(indices), bounds: { min, max }, ringStart };
}

export function mudBankBounds(): MudBankMesh['bounds'] {
  return generateMudBank().bounds;
}

/** Convex hulls stacked up the bank, since one hull over an S-curve would fill the concave foot. */
export function mudBankColliders(item: DecorItem): HullCollider[] {
  const mesh = generateMudBank();
  const matrix = decorMatrix(item);
  const point = new Vector3();
  return COLLIDER_BANDS.map(([from, to]) => {
    const first = from === 0 ? 0 : mesh.ringStart(from);
    const end = to > RINGS + 1 ? mesh.positions.length / 3 : mesh.ringStart(to) + SEGMENTS;
    const points = new Float64Array((end - first) * 3);
    for (let i = first; i < end; i++) {
      point
        .set(
          mesh.positions[i * 3] ?? 0,
          mesh.positions[i * 3 + 1] ?? 0,
          mesh.positions[i * 3 + 2] ?? 0,
        )
        .applyMatrix4(matrix);
      points.set([point.x, point.y, point.z], (i - first) * 3);
    }
    return fitHull(points);
  });
}

function bankGeometry(item: DecorItem, tank: TankDimensions): BufferGeometry {
  const mesh = generateMudBank();
  const matrix = decorMatrix(item);
  const innerLength = tank.length - 2 * tank.glass;
  const innerDepth = tank.depth - 2 * tank.glass;
  const uvs = new Float32Array((mesh.positions.length / 3) * 2);
  const point = new Vector3();
  for (let i = 0; i < mesh.positions.length / 3; i++) {
    point
      .set(
        mesh.positions[i * 3] ?? 0,
        mesh.positions[i * 3 + 1] ?? 0,
        mesh.positions[i * 3 + 2] ?? 0,
      )
      .applyMatrix4(matrix);
    uvs[i * 2] = point.x / innerLength;
    uvs[i * 2 + 1] = point.z / innerDepth;
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(mesh.positions, 3));
  geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  geometry.setIndex(Array.from(mesh.indices));
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * The bank as drawn. It wears the tank's substrate material so mud and bank read as one deposit;
 * UVs are baked in world metres over the glass-inner footprint so the substrate's normal map tiles
 * the same across both.
 */
export class MudBank {
  readonly mesh: Mesh;

  constructor(item: DecorItem, tank: TankDimensions, material: Material | Material[]) {
    this.mesh = new Mesh(bankGeometry(item, tank), material);
    this.mesh.name = MUD_BANK_ID;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.matrix.copy(decorMatrix(item));
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
  }

  setMaterial(material: Material | Material[]): void {
    this.mesh.material = material;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
  }
}
