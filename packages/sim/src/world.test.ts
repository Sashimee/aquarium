import { describe, expect, it } from 'vitest';

// Long simulations: well under a second locally, but shared CI runners can be several times slower.
const LONG = 60_000;
import { BEHAVIOUR } from './behaviour.ts';
import {
  ARCHETYPES,
  benchmarkConfig,
  blueTang,
  neonTetra,
  REEF_DECOR,
  REEF_TANK,
  spawnMany,
  yellowTang,
} from './fixtures.ts';
import { FishState, SNAPSHOT_STRIDE } from './snapshot.ts';
import { toSimSpecies } from './species.ts';
import { STEERING, STEP_DT, World, type WorldConfig } from './world.ts';

function stateOf(w: World): Float64Array[] {
  return [w.position, w.yaw, w.pitch, w.roll, w.speed, w.yawRate, w.pitchRate].map(
    (a) => new Float64Array(a),
  );
}

function run(config: WorldConfig, steps: number): World {
  const w = new World(config);
  for (let t = 0; t < steps; t++) w.step();
  return w;
}

function at(a: ArrayLike<number>, i: number): number {
  const v = a[i];
  if (v === undefined) throw new RangeError(`index ${i} out of range`);
  return v;
}

function shoalClusters(w: World, members: number[], linkM: number): number[] {
  const parent = members.map((_, k) => k);
  const root = (k: number): number => {
    while (at(parent, k) !== k) k = at(parent, k);
    return k;
  };
  members.forEach((i, a) => {
    for (let b = a + 1; b < members.length; b++) {
      const j = at(members, b);
      const d = Math.hypot(
        at(w.position, i * 3) - at(w.position, j * 3),
        at(w.position, i * 3 + 1) - at(w.position, j * 3 + 1),
        at(w.position, i * 3 + 2) - at(w.position, j * 3 + 2),
      );
      if (d < linkM) parent[root(a)] = root(b);
    }
  });
  const sizes = new Map<number, number>();
  members.forEach((_, k) => sizes.set(root(k), (sizes.get(root(k)) ?? 0) + 1));
  return [...sizes.values()];
}

describe('World determinism', { timeout: LONG }, () => {
  it('reproduces the trajectory bit for bit from the same seed', () => {
    const a = run(benchmarkConfig(3), 1000);
    const b = run(benchmarkConfig(3), 1000);
    expect(stateOf(a)).toEqual(stateOf(b));
    expect(a.contacts).toBe(b.contacts);
    expect(Array.from(a.state)).toEqual(Array.from(b.state));
  });

  it('stays bit-identical through taps, light changes and moved decor', () => {
    const drive = (): World => {
      const w = new World(benchmarkConfig(8));
      for (let t = 0; t < 1500; t++) {
        if (t === 200) w.startle({ position: [0, 0.3, 0.3], intensity: 1 });
        if (t === 400) w.setLight(0);
        if (t === 700) {
          w.setDecor(
            REEF_DECOR.map((c) =>
              c.id === 'rock-left'
                ? { ...c, shape: { kind: 'sphere', center: [-0.5, 0, 0.05], radius: 0.18 } }
                : c,
            ),
          );
        }
        if (t === 1000) w.setLight(1);
        w.step();
      }
      return w;
    };
    const a = drive();
    const b = drive();
    expect(stateOf(a)).toEqual(stateOf(b));
    expect(Array.from(a.state)).toEqual(Array.from(b.state));
    expect(Array.from(a.thrust)).toEqual(Array.from(b.thrust));
  });

  it('diverges for a different seed', () => {
    const a = run(benchmarkConfig(3), 50);
    const b = run(benchmarkConfig(4), 50);
    expect(a.position).not.toEqual(b.position);
  });

  it('advances a fixed 1/30 s per step', () => {
    const w = run(benchmarkConfig(1), 90);
    expect(w.tick).toBe(90);
    expect(w.time).toBeCloseTo(3, 12);
  });
});

describe('World containment', { timeout: LONG }, () => {
  it('keeps the decorated 60-fish community out of glass and rock', () => {
    const w = new World(benchmarkConfig(2));
    let worst = Infinity;
    for (let t = 0; t < 10_000; t++) {
      w.step();
      for (let i = 0; i < w.count; i++) worst = Math.min(worst, w.bodyClearance(i));
    }
    expect(worst).toBeGreaterThanOrEqual(-1e-9);
    expect(w.contacts / (w.count * 10_000)).toBeLessThan(1e-3);
  });

  it('backs a fish out of a dead-end crevice too narrow to turn in', () => {
    // A 4.5 cm slot between the back glass and a rock, closed at +x: a 15 cm tang fits lengthwise
    // but cannot turn round inside it.
    const back = -REEF_TANK.depth / 2;
    const w = new World({
      seed: 1,
      tank: REEF_TANK,
      species: ARCHETYPES,
      decor: [
        {
          id: 'slot-wall',
          solid: true,
          shape: {
            kind: 'box',
            center: [0.01, 0.15, back + 0.075],
            halfExtents: [0.11, 0.15, 0.03],
          },
        },
        {
          id: 'slot-end',
          solid: true,
          shape: {
            kind: 'box',
            center: [0.14, 0.15, back + 0.03],
            halfExtents: [0.02, 0.15, 0.03],
          },
        },
      ],
      fish: spawnMany(yellowTang.id, 1),
    });
    w.position.set([0, 0.15, back + 0.0225], 0);
    w.yaw[0] = Math.PI / 2;
    w.pitch[0] = 0;
    expect(w.bodyClearance(0)).toBeGreaterThanOrEqual(0);
    let worst = Infinity;
    let turned = 0;
    let freedAt = -1;
    for (let t = 0; t < 600; t++) {
      w.step();
      worst = Math.min(worst, w.bodyClearance(0));
      if (freedAt >= 0) continue;
      turned += Math.abs(at(w.yawRate, 0)) * STEP_DT;
      if (at(w.position, 0) < -0.1 - 0.5 * at(w.bodyLength, 0)) freedAt = t;
    }
    expect(worst).toBeGreaterThanOrEqual(-1e-9);
    expect(freedAt).toBeGreaterThanOrEqual(0);
    expect(freedAt * STEP_DT).toBeLessThan(5);
    // Backing out, not thrashing: it does not try to spin round inside the slot.
    expect(turned).toBeLessThan(2 * Math.PI);
  });
});

describe('World kinematic limits', { timeout: LONG }, () => {
  it('respects per-species turn rate, pitch, speed and bank limits', () => {
    const w = new World(benchmarkConfig(5));
    const worst = {
      yawRate: 0,
      pitchRate: 0,
      pitch: 0,
      speed: 0,
      roll: 0,
      minSpeed: Infinity,
      reflex: 0,
    };
    for (let t = 0; t < 3000; t++) {
      // Each tap is a coin flip per fish; tapping beside several guarantees a reflex to measure.
      if (t === 1000) {
        for (let i = 0; i < 6; i++) {
          const o = i * 3;
          const position = [
            at(w.position, o),
            at(w.position, o + 1),
            at(w.position, o + 2),
          ] as const;
          w.startle({ position, intensity: 1 });
        }
      }
      w.step();
      for (let i = 0; i < w.count; i++) {
        const sp = w.speciesOf(i);
        const vmax = (sp.maxSpeed * at(w.bodyLength, i)) / sp.bodyLength;
        const turn = Math.max(Math.abs(at(w.yawRate, i)), Math.abs(at(w.pitchRate, i)));
        // The C-start is a Mauthner reflex, far faster than any steering turn.
        if (at(w.state, i) === FishState.Startle) {
          worst.reflex = Math.max(worst.reflex, turn / BEHAVIOUR.cBendTurnRateRadPerS);
        } else {
          worst.yawRate = Math.max(worst.yawRate, Math.abs(at(w.yawRate, i)) / sp.maxTurnRate);
          worst.pitchRate = Math.max(
            worst.pitchRate,
            Math.abs(at(w.pitchRate, i)) / sp.maxTurnRate,
          );
        }
        worst.pitch = Math.max(worst.pitch, Math.abs(at(w.pitch, i)) / sp.maxPitch);
        worst.speed = Math.max(worst.speed, at(w.speed, i) / vmax);
        // Species that turn their belly to a surface roll past the bank limit on purpose.
        if (!sp.bellyToSurface) {
          worst.roll = Math.max(worst.roll, Math.abs(at(w.roll, i)) / STEERING.maxBankRad);
        }
        worst.minSpeed = Math.min(worst.minSpeed, at(w.speed, i));
      }
    }
    expect(worst.reflex).toBeGreaterThan(0);
    expect(worst.reflex).toBeLessThanOrEqual(1 + 1e-12);
    expect(worst.yawRate).toBeLessThanOrEqual(1 + 1e-12);
    expect(worst.pitchRate).toBeLessThanOrEqual(1 + 1e-12);
    expect(worst.pitch).toBeLessThanOrEqual(1 + 1e-12);
    expect(worst.speed).toBeLessThanOrEqual(1 + 1e-12);
    expect(worst.roll).toBeLessThanOrEqual(1 + 1e-12);
    expect(worst.minSpeed).toBeGreaterThanOrEqual(0);
  });

  it('banks into the turn (left turn lowers the left flank)', () => {
    const w = new World(benchmarkConfig(6));
    let sxy = 0;
    let sxx = 0;
    let syy = 0;
    for (let t = 0; t < 2000; t++) {
      w.step();
      for (let i = 0; i < w.count; i++) {
        // Positive roll lowers the right flank, so a left (positive) turn should roll negative.
        const expected = -Math.tanh(
          (at(w.speed, i) * at(w.yawRate, i)) / STEERING.bankReferenceAccel,
        );
        const roll = at(w.roll, i);
        sxy += expected * roll;
        sxx += expected * expected;
        syy += roll * roll;
      }
    }
    // Roll lags the turn by the bank smoothing time, so expect strong but not perfect agreement.
    expect(sxy / Math.sqrt(sxx * syy)).toBeGreaterThan(0.6);
  });

  it('steers a lone tang along the reef glass without flip-flopping or stalling', () => {
    let hardFlips = 0;
    let stalled = 0;
    let samples = 0;
    for (const seed of [1, 2, 3]) {
      const w = new World({
        seed,
        tank: REEF_TANK,
        species: ARCHETYPES,
        fish: spawnMany('blue-tang', 1),
      });
      const { maxTurnRate: maxTurn, cruiseSpeed } = toSimSpecies(blueTang);
      let lastHardSign = 0;
      for (let t = 0; t < 10_000; t++) {
        w.step();
        if (t < 300) continue;
        const turn = at(w.yawRate, 0);
        if (Math.abs(turn) > 0.3 * maxTurn) {
          const sign = Math.sign(turn);
          if (lastHardSign !== 0 && sign !== lastHardSign) hardFlips++;
          lastHardSign = sign;
        }
        // Speed lags the target, so a fish told to stop at each pane only sinks to a crawl.
        if (at(w.speed, 0) < 0.3 * cruiseSpeed) stalled++;
        samples++;
      }
    }
    expect((hardFlips / samples) * 30).toBeLessThan(0.3);
    expect(stalled / samples).toBeLessThan(0.01);
  });

  it.each([blueTang, yellowTang])(
    'keeps a group of six $id cruising the reef without stalls, flips or tight circling',
    (tang) => {
      const { maxTurnRate: maxTurn, cruiseSpeed } = toSimSpecies(tang);
      const window = Math.round(4 / STEP_DT);
      let hardFlips = 0;
      let stalled = 0;
      let samples = 0;
      const loopRadii: number[] = [];
      let fishSeconds = 0;
      for (const seed of [1, 2, 3, 4]) {
        const w = new World({
          seed,
          tank: REEF_TANK,
          species: ARCHETYPES,
          decor: REEF_DECOR,
          fish: spawnMany(tang.id, 6),
        });
        const lastHardSign = new Int8Array(w.count);
        const yawRing = Array.from({ length: w.count }, () => new Float64Array(window));
        const pathRing = Array.from({ length: w.count }, () => new Float64Array(window));
        const yawSum = new Float64Array(w.count);
        const pathSum = new Float64Array(w.count);
        const tightest = new Float64Array(w.count).fill(Infinity);
        for (let t = 0; t < 6000; t++) {
          w.step();
          for (let i = 0; i < w.count; i++) {
            const turn = at(w.yawRate, i);
            yawSum[i] = at(yawSum, i) + turn * STEP_DT;
            pathSum[i] = at(pathSum, i) + at(w.speed, i) * STEP_DT;
            const yaws = yawRing[i] ?? new Float64Array(window);
            const paths = pathRing[i] ?? new Float64Array(window);
            yaws[t % window] = at(yawSum, i);
            paths[t % window] = at(pathSum, i);
            if (t < 300) continue;
            // A loop is the shortest stretch of the last 4 s over which the fish turned a full
            // circle; its path length over 2π is the loop's radius.
            let radius = Infinity;
            for (let k = 1; k < window; k++) {
              const s = (t - k) % window;
              if (Math.abs(at(yawSum, i) - at(yaws, s)) >= 2 * Math.PI) {
                radius = (at(pathSum, i) - at(paths, s)) / (2 * Math.PI) / at(w.bodyLength, i);
                break;
              }
            }
            if (radius < Infinity) {
              tightest[i] = Math.min(at(tightest, i), radius);
            } else if (at(tightest, i) < Infinity) {
              loopRadii.push(at(tightest, i));
              tightest[i] = Infinity;
            }
            if (Math.abs(turn) > 0.3 * maxTurn) {
              const sign = Math.sign(turn);
              if (lastHardSign[i] !== 0 && sign !== lastHardSign[i]) hardFlips++;
              lastHardSign[i] = sign;
            }
            const state = at(w.state, i);
            const slow =
              state === FishState.Graze || state === FishState.Startle || state === FishState.Rest;
            if (slow) continue;
            // Speed lags the target, so a fish told to stop at each pane only sinks to a crawl.
            if (at(w.speed, i) < 0.3 * cruiseSpeed) stalled++;
            samples++;
          }
        }
        for (const r of tightest) if (r < Infinity) loopRadii.push(r);
        fishSeconds += w.count * (6000 - 300) * STEP_DT;
      }
      expect(stalled / samples).toBeLessThan(0.01);
      // A cruising fish turns on an arc of at least ~0.4 body lengths (Domenici & Blake 1997);
      // tighter loops are a fish chasing its own tail.
      expect(loopRadii.filter((r) => r < 0.35)).toEqual([]);
      // Six 15–20 cm fish in 60 cm of depth are sometimes boxed in by glass, rock and each other and
      // turn back twice within 4 s, or round a rock; that stays rare: under 2 per 10 fish-minutes.
      expect((loopRadii.length / fishSeconds) * 600).toBeLessThan(2);
      // Loose bound: neighbours and rock legitimately make tangs change their mind now and then.
      expect((hardFlips / samples) * 30).toBeLessThan(1);
    },
  );

  it('scales speed limits with an individual body length', () => {
    const w = new World({
      seed: 1,
      tank: REEF_TANK,
      species: [neonTetra],
      fish: [{ id: 'fry', species: 'neon-tetra', bodyLengthM: 0.0175 }],
    });
    const sp = toSimSpecies(neonTetra);
    for (let t = 0; t < 2000; t++) {
      w.step();
      expect(at(w.speed, 0)).toBeLessThanOrEqual(sp.maxSpeed / 2 + 1e-12);
    }
    expect(at(w.radius, 0)).toBeCloseTo(0.0175 * STEERING.collisionRadiusBodyLengths, 12);
  });
});

describe('World schooling', { timeout: LONG }, () => {
  it('holds tetra shoals within literature bands for spacing and local alignment', () => {
    const w = new World(benchmarkConfig(1));
    const tetras: number[] = [];
    for (let i = 0; i < w.count; i++) if (w.speciesOf(i).id === 'neon-tetra') tetras.push(i);
    const k = toSimSpecies(neonTetra).neighbours;
    let nnd = 0;
    let localPol = 0;
    let isolated = 0;
    let samples = 0;
    let clusters = 0;
    let largestShare = 0;
    let snapshots = 0;
    for (let t = 0; t < 6000; t++) {
      w.step();
      if (t < 600 || t % 15 !== 0) continue;
      const linked = shoalClusters(w, tetras, 4 * toSimSpecies(neonTetra).bodyLength);
      clusters += linked.length;
      largestShare += Math.max(...linked) / tetras.length;
      snapshots++;
      for (const i of tetras) {
        const byDistance = tetras
          .filter((j) => j !== i)
          .map((j) => ({
            j,
            d: Math.hypot(
              at(w.position, i * 3) - at(w.position, j * 3),
              at(w.position, i * 3 + 1) - at(w.position, j * 3 + 1),
              at(w.position, i * 3 + 2) - at(w.position, j * 3 + 2),
            ),
          }))
          .sort((a, b) => a.d - b.d)
          .slice(0, k);
        const bl = at(w.bodyLength, i);
        const nearestBl = (byDistance[0]?.d ?? Infinity) / bl;
        nnd += nearestBl;
        if (nearestBl > 4) isolated++;
        let hx = Math.sin(at(w.yaw, i));
        let hz = Math.cos(at(w.yaw, i));
        for (const { j } of byDistance) {
          hx += Math.sin(at(w.yaw, j));
          hz += Math.cos(at(w.yaw, j));
        }
        localPol += Math.hypot(hx, hz) / (byDistance.length + 1);
        samples++;
      }
    }
    // Pitcher & Partridge 1979: nearest neighbour ≈ 1 body length in cruising schools.
    expect(nnd / samples).toBeGreaterThan(0.5);
    expect(nnd / samples).toBeLessThan(2);
    expect(localPol / samples).toBeGreaterThan(0.7);
    expect(isolated / samples).toBeLessThan(0.05);
    expect(clusters / snapshots).toBeLessThanOrEqual(3);
    expect(largestShare / snapshots).toBeGreaterThanOrEqual(0.5);
  });
});

describe('World depth band', { timeout: LONG }, () => {
  it('keeps each species mostly inside its preferred band', () => {
    const w = new World(benchmarkConfig(4));
    const inside = new Float64Array(w.species.length);
    const total = new Float64Array(w.species.length);
    for (let t = 0; t < 6000; t++) {
      w.step();
      if (t < 600) continue;
      for (let i = 0; i < w.count; i++) {
        const sp = w.speciesOf(i);
        const s = at(w.speciesIndex, i);
        const y = at(w.position, i * 3 + 1) / w.tank.height;
        total[s] = at(total, s) + 1;
        if (y >= sp.depthLow - 0.05 && y <= sp.depthHigh + 0.05) inside[s] = at(inside, s) + 1;
      }
    }
    w.species.forEach((sp, s) => {
      if (at(total, s) === 0) return;
      expect(at(inside, s) / at(total, s), sp.id).toBeGreaterThan(0.85);
    });
  });
});

describe('World snapshot', () => {
  it('writes position, unit quaternion, speed, yaw rate and state per fish', () => {
    const w = run(benchmarkConfig(1), 30);
    const out = new Float32Array(w.count * SNAPSHOT_STRIDE);
    w.writeSnapshot(out);
    for (let i = 0; i < w.count; i++) {
      const o = i * SNAPSHOT_STRIDE;
      expect(at(out, o)).toBeCloseTo(at(w.position, i * 3), 5);
      expect(at(out, o + 1)).toBeCloseTo(at(w.position, i * 3 + 1), 5);
      expect(Math.hypot(...out.subarray(o + 3, o + 7))).toBeCloseTo(1, 5);
      expect(at(out, o + 7)).toBeCloseTo(at(w.speed, i), 5);
      expect(at(out, o + 8)).toBeCloseTo(at(w.yawRate, i), 5);
      expect(at(out, o + 9)).toBe(at(w.state, i));
    }
  });

  it('refuses a buffer that is too small', () => {
    const w = new World(benchmarkConfig(1));
    expect(() => w.writeSnapshot(new Float32Array(5))).toThrow(
      new RegExp(`needs ${60 * SNAPSHOT_STRIDE}`),
    );
  });
});

describe('World config validation', () => {
  const base = { seed: 1, tank: REEF_TANK, species: [neonTetra] };

  it('rejects unknown species, duplicate ids and fish that do not fit', () => {
    expect(() => new World({ ...base, fish: [{ id: 'a', species: 'nemo' }] })).toThrow(
      /unknown species "nemo"/,
    );
    expect(
      () =>
        new World({
          ...base,
          fish: [
            { id: 'a', species: 'neon-tetra' },
            { id: 'a', species: 'neon-tetra' },
          ],
        }),
    ).toThrow(/unique/);
    expect(
      () => new World({ ...base, fish: [{ id: 'a', species: 'neon-tetra', bodyLengthM: 2 }] }),
    ).toThrow(/does not fit/);
    expect(
      () => new World({ ...base, fish: [{ id: 'a', species: 'neon-tetra', bodyLengthM: 0 }] }),
    ).toThrow(/positive/);
  });

  it('handles an empty tank', () => {
    const w = new World({ ...base, fish: [] });
    w.step();
    expect(w.count).toBe(0);
  });
});
