import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { speciesContentSchema, type Collider } from '@aquarium/shared';
import { describe, expect, it } from 'vitest';
import {
  CARCASS,
  carcassFate,
  carcassSettleS,
  CarcassSupport,
  sinkingCarcass,
  sinkSpeed,
  type CarcassPose,
  type CarcassStart,
} from './carcass.ts';
import { compileCollider } from './decor.ts';
import { STEP_DT } from './world.ts';

const SETTLE_WITHIN_S = 15;
const TANK_DEPTH = 0.6;

const species = readdirSync(join(import.meta.dirname, '../../../content/species'))
  .filter((f) => f.endsWith('.json'))
  .map((f) =>
    speciesContentSchema.parse(
      JSON.parse(
        readFileSync(join(import.meta.dirname, '../../../content/species', f), 'utf8'),
      ) as unknown,
    ),
  );
const shrimp = species.filter((s) => s.locomotion.swimmingMode === 'pleopod');

function pose(): CarcassPose {
  return { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0, speed: 0, yawRate: 0, liveliness: 1 };
}

function trajectory(
  from: CarcassStart,
  length: number,
  seed: number,
  floorY: number,
  seconds: number,
): CarcassPose[] {
  const out: CarcassPose[] = [];
  for (let i = 0; i <= Math.round(seconds / STEP_DT); i++) {
    const p = pose();
    sinkingCarcass(i * STEP_DT, from, length, seed, floorY, p);
    out.push(p);
  }
  return out;
}

describe('carcassFate', () => {
  it('sinks the walking crustaceans and floats every finned fish', () => {
    expect(shrimp.length).toBeGreaterThanOrEqual(2);
    for (const s of species) {
      expect(carcassFate(s.locomotion.swimmingMode), s.id).toBe(
        s.locomotion.swimmingMode === 'pleopod' ? 'sink' : 'float',
      );
    }
  });

  it('sinks a shelled walker that never swims', () => {
    expect(carcassFate('none')).toBe('sink');
  });
});

describe('sinkingCarcass', () => {
  const seeds = [0, 0.2, 0.34, 0.5, 0.67, 0.7, 0.99];

  it.each(shrimp.map((s) => ({ id: s.id, length: s.locomotion.bodyLengthM })))(
    'a dead $id falls from the surface, rests on the floor within the limit and never rises',
    ({ length }) => {
      const floorY = 0.04;
      const from = { x: 0.1, y: floorY + TANK_DEPTH, z: -0.05, yaw: 1.2 };
      for (const seed of seeds) {
        const path = trajectory(from, length, seed, floorY, 2 * SETTLE_WITHIN_S);
        const settleS = carcassSettleS(from, length, seed, floorY);
        expect(settleS).toBeLessThan(SETTLE_WITHIN_S);
        const rest = path[path.length - 1];
        if (rest === undefined) throw new Error('empty trajectory');
        expect(rest.y - floorY).toBeGreaterThan(0);
        expect(rest.y - floorY).toBeLessThanOrEqual(CARCASS.restBellyBodyLengths * length + 1e-12);
        expect(rest.liveliness).toBe(0);
        expect([0, Math.PI / 2, -Math.PI / 2]).toContain(rest.roll);
        for (let i = 0; i < path.length; i++) {
          const p = path[i];
          if (p === undefined) throw new Error(`missing step ${i}`);
          expect(p.x).toBe(from.x);
          expect(p.z).toBe(from.z);
          expect(p.y).toBeGreaterThanOrEqual(rest.y);
          expect(p.y).toBeLessThanOrEqual(from.y);
          const before = path[i - 1];
          if (before !== undefined) expect(p.y).toBeLessThanOrEqual(before.y);
          if (i * STEP_DT >= settleS) expect(p).toEqual(rest);
        }
      }
    },
  );

  it('lands belly-down or on either side, all three across seeds', () => {
    const rolls = new Set<number>();
    for (let k = 0; k < 30; k++) {
      const p = pose();
      sinkingCarcass(60, { x: 0, y: 0.5, z: 0, yaw: 0 }, 0.03, k / 30, 0, p);
      rolls.add(p.roll);
    }
    expect([...rolls].sort()).toEqual([-Math.PI / 2, 0, Math.PI / 2].sort());
  });

  it('is deterministic: the same inputs give the same trajectory bit for bit', () => {
    const from = { x: -0.2, y: 0.45, z: 0.1, yaw: -0.4 };
    expect(trajectory(from, 0.045, 0.61, 0.02, 12)).toEqual(
      trajectory(from, 0.045, 0.61, 0.02, 12),
    );
  });

  it('follows quadratic-drag sinking: matches a numerical integration of the force balance', () => {
    const length = 0.03;
    const {
      densityContrast: s,
      addedMass,
      gravity,
      dragCoefficient,
      thicknessBodyLengths,
    } = CARCASS;
    const d = thicknessBodyLengths * length;
    const volume = (Math.PI / 4) * d * d * length;
    const area = d * length;
    const from = { x: 0, y: 1, z: 0, yaw: 0 };
    const dt = 1e-4;
    let v = 0;
    let y = from.y;
    for (let t = dt; t <= 3 + dt / 2; t += dt) {
      const force = (s - 1) * volume * gravity - 0.5 * dragCoefficient * area * v * v;
      v += (force / ((s + addedMass) * volume)) * dt;
      y -= v * dt;
    }
    const p = pose();
    sinkingCarcass(3, from, length, 0.5, -1, p);
    expect(p.y).toBeCloseTo(y, 4);
    expect(v).toBeCloseTo(sinkSpeed(length), 4);
  });

  it('sinks a few centimetres a second, much faster than a copepod carcass', () => {
    for (const s of shrimp) {
      const v = sinkSpeed(s.locomotion.bodyLengthM);
      expect(v, s.id).toBeGreaterThan(0.02);
      expect(v, s.id).toBeLessThan(0.1);
    }
  });

  it('one that died on the sand stays there and only tips over', () => {
    const floorY = 0.01;
    const length = 0.03;
    const from = { x: 0, y: floorY + 0.15 * length, z: 0, yaw: 0 };
    const path = trajectory(from, length, 0.9, floorY, 3);
    for (const p of path) {
      expect(p.y).toBeLessThanOrEqual(from.y);
      expect(p.y).toBeGreaterThan(floorY);
    }
    expect(path[path.length - 1]?.roll).toBe(-Math.PI / 2);
  });

  it('never lifts a carcass that died below its resting height', () => {
    const from = { x: 0, y: 0.001, z: 0, yaw: 0 };
    const p = pose();
    for (const t of [0, 0.5, 5]) {
      sinkingCarcass(t, from, 0.03, 0.1, 0, p);
      expect(p.y).toBe(from.y);
    }
  });

  it('falls again from rest when its support goes, limp and rolled as long dead', () => {
    const from = { x: 0, y: 0.2, z: 0, yaw: 0 };
    const p = pose();
    sinkingCarcass(30, from, 0.03, 0.9, 0, p, 0);
    expect(p).toMatchObject({ y: 0.2, roll: -Math.PI / 2, liveliness: 0 });
    sinkingCarcass(30.5, from, 0.03, 0.9, 0, p, 0.5);
    const fell = p.y;
    expect(fell).toBeLessThan(0.2);
    sinkingCarcass(0.5, from, 0.03, 0.9, 0, p);
    expect(fell).toBe(p.y);
  });

  it('holds the start pose before t = 0', () => {
    const from = { x: 0.3, y: 0.4, z: 0.2, yaw: 2 };
    const p = pose();
    sinkingCarcass(-1, from, 0.03, 0.5, 0, p);
    expect(p).toMatchObject({ x: 0.3, y: 0.4, z: 0.2, yaw: 2, roll: 0, liveliness: 1 });
  });
});

describe('CarcassSupport', () => {
  const length = 0.03;
  const sand = (): number => 0.02;
  const rock = (overrides: Partial<{ hard: boolean; y: number }> = {}): Collider => ({
    id: 'rock',
    kind: 'box',
    hard: overrides.hard ?? true,
    center: [0, overrides.y ?? 0.1, 0],
    halfExtents: [0.05, 0.05, 0.05],
    rotationY: 0,
    rounding: 0,
  });

  it('lands on the substrate when nothing hard is under the body', () => {
    const support = new CarcassSupport([rock({ hard: false })]);
    expect(support.floorY({ x: 0, y: 0.3, z: 0, yaw: 0 }, length, sand)).toBe(0.02);
    expect(new CarcassSupport([]).floorY({ x: 0, y: 0.3, z: 0, yaw: 0 }, length, sand)).toBe(0.02);
  });

  it('lands on top of a rock under its centre', () => {
    const support = new CarcassSupport([rock()]);
    expect(support.floorY({ x: 0.01, y: 0.3, z: -0.02, yaw: 1 }, length, sand)).toBeCloseTo(
      0.15,
      3,
    );
  });

  it('is held up by a rock under only one end', () => {
    const support = new CarcassSupport([rock()]);
    const edge = 0.05 + 0.3 * length;
    const along = { x: 0, y: 0.3, z: edge, yaw: 0 };
    const across = { x: 0, y: 0.3, z: edge, yaw: Math.PI / 2 };
    expect(support.floorY(along, length, sand)).toBeCloseTo(0.15, 3);
    expect(support.floorY(across, length, sand)).toBe(0.02);
  });

  const halfThickness = (CARCASS.thicknessBodyLengths / 2) * length;

  /** The least rock distance anywhere along the body's axis, tip to tip, at every frame of its sink and rest. */
  function closestOnTheWayDown(
    rocks: readonly Collider[],
    from: CarcassStart,
    seed: number,
  ): number {
    const support = new CarcassSupport(rocks);
    const { floorY, path } = support.descend(from, length, sand);
    const prims = rocks.map(compileCollider);
    const normal = new Float64Array(3);
    const p = pose();
    let closest = Infinity;
    const end = carcassSettleS(from, length, seed, floorY) + 1;
    for (let t = 0; t <= end; t += 1 / 60) {
      sinkingCarcass(t, from, length, seed, floorY, p, t, path);
      for (let k = -10; k <= 10; k++) {
        const along = (k / 20) * length;
        const x = p.x + Math.sin(p.yaw) * along;
        const z = p.z + Math.cos(p.yaw) * along;
        for (const prim of prims) closest = Math.min(closest, prim.sample(x, p.y, z, normal));
      }
    }
    return closest;
  }

  it('slides off a rock edge it would only catch on the rim of its body', () => {
    const from = { x: 0.05 + 0.9 * halfThickness, y: 0.3, z: 0, yaw: 0 };
    const { floorY, path } = new CarcassSupport([rock()]).descend(from, length, sand);
    expect(floorY).toBe(0.02);
    expect(path[path.length - 2]).toBeGreaterThanOrEqual(0.05 + halfThickness - 0.0005);
    expect(closestOnTheWayDown([rock()], from, 0.1)).toBeGreaterThan(halfThickness - 0.0005);
  });

  it('stays clear of a round rock all the way down, sliding off its steep flank', () => {
    const boulder: Collider = {
      id: 'boulder',
      kind: 'sphere',
      hard: true,
      center: [0, 0.1, 0],
      radius: 0.05,
    };
    const support = new CarcassSupport([boulder]);
    for (const x of [0, 0.015, 0.03, 0.045, 0.047, 0.049, 0.052, 0.055]) {
      for (const yaw of [0, Math.PI / 2, 1]) {
        const from = { x, y: 0.3, z: 0, yaw };
        expect(closestOnTheWayDown([boulder], from, 0.1)).toBeGreaterThan(halfThickness - 0.0005);
      }
    }
    const crownY = 0.1 + Math.sqrt(0.05 ** 2 - 0.015 ** 2);
    expect(support.floorY({ x: 0.015, y: 0.3, z: 0, yaw: 0 }, length, sand)).toBeGreaterThan(
      crownY - 0.001,
    );
    expect(support.floorY({ x: 0.049, y: 0.3, z: 0, yaw: 0 }, length, sand)).toBe(0.02);
  });

  it('lies across a round crown with no part of its body in the rock', () => {
    const boulder: Collider = {
      id: 'boulder',
      kind: 'sphere',
      hard: true,
      center: [0, 0.1, 0],
      radius: 0.05,
    };
    const across = { x: 0, y: 0.3, z: 0, yaw: Math.PI / 2 };
    expect(new CarcassSupport([boulder]).floorY(across, length, sand)).toBeGreaterThan(0.15);
    expect(closestOnTheWayDown([boulder], across, 0.1)).toBeGreaterThan(halfThickness - 0.0005);
  });

  it('slides all the way down a tall rock face it starts a hair away from', () => {
    const pillar: Collider = {
      id: 'pillar',
      kind: 'box',
      hard: true,
      center: [0, 0.27, 0],
      halfExtents: [0.02, 0.25, 0.02],
      rotationY: 0,
      rounding: 0,
    };
    const support = new CarcassSupport([pillar]);
    for (const skin of [0.0001, 0.000101, 0.00011, 0.00012, 0.0004]) {
      const from = { x: 0.02 + halfThickness + skin, y: 0.55, z: 0, yaw: 0 };
      expect(support.floorY(from, length, sand)).toBe(0.02);
    }
  });

  it('falls past a rock that is above where it died, as under a ledge', () => {
    const support = new CarcassSupport([rock({ y: 0.25 })]);
    expect(support.floorY({ x: 0, y: 0.15, z: 0, yaw: 0 }, length, sand)).toBe(0.02);
  });

  it('lies on top of a rock it starts inside', () => {
    const support = new CarcassSupport([rock()]);
    expect(support.floorY({ x: 0, y: 0.07, z: 0, yaw: 0 }, length, sand)).toBeCloseTo(0.15, 3);
  });

  describe('columnFloorY', () => {
    const ball: Collider = {
      id: 'ball',
      kind: 'sphere',
      hard: true,
      center: [0, 0.1, 0],
      radius: 0.05,
    };

    it('is the rock top or the sand straight below the point', () => {
      const support = new CarcassSupport([rock()]);
      expect(support.columnFloorY(0.01, -0.02, 0.3, sand)).toBeCloseTo(0.15, 3);
      expect(support.columnFloorY(0.049, 0, 0.3, sand)).toBeCloseTo(0.15, 3);
      expect(support.columnFloorY(0.051, 0, 0.3, sand)).toBe(0.02);
      expect(new CarcassSupport([]).columnFloorY(0, 0, 0.3, sand)).toBe(0.02);
      expect(new CarcassSupport([rock({ hard: false })]).columnFloorY(0, 0, 0.3, sand)).toBe(0.02);
    });

    it('finds the surface of a round rock down its steep flank', () => {
      const support = new CarcassSupport([ball]);
      for (const x of [0, 0.03, 0.045, 0.049]) {
        const top = 0.1 + Math.sqrt(0.05 ** 2 - x ** 2);
        expect(support.columnFloorY(x, 0, 0.3, sand)).toBeCloseTo(top, 3);
      }
      expect(support.columnFloorY(0.0505, 0, 0.3, sand)).toBe(0.02);
    });

    it('sees only what is below the point, and climbs out of rock it starts in', () => {
      const support = new CarcassSupport([rock({ y: 0.25 })]);
      expect(support.columnFloorY(0, 0, 0.15, sand)).toBe(0.02);
      expect(support.columnFloorY(0, 0, 0.25, sand)).toBeCloseTo(0.3, 3);
    });

    it('never reports a floor below the sand', () => {
      const support = new CarcassSupport([rock({ y: 0 })]);
      expect(support.columnFloorY(0, 0, 0.3, () => 0.08)).toBe(0.08);
    });
  });

  it('rests the body on the rock, not in it', () => {
    const support = new CarcassSupport([rock()]);
    const from = { x: 0, y: 0.3, z: 0, yaw: 0 };
    const floorY = support.floorY(from, length, sand);
    const p = pose();
    for (const seed of [0.1, 0.5, 0.9]) {
      sinkingCarcass(carcassSettleS(from, length, seed, floorY), from, length, seed, floorY, p);
      expect(p.y).toBeGreaterThan(0.15);
    }
  });
});
