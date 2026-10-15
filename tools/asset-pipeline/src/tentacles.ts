import type { Part } from './parts.ts';

export interface BristleSpec {
  /** Tentacles per side along the snout margin, tip to cheek. */
  rim: number;
  /** Shorter tentacles per side on top of the snout; males carry these, females and juveniles do not. */
  crown: number;
  /** Longest tentacle as a fraction of the body length. */
  length: number;
}

export interface BristleDetail {
  segments: number;
  sides: number;
  forks: boolean;
  /** Only the first this-many rim tentacles per side (the ones at the front of the snout) are grown. */
  rimMax: number;
  crown: boolean;
}

export const BRISTLE_DETAIL: readonly [BristleDetail, BristleDetail, BristleDetail] = [
  { segments: 5, sides: 6, forks: true, rimMax: Infinity, crown: true },
  { segments: 3, sides: 4, forks: false, rimMax: Infinity, crown: true },
  { segments: 2, sides: 3, forks: false, rimMax: 2, crown: false },
];

type V3 = [number, number, number];

const add = (a: V3, b: V3, k = 1): V3 => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const crossOf = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

function unit(a: V3): V3 {
  const length = Math.hypot(a[0], a[1], a[2]);
  return length === 0 ? [0, 1, 0] : [a[0] / length, a[1] / length, a[2] / length];
}

function orthogonal(a: V3, against: V3): V3 {
  return unit(add(a, against, -dot(a, against)));
}

/** Side of the square of texture each tentacle samples, so the normal map has a tangent frame to work in. */
const PATCH = 0.01;
const FORK_AT = 0.62;

interface Tentacle {
  base: V3;
  direction: V3;
  length: number;
  radius: number;
  /** Direction the tentacle curls towards as it grows. */
  curl: V3;
  /** How many times the tentacle splits in two towards its tip. */
  forks: number;
}

class TubeBuilder {
  private readonly detail: BristleDetail;

  constructor(detail: BristleDetail) {
    this.detail = detail;
  }

  readonly positions: number[] = [];
  readonly normals: number[] = [];
  readonly uvs: number[] = [];
  readonly indices: number[] = [];

  /** A tapered tube along a bent path with a rounded tip, open at the base so it sinks into the skin. */
  tube(t: Tentacle, uv: [number, number]): void {
    const { segments: SEGMENTS, sides: SIDES } = this.detail;
    const path: V3[] = [];
    for (let i = 0; i <= SEGMENTS; i++) {
      const s = i / SEGMENTS;
      path.push(add(add(t.base, t.direction, t.length * s), t.curl, t.length * 0.4 * s * s));
    }
    const radiusAt = (s: number): number => t.radius * (1 - 0.72 * s);
    const first = this.positions.length / 3;
    let reference: V3 = Math.abs(t.direction[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
    for (let i = 0; i <= SEGMENTS; i++) {
      const ahead = path[Math.min(i + 1, SEGMENTS)]!;
      const behind = path[Math.max(i - 1, 0)]!;
      const tangent = unit(add(ahead, behind, -1));
      const u = orthogonal(crossOf(tangent, reference), tangent);
      reference = u;
      const v = crossOf(tangent, u);
      const radius = radiusAt(i / SEGMENTS);
      for (let k = 0; k <= SIDES; k++) {
        const angle = (k / SIDES) * Math.PI * 2;
        const radial = add(
          [u[0] * Math.cos(angle), u[1] * Math.cos(angle), u[2] * Math.cos(angle)],
          v,
          Math.sin(angle),
        );
        this.positions.push(...add(path[i]!, radial, radius));
        this.normals.push(...unit(add(radial, tangent, 0.25)));
        this.uvs.push(uv[0] + PATCH * (k / SIDES), uv[1] + PATCH * (i / SEGMENTS));
      }
    }
    const tip = path[SEGMENTS]!;
    const tipDirection = unit(add(tip, path[SEGMENTS - 1]!, -1));
    const apex = this.positions.length / 3;
    this.positions.push(...add(tip, tipDirection, radiusAt(1) * 0.7));
    this.normals.push(...tipDirection);
    this.uvs.push(uv[0] + PATCH / 2, uv[1] + PATCH * 1.2);
    const ring = SIDES + 1;
    for (let i = 0; i < SEGMENTS; i++)
      for (let k = 0; k < SIDES; k++) {
        const a = first + i * ring + k;
        this.indices.push(a, a + ring, a + 1, a + 1, a + ring, a + ring + 1);
      }
    for (let k = 0; k < SIDES; k++) {
      const a = first + SEGMENTS * ring + k;
      this.indices.push(a, apex, a + 1);
    }

    if (t.forks === 0 || !this.detail.forks) return;
    const at = SEGMENTS * FORK_AT;
    const lower = path[Math.floor(at)]!;
    const upper = path[Math.ceil(at)]!;
    const origin = add(lower, add(upper, lower, -1), at - Math.floor(at));
    const along = unit(add(upper, lower, -1));
    const hinge = unit(crossOf(along, t.curl));
    for (const sign of [-1, 1]) {
      const branch = unit(add(along, hinge, sign * 0.55));
      this.tube(
        {
          base: add(origin, branch, -t.radius * 0.2),
          direction: branch,
          length: t.length * 0.45,
          radius: radiusAt(FORK_AT) * 0.85,
          curl: t.curl,
          forks: t.forks - 1,
        },
        uv,
      );
    }
  }
}

interface Frame {
  midline: number;
  length: number;
  zTip: number;
}

function frameOf(positions: Float32Array): Frame {
  const xs: number[] = [];
  let zMin = Infinity;
  let zMax = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    xs.push(positions[i]!);
    zMin = Math.min(zMin, positions[i + 2]!);
    zMax = Math.max(zMax, positions[i + 2]!);
  }
  xs.sort((a, b) => a - b);
  return { midline: xs[Math.floor(xs.length / 2)]!, length: zMax - zMin, zTip: zMax };
}

/** Plan-view outline of the snout on one side, from the tip back to where the head is widest: [out from midline, y, z]. */
function snoutMargin(positions: Float32Array, frame: Frame, side: number): V3[] {
  const { midline, length, zTip } = frame;
  const count = positions.length / 3;
  let yLow = Infinity;
  let yHigh = -Infinity;
  for (let i = 0; i < count; i++) {
    if (positions[i * 3 + 2]! < zTip - 0.3 * length) continue;
    yLow = Math.min(yLow, positions[i * 3 + 1]!);
    yHigh = Math.max(yHigh, positions[i * 3 + 1]!);
  }
  const rimFloor = yLow + 0.35 * (yHigh - yLow);
  const slice = 0.008 * length;
  const outline: V3[] = [];
  let widest = 0;
  for (let z = zTip; z > zTip - 0.3 * length; z -= slice) {
    let reach = -Infinity;
    let height = 0;
    for (let i = 0; i < count; i++) {
      if (Math.abs(positions[i * 3 + 2]! - z) > slice / 2 || positions[i * 3 + 1]! < rimFloor)
        continue;
      const out = side * (positions[i * 3]! - midline);
      if (out > reach) {
        reach = out;
        height = positions[i * 3 + 1]!;
      }
    }
    if (reach === -Infinity) continue;
    widest = Math.max(widest, reach);
    outline.push([reach, height, z]);
  }
  if (outline.length === 0)
    throw new Error('growBristles: no snout vertices found; check the despike and axes');
  const cut = outline.findIndex((p) => p[0] >= 0.95 * widest);
  return [[0, outline[0]![1], zTip], ...outline.slice(0, cut + 1)];
}

/**
 * Soft tentacles for the snout of a bristlenose pleco: a row along each side of the snout margin and, for males,
 * a few more on top of the snout. Nothing grows around the cheeks or gills, where real fish carry no bristles.
 * Built on the skin of `body` (+Z forward, +Y up, already despiked) and meant to be kept out of fin classification.
 */
export function growBristles(
  body: Part,
  spec: BristleSpec,
  skinUv: [number, number],
  detail: BristleDetail = BRISTLE_DETAIL[0],
): Part {
  const { positions } = body;
  const count = positions.length / 3;
  const frame = frameOf(positions);
  const { midline, length, zTip } = frame;
  const builder = new TubeBuilder(detail);

  for (const side of [-1, 1]) {
    const margin = snoutMargin(positions, frame, side);
    const arcs = [0];
    for (let i = 1; i < margin.length; i++)
      arcs.push(
        arcs[i - 1]! +
          Math.hypot(margin[i]![0] - margin[i - 1]![0], margin[i]![2] - margin[i - 1]![2]),
      );
    const total = arcs[arcs.length - 1]!;
    const pointAt = (arc: number): { p: V3; tangent: [number, number] } => {
      let k = 1;
      while (k < margin.length - 1 && arcs[k]! < arc) k++;
      const f = Math.min(1, Math.max(0, (arc - arcs[k - 1]!) / (arcs[k]! - arcs[k - 1]! || 1)));
      const a = margin[k - 1]!;
      const b = margin[k]!;
      return {
        p: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f],
        tangent: [b[0] - a[0], b[2] - a[2]],
      };
    };

    for (let i = 0; i < Math.min(spec.rim, detail.rimMax); i++) {
      const fraction = spec.rim === 1 ? 0.15 : 0.05 + (0.8 * i) / (spec.rim - 1);
      const { p, tangent } = pointAt(total * fraction);
      const along = Math.hypot(tangent[0], tangent[1]) || 1;
      const outward: [number, number] = [-tangent[1] / along, tangent[0] / along];
      const direction = unit([outward[0] * side * 0.8, 0.12, outward[1] * 0.8 + 0.55]);
      const reachLength = spec.length * length * (1 - 0.55 * fraction);
      const base: V3 = [midline + side * p[0], p[1], p[2]];
      builder.tube(
        {
          base: add(base, direction, -reachLength * 0.12),
          direction,
          length: reachLength,
          radius: reachLength * 0.1,
          curl: orthogonal([0, -1, 0.15], direction),
          forks: i === 0 ? 2 : i % 2 === 0 && i < spec.rim - 1 ? 1 : 0,
        },
        skinUv,
      );
    }

    for (let i = 0; i < (detail.crown ? spec.crown : 0); i++) {
      const z = zTip - (0.07 + 0.05 * i) * length;
      const half = margin.reduce((best, p) =>
        Math.abs(p[2] - z) < Math.abs(best[2] - z) ? p : best,
      )[0];
      const x = midline + side * 0.4 * half;
      let top = -Infinity;
      let surface: V3 = [x, 0, z];
      for (let v = 0; v < count; v++) {
        if (Math.hypot(positions[v * 3]! - x, positions[v * 3 + 2]! - z) > 0.025 * length) continue;
        if (positions[v * 3 + 1]! > top) {
          top = positions[v * 3 + 1]!;
          surface = [positions[v * 3]!, top, positions[v * 3 + 2]!];
        }
      }
      if (top === -Infinity) continue;
      const direction = unit([side * 0.3, 0.7, 0.8]);
      const reachLength = spec.length * length * 0.5;
      builder.tube(
        {
          base: add(surface, direction, -reachLength * 0.12),
          direction,
          length: reachLength,
          radius: reachLength * 0.11,
          curl: orthogonal([0, -1, 0.3], direction),
          forks: 0,
        },
        skinUv,
      );
    }
  }

  return {
    positions: Float32Array.from(builder.positions),
    normals: Float32Array.from(builder.normals),
    uvs: Float32Array.from(builder.uvs),
    indices: Uint32Array.from(builder.indices),
    material: body.material,
    extra: {},
  };
}

/**
 * Picks the texture coordinate of plain, mid-light head skin, so tentacles take the colour and gloss of the snout
 * rather than of the dark back or a painted spot. `luma` reads the final base colour at a uv.
 */
export function pickSkinUv(
  body: Part,
  headFraction: number,
  luma: (u: number, v: number) => number,
): [number, number] {
  const { positions, uvs } = body;
  const { length, zTip } = frameOf(positions);
  const candidates: { u: number; v: number; value: number }[] = [];
  for (let i = 0; i < positions.length / 3; i++) {
    if (positions[i * 3 + 2]! < zTip - headFraction * length) continue;
    const [u, v] = [uvs[i * 2]!, uvs[i * 2 + 1]!];
    candidates.push({ u, v, value: luma(u, v) });
  }
  if (candidates.length === 0) throw new Error('pickSkinUv: no head vertices found');
  const ranked = [...candidates].sort((a, b) => a.value - b.value || a.u - b.u || a.v - b.v);
  const chosen = ranked[Math.floor(ranked.length * 0.85)]!;
  return [chosen.u, chosen.v];
}
