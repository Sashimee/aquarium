import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mulberry32 } from './anemone.ts';
import { buildDocument, emitAsset, type LodPlan } from './emit.ts';
import { speciesLengthM, type FishContext } from './fish.ts';
import {
  FIN_ID_ATTRIBUTE,
  FIN_MASK_ATTRIBUTE,
  LEG_ATTRIBUTE,
  SHRIMP_PART_IDS,
  type OutputAsset,
} from './index-schema.ts';
import { vertexNormals } from './loft.ts';
import { clamp, smoothstep, type Vec3 } from './math.ts';
import type { MaterialDef, Part } from './parts.ts';
import { renderSheet } from './raster.ts';
import type { Rgba } from './textures.ts';

export const SHRIMP_LOD_PLAN: LodPlan = { ratios: [1, 0.4, 0.15], minTriangles: 150 };

export const LEG_PAIRS = 5;
export const PLEOPOD_PAIRS = 5;
const ABDOMEN_SEGMENTS = 6;
const RING = 16;
const SEGMENT_SAMPLES = 6;
const LEG_SIDES = 5;
const ANTENNA_SIDES = 4;

type Kind = 'cherry' | 'cleaner';

interface ProfileKey {
  s: number;
  hw: number;
  top: number;
  bottom: number;
}

export interface ShrimpRecipe {
  id: string;
  species: string;
  kind: Kind;
  fallbackLengthM: number;
  seed: number;
  /** Fraction of the body length, rostrum to telson, where the carapace ends and the abdomen starts. */
  carapaceEnd: number;
  widthScale: number;
  heightScale: number;
  /** Dorsal arch of the abdomen and how far the tail tucks down, in body lengths. */
  arch: { peak: number; drop: number };
  /** Length of the long antennae and of the antennules, in body lengths. */
  antennaLength: number;
  antennuleLength: number;
  /** Leg length multiplier and body ride height above the walking surface (body lengths). */
  legReach: number;
  legDrop: number;
  note: string;
}

export const SHRIMP_RECIPES: ShrimpRecipe[] = [
  {
    id: 'cherry-shrimp',
    species: 'cherry-shrimp',
    kind: 'cherry',
    fallbackLengthM: 0.03,
    seed: 11,
    carapaceEnd: 0.4,
    widthScale: 1,
    heightScale: 1,
    arch: { peak: 0.05, drop: 0.13 },
    antennaLength: 1.05,
    antennuleLength: 0.3,
    legReach: 1,
    legDrop: 0.05,
    note: 'Neocaridina davidi: stout carapace, arched abdomen; translucent red palette matched by eye to wm-cherry-dagostino-1',
  },
  {
    id: 'cleaner-shrimp',
    species: 'cleaner-shrimp',
    kind: 'cleaner',
    fallbackLengthM: 0.045,
    seed: 23,
    carapaceEnd: 0.38,
    widthScale: 0.78,
    heightScale: 0.8,
    arch: { peak: 0.03, drop: 0.09 },
    antennaLength: 1.9,
    antennuleLength: 0.45,
    legReach: 1.3,
    legDrop: 0.06,
    note: 'Lysmata amboinensis: slender body, red dorsal band split by a white stripe, white antennae, red tail fan with white rim; palette and layout matched by eye to wm-cleaner-schofield and wm-cleaner-huffman',
  },
];

const PROFILE: ProfileKey[] = [
  { s: 0, hw: 0.002, top: 0.004, bottom: 0.004 },
  { s: 0.05, hw: 0.008, top: 0.03, bottom: 0.008 },
  { s: 0.1, hw: 0.036, top: 0.08, bottom: 0.036 },
  { s: 0.17, hw: 0.065, top: 0.112, bottom: 0.075 },
  { s: 0.27, hw: 0.076, top: 0.128, bottom: 0.092 },
  { s: 0.4, hw: 0.07, top: 0.12, bottom: 0.092 },
  { s: 0.5, hw: 0.064, top: 0.106, bottom: 0.082 },
  { s: 0.62, hw: 0.058, top: 0.092, bottom: 0.072 },
  { s: 0.75, hw: 0.044, top: 0.07, bottom: 0.052 },
  { s: 0.88, hw: 0.028, top: 0.04, bottom: 0.03 },
  { s: 1, hw: 0.004, top: 0.006, bottom: 0.006 },
];

const ABDOMEN_END = 0.88;
const TELSON_SAMPLES = [0.91, 0.95, 0.98, 1];
const CARAPACE_SAMPLES = [0, 0.015, 0.04, 0.07, 0.1, 0.14, 0.18, 0.22, 0.26, 0.3];
const GROOVE_DEPTH = 0.07;
const SKIRT_WIDTH = 0.24;
const SKIRT_DROP = 0.018;

const ATLAS_WIDTH = 1024;
const ATLAS_HEIGHT = 512;
const BODY_V_MAX = 0.7;
const BANDS = {
  fan: { top: 0.7, bottom: 0.8 },
  leg: { top: 0.8, bottom: 0.88 },
  pleopod: { top: 0.88, bottom: 0.92 },
  antenna: { top: 0.92, bottom: 0.96 },
  eye: { top: 0.96, bottom: 1 },
} as const;

const MID = (band: { top: number; bottom: number }): number => (band.top + band.bottom) / 2;

function interpolateProfile(s: number): { hw: number; top: number; bottom: number } {
  let k = 0;
  while (k < PROFILE.length - 2 && s > PROFILE[k + 1]!.s) k++;
  const a = PROFILE[k]!;
  const b = PROFILE[k + 1]!;
  const t = clamp((s - a.s) / (b.s - a.s), 0, 1);
  const w = (1 - Math.cos(Math.PI * t)) / 2;
  return {
    hw: a.hw + (b.hw - a.hw) * w,
    top: a.top + (b.top - a.top) * w,
    bottom: a.bottom + (b.bottom - a.bottom) * w,
  };
}

function spineHeight(recipe: ShrimpRecipe, s: number): number {
  const hump = recipe.arch.peak * smoothstep(0.1, 0.6, s);
  const tuck = (recipe.arch.peak + recipe.arch.drop) * smoothstep(0.6, 1, s) ** 1.3;
  const rostrum = 0.035 * (1 - smoothstep(0, 0.14, s));
  return hump - tuck + rostrum;
}

const zOf = (s: number): number => 1 - s;

function normalise(v: Vec3): Vec3 {
  const n = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / n, v[1] / n, v[2] / n];
}

function crossOf(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

class Builder {
  positions: number[] = [];
  uvs: number[] = [];
  id: number[] = [];
  weight: number[] = [];
  limb: number[] = [];
  indices: number[] = [];

  get count(): number {
    return this.id.length;
  }

  vertex(p: Vec3, uv: [number, number], id: number, weight: number, limb: number): number {
    this.positions.push(p[0], p[1], p[2]);
    this.uvs.push(uv[0], uv[1]);
    this.id.push(id);
    this.weight.push(weight);
    this.limb.push(limb);
    return this.count - 1;
  }

  /** Flips triangles added since `from` so that they face away from the shape's own centroid. */
  faceOutward(fromVertex: number, fromIndex: number): void {
    let cx = 0;
    let cy = 0;
    let cz = 0;
    const n = this.count - fromVertex;
    for (let v = fromVertex; v < this.count; v++) {
      cx += this.positions[v * 3]!;
      cy += this.positions[v * 3 + 1]!;
      cz += this.positions[v * 3 + 2]!;
    }
    cx /= n;
    cy /= n;
    cz /= n;
    let score = 0;
    for (let t = fromIndex; t < this.indices.length; t += 3) {
      const a = this.indices[t]! * 3;
      const b = this.indices[t + 1]! * 3;
      const c = this.indices[t + 2]! * 3;
      const p = this.positions;
      const e1: Vec3 = [p[b]! - p[a]!, p[b + 1]! - p[a + 1]!, p[b + 2]! - p[a + 2]!];
      const e2: Vec3 = [p[c]! - p[a]!, p[c + 1]! - p[a + 1]!, p[c + 2]! - p[a + 2]!];
      const nrm = crossOf(e1, e2);
      const gx = (p[a]! + p[b]! + p[c]!) / 3 - cx;
      const gy = (p[a + 1]! + p[b + 1]! + p[c + 1]!) / 3 - cy;
      const gz = (p[a + 2]! + p[b + 2]! + p[c + 2]!) / 3 - cz;
      score += nrm[0] * gx + nrm[1] * gy + nrm[2] * gz;
    }
    if (score >= 0) return;
    for (let t = fromIndex; t < this.indices.length; t += 3) {
      const swap = this.indices[t + 1]!;
      this.indices[t + 1] = this.indices[t + 2]!;
      this.indices[t + 2] = swap;
    }
  }
}

interface Section {
  s: number;
  scale: number;
}

function bodySections(recipe: ShrimpRecipe): Section[] {
  const sections: Section[] = CARAPACE_SAMPLES.map((s) => ({ s, scale: 1 }));
  const segmentLength = (ABDOMEN_END - recipe.carapaceEnd) / ABDOMEN_SEGMENTS;
  for (let k = 0; k < ABDOMEN_SEGMENTS; k++)
    for (let j = 0; j < SEGMENT_SAMPLES; j++) {
      const u = j / SEGMENT_SAMPLES;
      sections.push({
        s: recipe.carapaceEnd + (k + u) * segmentLength,
        scale: 1 - GROOVE_DEPTH * (1 - u) ** 3,
      });
    }
  sections.push({ s: ABDOMEN_END, scale: 1 });
  for (const s of TELSON_SAMPLES) sections.push({ s, scale: 1 });
  return sections;
}

function addBody(b: Builder, recipe: ShrimpRecipe): void {
  const fromVertex = b.count;
  const fromIndex = b.indices.length;
  const sections = bodySections(recipe);
  const ring = RING + 1;
  for (const { s, scale } of sections) {
    const p = interpolateProfile(s);
    const hw = Math.max(0.002, p.hw * recipe.widthScale * scale);
    const top = Math.max(0.002, p.top * recipe.heightScale * scale);
    const bottom = Math.max(0.002, p.bottom * recipe.heightScale * scale);
    const yc = spineHeight(recipe, s);
    const abdomen = s >= recipe.carapaceEnd;
    const skirt =
      smoothstep(recipe.carapaceEnd - 0.03, recipe.carapaceEnd + 0.04, s) *
      (1 - smoothstep(0.78, ABDOMEN_END, s));
    const weight = abdomen ? clamp((s - recipe.carapaceEnd) / (1 - recipe.carapaceEnd), 0, 1) : 0;
    for (let j = 0; j < ring; j++) {
      const t = j / RING;
      const angle = Math.PI + 2 * Math.PI * t;
      const cosA = Math.cos(angle);
      const plate = skirt * Math.exp(-(((cosA + 0.5) / 0.35) ** 2));
      b.vertex(
        [
          hw * Math.sin(angle) * (1 + SKIRT_WIDTH * plate),
          yc + (cosA > 0 ? top : bottom) * cosA - SKIRT_DROP * plate * scale,
          zOf(s),
        ],
        [s, t * BODY_V_MAX],
        abdomen ? SHRIMP_PART_IDS.abdomen : SHRIMP_PART_IDS.body,
        weight,
        0,
      );
    }
  }
  for (let i = 0; i < sections.length - 1; i++)
    for (let j = 0; j < RING; j++) {
      const a = fromVertex + i * ring + j;
      const c = a + 1;
      const d = a + ring;
      const e = d + 1;
      b.indices.push(a, c, d, c, e, d);
    }
  b.faceOutward(fromVertex, fromIndex);
}

function addTube(
  b: Builder,
  points: Vec3[],
  radii: number[],
  sides: number,
  id: number,
  limb: number,
  uvAt: (f: number) => [number, number],
): void {
  const fromVertex = b.count;
  const fromIndex = b.indices.length;
  const lengths = [0];
  for (let i = 1; i < points.length; i++) {
    const p = points[i]!;
    const q = points[i - 1]!;
    lengths.push(lengths[i - 1]! + Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]));
  }
  const total = lengths.at(-1)!;
  for (let i = 0; i < points.length; i++) {
    const prev = points[Math.max(0, i - 1)]!;
    const next = points[Math.min(points.length - 1, i + 1)]!;
    const tangent = normalise([next[0] - prev[0], next[1] - prev[1], next[2] - prev[2]]);
    const helper: Vec3 = Math.abs(tangent[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const u = normalise(crossOf(tangent, helper));
    const w = crossOf(tangent, u);
    const f = total > 0 ? lengths[i]! / total : 0;
    const centre = points[i]!;
    const r = radii[i]!;
    for (let k = 0; k < sides; k++) {
      const angle = (2 * Math.PI * k) / sides;
      const c = Math.cos(angle) * r;
      const sn = Math.sin(angle) * r;
      b.vertex(
        [
          centre[0] + u[0] * c + w[0] * sn,
          centre[1] + u[1] * c + w[1] * sn,
          centre[2] + u[2] * c + w[2] * sn,
        ],
        uvAt(f),
        id,
        f,
        limb,
      );
    }
  }
  for (let i = 0; i < points.length - 1; i++)
    for (let k = 0; k < sides; k++) {
      const a = fromVertex + i * sides + k;
      const c = fromVertex + i * sides + ((k + 1) % sides);
      const d = a + sides;
      const e = c + sides;
      b.indices.push(a, c, d, c, e, d);
    }
  const tip = points.at(-1)!;
  const cap = b.vertex(tip, uvAt(1), id, 1, limb);
  const last = fromVertex + (points.length - 1) * sides;
  for (let k = 0; k < sides; k++) b.indices.push(cap, last + ((k + 1) % sides), last + k);
  b.faceOutward(fromVertex, fromIndex);
}

function addLeaf(
  b: Builder,
  base: Vec3,
  dir: Vec3,
  length: number,
  width: number,
  along: number,
  across: number,
  id: number,
  limb: number,
  weightAt: (p: number) => number,
  uvAt: (p: number, q: number) => [number, number],
): void {
  const first = b.count;
  const d = normalise(dir);
  const lat = normalise(crossOf(d, [0, 1, 0]));
  for (let i = 0; i <= along; i++) {
    const p = i / along;
    const w = width * Math.sin(Math.PI * (0.1 + 0.8 * p)) ** 0.7;
    for (let j = 0; j <= across; j++) {
      const q = (2 * j) / across - 1;
      b.vertex(
        [
          base[0] + d[0] * length * p + lat[0] * q * w,
          base[1] + d[1] * length * p + lat[1] * q * w,
          base[2] + d[2] * length * p + lat[2] * q * w,
        ],
        uvAt(p, q),
        id,
        weightAt(p),
        limb,
      );
    }
  }
  const row = across + 1;
  for (let i = 0; i < along; i++)
    for (let j = 0; j < across; j++) {
      const a = first + i * row + j;
      b.indices.push(a, a + 1, a + row, a + 1, a + row + 1, a + row);
    }
}

function addSphere(b: Builder, centre: Vec3, radius: number, uv: [number, number]): void {
  const fromVertex = b.count;
  const fromIndex = b.indices.length;
  const lon = 8;
  const lat = 5;
  for (let i = 1; i < lat; i++) {
    const phi = (Math.PI * i) / lat;
    for (let j = 0; j < lon; j++) {
      const theta = (2 * Math.PI * j) / lon;
      b.vertex(
        [
          centre[0] + radius * Math.sin(phi) * Math.cos(theta),
          centre[1] + radius * Math.cos(phi),
          centre[2] + radius * Math.sin(phi) * Math.sin(theta),
        ],
        uv,
        SHRIMP_PART_IDS.body,
        0,
        0,
      );
    }
  }
  const north = b.vertex([centre[0], centre[1] + radius, centre[2]], uv, 0, 0, 0);
  const south = b.vertex([centre[0], centre[1] - radius, centre[2]], uv, 0, 0, 0);
  for (let i = 0; i < lat - 2; i++)
    for (let j = 0; j < lon; j++) {
      const a = fromVertex + i * lon + j;
      const c = fromVertex + i * lon + ((j + 1) % lon);
      b.indices.push(a, c, a + lon, c, c + lon, a + lon);
    }
  for (let j = 0; j < lon; j++) {
    b.indices.push(north, fromVertex + ((j + 1) % lon), fromVertex + j);
    const base = fromVertex + (lat - 2) * lon;
    b.indices.push(south, base + j, base + ((j + 1) % lon));
  }
  b.faceOutward(fromVertex, fromIndex);
}

function addEyes(b: Builder, recipe: ShrimpRecipe): void {
  const s = 0.09;
  const p = interpolateProfile(s);
  const yc = spineHeight(recipe, s);
  for (const side of [-1, 1]) {
    const root: Vec3 = [
      side * p.hw * recipe.widthScale * 0.6,
      yc + p.top * recipe.heightScale * 0.6,
      zOf(s) + 0.005,
    ];
    const elbow: Vec3 = [
      side * (p.hw * recipe.widthScale * 0.6 + 0.025),
      root[1] + 0.012,
      root[2] + 0.014,
    ];
    const eye: Vec3 = [
      side * (p.hw * recipe.widthScale * 0.6 + 0.045),
      root[1] + 0.016,
      root[2] + 0.024,
    ];
    addTube(b, [root, elbow, eye], [0.008, 0.006, 0.0055], 6, SHRIMP_PART_IDS.body, 0, () => [
      0.1,
      MID(BANDS.eye),
    ]);
    addSphere(b, [eye[0] + side * 0.004, eye[1] + 0.002, eye[2] + 0.005], 0.017, [
      0.7,
      MID(BANDS.eye),
    ]);
  }
}

const LEG_ATTACH = [0.14, 0.185, 0.23, 0.275, 0.32];
const LEG_FORWARD_KNEE = [0.05, 0.03, 0.02, -0.02, -0.05];
const LEG_FORWARD_TIP = [0.1, 0.08, 0.05, -0.04, -0.12];

function legPath(recipe: ShrimpRecipe, pair: number, side: number): Vec3[] {
  const s = LEG_ATTACH[pair]! * (recipe.carapaceEnd / 0.33);
  const p = interpolateProfile(s);
  const hw = p.hw * recipe.widthScale;
  const yc = spineHeight(recipe, s);
  const bodyBottom = yc - p.bottom * recipe.heightScale;
  const z = zOf(s);
  const reach = recipe.legReach;
  const hip: Vec3 = [side * hw * 0.55, yc - p.bottom * recipe.heightScale * 0.8, z];
  const cheliped = pair < 2;
  const knee: Vec3 = [
    side * (hw + (cheliped ? 0.03 : 0.07) * reach),
    hip[1] + (cheliped ? 0.025 : 0.012),
    z + LEG_FORWARD_KNEE[pair]! * reach,
  ];
  const ground = bodyBottom - recipe.legDrop * reach;
  const tip: Vec3 = [
    side * (hw + (cheliped ? 0.02 : 0.1) * reach),
    cheliped ? hip[1] - 0.03 : ground,
    z + LEG_FORWARD_TIP[pair]! * reach,
  ];
  const mixPoint = (a: Vec3, c: Vec3): Vec3 => [
    (a[0] + c[0]) / 2,
    (a[1] + c[1]) / 2,
    (a[2] + c[2]) / 2,
  ];
  return [hip, mixPoint(hip, knee), knee, mixPoint(knee, tip), tip];
}

function addLegs(b: Builder, recipe: ShrimpRecipe): void {
  for (let pair = 0; pair < LEG_PAIRS; pair++)
    for (const side of [-1, 1]) {
      const radius = pair < 2 ? 0.01 : 0.0085;
      addTube(
        b,
        legPath(recipe, pair, side),
        [radius, radius * 0.85, radius * 0.7, radius * 0.5, radius * 0.4],
        LEG_SIDES,
        SHRIMP_PART_IDS.leg,
        pair * 2 + (side > 0 ? 1 : 0),
        (f) => [f, MID(BANDS.leg)],
      );
    }
}

function addPleopods(b: Builder, recipe: ShrimpRecipe): void {
  const segmentLength = (ABDOMEN_END - recipe.carapaceEnd) / ABDOMEN_SEGMENTS;
  for (let k = 0; k < PLEOPOD_PAIRS; k++) {
    const s = recipe.carapaceEnd + (k + 0.5) * segmentLength;
    const p = interpolateProfile(s);
    const yc = spineHeight(recipe, s);
    for (const side of [-1, 1])
      addLeaf(
        b,
        [side * p.hw * recipe.widthScale * 0.5, yc - p.bottom * recipe.heightScale * 0.9, zOf(s)],
        [side * 0.35, -0.3, -0.9],
        0.07,
        0.022,
        3,
        2,
        SHRIMP_PART_IDS.pleopod,
        k * 2 + (side > 0 ? 1 : 0),
        (u) => u,
        (u) => [u, MID(BANDS.pleopod)],
      );
  }
}

function addTailFan(b: Builder, recipe: ShrimpRecipe): void {
  const s = 0.87;
  const yc = spineHeight(recipe, s);
  const abdomenWeight = (p: number, reach: number): number =>
    clamp((s + reach * p - recipe.carapaceEnd) / (1 - recipe.carapaceEnd), 0, 1);
  const leaves: { dir: Vec3; length: number; width: number }[] = [
    { dir: [0.55, -0.08, -0.85], length: 0.135, width: 0.034 },
    { dir: [0.2, -0.05, -0.97], length: 0.125, width: 0.03 },
  ];
  for (const side of [-1, 1])
    leaves.forEach((leaf, k) => {
      addLeaf(
        b,
        [side * 0.012, yc, zOf(s)],
        [leaf.dir[0] * side, leaf.dir[1], leaf.dir[2]],
        leaf.length,
        leaf.width,
        4,
        4,
        SHRIMP_PART_IDS.abdomen,
        k * 2 + (side > 0 ? 1 : 0),
        (p) => abdomenWeight(p, leaf.length * (-leaf.dir[2] / Math.hypot(...leaf.dir))),
        (p, q) => [p, BANDS.fan.top + (BANDS.fan.bottom - BANDS.fan.top) * (0.5 + 0.5 * q)],
      );
    });
}

function bezier(p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3, t: number): Vec3 {
  const m = 1 - t;
  const w = [m * m * m, 3 * m * m * t, 3 * m * t * t, t * t * t];
  return [0, 1, 2].map(
    (a) => w[0]! * p0[a]! + w[1]! * p1[a]! + w[2]! * p2[a]! + w[3]! * p3[a]!,
  ) as Vec3;
}

function addAntennae(b: Builder, recipe: ShrimpRecipe): void {
  const s = 0.07;
  const p = interpolateProfile(s);
  const yc = spineHeight(recipe, s);
  const baseTop = yc + p.top * recipe.heightScale * 0.6;
  const z = zOf(s) + 0.02;
  for (const side of [-1, 1]) {
    const sideIndex = side > 0 ? 1 : 0;
    const L = recipe.antennaLength;
    const longBase: Vec3 = [side * 0.02, baseTop - 0.012, z];
    const long = [
      longBase,
      [side * 0.06, baseTop + 0.03, z + 0.1],
      [side * 0.27 * L, baseTop + 0.02, z - 0.48 * L],
      [side * 0.46 * L, baseTop - 0.04 * L, z - 0.82 * L],
    ] as [Vec3, Vec3, Vec3, Vec3];
    const longPoints = Array.from({ length: 11 }, (_, i) => bezier(...long, i / 10));
    addTube(
      b,
      longPoints,
      longPoints.map((_, i) => 0.0045 * (1 - 0.7 * (i / 10))),
      ANTENNA_SIDES,
      SHRIMP_PART_IDS.antenna,
      2 + sideIndex,
      (f) => [f, MID(BANDS.antenna)],
    );
    const U = recipe.antennuleLength;
    const shortBase: Vec3 = [side * 0.014, baseTop + 0.004, z + 0.01];
    const short = [
      shortBase,
      [side * 0.02, baseTop + 0.03, z + 0.12 * U],
      [side * 0.06 * U, baseTop + 0.05, z + 0.6 * U],
      [side * 0.18 * U, baseTop + 0.03, z + U],
    ] as [Vec3, Vec3, Vec3, Vec3];
    const shortPoints = Array.from({ length: 7 }, (_, i) => bezier(...short, i / 6));
    addTube(
      b,
      shortPoints,
      shortPoints.map((_, i) => 0.0035 * (1 - 0.6 * (i / 6))),
      ANTENNA_SIDES,
      SHRIMP_PART_IDS.antenna,
      sideIndex,
      (f) => [f, MID(BANDS.antenna)],
    );
  }
}

export interface ShrimpGeometry {
  part: Part;
  standoff: number;
  hinge: { y: number; z: number };
  telsonZ: number;
}

export function buildShrimpGeometry(recipe: ShrimpRecipe, standardLengthM: number): ShrimpGeometry {
  const b = new Builder();
  addBody(b, recipe);
  addEyes(b, recipe);
  addLegs(b, recipe);
  addPleopods(b, recipe);
  addTailFan(b, recipe);
  addAntennae(b, recipe);

  const positions = Float32Array.from(b.positions);
  const indices = Uint32Array.from(b.indices);
  const id = Float32Array.from(b.id);
  const bodyCount = (RING + 1) * bodySections(recipe).length;

  let area = 0;
  let cy = 0;
  let cz = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t]!;
    const c = indices[t + 1]!;
    const d = indices[t + 2]!;
    if (a >= bodyCount || c >= bodyCount || d >= bodyCount) continue;
    const e1: Vec3 = [0, 1, 2].map((k) => positions[c * 3 + k]! - positions[a * 3 + k]!) as Vec3;
    const e2: Vec3 = [0, 1, 2].map((k) => positions[d * 3 + k]! - positions[a * 3 + k]!) as Vec3;
    const tri = Math.hypot(...crossOf(e1, e2)) / 2;
    area += tri;
    cy += (tri * (positions[a * 3 + 1]! + positions[c * 3 + 1]! + positions[d * 3 + 1]!)) / 3;
    cz += (tri * (positions[a * 3 + 2]! + positions[c * 3 + 2]! + positions[d * 3 + 2]!)) / 3;
  }
  cy /= area;
  cz /= area;

  const scale = standardLengthM;
  let minLegY = Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    positions[i] = positions[i]! * scale;
    positions[i + 1] = (positions[i + 1]! - cy) * scale;
    positions[i + 2] = (positions[i + 2]! - cz) * scale;
    if (id[i / 3] === SHRIMP_PART_IDS.leg) minLegY = Math.min(minLegY, positions[i + 1]!);
  }
  const hingeS = recipe.carapaceEnd;
  const normals = vertexNormals(positions, indices);
  const part: Part = {
    positions,
    normals,
    uvs: Float32Array.from(b.uvs),
    indices,
    material: recipe.id,
    extra: {
      [FIN_MASK_ATTRIBUTE]: Float32Array.from(b.weight),
      [FIN_ID_ATTRIBUTE]: id,
      [LEG_ATTRIBUTE]: Float32Array.from(b.limb),
    },
  };
  return {
    part,
    standoff: -minLegY,
    hinge: { y: (spineHeight(recipe, hingeS) - cy) * scale, z: (zOf(hingeS) - cz) * scale },
    telsonZ: (0 - cz) * scale,
  };
}

type Rgb = [number, number, number];

const mix = (a: Rgb, b: Rgb, t: number): Rgb => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

const PALETTE = {
  cleaner: {
    flank: [0.95, 0.56, 0.22] as Rgb,
    belly: [0.98, 0.82, 0.58] as Rgb,
    red: [0.78, 0.05, 0.04] as Rgb,
    white: [0.97, 0.97, 1] as Rgb,
    leg: [0.96, 0.62, 0.28] as Rgb,
    pleopod: [0.97, 0.72, 0.5] as Rgb,
    antenna: [0.97, 0.98, 1] as Rgb,
    stalk: [0.95, 0.78, 0.62] as Rgb,
  },
  cherry: {
    flank: [0.85, 0.2, 0.12] as Rgb,
    belly: [0.93, 0.42, 0.28] as Rgb,
    red: [0.72, 0.06, 0.05] as Rgb,
    white: [0.94, 0.55, 0.45] as Rgb,
    leg: [0.88, 0.52, 0.46] as Rgb,
    pleopod: [0.9, 0.35, 0.3] as Rgb,
    antenna: [0.86, 0.62, 0.56] as Rgb,
    stalk: [0.8, 0.45, 0.38] as Rgb,
  },
};

// Cherry translucency hint: glTF alphaMode BLEND with baseColorFactor alpha 0.86; the renderer should keep depth write on and treat it as a slightly see-through shell. Cleaner stays OPAQUE.
const CHERRY_ALPHA = 0.86;
const CHERRY_SADDLE: Rgb = [0.45, 0.03, 0.04];
const EYE_BLACK: Rgb = [0.02, 0.02, 0.025];

export function shrimpTexture(recipe: ShrimpRecipe): Rgba {
  const random = mulberry32(recipe.seed);
  const data = new Uint8Array(ATLAS_WIDTH * ATLAS_HEIGHT * 4);
  const cleaner = recipe.kind === 'cleaner';
  const pal = PALETTE[recipe.kind];
  const segmentLength = (ABDOMEN_END - recipe.carapaceEnd) / ABDOMEN_SEGMENTS;

  const paintBody = (u: number, t: number): Rgb => {
    const theta = Math.abs(t - 0.5) * 2;
    let colour = mix(pal.flank, pal.belly, smoothstep(0.55, 0.85, theta));
    if (cleaner) {
      const ends = smoothstep(0, 0.05, u) * (1 - smoothstep(0.86, 0.9, u));
      const band = smoothstep(0.05, 0.09, theta) * (1 - smoothstep(0.42, 0.52, theta)) * ends;
      colour = mix(colour, pal.red, band);
      const stripe = 0.025 + 0.045 * smoothstep(0, 0.2, u);
      const white = (1 - smoothstep(stripe - 0.012, stripe, theta)) * smoothstep(0, 0.03, u);
      colour = mix(colour, pal.white, white * (1 - smoothstep(0.86, 0.9, u)));
      if (u > ABDOMEN_END) colour = mix(colour, pal.red, 1 - smoothstep(0.97, 0.995, u));
      if (u > 0.985) colour = pal.white;
    } else {
      const saddle = (1 - smoothstep(0.08, 0.34, theta)) * smoothstep(0.02, 0.1, u);
      colour = mix(colour, mix(pal.red, CHERRY_SADDLE, 0.5), saddle);
      const cell = (random() - 0.5) * 0.05;
      colour = [colour[0] + cell, colour[1] + cell * 0.4, colour[2] + cell * 0.4];
    }
    const into = (u - recipe.carapaceEnd) / segmentLength;
    if (into >= 0 && u < ABDOMEN_END) {
      const groove = (1 - (into - Math.floor(into))) ** 6;
      colour = mix(colour, [colour[0] * 0.55, colour[1] * 0.5, colour[2] * 0.5], 0.5 * groove);
    }
    return colour;
  };

  const paintFan = (p: number, q: number): Rgb => {
    const r = Math.abs(2 * q - 1);
    if (cleaner) {
      const rim = Math.max(smoothstep(0.78, 0.86, r), smoothstep(0.88, 0.94, p));
      return mix(pal.red, pal.white, rim);
    }
    return mix(mix(pal.red, CHERRY_SADDLE, 0.25 * (1 - r)), pal.white, smoothstep(0.8, 1, r) * 0.7);
  };

  const paintBand = (band: keyof typeof BANDS, u: number): Rgb => {
    switch (band) {
      case 'leg':
        return cleaner
          ? mix(pal.leg, pal.white, smoothstep(0.82, 0.9, u))
          : mix(pal.leg, pal.flank, 0.3 * smoothstep(0.8, 1, u));
      case 'pleopod':
        return mix(pal.pleopod, pal.white, cleaner ? 0.35 * u : 0.15 * u);
      case 'antenna':
        return cleaner ? pal.antenna : mix(pal.antenna, pal.flank, 0.5 * smoothstep(0.3, 1, u));
      case 'eye':
        return u < 0.3 ? pal.stalk : EYE_BLACK;
      default:
        return pal.leg;
    }
  };

  for (let y = 0; y < ATLAS_HEIGHT; y++) {
    const v = (y + 0.5) / ATLAS_HEIGHT;
    for (let x = 0; x < ATLAS_WIDTH; x++) {
      const u = (x + 0.5) / ATLAS_WIDTH;
      let c: Rgb;
      if (v < BODY_V_MAX) c = paintBody(u, v / BODY_V_MAX);
      else if (v < BANDS.fan.bottom)
        c = paintFan(u, (v - BANDS.fan.top) / (BANDS.fan.bottom - BANDS.fan.top));
      else if (v < BANDS.leg.bottom) c = paintBand('leg', u);
      else if (v < BANDS.pleopod.bottom) c = paintBand('pleopod', u);
      else if (v < BANDS.antenna.bottom) c = paintBand('antenna', u);
      else c = paintBand('eye', u);
      const o = (y * ATLAS_WIDTH + x) * 4;
      for (let k = 0; k < 3; k++) data[o + k] = Math.round(clamp(c[k]!, 0, 1) * 255);
      data[o + 3] = 255;
    }
  }
  return { width: ATLAS_WIDTH, height: ATLAS_HEIGHT, data };
}

export function shrimpMaterial(recipe: ShrimpRecipe, image: Rgba): MaterialDef {
  return {
    name: recipe.id,
    baseColorFactor: [1, 1, 1, recipe.kind === 'cherry' ? CHERRY_ALPHA : 1],
    baseColor: { role: 'baseColor', codec: 'etc1s', image },
    roughness: 0.4,
    metallic: 0,
    alphaMode: recipe.kind === 'cherry' ? 'BLEND' : 'OPAQUE',
    doubleSided: true,
    normalScale: 1,
  };
}

const PART_COLOURS: Record<number, Rgb> = {
  0: [0.7, 0.7, 0.72],
  6: [1, 0.85, 0.2],
  7: [0.2, 0.9, 1],
  8: [1, 0.3, 0.85],
  9: [1, 0.5, 0.15],
};

function partColours(id: Float32Array, weight: Float32Array): Float32Array {
  const colours = new Float32Array(id.length * 3);
  for (let i = 0; i < id.length; i++) {
    const base = PART_COLOURS[id[i]!] ?? PART_COLOURS[0]!;
    const k = id[i] === 0 ? 1 : 0.45 + 0.55 * weight[i]!;
    for (let c = 0; c < 3; c++) colours[i * 3 + c] = base[c]! * k;
  }
  return colours;
}

export async function writeShrimpDebugRenders(
  repoRoot: string,
  recipe: ShrimpRecipe,
  part: Part,
  atlas: Rgba,
): Promise<{ textured: string; parts: string }> {
  const dir = join(repoRoot, 'tools', 'asset-pipeline', 'debug');
  mkdirSync(dir, { recursive: true });
  const views = [
    { view: 'side', pixelsAcross: 1100 },
    { view: 'top', pixelsAcross: 1100 },
  ] as const;
  const mesh = { positions: part.positions, indices: part.indices, normals: part.normals };
  const textured = await renderSheet({ ...mesh, uvs: part.uvs }, [...views], {
    data: atlas.data,
    width: atlas.width,
    height: atlas.height,
    channels: 4,
  });
  const parts = await renderSheet(
    {
      ...mesh,
      colors: partColours(part.extra[FIN_ID_ATTRIBUTE]!, part.extra[FIN_MASK_ATTRIBUTE]!),
    },
    [...views],
  );
  writeFileSync(join(dir, `${recipe.id}.png`), textured);
  writeFileSync(join(dir, `${recipe.id}-parts.png`), parts);
  return { textured: `debug/${recipe.id}.png`, parts: `debug/${recipe.id}-parts.png` };
}

export function shrimpLength(
  repoRoot: string,
  species: string,
): { metres: number; source: 'species-json' } | null {
  for (const directory of ['species', 'species-pending']) {
    if (!existsSync(join(repoRoot, 'content', directory, `${species}.json`))) continue;
    const metres = speciesLengthM(repoRoot, species, directory);
    if (metres !== null) return { metres, source: 'species-json' };
  }
  return null;
}

export async function buildShrimp(recipe: ShrimpRecipe, ctx: FishContext): Promise<OutputAsset> {
  const fromSpecies = shrimpLength(ctx.repoRoot, recipe.species);
  const standardLengthM = fromSpecies?.metres ?? recipe.fallbackLengthM;
  const geometry = buildShrimpGeometry(recipe, standardLengthM);
  const image = shrimpTexture(recipe);
  const debug = await writeShrimpDebugRenders(ctx.repoRoot, recipe, geometry.part, image);
  const built = buildDocument(recipe.id, [geometry.part], [shrimpMaterial(recipe, image)]);
  return emitAsset({
    outRoot: ctx.outRoot,
    kind: 'shrimp',
    id: recipe.id,
    built,
    plan: SHRIMP_LOD_PLAN,
    meta: {
      species: recipe.species,
      origin: 'procedural',
      sources: [],
      licence: 'CC0-1.0',
      modifications: [
        'generated procedurally: lofted carapace and six-segment abdomen, five walking leg pairs, five pleopod pairs, tail fan, eye stalks, antennae and antennules, deterministic seed',
        'oriented to +Z forward / +Y up, origin at the body centre of mass, scaled so rostrum to telson tip is the standard length',
        '_FIN_ID part ids 0 body and eyes, 6 leg, 7 antenna, 8 pleopod, 9 abdomen and tail fan; _FIN_MASK weight along the limb; _LEG limb index',
        'colour atlas painted procedurally; palette and layout matched by eye to the reference photos, no photo pixels shipped',
        recipe.note,
      ],
      shrimp: {
        standardLengthM,
        lengthSource: fromSpecies ? 'species-json' : 'recipe',
        axes: { forward: '+z', up: '+y' },
        origin: 'centre-of-mass',
        standoffM: geometry.standoff,
        attributes: { partId: FIN_ID_ATTRIBUTE, weight: FIN_MASK_ATTRIBUTE, limb: LEG_ATTRIBUTE },
        partIds: { ...SHRIMP_PART_IDS },
        legPairs: LEG_PAIRS,
        pleopodPairs: PLEOPOD_PAIRS,
        abdomenHinge: geometry.hinge,
        telsonZ: geometry.telsonZ,
        debugRender: debug.textured,
        debugPartsRender: debug.parts,
      },
    },
  });
}
