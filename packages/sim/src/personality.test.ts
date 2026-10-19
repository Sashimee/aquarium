import { NEUTRAL_PERSONALITY, type Personality } from '@aquarium/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createSimHost, SimClient, type SimHost } from './bridge.ts';
import {
  ARCHETYPES,
  FoodRain,
  REEF_ANCHORS,
  REEF_DECOR,
  REEF_TANK,
  SHOW_TANK,
  spawnMany,
} from './fixtures.ts';
import { PERSONALITY, Personalities } from './personality.ts';
import { SNAPSHOT_STRIDE, type Snapshot } from './snapshot.ts';
import { BallPhase, TOYS } from './toys.ts';
import { STEP_HZ, World, type FishSpawn, type WorldConfig } from './world.ts';

const LONG = 120_000;

const BOLD: Personality = { boldness: 1, greed: 0.5, sociability: 0.5 };
const SHY: Personality = { boldness: 0, greed: 0.5, sociability: 0.5 };

function at(a: ArrayLike<number>, i: number): number {
  const v = a[i];
  if (v === undefined) throw new RangeError(`index ${i} out of range`);
  return v;
}

function seconds(s: number): number {
  return Math.round(s * STEP_HZ);
}

function withPersonality(fish: FishSpawn[], p: Personality | undefined): FishSpawn[] {
  return fish.map((f) => (p === undefined ? f : { ...f, personality: p }));
}

/** A mixed reef community fed twice, tapped twice, shown a lure, then put to bed. */
function community(seed: number, p?: Personality): WorldConfig {
  return {
    seed,
    tank: REEF_TANK,
    species: ARCHETYPES,
    decor: REEF_DECOR,
    anchors: REEF_ANCHORS,
    fish: withPersonality(
      [
        ...spawnMany('neon-tetra', 8),
        ...spawnMany('bronze-corydoras', 3),
        ...spawnMany('angelfish', 1),
        ...spawnMany('blue-tang', 1),
        ...spawnMany('ocellaris-clownfish', 2),
        ...spawnMany('royal-gramma', 1),
        ...spawnMany('betta', 1),
      ],
      p,
    ),
  };
}

/** FNV-1a over poses, speeds and states every 50 steps, and the RNG at the end. */
function trajectoryHash(w: World, steps: number, onStep?: (t: number) => void): number {
  const rain = new FoodRain(REEF_TANK);
  const front = w.basin.maxZ;
  let h = 0x811c9dc5;
  const mix = (a: Float64Array | Uint8Array | Uint32Array): void => {
    for (const b of new Uint8Array(a.buffer, a.byteOffset, a.byteLength)) {
      h = Math.imul(h ^ b, 0x01000193);
    }
  };
  for (let t = 0; t < steps; t++) {
    onStep?.(t);
    if (t === 60) rain.sprinkle('flakes', 30, 0.1, 0, 0.3);
    if (t === 400) rain.sprinkle('pellets', 15, -0.3, 0.1, 0.2);
    if (t === 700 || t === 1500) w.startle({ position: [0, 0.3, front], intensity: 1 });
    if (t === 1000) w.setLure([0.2, 0.25, front]);
    if (t === 1300) w.setLure(null);
    if (t === 2000) w.setLight(0);
    rain.feed(w);
    w.step();
    rain.eat(w.takeAteEvents());
    if (t % 50 === 0) {
      mix(w.position);
      mix(w.yaw);
      mix(w.speed);
      mix(w.state);
    }
  }
  const s = w.rng.state();
  mix(new Uint32Array([s.a, s.b, s.c, s.d]));
  return h >>> 0;
}

describe('neutral personalities', { timeout: LONG }, () => {
  it('put factors of exactly 1 on every behaviour and keep the species boldness', () => {
    const p = new Personalities(1);
    for (const species of [0, 0.2, 0.3, 0.5, 0.8, 1]) {
      expect(p.effectiveBoldness(0, species)).toBe(species);
    }
    for (const factor of [
      p.shelter(0),
      p.activity(0),
      p.cohesion(0),
      p.alignment(0),
      p.appetite(0),
      p.satiation(0),
      p.competition(0),
    ]) {
      expect(factor).toBe(1);
    }
  });

  it('leave the trajectory bit for bit as it is without personalities', () => {
    for (const seed of [5, 17]) {
      const none = trajectoryHash(new World(community(seed)), 2400);
      const spawned = trajectoryHash(new World(community(seed, NEUTRAL_PERSONALITY)), 2400);
      const set = new World(community(seed, BOLD));
      const reset = trajectoryHash(set, 2400, (t) => {
        if (t === 0) for (const id of set.fishIds) set.setPersonality(id, NEUTRAL_PERSONALITY);
      });
      expect(spawned).toBe(none);
      expect(reset).toBe(none);
    }
  });

  it('changes the trajectory once traits move off neutral', () => {
    const none = trajectoryHash(new World(community(5)), 2400);
    expect(trajectoryHash(new World(community(5, BOLD)), 2400)).not.toBe(none);
  });
});

describe('boldness', { timeout: LONG }, () => {
  /** How many of `trials` lone fish, each in a tank of its own, C-start at a tap 10 cm away. */
  function startled(p: Personality, trials: number): number {
    let count = 0;
    for (let seed = 1; seed <= trials; seed++) {
      const w = new World({
        seed,
        tank: SHOW_TANK,
        species: ARCHETYPES,
        decor: [],
        fish: withPersonality(spawnMany('angelfish', 1), p),
      });
      for (let t = 0; t < seconds(1); t++) w.step();
      w.startle({
        position: [at(w.position, 0), at(w.position, 1), at(w.position, 2) + 0.1],
        intensity: 1,
      });
      w.step();
      w.step();
      count += w.behaviour.isStartled(0) ? 1 : 0;
    }
    return count;
  }

  it('makes shy fish startle more readily than bold ones', () => {
    // At a tap 10 cm off a lone angelfish responds with p = 0.75 × (1 − 0.5 × boldness): 0.64
    // for the shyest and 0.49 for the boldest, about 128 and 98 of 200; the binomial spread is ~7.
    const shy = startled(SHY, 200);
    const bold = startled(BOLD, 200);
    expect(shy - bold).toBeGreaterThan(12);
    expect(shy).toBeLessThan(160);
    expect(bold).toBeGreaterThan(70);
  });

  it('keeps a shy cave dweller hiding longer after a startle', () => {
    const shelter = (p: Personality): number => {
      const w = new World(community(3, p));
      const g = w.fishIds.indexOf('royal-gramma-0');
      const timer: unknown = Reflect.get(w.behaviour, 'shelterTimer');
      if (!(timer instanceof Float64Array)) throw new Error('no shelterTimer');
      for (let t = 0; t < seconds(3); t++) {
        const o = g * 3;
        w.startle({
          position: [at(w.position, o), at(w.position, o + 1), at(w.position, o + 2) + 0.05],
          intensity: 1,
        });
        w.step();
        if (at(timer, g) > 0) return at(timer, g);
      }
      throw new Error('the gramma never startled');
    };
    const shyS = shelter(SHY);
    const boldS = shelter(BOLD);
    expect(shyS / boldS).toBeCloseTo(
      (1 + PERSONALITY.shelterGain) / (1 - PERSONALITY.shelterGain),
      1,
    );
  });

  it('sets bold fish cruising faster than shy ones', () => {
    const w = new World({
      seed: 2,
      tank: SHOW_TANK,
      species: ARCHETYPES,
      decor: [],
      fish: [
        ...withPersonality(spawnMany('neon-tetra', 1, 'bold'), BOLD),
        ...withPersonality(spawnMany('neon-tetra', 1, 'shy'), SHY),
      ],
    });
    w.step();
    const bold = w.behaviour.plans[0]?.cruiseScale ?? NaN;
    const shy = w.behaviour.plans[1]?.cruiseScale ?? NaN;
    expect(bold / shy).toBeCloseTo(
      (1 + PERSONALITY.activityGain) / (1 - PERSONALITY.activityGain),
      9,
    );
  });

  it('keeps a shy fish of a playful species away from a ball its neutral tankmates play with', () => {
    const ball = {
      kind: 'ball',
      position: [0, SHOW_TANK.height + 0.012, 0],
      velocity: [0, 0, 0],
    } as const;
    const tank = (p: Personality | undefined): World =>
      new World({
        seed: 2,
        tank: SHOW_TANK,
        species: ARCHETYPES,
        decor: [],
        fish: withPersonality(spawnMany('angelfish', 3), p),
      });
    const shy = tank(SHY);
    const neutral = tank(undefined);
    shy.setToys([ball]);
    neutral.setToys([ball]);
    const playing = (w: World): boolean =>
      w.behaviour.toys.ballPhase.some((p) => p !== BallPhase.Idle);
    let shyPlayed = false;
    let neutralPlayed = false;
    for (let t = 0; t < seconds(600) && !neutralPlayed; t++) {
      shy.step();
      neutral.step();
      shyPlayed ||= playing(shy);
      neutralPlayed = playing(neutral);
    }
    const species = ARCHETYPES.find((sp) => sp.id === 'angelfish')?.behaviour.boldness ?? NaN;
    expect(species).toBeGreaterThan(TOYS.shyBoldness);
    expect(species - PERSONALITY.startleBoldnessShift).toBeLessThanOrEqual(TOYS.shyBoldness);
    expect(neutralPlayed).toBe(true);
    expect(shyPlayed).toBe(false);
  });
});

describe('sociability', { timeout: LONG }, () => {
  /** Mean distance of the school from its centre over the last half of a minute. */
  function spread(sociability: number, seed: number): number {
    const w = new World({
      seed,
      tank: SHOW_TANK,
      species: ARCHETYPES,
      decor: [],
      fish: withPersonality(spawnMany('neon-tetra', 12), {
        boldness: 0.5,
        greed: 0.5,
        sociability,
      }),
    });
    let sum = 0;
    let samples = 0;
    for (let t = 0; t < seconds(60); t++) {
      w.step();
      if (t < seconds(30) || t % 15 !== 0) continue;
      const c = [0, 0, 0];
      for (let i = 0; i < w.count; i++) {
        for (let a = 0; a < 3; a++) c[a] = (c[a] ?? 0) + at(w.position, i * 3 + a) / w.count;
      }
      for (let i = 0; i < w.count; i++) {
        sum += Math.hypot(
          at(w.position, i * 3) - (c[0] ?? 0),
          at(w.position, i * 3 + 1) - (c[1] ?? 0),
          at(w.position, i * 3 + 2) - (c[2] ?? 0),
        );
        samples++;
      }
    }
    return sum / samples;
  }

  it('draws sociable fish into a tighter school than unsociable ones', () => {
    let social = 0;
    let loner = 0;
    for (const seed of [1, 2, 3]) {
      social += spread(1, seed);
      loner += spread(0, seed);
    }
    expect(social).toBeLessThan(loner);
  });
});

describe('greed', { timeout: LONG }, () => {
  it('lets greedy fish win more of a scarce meal than fish with little appetite', () => {
    let greedy = 0;
    let modest = 0;
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const w = new World({
        seed,
        tank: SHOW_TANK,
        species: ARCHETYPES,
        decor: [],
        fish: [
          ...withPersonality(spawnMany('neon-tetra', 6, 'greedy'), {
            boldness: 0.5,
            greed: 1,
            sociability: 0.5,
          }),
          ...withPersonality(spawnMany('neon-tetra', 6, 'modest'), {
            boldness: 0.5,
            greed: 0,
            sociability: 0.5,
          }),
        ].map((f) => ({ ...f, hunger: 1 })),
      });
      const rain = new FoodRain(SHOW_TANK);
      for (let t = 0; t < seconds(2); t++) w.step();
      rain.sprinkle('flakes', 8, 0, 0, 0.15);
      for (let t = 0; t < seconds(40); t++) {
        rain.feed(w);
        w.step();
        const events = w.takeAteEvents();
        for (const e of events) {
          if (e.fishId.startsWith('greedy')) greedy += e.portion;
          else modest += e.portion;
        }
        rain.eat(events);
      }
    }
    expect(greedy).toBeGreaterThan(1.5 * modest);
  });

  it('shortens the distance a greedy fish counts from contested food', () => {
    const p = new Personalities(2);
    p.set(0, { boldness: 0.5, greed: 1, sociability: 0.5 });
    p.set(1, { boldness: 0.5, greed: 0, sociability: 0.5 });
    expect(p.competition(0)).toBeCloseTo(1 - PERSONALITY.competitionGain, 12);
    expect(p.competition(1)).toBeCloseTo(1 + PERSONALITY.competitionGain, 12);
    expect(p.appetite(0)).toBeGreaterThan(p.appetite(1));
    expect(p.satiation(0)).toBeLessThan(p.satiation(1));
    expect(p.satiation(0)).toBeGreaterThanOrEqual(0);
  });
});

describe('personality input', () => {
  const tank = (fish: FishSpawn[]): WorldConfig => ({
    seed: 1,
    tank: SHOW_TANK,
    species: ARCHETYPES,
    decor: [],
    fish,
  });

  it('rejects traits outside 0 to 1, missing or unknown ones, at spawn and when set', () => {
    const bad: unknown[] = [
      { boldness: 2, greed: 0.5, sociability: 0.5 },
      { boldness: Number.NaN, greed: 0.5, sociability: 0.5 },
      { boldness: 0.5, greed: 0.5 },
      { boldness: 0.5, greed: 0.5, sociability: 0.5, curiosity: 1 },
      null,
    ];
    const w = new World(tank(spawnMany('angelfish', 1)));
    for (const raw of bad) {
      const spawn = { id: 'a', species: 'angelfish', personality: raw } as FishSpawn;
      expect(() => new World(tank([spawn]))).toThrow(/fish "a": personality/);
      expect(() => w.addFish({ ...spawn, id: 'b' })).toThrow(/fish "b": personality/);
      expect(() => w.setPersonality('angelfish-0', raw as Personality)).toThrow(RangeError);
    }
    expect(w.fishIds).toEqual(['angelfish-0']);
    expect(w.personalityOf('angelfish-0')).toEqual(NEUTRAL_PERSONALITY);
    expect(() => w.setPersonality('nobody', BOLD)).toThrow(/no fish "nobody"/);
  });

  it('keeps each fish its own traits as fish join and leave', () => {
    const traits = (k: number): Personality => ({
      boldness: k / 10,
      greed: 1 - k / 10,
      sociability: (k % 3) / 3,
    });
    const fish = spawnMany('neon-tetra', 5).map((f, k) => ({ ...f, personality: traits(k) }));
    const w = new World(tank(fish));
    w.removeFish('neon-tetra-1');
    w.addFish({ id: 'new', species: 'neon-tetra' });
    w.addFish({ id: 'given', species: 'neon-tetra', personality: BOLD });
    for (const k of [0, 2, 3, 4]) expect(w.personalityOf(`neon-tetra-${k}`)).toEqual(traits(k));
    expect(w.personalityOf('new')).toEqual(NEUTRAL_PERSONALITY);
    expect(w.personalityOf('given')).toEqual(BOLD);
    w.setPersonality('neon-tetra-3', SHY);
    expect(w.personalityOf('neon-tetra-3')).toEqual(SHY);
    expect(w.personalityOf('neon-tetra-4')).toEqual(traits(4));
  });
});

describe('personality through the worker bridge', () => {
  const ports: { host: SimHost; client: SimClient; a: MessagePort; b: MessagePort }[] = [];
  afterEach(() => {
    for (const h of ports.splice(0)) {
      h.client.dispose();
      h.host.dispose();
      h.a.close();
      h.b.close();
    }
  });

  function connect(): SimClient {
    const channel = new MessageChannel();
    const host = createSimHost(channel.port1);
    const client = new SimClient(channel.port2);
    ports.push({ host, client, a: channel.port1, b: channel.port2 });
    return client;
  }

  function snapshotAt(client: SimClient, tick: number): Promise<Snapshot> {
    return new Promise((resolve) => {
      const off = client.onSnapshot((s) => {
        if (s.tick !== tick) return;
        off();
        resolve(s);
      });
    });
  }

  it('applies personality and visitor commands exactly as a local world would', async () => {
    const config = community(4);
    const client = connect();
    await client.init(config);
    const local = new World(config);

    client.setPersonality('neon-tetra-0', BOLD);
    client.setPersonality('angelfish-0', SHY);
    client.setVisitor({ familiarity: 1, at: [0.1, 0.3] });
    const first = snapshotAt(client, 300);
    client.step(300);
    await first;
    client.setVisitor(null);
    const second = snapshotAt(client, 330);
    client.step(30);
    const remote = await second;

    local.setPersonality('neon-tetra-0', BOLD);
    local.setPersonality('angelfish-0', SHY);
    local.setVisitor({ familiarity: 1, at: [0.1, 0.3] });
    for (let t = 0; t < 300; t++) local.step();
    local.setVisitor(null);
    for (let t = 0; t < 30; t++) local.step();
    const expected = new Float32Array(local.count * SNAPSHOT_STRIDE);
    local.writeSnapshot(expected);
    expect(Array.from(remote.data)).toEqual(Array.from(expected));
  });

  it('reports bad personalities and visitors as errors', async () => {
    const client = connect();
    await client.init(community(1));
    const error = (): Promise<string> =>
      new Promise((resolve) => {
        const off = client.onError((m) => {
          off();
          resolve(m);
        });
      });
    const unknown = error();
    client.setPersonality('nobody', BOLD);
    expect(await unknown).toMatch(/no fish "nobody"/);
    const outOfRange = error();
    client.setPersonality('angelfish-0', { boldness: 3, greed: 0, sociability: 0 });
    expect(await outOfRange).toMatch(/personality/);
    const stranger = error();
    client.setVisitor({ familiarity: -1 });
    expect(await stranger).toMatch(/familiarity/);
  });
});
