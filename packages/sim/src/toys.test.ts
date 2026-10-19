import { describe, expect, it } from 'vitest';
import { ARCHETYPES, benchmarkConfig, betta, REEF_TANK, SHOW_TANK, spawnMany } from './fixtures.ts';
import { SNAPSHOT_STRIDE, SnapshotField } from './snapshot.ts';
import { BallPhase, MirrorPhase, TOYS, type SimToy, type ToyNudge } from './toys.ts';
import { STEP_HZ, World, type FishSpawn } from './world.ts';

const LONG = 300_000;
const BACK = -SHOW_TANK.depth / 2 + 0.004;
const MIRROR: SimToy = { kind: 'mirror', position: [0, 0.38, BACK], normal: [0, 0, 1] };
const BALL_Y = SHOW_TANK.height + 0.012;

function at(a: ArrayLike<number>, i: number): number {
  const v = a[i];
  if (v === undefined) throw new RangeError(`index ${i} out of range`);
  return v;
}

function seconds(s: number): number {
  return Math.round(s * STEP_HZ);
}

function show(fish: FishSpawn[], seed: number): World {
  return new World({ seed, tank: SHOW_TANK, species: ARCHETYPES, decor: [], fish });
}

/** A lone betta facing the back glass, a mirror's width in front of it. */
function bettaAtMirror(seed = 2): World {
  const w = show([], seed);
  w.addFish({ id: 'betta-0', species: 'betta' }, { position: [0, 0.38, -0.08], heading: Math.PI });
  w.setToys([MIRROR]);
  return w;
}

function snapshotField(w: World, i: number, field: number): number {
  const data = new Float32Array(w.count * SNAPSHOT_STRIDE);
  w.writeSnapshot(data);
  return at(data, i * SNAPSHOT_STRIDE + field);
}

function worstClearance(w: World): number {
  let worst = Infinity;
  for (let i = 0; i < w.count; i++) worst = Math.min(worst, w.bodyClearance(i));
  return worst;
}

/** Runs until fish 0 is displaying at the mirror, or throws after `limitS`. */
function untilDisplaying(w: World, limitS = 180): number {
  for (let t = 0; t < seconds(limitS); t++) {
    w.step();
    const phase = at(w.behaviour.toys.mirrorPhase, 0);
    if (phase === MirrorPhase.Frontal || phase === MirrorPhase.Lateral) return t;
  }
  throw new Error(`no display within ${limitS} s`);
}

/** A ball on the surface, drifting under the nudges it gets and bouncing off the glass. */
class FloatingBall {
  x: number;
  z: number;
  vx = 0;
  vz = 0;
  readonly nudges: ToyNudge[] = [];

  constructor(x: number, z: number) {
    this.x = x;
    this.z = z;
  }

  toy(): SimToy {
    return { kind: 'ball', position: [this.x, BALL_Y, this.z], velocity: [this.vx, 0, this.vz] };
  }

  apply(nudges: readonly ToyNudge[]): void {
    for (const n of nudges) {
      this.nudges.push(n);
      this.vx += n.ix;
      this.vz += n.iz;
    }
    const halfW = SHOW_TANK.width / 2 - 0.02;
    const halfD = SHOW_TANK.depth / 2 - 0.02;
    this.x += this.vx / STEP_HZ;
    this.z += this.vz / STEP_HZ;
    const damp = Math.exp(-1 / STEP_HZ / 3);
    this.vx *= damp;
    this.vz *= damp;
    if (Math.abs(this.x) > halfW) this.vx = -this.vx;
    if (Math.abs(this.z) > halfD) this.vz = -this.vz;
    this.x = Math.max(-halfW, Math.min(halfW, this.x));
    this.z = Math.max(-halfD, Math.min(halfD, this.z));
  }
}

describe('mirror', { timeout: LONG }, () => {
  it('draws a betta into a display stand-off a few centimetres off the glass', () => {
    const w = bettaAtMirror();
    const first = untilDisplaying(w);
    expect(first).toBeGreaterThanOrEqual(seconds(TOYS.mirrorLatencyMinS));
    const seen = new Set<number>();
    let maxDisplay = 0;
    let maxGill = 0;
    let nearest = Infinity;
    let gapSum = 0;
    let gapN = 0;
    let worst = Infinity;
    for (let t = 0; t < seconds(120); t++) {
      w.step();
      const phase = at(w.behaviour.toys.mirrorPhase, 0);
      seen.add(phase);
      maxDisplay = Math.max(maxDisplay, snapshotField(w, 0, SnapshotField.Display));
      maxGill = Math.max(maxGill, snapshotField(w, 0, SnapshotField.GillFlare));
      worst = Math.min(worst, worstClearance(w));
      if (phase === MirrorPhase.Frontal || phase === MirrorPhase.Lateral) {
        const gap = at(w.position, 2) - BACK;
        nearest = Math.min(nearest, gap);
        gapSum += gap;
        gapN++;
      }
    }
    expect(seen.has(MirrorPhase.Frontal)).toBe(true);
    expect(seen.has(MirrorPhase.Lateral)).toBe(true);
    expect(maxDisplay).toBeGreaterThan(0.6);
    expect(maxGill).toBeGreaterThan(0.6);
    const length = betta.locomotion.bodyLengthM;
    expect(nearest).toBeGreaterThan(0.2 * length);
    // Everett et al. 2025: the head held about 2.5 cm from the image.
    expect(gapSum / gapN).toBeGreaterThan(0.5 * length);
    expect(gapSum / gapN).toBeLessThan(1.2 * length);
    expect(worst).toBeGreaterThanOrEqual(-1e-9);
  });

  it('turns face-on to flare its gill covers and side-on to spread its fins', () => {
    const w = bettaAtMirror();
    untilDisplaying(w);
    let frontalCos = 0;
    let frontalN = 0;
    let lateralCos = 0;
    let lateralN = 0;
    for (let t = 0; t < seconds(90); t++) {
      w.step();
      const phase = at(w.behaviour.toys.mirrorPhase, 0);
      // Heading against the mirror's normal: -1 facing the glass, 0 side-on.
      const cos = Math.cos(at(w.yaw, 0));
      if (phase === MirrorPhase.Frontal) {
        frontalCos += cos;
        frontalN++;
      } else if (phase === MirrorPhase.Lateral) {
        lateralCos += Math.abs(cos);
        lateralN++;
      }
    }
    expect(frontalN).toBeGreaterThan(0);
    expect(lateralN).toBeGreaterThan(0);
    expect(frontalCos / frontalN).toBeLessThan(-0.7);
    expect(lateralCos / lateralN).toBeLessThan(0.5);
  });

  it('habituates and leaves, then comes back once the habituation has worn off', () => {
    const w = bettaAtMirror();
    untilDisplaying(w);
    let leftAt = -1;
    for (let t = 0; t < seconds(TOYS.mirrorAttentionS * 2); t++) {
      w.step();
      if (at(w.behaviour.toys.mirrorPhase, 0) === MirrorPhase.Idle) {
        leftAt = t;
        break;
      }
    }
    expect(leftAt).toBeGreaterThan(seconds(TOYS.mirrorAttentionS / 2));
    expect(at(w.behaviour.toys.mirrorHabituation, 0)).toBeGreaterThanOrEqual(1);
    for (let t = 0; t < seconds(5); t++) w.step();
    expect(snapshotField(w, 0, SnapshotField.Display)).toBeLessThan(0.05);

    let back = -1;
    for (let t = 0; t < seconds(3600); t++) {
      w.step();
      if (at(w.behaviour.toys.mirrorPhase, 0) !== MirrorPhase.Idle) {
        back = t;
        break;
      }
    }
    // Not before habituation decayed to the recovery level, but well inside an hour.
    const recover = TOYS.mirrorRecoverTauS * Math.log(1 / TOYS.mirrorRecoverLevel);
    expect(back).toBeGreaterThan(seconds(recover * 0.9));
    expect(worstClearance(w)).toBeGreaterThanOrEqual(-1e-9);
  });

  it('stops at once when the mirror is taken away mid-display, and the flare fades', () => {
    const w = bettaAtMirror();
    untilDisplaying(w);
    for (let t = 0; t < seconds(3); t++) w.step();
    const h = at(w.behaviour.toys.mirrorHabituation, 0);
    w.setToys([]);
    expect(at(w.behaviour.toys.mirrorPhase, 0)).toBe(MirrorPhase.Idle);
    expect(at(w.behaviour.toys.mirrorHabituation, 0)).toBe(h);
    for (let t = 0; t < seconds(3); t++) w.step();
    expect(at(w.behaviour.toys.mirrorPhase, 0)).toBe(MirrorPhase.Idle);
    expect(snapshotField(w, 0, SnapshotField.Display)).toBeLessThan(0.01);
    expect(snapshotField(w, 0, SnapshotField.GillFlare)).toBeLessThan(0.01);
  });

  it('stops when the mirror is moved, but not when the same mirror is resent', () => {
    const w = bettaAtMirror();
    untilDisplaying(w);
    w.setToys([MIRROR]);
    expect(at(w.behaviour.toys.mirrorPhase, 0)).not.toBe(MirrorPhase.Idle);
    w.setToys([{ kind: 'mirror', position: [0.3, 0.38, BACK], normal: [0, 0, 1] }]);
    expect(at(w.behaviour.toys.mirrorPhase, 0)).toBe(MirrorPhase.Idle);
  });

  it('lets a betta tired of its reflection ignore it without drawing on the RNG', () => {
    const watching = bettaAtMirror();
    const cleared = bettaAtMirror();
    let left = false;
    for (let t = 0; t < seconds(TOYS.mirrorAttentionS * 2) && !left; t++) {
      watching.step();
      cleared.step();
      left = at(watching.behaviour.toys.mirrorHabituation, 0) >= 1;
    }
    expect(left).toBe(true);
    expect(at(watching.behaviour.toys.mirrorPhase, 0)).toBe(MirrorPhase.Idle);
    cleared.setToys([]);
    // Still above the recovery level throughout: the mirror in view must change nothing.
    for (let t = 0; t < seconds(600); t++) {
      watching.step();
      cleared.step();
    }
    expect(at(watching.behaviour.toys.mirrorHabituation, 0)).toBeGreaterThan(
      TOYS.mirrorRecoverLevel,
    );
    expect(Array.from(watching.position)).toEqual(Array.from(cleared.position));
  });

  it('keeps a betta at a mirror with an id when the toy list is reordered', () => {
    const w = bettaAtMirror();
    const named: SimToy = { ...MIRROR, id: 'mirror' };
    const ball: SimToy = {
      kind: 'ball',
      id: 'ball',
      position: [0.4, BALL_Y, 0],
      velocity: [0, 0, 0],
    };
    w.setToys([named, ball]);
    untilDisplaying(w);
    w.setToys([ball, named]);
    expect(at(w.behaviour.toys.mirrorPhase, 0)).not.toBe(MirrorPhase.Idle);
    for (let t = 0; t < seconds(2); t++) w.step();
    expect(at(w.behaviour.toys.mirrorPhase, 0)).not.toBe(MirrorPhase.Idle);
    w.setToys([ball, { ...MIRROR, id: 'other' }]);
    expect(at(w.behaviour.toys.mirrorPhase, 0)).toBe(MirrorPhase.Idle);
  });

  it('leaves fish that do not display to rivals alone, without drawing on the RNG', () => {
    const fish = [...spawnMany('angelfish', 3), ...spawnMany('neon-tetra', 6)];
    const plain = show(fish, 7);
    const mirrored = show(fish, 7);
    mirrored.setToys([MIRROR]);
    for (let t = 0; t < seconds(120); t++) {
      plain.step();
      mirrored.step();
    }
    expect(Array.from(mirrored.behaviour.toys.mirrorPhase).every((p) => p === 0)).toBe(true);
    expect(Array.from(mirrored.behaviour.display).every((d) => d === 0)).toBe(true);
    expect(Array.from(mirrored.position)).toEqual(Array.from(plain.position));
  });
});

describe('ball', { timeout: LONG }, () => {
  it('is bumped by bold fish, whose nudges are finite and name the fish and ball', () => {
    const w = show(
      [...spawnMany('angelfish', 3), ...spawnMany('betta', 1), ...spawnMany('neon-tetra', 8)],
      2,
    );
    const ball = new FloatingBall(0.1, 0);
    let nearestNeon = Infinity;
    let worst = Infinity;
    for (let t = 0; t < seconds(600); t++) {
      w.setToys([MIRROR, ball.toy()]);
      w.step();
      ball.apply(w.takeToyNudges());
      worst = Math.min(worst, worstClearance(w));
      for (let i = 0; i < w.count; i++) {
        if (!(w.fishIds[i] ?? '').startsWith('neon')) continue;
        nearestNeon = Math.min(
          nearestNeon,
          Math.hypot(
            at(w.position, i * 3) - ball.x,
            at(w.position, i * 3 + 1) - BALL_Y,
            at(w.position, i * 3 + 2) - ball.z,
          ),
        );
      }
    }
    expect(ball.nudges.length).toBeGreaterThan(0);
    for (const n of ball.nudges) {
      expect(n.toy).toBe(1);
      expect(n.toyId).toBeNull();
      expect(n.fishId.startsWith('angelfish') || n.fishId === 'betta-0').toBe(true);
      expect(Number.isFinite(n.ix) && Number.isFinite(n.iz)).toBe(true);
      expect(Math.hypot(n.ix, n.iz)).toBeGreaterThan(0);
      expect(Math.hypot(n.ix, n.iz)).toBeLessThan(0.35);
    }
    expect(nearestNeon).toBeGreaterThan(0.1);
    expect(worst).toBeGreaterThanOrEqual(-1e-9);
  });

  it('is ignored where no fish can reach it', () => {
    const w = show(spawnMany('angelfish', 3), 2);
    const out: SimToy[] = [
      { kind: 'ball', position: [0, SHOW_TANK.height + 0.05, 0], velocity: [0, 0, 0] },
      { kind: 'ball', position: [SHOW_TANK.width, BALL_Y, 0], velocity: [0, 0, 0] },
    ];
    w.setToys(out);
    for (let t = 0; t < seconds(300); t++) {
      w.step();
      expect(w.takeToyNudges()).toEqual([]);
      expect(Array.from(w.behaviour.toys.ballPhase).every((p) => p === BallPhase.Idle)).toBe(true);
    }
  });

  it('names the ball in each nudge by id, whatever its place in the list', () => {
    const w = show(spawnMany('angelfish', 3), 2);
    const ball = new FloatingBall(0, 0);
    const decoy: SimToy = {
      kind: 'ball',
      id: 'decoy',
      position: [9, BALL_Y, 0],
      velocity: [0, 0, 0],
    };
    let playing = -1;
    let t = 0;
    for (; t < seconds(600) && playing < 0; t++) {
      w.setToys([{ ...ball.toy(), id: 'ping' }, decoy]);
      w.step();
      ball.apply(w.takeToyNudges());
      playing = Array.from(w.behaviour.toys.ballPhase).findIndex((p) => p !== BallPhase.Idle);
    }
    expect(playing).toBeGreaterThanOrEqual(0);
    const nudges: ToyNudge[] = [];
    for (; t < seconds(900); t++) {
      const toys: SimToy[] = [{ ...ball.toy(), id: 'ping' }, decoy];
      // Swapped every other step: the ball a fish is playing with must stay the same one.
      if (t % 2 === 0) toys.reverse();
      w.setToys(toys);
      w.step();
      const taken = w.takeToyNudges();
      for (const n of taken) {
        expect(n.toyId).toBe('ping');
        expect(n.toy).toBe(t % 2 === 0 ? 1 : 0);
      }
      nudges.push(...taken);
      ball.apply(taken);
    }
    expect(nudges.length).toBeGreaterThan(0);
  });

  it('ends a fish’s play when its ball is taken away', () => {
    const w = show(spawnMany('angelfish', 3), 2);
    const ball = new FloatingBall(0, 0);
    let playing = -1;
    for (let t = 0; t < seconds(600) && playing < 0; t++) {
      w.setToys([ball.toy()]);
      w.step();
      ball.apply(w.takeToyNudges());
      playing = Array.from(w.behaviour.toys.ballPhase).findIndex((p) => p !== BallPhase.Idle);
    }
    expect(playing).toBeGreaterThanOrEqual(0);
    w.setToys([]);
    expect(at(w.behaviour.toys.ballPhase, playing)).toBe(BallPhase.Idle);
    for (let t = 0; t < seconds(10); t++) {
      w.step();
      expect(w.takeToyNudges()).toEqual([]);
    }
  });
});

describe('toys', { timeout: LONG }, () => {
  function run(seed: number): { positions: number[]; nudges: ToyNudge[] } {
    const w = new World(benchmarkConfig(seed));
    const ball = { x: 0, z: 0 };
    const nudges: ToyNudge[] = [];
    const back = -REEF_TANK.depth / 2 + 0.004;
    for (let t = 0; t < seconds(120); t++) {
      w.setToys([
        { kind: 'mirror', position: [0.2, 0.45, back], normal: [0, 0, 1] },
        { kind: 'ball', position: [ball.x, REEF_TANK.height + 0.012, ball.z], velocity: [0, 0, 0] },
      ]);
      w.step();
      for (const n of w.takeToyNudges()) {
        nudges.push(n);
        ball.x += n.ix;
        ball.z += n.iz;
      }
    }
    return { positions: Array.from(w.position), nudges };
  }

  it('are deterministic: the same seed and toys give the same trajectories and nudges', () => {
    expect(run(11)).toEqual(run(11));
  });

  it('keep sixty fish out of the glass and decor over 10 000 steps', () => {
    const w = new World(benchmarkConfig(3));
    const back = -REEF_TANK.depth / 2 + 0.004;
    const ball = { x: -0.3, z: 0.1 };
    let worst = Infinity;
    for (let t = 0; t < 10_000; t++) {
      w.setToys([
        { kind: 'mirror', position: [0.5, 0.4, back], normal: [0, 0, 1] },
        { kind: 'ball', position: [ball.x, REEF_TANK.height + 0.012, ball.z], velocity: [0, 0, 0] },
      ]);
      w.step();
      for (const n of w.takeToyNudges()) {
        ball.x = Math.max(-0.85, Math.min(0.85, ball.x + n.ix));
        ball.z = Math.max(-0.25, Math.min(0.25, ball.z + n.iz));
      }
      worst = Math.min(worst, worstClearance(w));
    }
    expect(worst).toBeGreaterThanOrEqual(-1e-9);
    for (const v of w.position) expect(Number.isFinite(v)).toBe(true);
  });

  it('survive fish joining and leaving while one is displaying', () => {
    const w = bettaAtMirror();
    untilDisplaying(w);
    w.addFish({ id: 'angel', species: 'angelfish' }, { position: [0.3, 0.25, 0], heading: 0 });
    expect(at(w.behaviour.toys.mirrorPhase, 0)).not.toBe(MirrorPhase.Idle);
    expect(at(w.behaviour.toys.mirrorPhase, 1)).toBe(MirrorPhase.Idle);
    for (let t = 0; t < seconds(5); t++) w.step();
    w.removeFish('betta-0');
    expect(w.behaviour.toys.mirrorPhase.length).toBe(1);
    expect(at(w.behaviour.display, 0)).toBe(0);
    for (let t = 0; t < seconds(5); t++) w.step();
    expect(worstClearance(w)).toBeGreaterThanOrEqual(-1e-9);
  });

  it('reject malformed toys as a whole, keeping the previous ones', () => {
    const w = bettaAtMirror();
    untilDisplaying(w);
    const bad: unknown[] = [
      [{ kind: 'kite', position: [0, 0, 0] }],
      [{ kind: 'mirror', position: [0, Number.NaN, 0], normal: [0, 0, 1] }],
      [{ kind: 'mirror', position: [0, 0.3, BACK], normal: [0, 0, 0] }],
      [{ kind: 'mirror', position: [0, 0.3, BACK], normal: [0, 1, 0] }],
      [{ kind: 'ball', position: [0, BALL_Y, 0], velocity: [0, 0] }],
      Array.from({ length: 9 }, () => MIRROR),
      'mirror',
      [null],
      [{ ...MIRROR, id: '' }],
      [
        { ...MIRROR, id: 'same' },
        { kind: 'ball', id: 'same', position: [0, BALL_Y, 0], velocity: [0, 0, 0] },
      ],
    ];
    for (const toys of bad) {
      expect(() => w.setToys(toys as SimToy[])).toThrow(/^toys: /);
      expect(w.behaviour.toys.count).toBe(1);
      expect(at(w.behaviour.toys.mirrorPhase, 0)).not.toBe(MirrorPhase.Idle);
    }
  });

  it('report a fish’s position by id, and false for a fish not in the tank', () => {
    const w = bettaAtMirror();
    for (let t = 0; t < 10; t++) w.step();
    const out = [9, 9, 9];
    expect(w.fishPosition('betta-0', out)).toBe(true);
    expect(out).toEqual(Array.from(w.position.subarray(0, 3)));
    const untouched = [9, 9, 9];
    expect(w.fishPosition('nobody', untouched)).toBe(false);
    expect(untouched).toEqual([9, 9, 9]);
  });
});
