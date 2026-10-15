import type { Rgb } from './finish.ts';
import type { Part } from './parts.ts';
import type { Rgba } from './textures.ts';

export interface WorldSpotSpec {
  /** Average spot spacing as a fraction of the model's longest extent. */
  cell: number;
  /** Spot radius as a fraction of the cell. */
  radius: number;
  density: number;
  colour: Rgb;
  seed: number;
}

function hash3(x: number, y: number, z: number, seed: number): number {
  let h =
    Math.imul(x, 374761393) +
    Math.imul(y, 668265263) +
    Math.imul(z, 1274126177) +
    Math.imul(seed, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function longestExtent(parts: Part[]): number {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const part of parts)
    for (let i = 0; i < part.positions.length; i += 3)
      for (let a = 0; a < 3; a++) {
        const v = part.positions[i + a] ?? 0;
        min[a] = Math.min(min[a] ?? v, v);
        max[a] = Math.max(max[a] ?? v, v);
      }
  return Math.max(...[0, 1, 2].map((a) => (max[a] ?? 0) - (min[a] ?? 0)));
}

export function coveredTexelPositions(parts: Part[], width: number, height: number): Float32Array {
  const out = new Float32Array(width * height * 3).fill(Number.NaN);
  for (const part of parts) {
    for (let t = 0; t < part.indices.length; t += 3) {
      const ids = [part.indices[t] ?? 0, part.indices[t + 1] ?? 0, part.indices[t + 2] ?? 0];
      const u = ids.map((i) => (part.uvs[i * 2] ?? 0) * width);
      const v = ids.map((i) => (part.uvs[i * 2 + 1] ?? 0) * height);
      const minX = Math.max(0, Math.floor(Math.min(...u)));
      const maxX = Math.min(width - 1, Math.ceil(Math.max(...u)));
      const minY = Math.max(0, Math.floor(Math.min(...v)));
      const maxY = Math.min(height - 1, Math.ceil(Math.max(...v)));
      const denom =
        ((v[1] ?? 0) - (v[2] ?? 0)) * ((u[0] ?? 0) - (u[2] ?? 0)) +
        ((u[2] ?? 0) - (u[1] ?? 0)) * ((v[0] ?? 0) - (v[2] ?? 0));
      if (Math.abs(denom) < 1e-9) continue;
      for (let y = minY; y <= maxY; y++)
        for (let x = minX; x <= maxX; x++) {
          const px = x + 0.5;
          const py = y + 0.5;
          const w0 =
            (((v[1] ?? 0) - (v[2] ?? 0)) * (px - (u[2] ?? 0)) +
              ((u[2] ?? 0) - (u[1] ?? 0)) * (py - (v[2] ?? 0))) /
            denom;
          const w1 =
            (((v[2] ?? 0) - (v[0] ?? 0)) * (px - (u[2] ?? 0)) +
              ((u[0] ?? 0) - (u[2] ?? 0)) * (py - (v[2] ?? 0))) /
            denom;
          const w2 = 1 - w0 - w1;
          if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
          const slot = (y * width + x) * 3;
          for (let a = 0; a < 3; a++)
            out[slot + a] =
              w0 * (part.positions[(ids[0] ?? 0) * 3 + a] ?? 0) +
              w1 * (part.positions[(ids[1] ?? 0) * 3 + a] ?? 0) +
              w2 * (part.positions[(ids[2] ?? 0) * 3 + a] ?? 0);
        }
    }
  }
  return out;
}

/** World position of every texel the UV layout covers; gutter texels borrow the nearest covered neighbour so mips do not bleed unspotted colour. */
function texelPositions(parts: Part[], width: number, height: number): Float32Array {
  const out = coveredTexelPositions(parts, width, height);
  for (let pass = 0; pass < 4; pass++) {
    const snapshot = out.slice();
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const slot = (y * width + x) * 3;
        if (!Number.isNaN(snapshot[slot])) continue;
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const from = (ny * width + nx) * 3;
          if (Number.isNaN(snapshot[from])) continue;
          for (let a = 0; a < 3; a++) out[slot + a] = snapshot[from + a] ?? 0;
          break;
        }
      }
  }
  return out;
}

/** Paints evenly sized pale spots in world space, so UV stretch cannot enlarge them. */
export function worldSpotImage(image: Rgba, parts: Part[], spec: WorldSpotSpec): Rgba {
  const { width, height, data } = image;
  const positions = texelPositions(parts, width, height);
  const cell = longestExtent(parts) * spec.cell;
  const out = new Uint8Array(data);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const slot = (y * width + x) * 3;
      const px = positions[slot] ?? Number.NaN;
      if (Number.isNaN(px)) continue;
      const py = positions[slot + 1] ?? 0;
      const pz = positions[slot + 2] ?? 0;
      const cx = Math.floor(px / cell);
      const cy = Math.floor(py / cell);
      const cz = Math.floor(pz / cell);
      let cover = 0;
      for (let dz = -1; dz <= 1; dz++)
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const gx = cx + dx;
            const gy = cy + dy;
            const gz = cz + dz;
            if (hash3(gx, gy, gz, spec.seed) > spec.density) continue;
            const sx = (gx + 0.15 + 0.7 * hash3(gx, gy, gz, spec.seed + 1)) * cell;
            const sy = (gy + 0.15 + 0.7 * hash3(gx, gy, gz, spec.seed + 2)) * cell;
            const sz = (gz + 0.15 + 0.7 * hash3(gx, gy, gz, spec.seed + 3)) * cell;
            const radius = cell * spec.radius * (0.85 + 0.3 * hash3(gx, gy, gz, spec.seed + 4));
            const d = Math.hypot(px - sx, py - sy, pz - sz);
            cover = Math.max(cover, Math.min(1, Math.max(0, (radius - d) / (radius * 0.35))));
          }
      if (cover === 0) continue;
      const i = (y * width + x) * 4;
      const shade =
        0.75 + 0.25 * (((data[i] ?? 0) + (data[i + 1] ?? 0) + (data[i + 2] ?? 0)) / 3 / 128);
      for (let c = 0; c < 3; c++)
        out[i + c] = Math.round(
          (data[i + c] ?? 0) * (1 - cover) + Math.min(255, (spec.colour[c] ?? 0) * shade) * cover,
        );
    }
  return { width, height, data: out };
}
