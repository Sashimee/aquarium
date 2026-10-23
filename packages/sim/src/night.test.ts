import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { speciesContentSchema } from '@aquarium/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { lampIsOn } from '../lifecycle/water.ts';
import { createSimHost, SimClient, type SimHost, type SimHostOptions } from './bridge.ts';
import { cleanupSurfaces, crewCleanup } from './crew.ts';
import {
  ARCHETYPES,
  bronzeCorydoras,
  FoodRain,
  neonTetra,
  SHOW_TANK,
  spawnMany,
  stepTo,
} from './fixtures.ts';
import { NIGHT, Night } from './night.ts';
import { FishState, SnapshotField, SNAPSHOT_STRIDE, type Snapshot } from './snapshot.ts';
import { toSimSpecies, type SpeciesInput } from './species.ts';
import { STEP_HZ, World, type FishSpawn } from './world.ts';

const LONG = 60_000;

function at(a: ArrayLike<number>, i: number): number {
  const v = a[i];
  if (v === undefined) throw new RangeError(`index ${i} out of range`);
  return v;
}

function withActivity(sp: SpeciesInput, id: string, activity: string): SpeciesInput {
  return { ...sp, id, behaviour: { ...sp.behaviour, activity } } as SpeciesInput;
}

const nocturnalForager = withActivity(bronzeCorydoras, 'nocturnal-forager', 'nocturnal');
const nocturnalTetra = withActivity(neonTetra, 'nocturnal-tetra', 'nocturnal');
const SPECIES = [...ARCHETYPES, nocturnalForager, nocturnalTetra];

function tank(fish: FishSpawn[], seed = 1, light?: number): World {
  return new World({
    seed,
    tank: SHOW_TANK,
    species: SPECIES,
    fish,
    ...(light === undefined ? {} : { light }),
  });
}

/** The light the web's hood shows during a ramp: smoothstep, resent each second once it moved 0.005. */
function webRamp(from: number, to: number, rampS: number): (t: number) => number | null {
  let sent = from;
  return (t) => {
    if (t % 1 !== 0) return null;
    const x = Math.min(1, Math.max(0, t / rampS));
    const level = from + (to - from) * x * x * (3 - 2 * x);
    if (Math.abs(level - sent) < 0.005 && level !== to) return null;
    sent = level;
    return level;
  };
}

/** Steps a lone `Night` through a light schedule; returns each non-zero startle and its step. */
function shocks(n: Night, steps: number, light: (step: number) => number | null): number[][] {
  const out: number[][] = [];
  for (let s = 0; s < steps; s++) {
    const level = light(s);
    if (level !== null) n.setLight(level);
    const shock = n.step();
    if (shock > 0) out.push([s, shock]);
  }
  return out;
}

function stepped(n: Night): Night {
  n.step();
  return n;
}

describe('Night light shock', () => {
  it('fires once, at full strength, one step after an abrupt switch', () => {
    for (const [from, to] of [
      [1, 0],
      [0, 1],
    ] as const) {
      const n = new Night();
      n.setLight(from);
      const fired = shocks(n, 300, (s) => (s === 30 ? to : null));
      expect(fired).toEqual([[31, 1]]);
    }
  });

  it('never fires over the hood’s one-hour dawn or dusk ramp', () => {
    for (const [from, to] of [
      [0, 1],
      [1, 0],
    ] as const) {
      const n = stepped(new Night());
      n.setLight(from);
      n.settle();
      const ramp = webRamp(from, to, 3600);
      expect(shocks(n, 3700 * STEP_HZ, (s) => ramp(s / STEP_HZ))).toEqual([]);
      expect(n.light).toBe(to);
    }
  });

  it('never fires over a one-minute ramp sent every step', () => {
    const n = stepped(new Night());
    expect(shocks(n, 90 * STEP_HZ, (s) => Math.max(0, 1 - s / (60 * STEP_HZ)))).toEqual([]);
  });

  it('scales with how abrupt the change is', () => {
    const strength = (rampS: number): number => {
      const n = stepped(new Night());
      const steps = Math.max(1, Math.round(rampS * STEP_HZ));
      const fired = shocks(n, 20 * STEP_HZ, (s) => Math.max(0, 1 - (s + 1) / steps));
      expect(fired.length, `ramp ${rampS} s`).toBeLessThanOrEqual(1);
      return fired[0]?.[1] ?? 0;
    };
    const abrupt = strength(0);
    const half = strength(0.5);
    const two = strength(2);
    const slow = strength(20);
    expect(abrupt).toBe(1);
    expect(half).toBeGreaterThan(two);
    expect(two).toBeGreaterThan(0);
    expect(two).toBeLessThan(abrupt);
    expect(slow).toBe(0);
  });

  it('fires within lightStartleWindowS of arming, while the gap is still growing', () => {
    // A 3 s linear fade outruns the eye (τ = 1 s), so the gap grows until the fade ends; only the
    // window makes the startle fire before then.
    const fadeSteps = 3 * STEP_HZ;
    const fade = (s: number): number => Math.max(0, 1 - (s + 1) / fadeSteps);
    let adapted = 1;
    let armedAt = -1;
    for (let s = 0; armedAt < 0; s++) {
      if (Math.abs(fade(s) - adapted) > NIGHT.lightStartleThreshold) armedAt = s;
      adapted += (fade(s) - adapted) * (1 - Math.exp(-1 / STEP_HZ / NIGHT.lightAdaptTauS));
    }
    const fired = shocks(stepped(new Night()), 2 * fadeSteps, fade);
    expect(fired).toHaveLength(1);
    const firedAt = fired[0]?.[0] ?? Infinity;
    expect(firedAt).toBeGreaterThan(armedAt);
    expect(firedAt).toBeLessThanOrEqual(armedAt + NIGHT.lightStartleWindowS * STEP_HZ + 1);
    expect(firedAt).toBeLessThan(fadeSteps - STEP_HZ);
  });

  it('fires again for a later switch once the eye has adapted', () => {
    const n = stepped(new Night());
    const fired = shocks(n, 600, (s) => (s === 10 ? 0 : s === 300 ? 1 : null));
    expect(fired.map(([s]) => s)).toEqual([11, 301]);
  });

  it('ignores light set before the first step, and light settled while paused', () => {
    const fresh = new Night();
    fresh.setLight(0);
    expect(shocks(fresh, 300, () => null)).toEqual([]);
    const paused = stepped(new Night());
    paused.setLight(0);
    paused.settle();
    expect(shocks(paused, 300, () => null)).toEqual([]);
  });

  it('rejects a light level outside 0..1', () => {
    for (const level of [-0.1, 1.1, Number.NaN]) {
      expect(() => new Night().setLight(level)).toThrow(/light level/);
    }
  });
});

describe('Night rest window', () => {
  it('inverts the rest window for nocturnal species, with the diurnal hysteresis', () => {
    const n = new Night();
    const both = (): [number, number] => [n.restTarget('diurnal'), n.restTarget('nocturnal')];
    expect(both()).toEqual([0, 1]);
    n.setLight(0.3);
    expect(both()).toEqual([0, 1]);
    n.setLight(0.2);
    expect(both()).toEqual([1, 0]);
    n.setLight(0.3);
    expect(both()).toEqual([1, 0]);
    n.setLight(0.4);
    expect(both()).toEqual([0, 1]);
  });

  it('has crepuscular species awake at dawn and dusk and resting more in the dark than by day', () => {
    const n = new Night();
    const rest = (light: number): number => {
      n.setLight(light);
      return n.restTarget('crepuscular');
    };
    expect(rest(0.5)).toBe(0);
    expect(rest(0.1)).toBe(0);
    expect(rest(1)).toBe(NIGHT.crepuscularDayRest);
    expect(rest(0)).toBe(1);
    expect(NIGHT.crepuscularDayRest).toBeGreaterThan(0);
    expect(NIGHT.crepuscularDayRest).toBeLessThan(1);
  });

  it('follows a lamp schedule across midnight: rest flips at on and off, not at 00:00', () => {
    // One step per minute of the tank clock, two days of a 22:00–06:00 lamp.
    const n = stepped(new Night());
    const minute = 60_000;
    const lit = (s: number): number => (lampIsOn((s + 1) * minute, 1 / 60, 22, 6) ? 1 : 0);
    const flips: number[] = [];
    const fired: number[] = [];
    let last = n.restTarget('nocturnal');
    for (let s = 0; s < 2 * 1440; s++) {
      n.setLight(lit(s));
      if (n.step() > 0) fired.push(s % 1440);
      const now = n.restTarget('nocturnal');
      if (now !== last) flips.push(s % 1440);
      last = now;
      if (s % 1440 === 23 * 60) expect(now, 'lamp on at 23:00').toBe(1);
      if (s % 1440 === 0) expect(now, 'lamp still on at 00:00').toBe(1);
      if (s % 1440 === 12 * 60) expect(now, 'lamp off at noon').toBe(0);
    }
    const onOff = [6 * 60, 22 * 60, 6 * 60, 22 * 60];
    expect(flips).toEqual(onOff);
    expect(fired, 'the startle fires the step after the switch').toEqual(onOff.map((m) => m + 1));
  });
});

describe('Night polyp extension', () => {
  it('starts where the darkness puts it and stays retracted under a lamp that never changes', () => {
    expect(new Night().polypExtension).toBe(0);
    const dark = new Night();
    dark.setLight(0);
    expect(dark.polypExtension).toBe(1);
    const n = stepped(new Night());
    for (let s = 0; s < 3000; s++) n.step();
    expect(n.polypExtension).toBe(0);
  });

  it('eases out after lights-off and back in after lights-on, about polypTauS each way', () => {
    const n = stepped(new Night());
    n.setLight(0);
    let previous = n.polypExtension;
    for (let s = 0; s < NIGHT.polypTauS * STEP_HZ; s++) {
      n.step();
      expect(n.polypExtension).toBeGreaterThanOrEqual(previous);
      previous = n.polypExtension;
    }
    expect(previous).toBeCloseTo(1 - Math.exp(-1), 2);
    for (let s = 0; s < 5 * NIGHT.polypTauS * STEP_HZ; s++) n.step();
    expect(n.polypExtension).toBeGreaterThan(0.99);
    n.setLight(0.5);
    for (let s = 0; s < 10 * NIGHT.polypTauS * STEP_HZ; s++) n.step();
    expect(n.polypExtension).toBeCloseTo(0.5, 3);
  });

  it('on settle moves as far as the paused time in the current darkness would have', () => {
    const settled = (pausedS: number): number => {
      const n = stepped(new Night());
      n.setLight(0);
      n.settle(pausedS);
      return n.polypExtension;
    };
    expect(settled(0)).toBe(0);
    expect(settled(1)).toBeCloseTo(1 - Math.exp(-1 / NIGHT.polypTauS), 12);
    expect(settled(NIGHT.polypTauS)).toBeCloseTo(1 - Math.exp(-1), 12);
    expect(settled(Infinity)).toBe(1);
    for (const bad of [-1, Number.NaN]) {
      expect(() => new Night().settle(bad)).toThrow(/paused time/);
    }
  });
});

describe('species activity', () => {
  it('defaults to diurnal and rejects an unknown activity', () => {
    expect(toSimSpecies(neonTetra).activity).toBe('diurnal');
    expect(toSimSpecies(nocturnalTetra).activity).toBe('nocturnal');
    expect(() => toSimSpecies(withActivity(neonTetra, 'x', 'nightly'))).toThrow(
      /behaviour\.activity/,
    );
  });

  it('ships the bristlenose pleco as nocturnal and keeps the Banggai cardinalfish diurnal', () => {
    const load = (id: string): SpeciesInput =>
      speciesContentSchema.parse(
        JSON.parse(
          readFileSync(join(import.meta.dirname, `../../../content/species/${id}.json`), 'utf8'),
        ),
      );
    expect(toSimSpecies(load('bristlenose-pleco')).activity).toBe('nocturnal');
    expect(toSimSpecies(load('banggai-cardinalfish')).activity).toBe('diurnal');
  });
});

describe('nocturnal fish in the world', { timeout: LONG }, () => {
  function meanRest(w: World, ids: readonly number[]): number {
    return ids.reduce((s, i) => s + at(w.behaviour.rest, i), 0) / ids.length;
  }

  it('rest while the lamp is on and wake when it goes off, the inverse of diurnal fish', () => {
    const w = tank([
      ...spawnMany(neonTetra.id, 6, 'day'),
      ...spawnMany(nocturnalTetra.id, 6, 'night'),
    ]);
    const day = [0, 1, 2, 3, 4, 5];
    const night = [6, 7, 8, 9, 10, 11];
    for (let t = 0; t < 180 * STEP_HZ; t++) w.step();
    expect(meanRest(w, day)).toBeLessThan(0.05);
    expect(meanRest(w, night)).toBeGreaterThan(0.95);
    let speedDay = 0;
    let speedNight = 0;
    for (let t = 0; t < 30 * STEP_HZ; t++) {
      w.step();
      for (const i of day) speedDay += at(w.speed, i);
      for (const i of night) speedNight += at(w.speed, i);
    }
    expect(speedNight).toBeLessThan(0.5 * speedDay);
    w.setLight(0);
    for (let t = 0; t < 180 * STEP_HZ; t++) w.step();
    expect(meanRest(w, day)).toBeGreaterThan(0.95);
    expect(meanRest(w, night)).toBeLessThan(0.05);
  });

  it('a nocturnal forager resting by day still comes out for food; a diurnal one at night does not', () => {
    const portions = (species: string, light: number): number => {
      const w = tank([{ id: 'a', species }], 3, light);
      for (let t = 0; t < 120 * STEP_HZ; t++) w.step();
      expect(at(w.behaviour.rest, 0), `${species} rests before the food lands`).toBeGreaterThan(
        0.95,
      );
      const rain = new FoodRain(SHOW_TANK);
      const x = at(w.position, 0);
      const z = at(w.position, 2);
      for (let k = 0; k < 4; k++) rain.place('pellets', x + 0.04 * (k - 1.5), 0.01, z, 0, 0);
      for (let t = 0; t < 60 * STEP_HZ; t++) {
        rain.feed(w);
        w.step();
        rain.eat(w.takeAteEvents());
      }
      return rain.eaten;
    };
    expect(portions(nocturnalForager.id, 1)).toBeGreaterThan(0);
    expect(portions(bronzeCorydoras.id, 0)).toBe(0);
  });
});

describe('lights on/off startle in the world', { timeout: LONG }, () => {
  function startledSince(w: World, tick: number): number {
    let n = 0;
    for (let i = 0; i < w.count; i++) if (at(w.behaviour.startledAt, i) >= tick) n++;
    return n;
  }

  it('an abrupt switch scatters most of a school within a fraction of a second', () => {
    for (const [from, to] of [
      [1, 0],
      [0, 1],
    ] as const) {
      const w = tank(spawnMany(neonTetra.id, 20), 5, from);
      for (let t = 0; t < 30 * STEP_HZ; t++) w.step();
      const switchedAt = w.tick;
      w.setLight(to);
      for (let t = 0; t < 10; t++) w.step();
      expect(startledSince(w, switchedAt), `${from} → ${to}`).toBeGreaterThanOrEqual(10);
      const yaws = [];
      for (let i = 0; i < w.count; i++) {
        if (at(w.behaviour.startledAt, i) >= switchedAt) yaws.push(at(w.yaw, i));
      }
      const meanCos = yaws.reduce((s, y) => s + Math.cos(y), 0) / yaws.length;
      const meanSin = yaws.reduce((s, y) => s + Math.sin(y), 0) / yaws.length;
      expect(Math.hypot(meanCos, meanSin), 'escape headings scatter').toBeLessThan(0.9);
    }
  });

  it('a two-minute ramp startles nobody', () => {
    const w = tank(spawnMany(neonTetra.id, 20), 5);
    for (let t = 0; t < 30 * STEP_HZ; t++) w.step();
    const from = w.tick;
    const ramp = webRamp(1, 0, 120);
    for (let s = 0; s < 150 * STEP_HZ; s++) {
      const level = ramp(s / STEP_HZ);
      if (level !== null) w.setLight(level);
      w.step();
    }
    expect(w.light).toBe(0);
    expect(startledSince(w, from)).toBe(0);
  });

  it('a tank whose light is never set never startles and keeps its polyps in', () => {
    const w = tank([...spawnMany(neonTetra.id, 10), ...spawnMany(nocturnalTetra.id, 3, 'n')], 2);
    for (let t = 0; t < 120 * STEP_HZ; t++) w.step();
    expect(startledSince(w, 0)).toBe(0);
    expect(w.polypExtension).toBe(0);
    expect(at(w.behaviour.rest, 10)).toBeGreaterThan(0.95);
    expect(at(w.behaviour.rest, 0)).toBeLessThan(0.05);
  });

  it('a world built in the dark starts neither startled nor with its polyps in', () => {
    const w = tank(spawnMany(neonTetra.id, 10), 2, 0);
    w.setLight(0);
    expect(w.polypExtension).toBe(1);
    for (let t = 0; t < 10 * STEP_HZ; t++) w.step();
    expect(startledSince(w, 0)).toBe(0);
  });

  it('is deterministic: same seed, same switches, same trajectories and startles', () => {
    const run = (): [number[], number[], number] => {
      const w = tank([...spawnMany(neonTetra.id, 15), ...spawnMany(nocturnalTetra.id, 5, 'n')], 9);
      const ramp = webRamp(0, 1, 5);
      for (let s = 0; s < 40 * STEP_HZ; s++) {
        if (s === 10 * STEP_HZ) w.setLight(0);
        if (s >= 20 * STEP_HZ) {
          const level = ramp((s - 20 * STEP_HZ) / STEP_HZ);
          if (level !== null) w.setLight(level);
        }
        w.step();
      }
      return [Array.from(w.position), Array.from(w.behaviour.startledAt), w.polypExtension];
    };
    const a = run();
    expect(a[1].some((t) => t >= 10 * STEP_HZ)).toBe(true);
    expect(run()).toEqual(a);
  });
});

describe('nocturnal clean-up crew offline', () => {
  const species = new Map([
    [nocturnalForager.id, toSimSpecies(nocturnalForager)],
    [bronzeCorydoras.id, toSimSpecies(bronzeCorydoras)],
  ]);
  const eats = (id: string, litFraction: number): number =>
    crewCleanup({
      crew: [{ id: 'a', species: id, alive: true, hunger: 1 }],
      species,
      algae: 0,
      uneatenFood: 1,
      dtHours: 2,
      litFraction,
      surfaces: cleanupSurfaces({ width: 0.6, depth: 0.3, height: 0.35 }),
    }).foodEaten;

  it('scavenges while the lamp is off and not while it is on', () => {
    expect(eats(nocturnalForager.id, 0)).toBeGreaterThan(0);
    expect(eats(nocturnalForager.id, 1)).toBe(0);
    expect(eats(nocturnalForager.id, 0.5)).toBeCloseTo(eats(bronzeCorydoras.id, 0.5), 12);
    expect(eats(nocturnalForager.id, 0)).toBeCloseTo(eats(bronzeCorydoras.id, 1), 12);
  });
});

describe('bridge', () => {
  const opened: { host: SimHost; client: SimClient; ports: MessagePort[] }[] = [];

  afterEach(() => {
    for (const h of opened) {
      h.client.dispose();
      h.host.dispose();
      for (const p of h.ports) p.close();
    }
    opened.length = 0;
  });

  function connect(options?: SimHostOptions): { client: SimClient } {
    const channel = new MessageChannel();
    const host = createSimHost(channel.port1, options);
    const client = new SimClient(channel.port2);
    opened.push({ host, client, ports: [channel.port1, channel.port2] });
    return { client };
  }

  function nextError(client: SimClient): Promise<string> {
    return new Promise((resolve) => {
      const off = client.onError((message) => {
        off();
        resolve(message);
      });
    });
  }

  function nextPolyps(client: SimClient): Promise<number> {
    return new Promise((resolve) => {
      const off = client.onPolyps((extension) => {
        off();
        resolve(extension);
      });
    });
  }

  it('reports the polyp extension after init and as the darkness moves it', async () => {
    const { client } = connect();
    const first = nextPolyps(client);
    await client.init({
      seed: 1,
      tank: SHOW_TANK,
      species: SPECIES,
      fish: spawnMany(neonTetra.id, 2),
      light: 0,
    });
    expect(await first).toBe(1);
    client.step(1);
    client.setLight(1);
    const moved = nextPolyps(client);
    client.step(STEP_HZ * 10);
    const extension = await moved;
    expect(extension).toBeLessThan(1);
    expect(extension).toBeGreaterThan(0.9);
  });

  function startled(snapshot: Snapshot): number {
    let n = 0;
    for (let o = SnapshotField.State; o < snapshot.data.length; o += SNAPSHOT_STRIDE) {
      if (snapshot.data[o] === FishState.Startle) n++;
    }
    return n;
  }

  // A frozen clock: the host's timer wakes but never finds a step due, so only `step` advances.
  const frozen = (): SimHostOptions => ({ now: () => 0 });

  it('takes light changed while stopped as adapted to on start', async () => {
    const lightsOutWhileStopped = async (restart: boolean): Promise<number> => {
      const { client } = connect(frozen());
      await client.init({
        seed: 5,
        tank: SHOW_TANK,
        species: SPECIES,
        fish: spawnMany(neonTetra.id, 20),
      });
      await stepTo(client, STEP_HZ, STEP_HZ);
      client.setLight(0);
      if (restart) {
        client.start();
        client.stop();
      }
      let most = 0;
      for (let k = 0; k < 10; k++) {
        most = Math.max(most, startled(await stepTo(client, 1, STEP_HZ + 1 + k)));
      }
      return most;
    };
    expect(await lightsOutWhileStopped(false), 'stepped on without a start').toBeGreaterThan(5);
    expect(await lightsOutWhileStopped(true)).toBe(0);
  });

  it('eases the polyps on start by the time the sim was stopped', async () => {
    const afterPause = async (pausedMs: number): Promise<number[]> => {
      let clock = 0;
      const { client } = connect({ now: () => clock });
      const seen: number[] = [];
      client.onPolyps((extension) => seen.push(extension));
      await client.init({
        seed: 1,
        tank: SHOW_TANK,
        species: SPECIES,
        fish: spawnMany(neonTetra.id, 2),
      });
      client.start();
      client.stop();
      await stepTo(client, 1, 1);
      clock = pausedMs;
      client.setLight(0);
      client.start();
      client.stop();
      await stepTo(client, 1, 2);
      return seen;
    };
    const eased = (s: number): number => 1 - Math.exp(-s / NIGHT.polypTauS);
    const after = (pausedS: number): number => {
      const e = eased(pausedS);
      return e + (1 - e) * eased(1 / STEP_HZ);
    };
    expect(await afterPause(30_000)).toEqual([0, expect.closeTo(after(30), 6)]);
    expect(await afterPause(600_000)).toEqual([0, expect.closeTo(after(600), 6)]);
  });

  it('eases the polyps from the last good clock reading after the loop halted on a throw', async () => {
    let calls = 0;
    let clock = 0;
    const { client } = connect({
      now: () => {
        calls++;
        if (calls === 2) throw new Error('clock exploded');
        return clock;
      },
    });
    const seen: number[] = [];
    client.onPolyps((extension) => seen.push(extension));
    await client.init({
      seed: 1,
      tank: SHOW_TANK,
      species: SPECIES,
      fish: spawnMany(neonTetra.id, 2),
    });
    const failed = nextError(client);
    client.start();
    expect(await failed).toBe('clock exploded');
    await stepTo(client, 1, 1);
    clock = 30_000;
    client.setLight(0);
    client.start();
    client.stop();
    await stepTo(client, 1, 2);
    const e = 1 - Math.exp(-30 / NIGHT.polypTauS);
    const step = 1 - Math.exp(-1 / STEP_HZ / NIGHT.polypTauS);
    expect(seen).toEqual([0, expect.closeTo(e + (1 - e) * step, 6)]);
  });

  it('starts again after the clock threw inside stop', async () => {
    let calls = 0;
    const { client } = connect({
      now: () => {
        calls++;
        if (calls === 2) throw new Error('clock exploded');
        return performance.now();
      },
    });
    await client.init({
      seed: 1,
      tank: SHOW_TANK,
      species: SPECIES,
      fish: spawnMany(neonTetra.id, 2),
    });
    const failed = nextError(client);
    client.start();
    client.stop();
    expect(await failed).toBe('clock exploded');
    const ticked = new Promise<number | null>((resolve) => {
      const timeout = setTimeout(() => {
        off();
        resolve(null);
      }, 1000);
      const off = client.onSnapshot((snapshot) => {
        if (snapshot.tick < 1) return;
        clearTimeout(timeout);
        off();
        resolve(snapshot.tick);
      });
    });
    client.start();
    expect(await ticked).toBeGreaterThanOrEqual(1);
  });
});
