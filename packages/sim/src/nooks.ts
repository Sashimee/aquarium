import type { Basin } from './basin.ts';
import type { Anchor } from './behaviour.ts';
import type { Sdf } from './sdf.ts';

/** Crevice shelters found in the hardscape when the scene offers no cave; sources in BEHAVIOUR.md. */
export const NOOK = {
  maxNooks: 4,
  gridCells: 40,
  stepBodyLengths: 0.25,
  rockTouchBodyLengths: 0.25,
  coverBodyLengths: 1.5,
  minCoverShare: 0.45,
  spacingBodyLengths: 2,
  traceSteps: 24,
} as const;

/** The 26 unit directions to the neighbours of a cube cell. */
const DIRECTIONS: readonly (readonly [number, number, number])[] = (() => {
  const out: [number, number, number][] = [];
  for (const dx of [-1, 0, 1]) {
    for (const dy of [-1, 0, 1]) {
      for (const dz of [-1, 0, 1]) {
        if (dx === 0 && dy === 0 && dz === 0) continue;
        const l = Math.hypot(dx, dy, dz);
        out.push([dx / l, dy / l, dz / l]);
      }
    }
  }
  return out;
})();

export interface NookField {
  readonly basin: Basin;
  /** Glass, sand and hard decor, without the water surface: what a fish can hide against. */
  readonly cover: Sdf;
  /** Glass, sand, surface and hard decor: what a fish's body must clear. */
  readonly water: Sdf;
  /** Hard decor alone. */
  readonly rock: Sdf;
}

interface Candidate {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly clearance: number;
  readonly cover: number;
  readonly facing: [number, number, number];
}

/**
 * Up to `NOOK.maxNooks` crevices against the hardscape for a cave-dweller of body length `length`:
 * free water with room for its whole body, touching rock, and walled in (rock, sand or glass) on
 * at least `minCoverShare` of the 26 directions within `coverBodyLengths`. Each opens toward its
 * open directions, as a cave mouth does. The best covered come first, `spacingBodyLengths` apart.
 * Deterministic: a fixed grid, no RNG.
 */
export function findNooks(field: NookField, length: number, idPrefix = 'nook:'): Anchor[] {
  const { basin, cover, water, rock } = field;
  const r = 0.5 * length;
  const span = Math.max(basin.width, basin.maxY - basin.minY, basin.depth);
  const step = Math.max(NOOK.stepBodyLengths * length, span / NOOK.gridCells);
  const xs = Math.floor((basin.width - 2 * r) / step) + 1;
  const zs = Math.floor((basin.depth - 2 * r) / step) + 1;
  const reach = NOOK.coverBodyLengths * length;
  const touch = r + NOOK.rockTouchBodyLengths * length;
  const n = new Float64Array(3);
  const candidates: Candidate[] = [];
  for (let ix = 0; ix < xs; ix++) {
    const x = basin.minX + r + ix * step;
    for (let iz = 0; iz < zs; iz++) {
      const z = basin.minZ + r + iz * step;
      const lo = basin.ground(x, z) + r;
      const ys = Math.floor((basin.maxY - r - lo) / step) + 1;
      for (let iy = 0; iy < ys; iy++) {
        const y = lo + iy * step;
        const clearance = water.sample(x, y, z, n);
        if (clearance < r) continue;
        if (rock.sample(x, y, z, n) > touch) continue;
        let covered = 0;
        let fx = 0;
        let fz = 0;
        for (const [dx, dy, dz] of DIRECTIONS) {
          if (blocked(cover, x, y, z, dx, dy, dz, reach, 0.25 * r, n)) {
            covered++;
          } else {
            fx += dx;
            fz += dz;
          }
        }
        if (covered < NOOK.minCoverShare * DIRECTIONS.length) continue;
        // Cave mouths open sideways, so a nook does too, toward its open water.
        const fl = Math.hypot(fx, fz);
        if (fl < 1e-6) continue;
        const facing: [number, number, number] = [fx / fl, 0, fz / fl];
        const out = clearance + length;
        const mx = x + facing[0] * out;
        const my = y + facing[1] * out;
        const mz = z + facing[2] * out;
        if (water.sample(mx, my, mz, n) < r) continue;
        candidates.push({ x, y, z, clearance, cover: covered, facing });
      }
    }
  }
  // Stable sort: equal cover keeps grid order, so the choice never depends on the engine.
  candidates.sort((a, b) => b.cover - a.cover || a.y - b.y);
  const spacing = NOOK.spacingBodyLengths * length;
  const nooks: Anchor[] = [];
  for (const c of candidates) {
    if (nooks.length >= NOOK.maxNooks) break;
    const apart = nooks.every(
      (k) => Math.hypot(k.position[0] - c.x, k.position[1] - c.y, k.position[2] - c.z) >= spacing,
    );
    if (!apart) continue;
    nooks.push({
      id: `${idPrefix}${nooks.length}`,
      kind: 'cave',
      position: [c.x, c.y, c.z],
      radius: c.clearance,
      facing: c.facing,
    });
  }
  return nooks;
}

function blocked(
  sdf: Sdf,
  x: number,
  y: number,
  z: number,
  dx: number,
  dy: number,
  dz: number,
  reach: number,
  hit: number,
  n: Float64Array,
): boolean {
  let t = 0;
  for (let k = 0; k < NOOK.traceSteps && t <= reach; k++) {
    const d = sdf.sample(x + dx * t, y + dy * t, z + dz * t, n);
    if (d < hit) return true;
    t += Math.max(d, hit);
  }
  return false;
}
