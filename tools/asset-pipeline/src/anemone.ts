import { buildDocument, emitAsset, type LodPlan } from './emit.ts';
import type { FishContext } from './fish.ts';
import { SWAY_ATTRIBUTE, type OutputAsset } from './index-schema.ts';
import { signedVolume, vertexNormals } from './loft.ts';
import { smoothstep } from './math.ts';
import type { MaterialDef, Part } from './parts.ts';
import type { Rgba } from './textures.ts';

export const ANEMONE_LOD_PLAN: LodPlan = { ratios: [1, 0.5, 0.2], minTriangles: 300 };

const COLUMN_RING = 24;
const TUBE_SIDES = 6;
const TUBE_SEGMENTS = 7;
const TENTACLE_RINGS = [
  { radius: 0.02, count: 8, lean: 0.15, length: 0.11 },
  { radius: 0.05, count: 16, lean: 0.35, length: 0.14 },
  { radius: 0.08, count: 24, lean: 0.55, length: 0.16 },
  { radius: 0.11, count: 32, lean: 0.8, length: 0.15 },
  { radius: 0.135, count: 36, lean: 1.1, length: 0.13 },
];
const TARGET_EXTENT_M = 0.3;

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Builder {
  positions: number[] = [];
  sway: number[] = [];
  v: number[] = [];
  indices: number[] = [];

  vertex(x: number, y: number, z: number, sway: number, v: number): number {
    this.positions.push(x, y, z);
    this.sway.push(sway);
    this.v.push(v);
    return this.sway.length - 1;
  }
}

function addColumn(b: Builder): void {
  const profile: [number, number][] = [
    [0.0, 0.075],
    [0.015, 0.082],
    [0.06, 0.09],
    [0.1, 0.115],
    [0.125, 0.145],
  ];
  const first = b.sway.length;
  for (const [y, radius] of profile)
    for (let j = 0; j < COLUMN_RING; j++) {
      const angle = (2 * Math.PI * j) / COLUMN_RING;
      b.vertex(radius * Math.cos(angle), y, radius * Math.sin(angle), 0, 0.05);
    }
  for (let s = 0; s < profile.length - 1; s++)
    for (let j = 0; j < COLUMN_RING; j++) {
      const a = first + s * COLUMN_RING + j;
      const c = first + s * COLUMN_RING + ((j + 1) % COLUMN_RING);
      const d = a + COLUMN_RING;
      const e = c + COLUMN_RING;
      b.indices.push(a, c, d, c, e, d);
    }
  const bottom = b.vertex(0, 0, 0, 0, 0.05);
  const disc = b.vertex(0, 0.11, 0, 0, 0.05);
  const topRing = first + (profile.length - 1) * COLUMN_RING;
  for (let j = 0; j < COLUMN_RING; j++) {
    const next = (j + 1) % COLUMN_RING;
    b.indices.push(bottom, first + next, first + j);
    b.indices.push(disc, topRing + j, topRing + next);
  }
}

function addTentacle(
  b: Builder,
  origin: [number, number, number],
  outward: [number, number],
  lean: number,
  length: number,
  radius: number,
  phase: number,
): void {
  const first = b.sway.length;
  const points: [number, number, number][] = [];
  for (let s = 0; s <= TUBE_SEGMENTS; s++) {
    const f = s / TUBE_SEGMENTS;
    const reach = lean * length * f * (1 - 0.25 * f);
    const sag = 0.06 * Math.sin(phase + f * 2.4) * length * f;
    points.push([
      origin[0] + outward[0] * reach - outward[1] * sag,
      origin[1] + length * f * (1 - 0.35 * f * lean),
      origin[2] + outward[1] * reach + outward[0] * sag,
    ]);
  }
  for (let s = 0; s <= TUBE_SEGMENTS; s++) {
    const f = s / TUBE_SEGMENTS;
    const prev = points[Math.max(0, s - 1)]!;
    const next = points[Math.min(TUBE_SEGMENTS, s + 1)]!;
    let tx = next[0] - prev[0];
    let ty = next[1] - prev[1];
    let tz = next[2] - prev[2];
    const tn = Math.hypot(tx, ty, tz);
    tx /= tn;
    ty /= tn;
    tz /= tn;
    const helper: [number, number, number] = Math.abs(ty) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    let ux = ty * helper[2] - tz * helper[1];
    let uy = tz * helper[0] - tx * helper[2];
    let uz = tx * helper[1] - ty * helper[0];
    const un = Math.hypot(ux, uy, uz);
    ux /= un;
    uy /= un;
    uz /= un;
    const wx = ty * uz - tz * uy;
    const wy = tz * ux - tx * uz;
    const wz = tx * uy - ty * ux;
    const r = radius * (1 - 0.55 * f) * (1 + 0.6 * smoothstep(0.78, 0.95, f));
    const centre = points[s]!;
    for (let k = 0; k < TUBE_SIDES; k++) {
      const angle = (2 * Math.PI * k) / TUBE_SIDES;
      const c = Math.cos(angle) * r;
      const sn = Math.sin(angle) * r;
      b.vertex(
        centre[0] + ux * c + wx * sn,
        centre[1] + uy * c + wy * sn,
        centre[2] + uz * c + wz * sn,
        f,
        f,
      );
    }
  }
  for (let s = 0; s < TUBE_SEGMENTS; s++)
    for (let k = 0; k < TUBE_SIDES; k++) {
      const a = first + s * TUBE_SIDES + k;
      const c = first + s * TUBE_SIDES + ((k + 1) % TUBE_SIDES);
      const d = a + TUBE_SIDES;
      const e = c + TUBE_SIDES;
      b.indices.push(a, c, d, c, e, d);
    }
  const tip = points[TUBE_SEGMENTS]!;
  const cap = b.vertex(tip[0], tip[1], tip[2], 1, 1);
  const lastRing = first + TUBE_SEGMENTS * TUBE_SIDES;
  for (let k = 0; k < TUBE_SIDES; k++)
    b.indices.push(cap, lastRing + ((k + 1) % TUBE_SIDES), lastRing + k);
}

export function anemonePart(seed = 7): Part {
  const random = mulberry32(seed);
  const b = new Builder();
  addColumn(b);
  for (const ring of TENTACLE_RINGS)
    for (let i = 0; i < ring.count; i++) {
      const angle = (2 * Math.PI * (i + random() * 0.6)) / ring.count;
      const radius = ring.radius * (0.9 + random() * 0.2);
      const outward: [number, number] = [Math.cos(angle), Math.sin(angle)];
      addTentacle(
        b,
        [outward[0] * radius, 0.115 + radius * 0.2, outward[1] * radius],
        outward,
        ring.lean * (0.8 + random() * 0.4),
        ring.length * (0.8 + random() * 0.4),
        0.0075 * (0.85 + random() * 0.3),
        random() * Math.PI * 2,
      );
    }

  const positions = Float32Array.from(b.positions);
  const indices = Uint32Array.from(b.indices);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3)
    for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a]!, positions[i + a]!);
      max[a] = Math.max(max[a]!, positions[i + a]!);
    }
  const scale = TARGET_EXTENT_M / Math.max(max[0]! - min[0]!, max[2]! - min[2]!);
  for (let i = 0; i < positions.length; i++) positions[i] = positions[i]! * scale;

  if (signedVolume(positions, indices) < 0) {
    for (let t = 0; t < indices.length; t += 3) {
      const swap = indices[t + 1]!;
      indices[t + 1] = indices[t + 2]!;
      indices[t + 2] = swap;
    }
  }
  const count = positions.length / 3;
  const uvs = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    uvs[i * 2] = 0.5;
    uvs[i * 2 + 1] = b.v[i]!;
  }
  return {
    positions,
    normals: vertexNormals(positions, indices),
    uvs,
    indices,
    material: 'host-anemone',
    extra: { [SWAY_ATTRIBUTE]: Float32Array.from(b.sway) },
  };
}

export function anemoneTexture(): Rgba {
  const width = 16;
  const height = 256;
  const stops: [number, [number, number, number]][] = [
    [0, [0.34, 0.24, 0.16]],
    [0.12, [0.42, 0.3, 0.2]],
    [0.55, [0.58, 0.42, 0.34]],
    [0.8, [0.72, 0.4, 0.5]],
    [1, [0.92, 0.36, 0.64]],
  ];
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const f = y / (height - 1);
    let k = 0;
    while (k < stops.length - 2 && f > stops[k + 1]![0]) k++;
    const [f0, c0] = stops[k]!;
    const [f1, c1] = stops[k + 1]!;
    const t = Math.min(1, Math.max(0, (f - f0) / (f1 - f0)));
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      for (let c = 0; c < 3; c++) data[o + c] = Math.round((c0[c]! + (c1[c]! - c0[c]!) * t) * 255);
      data[o + 3] = 255;
    }
  }
  return { width, height, data };
}

export async function buildAnemone(ctx: FishContext): Promise<OutputAsset> {
  const part = anemonePart();
  const material: MaterialDef = {
    name: 'host-anemone',
    baseColorFactor: [1, 1, 1, 1],
    baseColor: { role: 'baseColor', codec: 'etc1s', image: anemoneTexture() },
    roughness: 0.55,
    metallic: 0,
    alphaMode: 'OPAQUE',
    doubleSided: false,
    normalScale: 1,
  };
  const built = buildDocument('host-anemone', [part], [material]);
  return emitAsset({
    outRoot: ctx.outRoot,
    kind: 'anemone',
    id: 'host-anemone',
    built,
    plan: ANEMONE_LOD_PLAN,
    meta: {
      origin: 'procedural',
      sources: [],
      licence: 'CC0-1.0',
      modifications: [
        'generated procedurally: columnar body with five rings of tapered tentacles, deterministic seed',
        'origin at the centre of the foot, scaled to a 0.3 m spread',
        '_SWAY vertex attribute: 0 at the foot and column, rising to 1 at each tentacle tip',
        'colour gradient texture generated procedurally',
      ],
    },
  });
}
