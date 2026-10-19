import type { Primitive } from '@gltf-transform/core';
import { buildDocument, emitAsset, type LodPlan } from './emit.ts';
import {
  areaCentroid,
  boundsOf,
  canonicalVertices,
  dot,
  loadScan,
  principalAxes,
  place,
  pointAt,
  sub,
  unit,
} from './crew-scan.ts';
import { speciesLengthM, type FishContext } from './fish.ts';
import {
  FIN_ID_ATTRIBUTE,
  FIN_MASK_ATTRIBUTE,
  SNAIL_PART_IDS,
  type OutputAsset,
} from './index-schema.ts';
import { signedVolume, vertexNormals } from './loft.ts';
import { clamp, cross, percentile, smoothstep, type Vec3 } from './math.ts';
import type { MaterialDef, Part } from './parts.ts';
import { simplifyPrimitive, triangleCountOf } from './lod.ts';
import { growMask, inpaintColours, smoothMasked } from './dense-edit.ts';
import { writeShippedDebugRenders } from './crew-debug.ts';
import { weldDense, type Dense } from './rebake.ts';
import { bakeScanPart } from './scan-bake.ts';
import type { Rgba } from './textures.ts';

export interface ShellRetouch {
  /** Sphere centre as fractions of the shell length; height counts up from the shell's lowest point. */
  centre: Vec3;
  radius: number;
  /** Pale pixels (every channel above this) inside the sphere are repainted. */
  minChannel: number;
  note: string;
}

export interface NeriteRecipe {
  id: string;
  species: string;
  sourceId: string;
  dropMeshes: RegExp;
  fallbackLengthM: number;
  shellTriangles: [number, number, number];
  bodyRatios: [number, number, number];
  textureSize: number;
  /** Triangle budget of the baked shell at LOD0. */
  bakeTriangles: number;
  /** White marks of the scan's colour checker and handling, painted over from the shell around them. */
  retouch: ShellRetouch[];
  note: string;
}

export const NERITE_RECIPES: NeriteRecipe[] = [
  {
    id: 'nerite-snail',
    species: 'nerite-snail',
    sourceId: 'sketchfab-70b8866a',
    dropMeshes: /^Object_0$/,
    fallbackLengthM: 0.02,
    shellTriangles: [9000, 3600, 1300],
    bodyRatios: [1, 0.6, 0.35],
    textureSize: 2048,
    bakeTriangles: 9000,
    retouch: [
      {
        centre: [0.024, 0.5965, -0.2705],
        radius: 0.08,
        minChannel: 0.5,
        note: 'white marker ring on the dome',
      },
      {
        centre: [-0.3, 0.252, -0.45],
        radius: 0.16,
        minChannel: 0.42,
        note: 'white scar near the rear',
      },
    ],
    note: 'foot, head and tentacle colour matched by eye to the Wikimedia nerite photo, no photo pixels shipped',
  },
];

export const SHELL_MATERIAL = 'nerite-shell';
export const BODY_MATERIAL = 'nerite-body';

/** How far a vertex normal strays from its neighbours' mean: near 0 on the smooth dome, high on the crusty scanned underside. */
export function vertexRoughness(
  positions: Float32Array,
  indices: Uint32Array,
  canon: Int32Array,
): Float32Array {
  const count = positions.length / 3;
  const normals = vertexNormals(positions, indices);
  const sum = new Float32Array(count * 3);
  for (let t = 0; t < indices.length; t += 3)
    for (let k = 0; k < 3; k++) {
      const a = indices[t + k]!;
      const b = indices[t + ((k + 1) % 3)]!;
      for (let q = 0; q < 3; q++) {
        sum[canon[a]! * 3 + q]! += normals[b * 3 + q]!;
        sum[canon[b]! * 3 + q]! += normals[a * 3 + q]!;
      }
    }
  const rough = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const c = canon[i]! * 3;
    const length = Math.hypot(sum[c]!, sum[c + 1]!, sum[c + 2]!) || 1;
    rough[i] =
      1 -
      (normals[i * 3]! * sum[c]! +
        normals[i * 3 + 1]! * sum[c + 1]! +
        normals[i * 3 + 2]! * sum[c + 2]!) /
        length;
  }
  return rough;
}

export interface ShellFrame {
  /** Centre of the aperture side of the shell, in source space. */
  rimCentre: Vec3;
  up: Vec3;
  forward: Vec3;
  right: Vec3;
}

const ROUGH_THRESHOLD = 0.08;
const RIM_PASSES = 2;
const RIM_BAND = 0.07;

/**
 * Finds up and forward of a scanned snail shell whose aperture side is the only crusty surface:
 * up points from that rough underside to the smooth dome, forward from the dome peak towards the aperture.
 */
export function shellFrame(
  positions: Float32Array,
  indices: Uint32Array,
  fallbackForward: Vec3 = [0, 0, 1],
): ShellFrame {
  const count = positions.length / 3;
  const { min, max } = boundsOf(positions);
  const longest = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  const canon = canonicalVertices(positions, longest / 4000);
  const rough = vertexRoughness(positions, indices, canon);
  const all: Vec3 = [0, 0, 0];
  const crusty: Vec3 = [0, 0, 0];
  const crustyPoints: Vec3[] = [];
  let crustyCount = 0;
  for (let i = 0; i < count; i++) {
    const p = pointAt(positions, i);
    for (let a = 0; a < 3; a++) all[a]! += p[a]! / count;
    if (rough[i]! > ROUGH_THRESHOLD) {
      crustyCount++;
      crustyPoints.push(p);
      for (let a = 0; a < 3; a++) crusty[a]! += p[a]!;
    }
  }
  if (crustyCount < count * 0.005)
    throw new Error(
      'shellFrame: no crusty underside found; the shell scan changed, recheck the orientation recipe',
    );
  for (let a = 0; a < 3; a++) crusty[a]! /= crustyCount;
  const towardDome = sub(all, crusty);
  const orient = (axis: Vec3): Vec3 =>
    dot(axis, towardDome) >= 0 ? axis : [-axis[0], -axis[1], -axis[2]];
  let up = orient(principalAxes(crustyPoints).axes[2]);
  for (let pass = 0; pass < RIM_PASSES; pass++) {
    const heightsNow = Array.from({ length: count }, (_, i) => dot(pointAt(positions, i), up));
    const floor = percentile(Float32Array.from(heightsNow).sort(), 0.01);
    const roof = percentile(Float32Array.from(heightsNow).sort(), 0.99);
    const rimPoints: Vec3[] = [];
    for (let i = 0; i < count; i++)
      if (heightsNow[i]! < floor + (roof - floor) * RIM_BAND) rimPoints.push(pointAt(positions, i));
    up = orient(principalAxes(rimPoints).axes[2]);
  }

  const heights = new Float32Array(count);
  for (let i = 0; i < count; i++) heights[i] = dot(pointAt(positions, i), up);
  const sortedHeights = Float32Array.from(heights).sort();
  const crown = percentile(sortedHeights, 0.92);
  const dome: Vec3 = [0, 0, 0];
  let domeCount = 0;
  for (let i = 0; i < count; i++)
    if (heights[i]! >= crown) {
      domeCount++;
      const p = pointAt(positions, i);
      for (let a = 0; a < 3; a++) dome[a]! += p[a]!;
    }
  for (let a = 0; a < 3; a++) dome[a]! /= domeCount;
  const rim = crusty;

  const toRim = sub(all, dome);
  const planar: Vec3 = [
    toRim[0] - up[0] * dot(toRim, up),
    toRim[1] - up[1] * dot(toRim, up),
    toRim[2] - up[2] * dot(toRim, up),
  ];
  const forward = Math.hypot(...planar) > longest * 0.01 ? unit(planar) : unit(fallbackForward);
  const right = unit(cross(up, forward));
  return { rimCentre: rim, up, forward: unit(cross(right, up)), right };
}

interface Rings {
  positions: number[];
  ids: number[];
  weights: number[];
  indices: number[];
}

function pushRing(rings: Rings, points: Vec3[], id: number, weight: number): number {
  const first = rings.positions.length / 3;
  for (const p of points) {
    rings.positions.push(p[0], p[1], p[2]);
    rings.ids.push(id);
    rings.weights.push(weight);
  }
  return first;
}

function pushPoint(rings: Rings, p: Vec3, id: number, weight: number): number {
  return pushRing(rings, [p], id, weight);
}

function stitch(rings: Rings, a: number, b: number, segments: number): void {
  for (let k = 0; k < segments; k++) {
    const k1 = (k + 1) % segments;
    rings.indices.push(a + k, b + k, b + k1, a + k, b + k1, a + k1);
  }
}

function fan(rings: Rings, ring: number, centre: number, segments: number, flip: boolean): void {
  for (let k = 0; k < segments; k++) {
    const k1 = (k + 1) % segments;
    if (flip) rings.indices.push(centre, ring + k1, ring + k);
    else rings.indices.push(centre, ring + k, ring + k1);
  }
}
const FOOT_SEGMENTS = 40;
const FOOT_ROUNDNESS = 2.2;
const HEAD_SEGMENTS = 16;
const HEAD_RINGS = 8;
const TENTACLE_SIDES = 6;
const TENTACLE_STEPS = 8;

/** Foot rows as (height as a fraction of footH, outline scale, ripple weight): flat sole, widest near the bottom, domed top. */
const FOOT_PROFILE: [number, number, number][] = [
  [0, 0.88, 0.5],
  [0.12, 1, 1],
  [0.45, 0.96, 1],
  [0.8, 0.76, 0.5],
  [1, 0.42, 0.15],
];

const RAMP_HEIGHT = 64;
const RAMP_WIDTH = 8;
const RAMP_STOPS: [number, Vec3][] = [
  [0, [0.36, 0.33, 0.27]],
  [0.3, [0.22, 0.205, 0.18]],
  [0.4, [0.21, 0.195, 0.17]],
  [0.5, [0.17, 0.155, 0.135]],
  [0.95, [0.33, 0.3, 0.25]],
  [1, [0.33, 0.3, 0.25]],
];

function rampColour(v: number): Vec3 {
  for (let k = 1; k < RAMP_STOPS.length; k++) {
    const [v1, c1] = RAMP_STOPS[k]!;
    const [v0, c0] = RAMP_STOPS[k - 1]!;
    if (v <= v1) {
      const f = (v - v0) / (v1 - v0);
      return [
        c0[0] + (c1[0] - c0[0]) * f,
        c0[1] + (c1[1] - c0[1]) * f,
        c0[2] + (c1[2] - c0[2]) * f,
      ];
    }
  }
  return RAMP_STOPS[RAMP_STOPS.length - 1]![1];
}

/** Vertical colour ramp the foot, head and tentacle UVs index into: pale foot edge, dark centre and head, lighter tentacle tips. */
export function bodyRamp(): Rgba {
  const data = new Uint8Array(RAMP_WIDTH * RAMP_HEIGHT * 4);
  for (let y = 0; y < RAMP_HEIGHT; y++) {
    const colour = rampColour(y / (RAMP_HEIGHT - 1));
    for (let x = 0; x < RAMP_WIDTH; x++) {
      const o = (y * RAMP_WIDTH + x) * 4;
      for (let c = 0; c < 3; c++) data[o + c] = Math.round(colour[c]! * 255);
      data[o + 3] = 255;
    }
  }
  return { width: RAMP_WIDTH, height: RAMP_HEIGHT, data };
}

export interface ShellFootprint {
  /** Half-width of the aperture rim across the shell. */
  halfWidth: number;
  rearZ: number;
  /** Furthest forward point of the whole shell. */
  frontZ: number;
  /** Height of the lowest rim points above the ground. */
  rimY: number;
}

function signedPow(v: number, exponent: number): number {
  return Math.sign(v) * Math.abs(v) ** exponent;
}

function closeSurface(rings: Rings): {
  indices: Uint32Array<ArrayBuffer>;
  positions: Float32Array<ArrayBuffer>;
} {
  const positions = Float32Array.from(rings.positions);
  const indices = Uint32Array.from(rings.indices);
  if (signedVolume(positions, indices) < 0) {
    for (let t = 0; t < indices.length; t += 3) {
      const b = indices[t + 1]!;
      indices[t + 1] = indices[t + 2]!;
      indices[t + 2] = b;
    }
  }
  return { positions, indices };
}

function tentacleCentreline(base: Vec3, side: number, length: number): (t: number) => Vec3 {
  return (t) => [
    base[0] + side * length * (0.5 * t + 0.2 * t * t),
    base[1] + length * (0.42 * t - 0.2 * t * t),
    base[2] + length * (0.78 * t + 0.1 * t * t),
  ];
}

export interface NeriteBody {
  part: Part;
  /** Where the foot sits along z before the model is moved to put the foot centre at the origin. */
  footCentreZ: number;
}

/**
 * Procedural body for a nerite: a thin rounded lens-section foot under the shell that reaches out in front of
 * the lip, a low head on its front end, in front of the shell, and two slender curved tentacles starting on the
 * head. Ground is y = 0, forward is +z, `length` is the shell length. UV v indexes `bodyRamp`.
 */
export function buildNeriteBody(footprint: ShellFootprint, length: number): NeriteBody {
  const rings: Rings = { positions: [], ids: [], weights: [], indices: [] };
  const uvs: number[] = [];
  const pushUv = (count: number, v: (k: number) => number): void => {
    for (let k = 0; k < count; k++) uvs.push(0.5, v(k));
  };
  const footH = length * 0.062;
  const halfWidth = footprint.halfWidth * 0.95;
  const rear = footprint.rearZ + length * 0.05;
  const front = footprint.frontZ + length * 0.17;
  const centreZ = (rear + front) / 2;
  const halfLength = (front - rear) / 2;
  const edgeV = (scale: number): number => 0.3 * clamp((1 - scale) / 0.58, 0, 1);

  const footRings: number[] = [];
  for (const [rise, scale, weight] of FOOT_PROFILE) {
    const points: Vec3[] = [];
    for (let k = 0; k < FOOT_SEGMENTS; k++) {
      const angle = (k / FOOT_SEGMENTS) * Math.PI * 2;
      const taper = 1 - 0.3 * smoothstep(0, 1, Math.max(0, Math.sin(angle)));
      points.push([
        halfWidth * scale * taper * signedPow(Math.cos(angle), 2 / FOOT_ROUNDNESS),
        rise * footH,
        centreZ + halfLength * scale * signedPow(Math.sin(angle), 2 / FOOT_ROUNDNESS),
      ]);
    }
    footRings.push(pushRing(rings, points, SNAIL_PART_IDS.foot, weight));
    pushUv(
      FOOT_SEGMENTS,
      (k) =>
        edgeV(scale) + 0.05 * (0.5 + 0.5 * Math.sin((k / FOOT_SEGMENTS) * Math.PI * 14 + rise * 5)),
    );
  }
  const soleCentre = pushPoint(rings, [0, 0, centreZ], SNAIL_PART_IDS.foot, 0);
  pushUv(1, () => 0.3);
  const topCentre = pushPoint(rings, [0, footH * 1.03, centreZ], SNAIL_PART_IDS.foot, 0);
  pushUv(1, () => 0.3);
  fan(rings, footRings[0]!, soleCentre, FOOT_SEGMENTS, false);
  for (let r = 0; r + 1 < footRings.length; r++)
    stitch(rings, footRings[r]!, footRings[r + 1]!, FOOT_SEGMENTS);
  fan(rings, footRings[footRings.length - 1]!, topCentre, FOOT_SEGMENTS, true);

  const headCentre: Vec3 = [0, footH * 0.72, front - length * 0.1];
  const headRadius: Vec3 = [halfWidth * 0.27, footH * 0.55, length * 0.12];
  const headRings: number[] = [];
  for (let r = 1; r < HEAD_RINGS; r++) {
    const phi = (r / HEAD_RINGS) * Math.PI;
    const points: Vec3[] = [];
    for (let k = 0; k < HEAD_SEGMENTS; k++) {
      const angle = (k / HEAD_SEGMENTS) * Math.PI * 2;
      points.push([
        headCentre[0] + headRadius[0] * Math.sin(phi) * Math.cos(angle),
        headCentre[1] + headRadius[1] * Math.sin(phi) * Math.sin(angle),
        headCentre[2] + headRadius[2] * Math.cos(phi),
      ]);
    }
    headRings.push(pushRing(rings, points, SNAIL_PART_IDS.head, 0));
    pushUv(HEAD_SEGMENTS, () => 0.4);
  }
  const headTip = pushPoint(
    rings,
    [headCentre[0], headCentre[1], headCentre[2] - headRadius[2]],
    SNAIL_PART_IDS.head,
    0,
  );
  pushUv(1, () => 0.4);
  const headNose = pushPoint(
    rings,
    [headCentre[0], headCentre[1], headCentre[2] + headRadius[2]],
    SNAIL_PART_IDS.head,
    0,
  );
  pushUv(1, () => 0.4);
  fan(rings, headRings[0]!, headNose, HEAD_SEGMENTS, false);
  for (let r = 0; r + 1 < headRings.length; r++)
    stitch(rings, headRings[r]!, headRings[r + 1]!, HEAD_SEGMENTS);
  fan(rings, headRings[headRings.length - 1]!, headTip, HEAD_SEGMENTS, true);

  const tentacleLength = length * 0.34;
  for (const side of [-1, 1]) {
    const base: Vec3 = [
      side * headRadius[0] * 0.5,
      headCentre[1] + headRadius[1] * 0.5,
      headCentre[2] + headRadius[2] * 0.55,
    ];
    const centre = tentacleCentreline(base, side, tentacleLength);
    const baseRadius = length * 0.017;
    const tubeRings: number[] = [];
    for (let s = 0; s <= TENTACLE_STEPS; s++) {
      const t = s / TENTACLE_STEPS;
      const here = centre(t);
      const tangent = unit(sub(centre(Math.min(1, t + 0.02)), centre(Math.max(0, t - 0.02))));
      const sideways = unit(cross(tangent, [0, 1, 0]));
      const lift = cross(sideways, tangent);
      const radius = baseRadius * (1 - 0.8 * t);
      const points: Vec3[] = [];
      for (let k = 0; k < TENTACLE_SIDES; k++) {
        const angle = (k / TENTACLE_SIDES) * Math.PI * 2;
        points.push([
          here[0] + radius * (Math.cos(angle) * sideways[0] + Math.sin(angle) * lift[0]),
          here[1] + radius * (Math.cos(angle) * sideways[1] + Math.sin(angle) * lift[1]),
          here[2] + radius * (Math.cos(angle) * sideways[2] + Math.sin(angle) * lift[2]),
        ]);
      }
      tubeRings.push(pushRing(rings, points, SNAIL_PART_IDS.tentacle, t));
      pushUv(TENTACLE_SIDES, () => 0.5 + 0.45 * t);
    }
    pushPoint(rings, centre(1), SNAIL_PART_IDS.tentacle, 1);
    pushUv(1, () => 0.95);
    pushPoint(rings, centre(0), SNAIL_PART_IDS.tentacle, 0);
    pushUv(1, () => 0.5);
    const root = rings.positions.length / 3 - 1;
    const tip = root - 1;
    for (let r = 0; r + 1 < tubeRings.length; r++)
      stitch(rings, tubeRings[r]!, tubeRings[r + 1]!, TENTACLE_SIDES);
    fan(rings, tubeRings[tubeRings.length - 1]!, tip, TENTACLE_SIDES, true);
    fan(rings, tubeRings[0]!, root, TENTACLE_SIDES, false);
  }

  const { positions, indices } = closeSurface(rings);
  const normals = vertexNormals(positions, indices);
  return {
    footCentreZ: centreZ,
    part: {
      positions,
      normals,
      uvs: Float32Array.from(uvs),
      indices,
      material: BODY_MATERIAL,
      extra: {
        [FIN_ID_ATTRIBUTE]: Float32Array.from(rings.ids),
        [FIN_MASK_ATTRIBUTE]: Float32Array.from(rings.weights),
      },
    },
  };
}

export interface PlacedShell {
  part: Part;
  footprint: ShellFootprint;
  length: number;
}

/** Orients, scales and seats the scanned shell: +z forward, +y up, ground at y = 0, origin under the shell's centre. */
export function placeShell(part: Part, standardLengthM: number): PlacedShell {
  const frame = shellFrame(part.positions, part.indices);
  const origin = areaCentroid(part.positions, part.indices);
  place(part, {
    origin,
    right: frame.right,
    up: frame.up,
    forward: frame.forward,
    scale: 1,
    shift: [0, 0, 0],
  });
  const placed = boundsOf(part.positions);
  const lengthNow = Math.max(
    placed.max[0] - placed.min[0],
    placed.max[1] - placed.min[1],
    placed.max[2] - placed.min[2],
  );
  const scale = standardLengthM / lengthNow;
  const heights = Array.from(
    { length: part.positions.length / 3 },
    (_, i) => part.positions[i * 3 + 1]!,
  ).sort((a, b) => a - b);
  const rimLevel = percentile(heights, 0.01);
  const rimY = standardLengthM * 0.05;
  const rimBand = rimLevel + (placed.max[1] - rimLevel) * 0.1;
  let zMin = Infinity;
  let xMax = 0;
  for (let i = 0; i < part.positions.length; i += 3)
    if (part.positions[i + 1]! < rimBand) {
      zMin = Math.min(zMin, part.positions[i + 2]!);
      xMax = Math.max(xMax, Math.abs(part.positions[i]!));
    }
  for (let i = 0; i < part.positions.length; i += 3) {
    part.positions[i] = part.positions[i]! * scale;
    part.positions[i + 1] = (part.positions[i + 1]! - rimLevel) * scale + rimY;
    part.positions[i + 2] = part.positions[i + 2]! * scale;
  }
  const normals = vertexNormals(part.positions, part.indices);
  part.normals.set(normals);
  return {
    part,
    length: standardLengthM,
    footprint: {
      halfWidth: xMax * scale,
      rearZ: zMin * scale,
      frontZ: boundsOf(part.positions).max[2],
      rimY,
    },
  };
}

const SMOOTH_ROUGHNESS = 0.04;
const SMOOTH_PASSES = 120;
const SMOOTH_REACH = 8;
const RETOUCH_REACH = 8;
const RETOUCH_MAX_SATURATION = 0.3;
const CLOSE_HOLES_UP_TO = 12;

/**
 * Cleans the welded dense shell before it is baked: the crusty aperture lip is relaxed (so decimation does not
 * leave saw-teeth), then the pale scan marks listed in the recipe are painted over from the colours around them.
 */
export function cleanShell(dense: Dense, length: number, retouch: ShellRetouch[]): void {
  const count = dense.positions.length / 3;
  const identity = Int32Array.from({ length: count }, (_, i) => i);
  const rough = vertexRoughness(dense.positions, dense.indices, identity);
  const crusty = new Uint8Array(count);
  for (let i = 0; i < count; i++) if (rough[i]! > SMOOTH_ROUGHNESS) crusty[i] = 1;
  smoothMasked(dense, growMask(dense, crusty, SMOOTH_REACH), SMOOTH_PASSES);

  let lowest = Infinity;
  for (let i = 0; i < count; i++) lowest = Math.min(lowest, dense.positions[i * 3 + 1]!);
  const marks = new Uint8Array(count);
  for (const spot of retouch) {
    const centre: Vec3 = [
      spot.centre[0] * length,
      lowest + spot.centre[1] * length,
      spot.centre[2] * length,
    ];
    for (let i = 0; i < count; i++) {
      const distance = Math.hypot(
        dense.positions[i * 3]! - centre[0],
        dense.positions[i * 3 + 1]! - centre[1],
        dense.positions[i * 3 + 2]! - centre[2],
      );
      if (distance > spot.radius * length) continue;
      const r = dense.colours[i * 3]!;
      const g = dense.colours[i * 3 + 1]!;
      const b = dense.colours[i * 3 + 2]!;
      const floor = Math.min(r, g, b);
      if (floor > spot.minChannel && Math.max(r, g, b) - floor < RETOUCH_MAX_SATURATION)
        marks[i] = 1;
    }
  }
  inpaintColours(dense, growMask(dense, marks, RETOUCH_REACH));
}

function shiftZ(positions: Float32Array, dz: number): void {
  for (let i = 2; i < positions.length; i += 3) positions[i] = positions[i]! + dz;
}

function decimateByMaterial(prim: Primitive, level: number, recipe: NeriteRecipe): void {
  const triangles = triangleCountOf(prim);
  const isShell = prim.getMaterial()?.getName() === SHELL_MATERIAL;
  const target = isShell ? recipe.shellTriangles[level]! : triangles * recipe.bodyRatios[level]!;
  simplifyPrimitive(prim, {
    ratio: Math.min(1, target / triangles),
    minTriangles: isShell ? 600 : 150,
  });
}

const PART_RGB: Record<number, Vec3> = {
  0: [0.55, 0.55, 0.6],
  10: [0.25, 0.7, 0.35],
  11: [0.9, 0.7, 0.2],
  12: [0.9, 0.3, 0.3],
};

function partColours(ids: Float32Array, weights: Float32Array): Float32Array {
  const out = new Float32Array(ids.length * 3);
  for (let i = 0; i < ids.length; i++) {
    const base = PART_RGB[ids[i]!] ?? PART_RGB[0]!;
    const k = ids[i] === 0 ? 1 : 0.45 + 0.55 * weights[i]!;
    for (let c = 0; c < 3; c++) out[i * 3 + c] = base[c]! * k;
  }
  return out;
}

export async function buildNerite(recipe: NeriteRecipe, ctx: FishContext): Promise<OutputAsset> {
  const fromSpecies = speciesLengthM(ctx.repoRoot, recipe.species);
  const standardLengthM = fromSpecies ?? recipe.fallbackLengthM;
  const scan = await loadScan(ctx, recipe.sourceId, recipe.dropMeshes, recipe.textureSize);
  const placed = placeShell(scan.part, standardLengthM);
  const dense = weldDense(placed.part, scan.image, standardLengthM / 4000);
  cleanShell(dense, standardLengthM, recipe.retouch);
  dense.extra[FIN_ID_ATTRIBUTE] = new Float32Array(dense.positions.length / 3).fill(
    SNAIL_PART_IDS.shell,
  );
  dense.extra[FIN_MASK_ATTRIBUTE] = new Float32Array(dense.positions.length / 3);

  const baked = bakeScanPart(dense, SHELL_MATERIAL, {
    targetTriangles: recipe.bakeTriangles,
    atlasSize: recipe.textureSize,
    gutter: 4,
    bleed: 6,
    colourWeight: 0.5,
    closeHolesUpTo: CLOSE_HOLES_UP_TO,
  });
  const body = buildNeriteBody(placed.footprint, standardLengthM);
  shiftZ(baked.part.positions, -body.footCentreZ);
  shiftZ(body.part.positions, -body.footCentreZ);
  const ramp = bodyRamp();

  const materials: MaterialDef[] = [
    {
      name: SHELL_MATERIAL,
      baseColorFactor: [1, 1, 1, 1],
      baseColor: { role: 'baseColor', codec: 'etc1s', image: baked.image },
      roughness: 0.4,
      metallic: 0,
      alphaMode: 'OPAQUE',
      doubleSided: false,
      normalScale: 1,
    },
    {
      name: BODY_MATERIAL,
      baseColorFactor: [1, 1, 1, 1],
      baseColor: { role: 'baseColor', codec: 'etc1s', image: ramp },
      roughness: 0.45,
      metallic: 0,
      alphaMode: 'OPAQUE',
      doubleSided: false,
      normalScale: 1,
    },
  ];
  const plan: LodPlan = {
    ratios: [1, 1, 1],
    minTriangles: 100,
    prepare: (prim, level) => decimateByMaterial(prim, level, recipe),
  };
  const built = buildDocument(recipe.id, [baked.part, body.part], materials);
  const asset = await emitAsset({
    outRoot: ctx.outRoot,
    kind: 'snail',
    id: recipe.id,
    built,
    plan,
    meta: {
      species: recipe.species,
      origin: 'model',
      sources: [recipe.sourceId],
      licence: ctx.licenceOf(recipe.sourceId),
      modifications: [
        'shell from the photogrammetry scan: colour-checker cube removed, merged and welded, oriented to +Z forward / +Y up from the crusty aperture side and the dome peak, scaled so its longest edge is the standard length',
        'aperture lip relaxed with a roughness-masked Laplacian smooth so the decimated rim has no saw-teeth, holes that decimation opened are closed',
        ...recipe.retouch.map(
          (r) =>
            `retouched the scan texture: ${r.note}, painted over from the surrounding shell colours`,
        ),
        `re-simplified to ${recipe.bakeTriangles} triangles, box-projected into a fresh atlas and the colour re-baked from the scan's vertex colours, ${recipe.textureSize} px KTX2`,
        'foot, head and two tentacles generated procedurally: lens-section foot with edge colour variation from a small ramp texture, head and slender curved tentacles in front of the lip, deterministic',
        'origin moved to the centre of the foot on the ground',
        '_FIN_ID part ids 0 shell, 10 foot, 11 head, 12 tentacle; _FIN_MASK foot ripple weight and tentacle base-to-tip weight',
        `LOD1 and LOD2 shell simplified to ${recipe.shellTriangles[1]} and ${recipe.shellTriangles[2]} triangles`,
        recipe.note,
      ],
      snail: {
        standardLengthM,
        lengthSource: fromSpecies !== null ? 'species-json' : 'recipe',
        axes: { forward: '+z', up: '+y' },
        origin: 'foot-centre',
        attributes: { partId: FIN_ID_ATTRIBUTE, weight: FIN_MASK_ATTRIBUTE },
        partIds: { ...SNAIL_PART_IDS },
        debugRender: `debug/${recipe.id}.png`,
        debugPartsRender: `debug/${recipe.id}-parts.png`,
      },
    },
  });
  await writeShippedDebugRenders(
    ctx.repoRoot,
    ctx.outRoot,
    'snail',
    recipe.id,
    { [SHELL_MATERIAL]: baked.image, [BODY_MATERIAL]: ramp },
    partColours,
  );
  return asset;
}
