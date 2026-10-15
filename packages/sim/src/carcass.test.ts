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

  it('slides past a rock face it only brushes', () => {
    const turned = { ...rock(), rotationY: Math.PI / 4 };
    const support = new CarcassSupport([turned]);
    const off = (0.05 + 0.0002) / Math.SQRT2;
    const brushing = { x: off, y: 0.3, z: off, yaw: (3 * Math.PI) / 4 };
    expect(support.floorY(brushing, length, sand)).toBe(0.02);
  });

  it('falls past a rock that is above where it died, as under a ledge', () => {
    const support = new CarcassSupport([rock({ y: 0.25 })]);
    expect(support.floorY({ x: 0, y: 0.15, z: 0, yaw: 0 }, length, sand)).toBe(0.02);
  });

  it('lies on top of a rock it starts inside', () => {
    const support = new CarcassSupport([rock()]);
    expect(support.floorY({ x: 0, y: 0.07, z: 0, yaw: 0 }, length, sand)).toBeCloseTo(0.15, 3);
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
