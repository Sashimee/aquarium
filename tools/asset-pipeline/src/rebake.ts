import { MeshoptSimplifier } from 'meshoptimizer';
import { vertexNormals } from './loft.ts';
import type { Vec3 } from './math.ts';
import type { Part } from './parts.ts';
import type { Rgba } from './textures.ts';
import { coveredTexelPositions } from './world-spots.ts';

/** A surface welded by position, carrying one colour per vertex and any per-vertex attributes in `extra`. */
export interface Dense {
  positions: Float32Array<ArrayBuffer>;
  indices: Uint32Array<ArrayBuffer>;
  /** sRGB 0..1, three floats per vertex. */
  colours: Float32Array<ArrayBuffer>;
  extra: Record<string, Float32Array<ArrayBuffer>>;
}

function sampleBilinear(image: Rgba, u: number, v: number, out: Float32Array, at: number): void {
  const x = (u - Math.floor(u)) * image.width - 0.5;
  const y = (v - Math.floor(v)) * image.height - 0.5;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const wrap = (n: number, size: number): number => ((n % size) + size) % size;
  for (let c = 0; c < 3; c++) {
    let value = 0;
    for (const [dx, dy, w] of [
      [0, 0, (1 - fx) * (1 - fy)],
      [1, 0, fx * (1 - fy)],
      [0, 1, (1 - fx) * fy],
      [1, 1, fx * fy],
    ] as const) {
      const px = wrap(x0 + dx, image.width);
      const py = wrap(y0 + dy, image.height);
      value += (image.data[(py * image.width + px) * 4 + c] ?? 0) * w;
    }
    out[at + c] = value / 255;
  }
}

/**
 * Merges every vertex at the same quantised position, so texture-seam duplicates stop being cracks, and
 * samples the colour map once per vertex (averaged over the duplicates).
 */
export function weldDense(part: Part, image: Rgba, quantum: number): Dense {
  const count = part.positions.length / 3;
  const first = new Map<string, number>();
  const remap = new Uint32Array(count);
  const kept: number[] = [];
  for (let i = 0; i < count; i++) {
    const key = `${Math.round(part.positions[i * 3]! / quantum)},${Math.round(part.positions[i * 3 + 1]! / quantum)},${Math.round(part.positions[i * 3 + 2]! / quantum)}`;
    const existing = first.get(key);
    if (existing === undefined) {
      first.set(key, kept.length);
      remap[i] = kept.length;
      kept.push(i);
    } else {
      remap[i] = existing;
    }
  }
  const colours = new Float32Array(kept.length * 3);
  const copies = new Float32Array(kept.length);
  const sample = new Float32Array(3);
  for (let i = 0; i < count; i++) {
    const v = remap[i]!;
    sampleBilinear(image, part.uvs[i * 2]!, part.uvs[i * 2 + 1]!, sample, 0);
    for (let c = 0; c < 3; c++) colours[v * 3 + c]! += sample[c]!;
    copies[v]!++;
  }
  for (let v = 0; v < kept.length; v++)
    for (let c = 0; c < 3; c++) colours[v * 3 + c]! /= copies[v]!;

  const positions = new Float32Array(kept.length * 3);
  kept.forEach((source, v) =>
    positions.set(part.positions.subarray(source * 3, source * 3 + 3), v * 3),
  );
  const extra: Dense['extra'] = {};
  for (const [key, values] of Object.entries(part.extra)) {
    extra[key] = new Float32Array(kept.length);
    kept.forEach((source, v) => (extra[key]![v] = values[source]!));
  }
  const indices: number[] = [];
  for (let t = 0; t < part.indices.length; t += 3) {
    const a = remap[part.indices[t]!]!;
    const b = remap[part.indices[t + 1]!]!;
    const c = remap[part.indices[t + 2]!]!;
    if (a !== b && b !== c && a !== c) indices.push(a, b, c);
  }
  return { positions, indices: Uint32Array.from(indices), colours, extra };
}

export function compactDense(dense: Dense, indices: Uint32Array): Dense {
  const remap = new Int32Array(dense.positions.length / 3).fill(-1);
  const order: number[] = [];
  const out = new Uint32Array(indices.length);
  indices.forEach((vertex, k) => {
    if (remap[vertex]! < 0) {
      remap[vertex] = order.length;
      order.push(vertex);
    }
    out[k] = remap[vertex]!;
  });
  const positions = new Float32Array(order.length * 3);
  const colours = new Float32Array(order.length * 3);
  order.forEach((source, v) => {
    positions.set(dense.positions.subarray(source * 3, source * 3 + 3), v * 3);
    colours.set(dense.colours.subarray(source * 3, source * 3 + 3), v * 3);
  });
  const extra: Dense['extra'] = {};
  for (const [key, values] of Object.entries(dense.extra)) {
    extra[key] = new Float32Array(order.length);
    order.forEach((source, v) => (extra[key]![v] = values[source]!));
  }
  return { positions, indices: out, colours, extra };
}

export interface DenseSimplifyOptions {
  targetTriangles: number;
  /** Weight of the vertex colour in the collapse cost; 0 simplifies by shape alone. */
  colourWeight?: number;
  /** Weight of every extra attribute, so part boundaries survive. */
  extraWeight?: number;
  lockBorder?: boolean;
}

/** Position-and-attribute simplification of a welded surface. Texture seams do not exist yet, so none can be crossed. */
export function simplifyDense(dense: Dense, options: DenseSimplifyOptions): Dense {
  const count = dense.positions.length / 3;
  const colourWeight = options.colourWeight ?? 0.5;
  const extraKeys = Object.keys(dense.extra).sort();
  const stride = 3 + extraKeys.length;
  const attributes = new Float32Array(count * stride);
  for (let v = 0; v < count; v++) {
    for (let c = 0; c < 3; c++) attributes[v * stride + c] = dense.colours[v * 3 + c]!;
    extraKeys.forEach((key, k) => (attributes[v * stride + 3 + k] = dense.extra[key]![v]!));
  }
  const weights = [
    colourWeight,
    colourWeight,
    colourWeight,
    ...extraKeys.map(() => options.extraWeight ?? 3),
  ];
  const [simplified] = MeshoptSimplifier.simplifyWithAttributes(
    dense.indices,
    dense.positions,
    3,
    attributes,
    stride,
    weights,
    null,
    options.targetTriangles * 3,
    1,
    options.lockBorder ? ['LockBorder'] : [],
  );
  if (simplified.length === 0)
    throw new Error('simplifyDense: simplification removed every triangle');
  return compactDense(dense, Uint32Array.from(simplified));
}

const AXES: Vec3[] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

function triangleNormal(positions: ArrayLike<number>, a: number, b: number, c: number): Vec3 {
  const e1: Vec3 = [
    positions[b * 3]! - positions[a * 3]!,
    positions[b * 3 + 1]! - positions[a * 3 + 1]!,
    positions[b * 3 + 2]! - positions[a * 3 + 2]!,
  ];
  const e2: Vec3 = [
    positions[c * 3]! - positions[a * 3]!,
    positions[c * 3 + 1]! - positions[a * 3 + 1]!,
    positions[c * 3 + 2]! - positions[a * 3 + 2]!,
  ];
  return [
    e1[1] * e2[2] - e1[2] * e2[1],
    e1[2] * e2[0] - e1[0] * e2[2],
    e1[0] * e2[1] - e1[1] * e2[0],
  ];
}

function triangleNeighbours(indices: Uint32Array, vertexCount: number): number[][] {
  const triangles = indices.length / 3;
  const owner = new Map<number, number[]>();
  const key = (a: number, b: number): number => (a < b ? a * vertexCount + b : b * vertexCount + a);
  for (let t = 0; t < triangles; t++)
    for (let k = 0; k < 3; k++) {
      const edge = key(indices[t * 3 + k]!, indices[t * 3 + ((k + 1) % 3)]!);
      (owner.get(edge) ?? owner.set(edge, []).get(edge)!).push(t);
    }
  const neighbours: number[][] = Array.from({ length: triangles }, () => []);
  for (const pair of owner.values())
    for (const a of pair) for (const b of pair) if (a !== b) neighbours[a]!.push(b);
  return neighbours;
}

export interface Unwrapped {
  part: Part;
  charts: number;
}

export interface UnwrapOptions {
  size: number;
  /** Empty texels around every chart that the bake bleeds into, so mips and filtering stay clean. */
  gutter: number;
  /** Share of the atlas the charts may fill. */
  fill?: number;
}

/**
 * Box-projection atlas: triangles pick the world axis they face most, a smoothing pass removes lone triangles,
 * connected runs become charts, each chart is projected flat and shelf-packed. Few big charts keep later
 * simplification of a shared texture from tearing across seams.
 */
export function unwrapBox(
  dense: Dense,
  material: string,
  extraNames: string[],
  options: UnwrapOptions,
): Unwrapped {
  const vertexCount = dense.positions.length / 3;
  const triangles = dense.indices.length / 3;
  const neighbours = triangleNeighbours(dense.indices, vertexCount);
  const axisOf = new Uint8Array(triangles);
  const areas = new Float32Array(triangles);
  for (let t = 0; t < triangles; t++) {
    const n = triangleNormal(
      dense.positions,
      dense.indices[t * 3]!,
      dense.indices[t * 3 + 1]!,
      dense.indices[t * 3 + 2]!,
    );
    areas[t] = Math.hypot(...n) / 2;
    let best = 0;
    let bestDot = -Infinity;
    AXES.forEach((axis, k) => {
      const d = n[0] * axis[0] + n[1] * axis[1] + n[2] * axis[2];
      if (d > bestDot) {
        bestDot = d;
        best = k;
      }
    });
    axisOf[t] = best;
  }
  for (let pass = 0; pass < 3; pass++) {
    const next = Uint8Array.from(axisOf);
    for (let t = 0; t < triangles; t++) {
      const votes = new Map<number, number>();
      for (const n of neighbours[t]!) votes.set(axisOf[n]!, (votes.get(axisOf[n]!) ?? 0) + 1);
      let top = axisOf[t]!;
      let topVotes = votes.get(top) ?? 0;
      for (const [axis, count] of [...votes].sort((a, b) => a[0] - b[0]))
        if (count > topVotes + 1) {
          top = axis;
          topVotes = count;
        }
      next[t] = top;
    }
    axisOf.set(next);
  }

  const chartOf = new Int32Array(triangles).fill(-1);
  let charts = 0;
  for (let seed = 0; seed < triangles; seed++) {
    if (chartOf[seed]! >= 0) continue;
    const stack = [seed];
    chartOf[seed] = charts;
    while (stack.length > 0) {
      const t = stack.pop()!;
      for (const n of neighbours[t]!)
        if (chartOf[n]! < 0 && axisOf[n] === axisOf[seed]) {
          chartOf[n] = charts;
          stack.push(n);
        }
    }
    charts++;
  }

  const project = (axis: number, p: Vec3): [number, number] => {
    if (axis < 2) return [p[2], p[1]];
    if (axis < 4) return [p[0], p[2]];
    return [p[0], p[1]];
  };
  const duplicate = new Map<string, number>();
  const source: number[] = [];
  const planar: [number, number][] = [];
  const chartVertices: number[][] = Array.from({ length: charts }, () => []);
  const indices = new Uint32Array(dense.indices.length);
  for (let t = 0; t < triangles; t++)
    for (let k = 0; k < 3; k++) {
      const vertex = dense.indices[t * 3 + k]!;
      const key = `${vertex}:${chartOf[t]}`;
      let id = duplicate.get(key);
      if (id === undefined) {
        id = source.length;
        duplicate.set(key, id);
        source.push(vertex);
        planar.push(
          project(axisOf[t]!, [
            dense.positions[vertex * 3]!,
            dense.positions[vertex * 3 + 1]!,
            dense.positions[vertex * 3 + 2]!,
          ]),
        );
        chartVertices[chartOf[t]!]!.push(id);
      }
      indices[t * 3 + k] = id;
    }

  const boxes = chartVertices.map((ids) => {
    let u0 = Infinity;
    let v0 = Infinity;
    let u1 = -Infinity;
    let v1 = -Infinity;
    for (const id of ids) {
      const [u, v] = planar[id]!;
      u0 = Math.min(u0, u);
      u1 = Math.max(u1, u);
      v0 = Math.min(v0, v);
      v1 = Math.max(v1, v);
    }
    return { u0, v0, width: u1 - u0, height: v1 - v0 };
  });
  const order = boxes.map((_, i) => i).sort((a, b) => boxes[b]!.height - boxes[a]!.height || a - b);
  const totalBox = boxes.reduce((sum, b) => sum + b.width * b.height, 0);
  const { size, gutter } = options;
  let scale = Math.sqrt(((options.fill ?? 0.7) * size * size) / totalBox);
  let slots: { x: number; y: number }[] = [];
  for (let attempt = 0; attempt < 80; attempt++) {
    slots = new Array(charts);
    let x = 0;
    let y = 0;
    let rowHeight = 0;
    let fits = true;
    for (const c of order) {
      const w = Math.ceil(boxes[c]!.width * scale) + 2 * gutter + 1;
      const h = Math.ceil(boxes[c]!.height * scale) + 2 * gutter + 1;
      if (w > size) {
        fits = false;
        break;
      }
      if (x + w > size) {
        x = 0;
        y += rowHeight;
        rowHeight = 0;
      }
      if (y + h > size) {
        fits = false;
        break;
      }
      slots[c] = { x: x + gutter, y: y + gutter };
      x += w;
      rowHeight = Math.max(rowHeight, h);
    }
    if (fits) break;
    scale *= 0.96;
    if (attempt === 79) throw new Error('unwrapBox: charts do not fit the atlas');
  }

  const vertexTotal = source.length;
  const positions = new Float32Array(vertexTotal * 3);
  const uvs = new Float32Array(vertexTotal * 2);
  const extra: Part['extra'] = {};
  for (const name of extraNames) extra[name] = new Float32Array(vertexTotal);
  chartVertices.forEach((ids, c) => {
    const box = boxes[c]!;
    const slot = slots[c]!;
    for (const id of ids) {
      uvs[id * 2] = (slot.x + (planar[id]![0] - box.u0) * scale) / size;
      uvs[id * 2 + 1] = (slot.y + (planar[id]![1] - box.v0) * scale) / size;
    }
  });
  source.forEach((vertex, id) => {
    positions.set(dense.positions.subarray(vertex * 3, vertex * 3 + 3), id * 3);
    for (const name of extraNames) extra[name]![id] = dense.extra[name]![vertex]!;
  });
  const normals = new Float32Array(vertexTotal * 3);
  const smooth = vertexNormals(dense.positions, dense.indices);
  source.forEach((vertex, id) => normals.set(smooth.subarray(vertex * 3, vertex * 3 + 3), id * 3));
  return { part: { positions, normals, uvs, indices, material, extra }, charts };
}

class Lookup {
  private readonly cells = new Map<number, number[]>();
  private readonly cell: number;
  private readonly origin: Vec3;
  private readonly positions: Float32Array;

  constructor(positions: Float32Array, cell: number) {
    this.positions = positions;
    this.cell = cell;
    this.origin = [Infinity, Infinity, Infinity];
    for (let i = 0; i < positions.length; i += 3)
      for (let a = 0; a < 3; a++) this.origin[a] = Math.min(this.origin[a]!, positions[i + a]!);
    for (let v = 0; v < positions.length / 3; v++) {
      const key = this.key(
        ...this.cellOf(positions[v * 3]!, positions[v * 3 + 1]!, positions[v * 3 + 2]!),
      );
      (this.cells.get(key) ?? this.cells.set(key, []).get(key)!).push(v);
    }
  }

  private cellOf(x: number, y: number, z: number): [number, number, number] {
    return [
      Math.floor((x - this.origin[0]) / this.cell),
      Math.floor((y - this.origin[1]) / this.cell),
      Math.floor((z - this.origin[2]) / this.cell),
    ];
  }

  private key(x: number, y: number, z: number): number {
    return (x + 512) * 1048576 + (y + 512) * 1024 + (z + 512);
  }

  /** The `count` nearest vertices, nearest first. */
  nearest(x: number, y: number, z: number, count: number): { vertex: number; distance: number }[] {
    const [cx, cy, cz] = this.cellOf(x, y, z);
    for (let reach = 1; reach <= 6; reach++) {
      const found: { vertex: number; distance: number }[] = [];
      for (let dz = -reach; dz <= reach; dz++)
        for (let dy = -reach; dy <= reach; dy++)
          for (let dx = -reach; dx <= reach; dx++)
            for (const v of this.cells.get(this.key(cx + dx, cy + dy, cz + dz)) ?? [])
              found.push({
                vertex: v,
                distance: Math.hypot(
                  this.positions[v * 3]! - x,
                  this.positions[v * 3 + 1]! - y,
                  this.positions[v * 3 + 2]! - z,
                ),
              });
      if (found.length >= count || reach === 6) {
        found.sort((a, b) => a.distance - b.distance || a.vertex - b.vertex);
        return found.slice(0, count);
      }
    }
    return [];
  }
}

export function meanSpacing(dense: Dense): number {
  let total = 0;
  let edges = 0;
  for (let t = 0; t < dense.indices.length; t += 3)
    for (let k = 0; k < 3; k++) {
      const a = dense.indices[t + k]!;
      const b = dense.indices[t + ((k + 1) % 3)]!;
      total += Math.hypot(
        dense.positions[a * 3]! - dense.positions[b * 3]!,
        dense.positions[a * 3 + 1]! - dense.positions[b * 3 + 1]!,
        dense.positions[a * 3 + 2]! - dense.positions[b * 3 + 2]!,
      );
      edges++;
    }
  return edges === 0 ? 1 : total / edges;
}

/**
 * Paints the atlas of `target` from the colours of the nearest `source` vertices, then bleeds the chart edges
 * outwards by `bleed` texels.
 */
export function bakeColour(
  target: Part,
  source: Dense,
  size: number,
  bleed: number,
  neighbours = 3,
): Rgba {
  const lookup = new Lookup(source.positions, meanSpacing(source) * 2);
  const spots = coveredTexelPositions([target], size, size);
  const data = new Uint8Array(size * size * 4);
  const covered = new Uint8Array(size * size);
  let mean = [0, 0, 0];
  let painted = 0;
  for (let texel = 0; texel < size * size; texel++) {
    const x = spots[texel * 3]!;
    if (Number.isNaN(x)) continue;
    const near = lookup.nearest(x, spots[texel * 3 + 1]!, spots[texel * 3 + 2]!, neighbours);
    const nearest = near[0]?.distance ?? 0;
    let weightSum = 0;
    const rgb = [0, 0, 0];
    for (const { vertex, distance } of near) {
      const w = 1 / (distance + nearest * 0.5 + 1e-12);
      weightSum += w;
      for (let c = 0; c < 3; c++) rgb[c]! += source.colours[vertex * 3 + c]! * w;
    }
    for (let c = 0; c < 3; c++) {
      const value = rgb[c]! / weightSum;
      data[texel * 4 + c] = Math.round(Math.min(1, Math.max(0, value)) * 255);
      mean[c]! += value;
    }
    data[texel * 4 + 3] = 255;
    covered[texel] = 1;
    painted++;
  }
  mean = mean.map((v) => v / Math.max(1, painted));
  for (let pass = 0; pass < bleed; pass++) {
    const snapshot = Uint8Array.from(covered);
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const texel = y * size + x;
        if (snapshot[texel]) continue;
        const sum = [0, 0, 0];
        let n = 0;
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= size || ny >= size || !snapshot[ny * size + nx]) continue;
          for (let c = 0; c < 3; c++) sum[c]! += data[(ny * size + nx) * 4 + c]!;
          n++;
        }
        if (n === 0) continue;
        for (let c = 0; c < 3; c++) data[texel * 4 + c] = Math.round(sum[c]! / n);
        data[texel * 4 + 3] = 255;
        covered[texel] = 1;
      }
  }
  for (let texel = 0; texel < size * size; texel++)
    if (!covered[texel]) {
      for (let c = 0; c < 3; c++) data[texel * 4 + c] = Math.round(mean[c]! * 255);
      data[texel * 4 + 3] = 255;
    }
  return { width: size, height: size, data };
}

/** Share of triangles whose texture-to-surface scale is more than `factor` times the median or less than 1/factor of it. */
export function uvStretchShare(
  part: Pick<Part, 'positions' | 'uvs' | 'indices'>,
  factor = 5,
): number {
  const ratios: number[] = [];
  for (let t = 0; t < part.indices.length; t += 3) {
    const [a, b, c] = [part.indices[t]!, part.indices[t + 1]!, part.indices[t + 2]!];
    const n = triangleNormal(part.positions, a, b, c);
    const area3 = Math.hypot(...n) / 2;
    const areaUv =
      Math.abs(
        (part.uvs[b * 2]! - part.uvs[a * 2]!) * (part.uvs[c * 2 + 1]! - part.uvs[a * 2 + 1]!) -
          (part.uvs[c * 2]! - part.uvs[a * 2]!) * (part.uvs[b * 2 + 1]! - part.uvs[a * 2 + 1]!),
      ) / 2;
    if (area3 > 0) ratios.push(Math.sqrt(areaUv / area3));
  }
  if (ratios.length === 0) return 0;
  const sorted = [...ratios].sort((x, y) => x - y);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  return ratios.filter((r) => r > median * factor || r < median / factor).length / ratios.length;
}
