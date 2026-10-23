import { describe, expect, it } from 'vitest';
import { basinOf } from './basin.ts';
import { Route, SIGHT_SAMPLES_PER_CELL, SIGHT_TRIES } from './routes.ts';
import { TankSdf, type Sdf } from './sdf.ts';

const tank = { width: 1, height: 0.5, depth: 0.4 };
const basin = basinOf(tank);
const glass = new TankSdf(tank);

/** Distance to an upright slab spanning the water's height, |x - cx| ≤ hx and |z - cz| ≤ hz. */
function slab(x: number, z: number, cx: number, hx: number, cz: number, hz: number): number {
  const dx = Math.abs(x - cx) - hx;
  const dz = Math.abs(z - cz) - hz;
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dz, 0));
  return outside > 0 ? outside : Math.max(dx, dz);
}

/** The tank with a full-height wall at x = 0 from the back glass to `front`, open beyond it. */
function walled(front: number): Sdf {
  return {
    sample(x, y, z, normal) {
      const wall = slab(x, z, 0, 0.02, 0.5 * (front - 0.2), 0.5 * (front + 0.2));
      return Math.min(glass.sample(x, y, z, normal), wall);
    },
  };
}

const hollow = [0.2, 0.25, -0.1] as const;

function built(r: Route): Route {
  r.build(Infinity);
  return r;
}

function route(water: Sdf): Route {
  const [x, y, z] = hollow;
  return built(new Route(basin, water, x, y, z, 0.02, 0.02, 0.01));
}

/**
 * Follows `r` from (x, z) a leg of `ahead` at a time, for at most `legs` legs or until it gives no
 * way or stops moving, and returns every point it passed.
 */
function follow(r: Route, x: number, z: number, ahead: number, legs: number): [number, number][] {
  const path: [number, number][] = [[x, z]];
  for (let leg = 0; leg < legs; leg++) {
    const way = r.toward(x, r.y, z, 0.05, ahead);
    if (way === null || (way[0] === x && way[1] === z)) break;
    [x, z] = way;
    path.push(way);
  }
  return path;
}

/** Whether the straight line between two points stays in water, sampled every 0.5 mm. */
function inWater(water: Sdf, y: number, [ax, az]: number[], [bx, bz]: number[]): boolean {
  const n3 = new Float64Array(3);
  const n = Math.max(1, Math.ceil(Math.hypot((bx ?? 0) - (ax ?? 0), (bz ?? 0) - (az ?? 0)) / 5e-4));
  for (let k = 0; k <= n; k++) {
    const x = (ax ?? 0) + ((bx ?? 0) - (ax ?? 0)) * (k / n);
    const z = (az ?? 0) + ((bz ?? 0) - (az ?? 0)) * (k / n);
    if (water.sample(x, y, z, n3) <= 0) return false;
  }
  return true;
}

describe('Route', () => {
  it('heads straight for the hollow across open water', () => {
    const way = route(glass).toward(-0.2, hollow[1], -0.1, 0.05, 0.1);
    expect(way).not.toBeNull();
    const [x, z] = way ?? [0, 0];
    expect(x).toBeCloseTo(-0.1, 1);
    expect(Math.abs(z + 0.1)).toBeLessThan(0.02);
  });

  it('goes round a wall by its open end, not into it', () => {
    const r = route(walled(0.1));
    let [x, z] = [-0.2, -0.1];
    for (let leg = 0; leg < 12; leg++) {
      const way = r.toward(x, hollow[1], z, 0.05, 0.05);
      if (way === null) throw new Error(`leg ${leg}: no way from (${x}, ${z})`);
      [x, z] = way;
      if (Math.abs(x) <= 0.04) expect(z, `leg ${leg} crosses the wall line`).toBeGreaterThan(0.1);
    }
    expect(Math.hypot(x - hollow[0], z - hollow[2])).toBeLessThan(0.05);
  });

  it('has no way out of water the wall cuts off, nor from inside the rock', () => {
    const r = route(walled(0.2));
    expect(r.toward(-0.2, hollow[1], -0.1, 0.05, 0.05)).toBeNull();
    expect(route(walled(0.1)).toward(0, hollow[1], -0.15, 0.01, 0.05)).toBeNull();
  });

  it('keeps out of a gap narrower than its clearance', () => {
    const r = built(new Route(basin, walled(0.165), ...hollow, 0.02, 0.02, 0.01));
    expect(r.toward(-0.2, hollow[1], -0.1, 0.05, 0.05)).toBeNull();
    const thin = built(new Route(basin, walled(0.165), ...hollow, 0.02, 0.01, 0.005));
    expect(thin.toward(-0.2, hollow[1], -0.1, 0.05, 0.05)).not.toBeNull();
  });

  it('takes the documented side where two ways round are equally short', () => {
    // Cells 1/64 m across, centred so that z = 0 is a row of cells and every cell centre and
    // distance is exact: the wall and the hollow are mirrored in z = 0, so are the two ways round.
    const cell = 1 / 64;
    const mirrored = { width: 1, height: 0.5, depth: 33 * cell };
    const half = 0.5 * mirrored.depth;
    const water: Sdf = {
      sample(x, _y, z) {
        const box = Math.min(0.5 - Math.abs(x), half - Math.abs(z));
        return Math.min(box, slab(x, z, 0, 0.02, 0, 0.125));
      },
    };
    const r = built(new Route(basinOf(mirrored), water, 0.25, 0.25, 0, 0.02, 0.02, cell));
    const x0 = -0.5 + 0.5 * cell + 16 * cell;
    for (const z of [1, 3, 7].map((k) => k * cell)) {
      const up = r.toward(x0, 0.25, z, 0.05, 4 * cell);
      const down = r.toward(x0, 0.25, -z, 0.05, 4 * cell);
      expect(down, `from ±${z}`).toEqual(up === null ? null : [up[0], -up[1]]);
    }
    // On the line between them, the neighbours toward each way tie and the first in STEPS order
    // wins: +x−z before +x+z.
    expect(r.toward(x0, 0.25, 0, 0.05, cell)).toEqual([x0 + cell, -cell]);
    const path = follow(r, x0, 0, cell, 200);
    for (const [x, z] of path) if (Math.abs(x) <= 0.03) expect(z).toBeLessThan(-0.125);
    const [ex, ez] = path.at(-1) ?? [0, 0];
    expect(Math.hypot(ex - 0.25, ez)).toBeLessThan(0.03);
  });

  it('gives no hollow cell behind thin rock a way in', () => {
    // A 2 mm wall 3 cm past the hollow, from the back glass to z = 0.1: cells beyond it are within
    // the hollow's reach but out of its sight, so the way from behind the wall goes round its end.
    const water: Sdf = {
      sample(x, y, z, normal) {
        return Math.min(glass.sample(x, y, z, normal), slab(x, z, 0.231, 0.001, -0.05, 0.15));
      },
    };
    const [x, y, z] = hollow;
    const r = built(new Route(basin, water, x, y, z, 0.05, 0.02, 0.01));
    const path = follow(r, 0.4, -0.1, 0.05, 40);
    let crossed = false;
    for (let k = 1; k < path.length; k++) {
      const [ax, az] = path[k - 1] ?? [0, 0];
      const [bx, bz] = path[k] ?? [0, 0];
      expect(inWater(water, y, [ax, az], [bx, bz])).toBe(true);
      if (ax > 0.231 && bx < 0.231) {
        crossed = true;
        expect(Math.min(az, bz), `(${ax}, ${az}) → (${bx}, ${bz})`).toBeGreaterThan(0.1);
      }
    }
    expect(crossed).toBe(true);
    const [ex, ez] = path.at(-1) ?? [0, 0];
    expect(Math.hypot(ex - x, ez - z)).toBeLessThan(0.05);
  });

  it('gives a fish no way through thin rock to a cell in reach beyond it', () => {
    // A 4 mm wall from glass to glass at x = 0 cuts the fish off, though the hollow's cells beyond
    // it are within the fish's reach.
    const water: Sdf = {
      sample(x, y, z, normal) {
        return Math.min(glass.sample(x, y, z, normal), slab(x, z, 0, 0.002, 0, 0.3));
      },
    };
    const [x, y, z] = hollow;
    const r = built(new Route(basin, water, x, y, z, 0.02, 0.02, 0.01));
    expect(r.toward(-0.01, y, -0.1, 0.05, 0.05)).toBeNull();
    expect(r.toward(0.01, y, -0.1, 0.05, 0.05)).not.toBeNull();
  });

  it('sees no cell through rock thinner than the gap between two sight samples', () => {
    // A 0.2 mm wall from glass to glass: samples 5 mm apart along a line of sight almost never land
    // in it, so only the room of the two samples either side, short of the gap, gives it away.
    const water: Sdf = {
      sample(x, y, z, normal) {
        return Math.min(glass.sample(x, y, z, normal), slab(x, z, 0, 0.0001, 0, 0.3));
      },
    };
    const [x, y, z] = hollow;
    const r = built(new Route(basin, water, x, y, z, 0.02, 0.02, 0.01));
    for (const fx of [-0.0013, -0.0021, -0.0029, -0.0037, -0.0045]) {
      for (const fz of [-0.17, -0.13, -0.1, -0.06, 0.02, 0.11]) {
        expect(r.entry(fx, y, fz, 0.05), `from (${fx}, ${fz})`).toBe(-1);
        expect(r.entry(-fx, y, fz, 0.05), `from (${-fx}, ${fz})`).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('joins the way by a cell it can follow, and throws for one without a way', () => {
    const r = route(walled(0.1));
    const c = r.entry(-0.2, hollow[1], -0.1, 0.05);
    expect(c).toBeGreaterThanOrEqual(0);
    expect(r.from(c, 0.05)).toEqual(r.toward(-0.2, hollow[1], -0.1, 0.05, 0.05));
    expect(r.entry(-0.2, hollow[1], -0.1, 0.001)).toBe(-1);
    expect(() => r.from(0, 0.05)).toThrow(/no way to the hollow/);
  });

  it('counts the samples its lines of sight take', () => {
    const [x, y, z] = hollow;
    const r = built(new Route(basin, walled(0.2), x, y, z, 0.02, 0.02, 0.01));
    const before = r.sightSamplesTaken;
    expect(r.entry(-0.2, y, -0.1, 0.05)).toBe(-1);
    expect(r.sightSamplesTaken).toBe(before);
    expect(r.entry(0.1, y, -0.1, 0.05)).toBeGreaterThanOrEqual(0);
    const one = r.sightSamplesTaken - before;
    expect(one).toBeGreaterThan(1);
    expect(one).toBeLessThanOrEqual(
      SIGHT_TRIES * (Math.ceil((SIGHT_SAMPLES_PER_CELL * 0.05) / 0.01) + 1),
    );
  });

  it('cuts no rock corner where a big tank makes the cells coarser than its clearance', () => {
    // 4 m across caps the cells at 1/64 m, three times a 5 mm clearance. Posts 3 mm thick stand at
    // the corners between cells along x = 0, so every diagonal across that line runs into one.
    const cell = 1 / 64;
    const big = { width: 4, height: 0.5, depth: 0.5 };
    const box = new TankSdf(big);
    const water: Sdf = {
      sample(x, y, z, normal) {
        const k = Math.round((z + 0.25) / cell);
        const post = k >= 1 && k <= 31 ? Math.hypot(x, z - (-0.25 + k * cell)) - 0.003 : Infinity;
        return Math.min(box.sample(x, y, z, normal), post);
      },
    };
    const y = 0.25;
    const r = built(new Route(basinOf(big), water, 0.5, y, 0.1, 0.02, 0.005, 0.0025));
    let crossings = 0;
    for (const [sx, sz] of [
      [-0.5, -0.15],
      [-0.3, 0.2],
      [-0.1, -0.05],
      [-0.05, 0.12],
    ] as const) {
      const path = follow(r, sx, sz, cell, 400);
      for (let k = 1; k < path.length; k++) {
        const a = path[k - 1] ?? [0, 0];
        const b = path[k] ?? [0, 0];
        expect(inWater(water, y, a, b), `(${a.join(', ')}) → (${b.join(', ')})`).toBe(true);
        if (a[0] < 0 && b[0] > 0) crossings++;
      }
      const [ex, ez] = path.at(-1) ?? [0, 0];
      expect(Math.hypot(ex - 0.5, ez - 0.1), `from (${sx}, ${sz})`).toBeLessThan(0.03);
    }
    expect(crossings).toBe(4);
  });

  it('finds the same way built a little at a time as all at once', () => {
    const [x, y, z] = hollow;
    const whole = route(walled(0.1));
    const piecemeal = new Route(basin, walled(0.1), x, y, z, 0.02, 0.02, 0.01);
    expect(() => piecemeal.toward(-0.2, y, -0.1, 0.05, 0.05)).toThrow(/not built/);
    let calls = 0;
    while (!piecemeal.ready) {
      const spent = piecemeal.build(64, false);
      expect(spent).toBeGreaterThan(0);
      expect(spent).toBeLessThanOrEqual(64);
      calls++;
    }
    expect(calls).toBeGreaterThan(10);
    expect(piecemeal.build(64)).toBe(0);
    for (const [px, pz] of [
      [-0.3, 0],
      [-0.1, -0.15],
      [0.4, 0.15],
    ] as const) {
      expect(piecemeal.toward(px, y, pz, 0.05, 0.08)).toEqual(whole.toward(px, y, pz, 0.05, 0.08));
    }
  });

  it('does nothing past a line of sight the budget cannot cover, unless told to overrun', () => {
    const [x, y, z] = hollow;
    const r = new Route(basin, glass, x, y, z, 0.05, 0.02, 0.01);
    const cells = 100 * 40;
    expect(r.build(cells)).toBe(cells);
    expect(r.build(2, false)).toBe(0);
    expect(r.build(2)).toBeGreaterThan(2);
  });
});
