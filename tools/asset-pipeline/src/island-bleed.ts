import type { Part } from './parts.ts';
import type { Rgba } from './textures.ts';
import { coveredTexelPositions } from './world-spots.ts';

interface Level {
  width: number;
  height: number;
  colour: Float32Array;
  weight: Float32Array;
}

const at = (values: ArrayLike<number>, i: number): number => values[i] ?? 0;

function interiorMask(parts: Part[], width: number, height: number, px: number): Uint8Array {
  const positions = coveredTexelPositions(parts, width, height);
  const count = width * height;
  const depth = new Int32Array(count).fill(-1);
  let frontier: number[] = [];
  for (let i = 0; i < count; i++)
    if (Number.isNaN(at(positions, i * 3))) {
      depth[i] = 0;
      frontier.push(i);
    }
  for (let d = 1; frontier.length > 0 && d <= px; d++) {
    const next: number[] = [];
    for (const i of frontier) {
      const x = i % width;
      for (const [step, blocked] of [
        [1, x === width - 1],
        [-1, x === 0],
        [width, false],
        [-width, false],
      ] as const) {
        const n = i + step;
        if (blocked || n < 0 || n >= count || at(depth, n) >= 0) continue;
        depth[n] = d;
        next.push(n);
      }
    }
    frontier = next;
  }
  return Uint8Array.from(depth, (d) => (d < 0 ? 1 : 0));
}

function downsample(level: Level): Level {
  const width = Math.max(1, level.width >> 1);
  const height = Math.max(1, level.height >> 1);
  const colour = new Float32Array(width * height * 3);
  const weight = new Float32Array(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      let w = 0;
      const sum = [0, 0, 0];
      for (let dy = 0; dy < 2; dy++)
        for (let dx = 0; dx < 2; dx++) {
          const sx = Math.min(level.width - 1, x * 2 + dx);
          const sy = Math.min(level.height - 1, y * 2 + dy);
          const i = sy * level.width + sx;
          const wi = at(level.weight, i);
          w += wi;
          for (let c = 0; c < 3; c++) sum[c] = (sum[c] ?? 0) + at(level.colour, i * 3 + c) * wi;
        }
      const o = y * width + x;
      weight[o] = Math.min(1, w / 4);
      for (let c = 0; c < 3; c++) colour[o * 3 + c] = w > 0 ? (sum[c] ?? 0) / w : 0;
    }
  return { width, height, colour, weight };
}

function fillFrom(level: Level, coarse: Level): void {
  for (let y = 0; y < level.height; y++)
    for (let x = 0; x < level.width; x++) {
      const o = y * level.width + x;
      const w = at(level.weight, o);
      if (w >= 1) continue;
      const fx = Math.min(coarse.width - 1, Math.max(0, (x + 0.5) / 2 - 0.5));
      const fy = Math.min(coarse.height - 1, Math.max(0, (y + 0.5) / 2 - 0.5));
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const x1 = Math.min(coarse.width - 1, x0 + 1);
      const y1 = Math.min(coarse.height - 1, y0 + 1);
      const tx = fx - x0;
      const ty = fy - y0;
      for (let c = 0; c < 3; c++) {
        const sample = (sx: number, sy: number): number =>
          at(coarse.colour, (sy * coarse.width + sx) * 3 + c);
        const up =
          (sample(x0, y0) * (1 - tx) + sample(x1, y0) * tx) * (1 - ty) +
          (sample(x0, y1) * (1 - tx) + sample(x1, y1) * tx) * ty;
        level.colour[o * 3 + c] = at(level.colour, o * 3 + c) * w + up * (1 - w);
      }
      level.weight[o] = 1;
    }
}

/**
 * Source atlases outline every UV island in near-black and fill the gutter between islands with a
 * dark smear. Simplification pulls vertices across island borders, so triangles stretch over the
 * gutter and show it as a dark crack. Texels within `px` of an island border, and the whole gutter,
 * are replaced by a smooth push-pull fill of the colours deeper inside, so a stretched triangle
 * blends between the two islands instead of cutting through black.
 */
export function bleedIslandEdges(image: Rgba, parts: Part[], px: number): Rgba {
  const { width, height, data } = image;
  const valid = interiorMask(parts, width, height, px);
  if (!valid.includes(1)) return image;
  const base: Level = {
    width,
    height,
    colour: new Float32Array(width * height * 3),
    weight: Float32Array.from(valid),
  };
  for (let i = 0; i < width * height; i++)
    if (valid[i]) for (let c = 0; c < 3; c++) base.colour[i * 3 + c] = at(data, i * 4 + c);

  const levels = [base];
  for (;;) {
    const top = levels[levels.length - 1] ?? base;
    if (top.width === 1 && top.height === 1) break;
    levels.push(downsample(top));
  }
  for (let k = levels.length - 2; k >= 0; k--) {
    const level = levels[k];
    const coarse = levels[k + 1];
    if (level && coarse) fillFrom(level, coarse);
  }

  const out = new Uint8Array(data);
  for (let i = 0; i < width * height; i++) {
    if (valid[i]) continue;
    for (let c = 0; c < 3; c++) out[i * 4 + c] = Math.round(at(base.colour, i * 3 + c));
  }
  return { width, height, data: out };
}
