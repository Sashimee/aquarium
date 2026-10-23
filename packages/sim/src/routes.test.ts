import { describe, expect, it } from 'vitest';
import { basinOf } from './basin.ts';
import { Route } from './routes.ts';
import { TankSdf, type Sdf } from './sdf.ts';

const tank = { width: 1, height: 0.5, depth: 0.4 };
const basin = basinOf(tank);
const glass = new TankSdf(tank);

/** The tank with a full-height wall at x = 0 from the back glass to `front`, open beyond it. */
function walled(front: number): Sdf {
  return {
    sample(x, y, z, normal) {
      const dx = Math.abs(x) - 0.02;
      const dz = Math.max(-0.2 - z, z - front);
      const outside = Math.hypot(Math.max(dx, 0), Math.max(dz, 0));
      const wall = outside > 0 ? outside : Math.max(dx, dz);
      return Math.min(glass.sample(x, y, z, normal), wall);
    },
  };
}

const hollow = [0.2, 0.25, -0.1] as const;

function route(water: Sdf): Route {
  const [x, y, z] = hollow;
  return new Route(basin, water, x, y, z, 0.02, 0.02, 0.01);
}

describe('Route', () => {
  it('heads straight for the hollow across open water', () => {
    const way = route(glass).toward(-0.2, -0.1, 0.05, 0.1);
    expect(way).not.toBeNull();
    const [x, z] = way ?? [0, 0];
    expect(x).toBeCloseTo(-0.1, 1);
    expect(Math.abs(z + 0.1)).toBeLessThan(0.02);
  });

  it('goes round a wall by its open end, not into it', () => {
    const r = route(walled(0.1));
    let [x, z] = [-0.2, -0.1];
    for (let leg = 0; leg < 12; leg++) {
      const way = r.toward(x, z, 0.05, 0.05);
      if (way === null) throw new Error(`leg ${leg}: no way from (${x}, ${z})`);
      [x, z] = way;
      if (Math.abs(x) <= 0.04) expect(z, `leg ${leg} crosses the wall line`).toBeGreaterThan(0.1);
    }
    expect(Math.hypot(x - hollow[0], z - hollow[2])).toBeLessThan(0.05);
  });

  it('has no way out of water the wall cuts off, nor from inside the rock', () => {
    const r = route(walled(0.2));
    expect(r.toward(-0.2, -0.1, 0.05, 0.05)).toBeNull();
    expect(route(walled(0.1)).toward(0, -0.15, 0.01, 0.05)).toBeNull();
  });

  it('keeps out of a gap narrower than its clearance', () => {
    const r = new Route(basin, walled(0.165), ...hollow, 0.02, 0.02, 0.01);
    expect(r.toward(-0.2, -0.1, 0.05, 0.05)).toBeNull();
    const thin = new Route(basin, walled(0.165), ...hollow, 0.02, 0.01, 0.005);
    expect(thin.toward(-0.2, -0.1, 0.05, 0.05)).not.toBeNull();
  });

  it('is the same way every time it is found', () => {
    const a = route(walled(0.1));
    const b = route(walled(0.1));
    for (const [x, z] of [
      [-0.3, 0],
      [-0.1, -0.15],
      [0.4, 0.15],
    ] as const) {
      expect(a.toward(x, z, 0.05, 0.08)).toEqual(b.toward(x, z, 0.05, 0.08));
    }
  });
});
