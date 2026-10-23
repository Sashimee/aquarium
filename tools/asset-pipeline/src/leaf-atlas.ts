import type { Part } from './parts.ts';
import type { Rgba } from './textures.ts';

export interface LeafAtlasLayout {
  columns: number;
  rows: number;
  cellWidth: number;
  cellHeight: number;
}

export function atlasLayout(
  leaves: number,
  cellWidth: number,
  cellHeight: number,
): LeafAtlasLayout {
  const columns = 2 ** Math.ceil(Math.log2(Math.sqrt(leaves)));
  const rows = 2 ** Math.ceil(Math.log2(Math.ceil(leaves / columns)));
  return { columns, rows, cellWidth, cellHeight };
}

/** Maps a leaf card onto unit UVs: u across its width, v from the lowest point (the base) up its length. */
export function leafLocalUvs(positions: Float32Array): Float32Array {
  const count = positions.length / 3;
  const mean = [0, 0, 0];
  for (let i = 0; i < count; i++)
    for (let a = 0; a < 3; a++) mean[a]! += positions[i * 3 + a]! / count;
  const cov = [0, 0, 0, 0, 0, 0];
  for (let i = 0; i < count; i++) {
    const d = [0, 1, 2].map((a) => positions[i * 3 + a]! - mean[a]!);
    cov[0]! += d[0]! * d[0]!;
    cov[1]! += d[0]! * d[1]!;
    cov[2]! += d[0]! * d[2]!;
    cov[3]! += d[1]! * d[1]!;
    cov[4]! += d[1]! * d[2]!;
    cov[5]! += d[2]! * d[2]!;
  }
  const mul = (v: number[]): number[] => [
    cov[0]! * v[0]! + cov[1]! * v[1]! + cov[2]! * v[2]!,
    cov[1]! * v[0]! + cov[3]! * v[1]! + cov[4]! * v[2]!,
    cov[2]! * v[0]! + cov[4]! * v[1]! + cov[5]! * v[2]!,
  ];
  const unit = (v: number[]): number[] => {
    const n = Math.hypot(v[0]!, v[1]!, v[2]!) || 1;
    return v.map((x) => x / n);
  };
  let major = [0.3, 1, 0.2];
  for (let i = 0; i < 40; i++) major = unit(mul(major));
  let minor = [1, 0.1, 0.7];
  for (let i = 0; i < 40; i++) {
    const dot = minor[0]! * major[0]! + minor[1]! * major[1]! + minor[2]! * major[2]!;
    minor = unit(mul(minor.map((x, a) => x - dot * major[a]!)));
  }
  const along: number[] = [];
  const across: number[] = [];
  for (let i = 0; i < count; i++) {
    const d = [0, 1, 2].map((a) => positions[i * 3 + a]! - mean[a]!);
    along.push(d[0]! * major[0]! + d[1]! * major[1]! + d[2]! * major[2]!);
    across.push(d[0]! * minor[0]! + d[1]! * minor[1]! + d[2]! * minor[2]!);
  }
  let lowestAlong = 0;
  let lowestY = Infinity;
  for (let i = 0; i < count; i++) {
    const y = positions[i * 3 + 1]!;
    if (y < lowestY) {
      lowestY = y;
      lowestAlong = along[i]!;
    }
  }
  const flip = lowestAlong > 0 ? -1 : 1;
  const alongMin = Math.min(...along.map((v) => v * flip));
  const alongMax = Math.max(...along.map((v) => v * flip));
  const acrossMax = Math.max(...across.map(Math.abs)) || 1;
  const uvs = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    uvs[i * 2] = 0.5 + (0.5 * across[i]!) / acrossMax;
    uvs[i * 2 + 1] = (along[i]! * flip - alongMin) / (alongMax - alongMin || 1);
  }
  return uvs;
}

/** Gives every leaf its own cell of one atlas, cell `i` holding the leaf texture times `shades[i]`. */
export function packLeafAtlas(
  parts: Part[],
  leaf: Rgba,
  shades: readonly (readonly [number, number, number])[],
  layout: LeafAtlasLayout,
): { part: Part; atlas: Rgba } {
  if (parts.length !== shades.length)
    throw new Error(`${parts.length} leaves but ${shades.length} shades`);
  if (parts.length > layout.columns * layout.rows)
    throw new Error(`${parts.length} leaves do not fit a ${layout.columns}x${layout.rows} atlas`);
  if (leaf.width !== layout.cellWidth || leaf.height !== layout.cellHeight)
    throw new Error(
      `leaf image is ${leaf.width}x${leaf.height} but the cell is ${layout.cellWidth}x${layout.cellHeight}`,
    );
  const width = layout.columns * layout.cellWidth;
  const height = layout.rows * layout.cellHeight;
  const atlas = new Uint8Array(width * height * 4).fill(255);
  const vertices = parts.reduce((s, p) => s + p.positions.length / 3, 0);
  const positions = new Float32Array(vertices * 3);
  const normals = new Float32Array(vertices * 3);
  const uvs = new Float32Array(vertices * 2);
  const indices: number[] = [];
  let base = 0;
  parts.forEach((part, leafIndex) => {
    const col = leafIndex % layout.columns;
    const row = Math.floor(leafIndex / layout.columns);
    const shade = shades[leafIndex]!;
    for (let y = 0; y < layout.cellHeight; y++)
      for (let x = 0; x < layout.cellWidth; x++) {
        const from = (y * leaf.width + x) * 4;
        const to = ((row * layout.cellHeight + y) * width + col * layout.cellWidth + x) * 4;
        for (let c = 0; c < 3; c++)
          atlas[to + c] = Math.min(255, Math.round((leaf.data[from + c] ?? 0) * shade[c]!));
      }
    const local = leafLocalUvs(part.positions);
    const inset = 0.5 / layout.cellWidth;
    const insetV = 0.5 / layout.cellHeight;
    const count = part.positions.length / 3;
    positions.set(part.positions, base * 3);
    normals.set(part.normals, base * 3);
    for (let i = 0; i < count; i++) {
      const u = inset + local[i * 2]! * (1 - 2 * inset);
      const v = insetV + local[i * 2 + 1]! * (1 - 2 * insetV);
      uvs[(base + i) * 2] = (col + u) / layout.columns;
      uvs[(base + i) * 2 + 1] = (row + 1 - v) / layout.rows;
    }
    for (const index of part.indices) indices.push(base + index);
    base += count;
  });
  return {
    part: {
      positions,
      normals,
      uvs,
      indices: Uint32Array.from(indices),
      material: parts[0]!.material,
      extra: {},
    },
    atlas: { width, height, data: atlas },
  };
}
