import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { speciesContentSchema } from '@aquarium/shared';
import { describe, expect, it } from 'vitest';
import { BEHAVIOUR } from './behaviour.ts';
import type { Collider } from '@aquarium/shared';
import { compileCollider } from './decor.ts';
import {
  REEF_ANCHORS,
  REEF_DECOR,
  REEF_TANK,
  SHOW_DECOR,
  SHOW_TANK,
  spawnMany,
} from './fixtures.ts';
import { TankSdf, type TankDimensions } from './sdf.ts';
import { toSimSpecies } from './species.ts';
import { FishState } from './snapshot.ts';
import { WAVE_MAKER } from './waveMaker.ts';
import { World } from './world.ts';

const LONG = 120_000;
/** Seeds 4 and 6 gave the most tetra and cleaner-shrimp contacts in a 9-seed sweep (#667). */
const CONTACT_SEEDS = [4, 6, 11];
const dir = join(import.meta.dirname, '../../../content/species');

function load(from: string) {
  return readdirSync(from)
    .filter((f) => f.endsWith('.json'))
    .map((file) => {
      const raw: unknown = JSON.parse(readFileSync(join(from, file), 'utf8'));
      return { file, raw, species: speciesContentSchema.parse(raw) };
    });
}

const roster = load(dir);

function byId(id: string) {
  const found = roster.find((r) => r.species.id === id)?.species;
  if (!found) throw new Error(`no content/species/${id}.json`);
  return found;
}

const MVP_ROSTER = [
  ['angelfish', 'Pterophyllum scalare', 'freshwater'],
  ['apistogramma-hongsloi', 'Apistogramma hongsloi', 'blackwater'],
  ['banded-archerfish', 'Toxotes jaculatrix', 'mangrove'],
  ['banggai-cardinalfish', 'Pterapogon kauderni', 'reef'],
  ['barred-mudskipper', 'Periophthalmus argentilineatus', 'mangrove'],
  ['betta', 'Betta splendens', 'freshwater'],
  ['blue-spotted-mudskipper', 'Boleophthalmus pectinirostris', 'mangrove'],
  ['blue-tang', 'Paracanthurus hepatus', 'reef'],
  ['bristlenose-pleco', 'Ancistrus cirrhosus', 'freshwater'],
  ['bronze-corydoras', 'Corydoras aeneus', 'freshwater'],
  ['bumblebee-goby', 'Brachygobius doriae', 'mangrove'],
  ['cardinal-tetra', 'Paracheirodon axelrodi', 'blackwater'],
  ['cherry-shrimp', 'Neocaridina davidi', 'freshwater'],
  ['cleaner-shrimp', 'Lysmata amboinensis', 'reef'],
  ['cleaner-wrasse', 'Labroides dimidiatus', 'reef'],
  ['discus', 'Symphysodon aequifasciatus', 'freshwater'],
  ['dwarf-pencilfish', 'Nannostomus marginatus', 'blackwater'],
  ['firefish', 'Nemateleotris magnifica', 'reef'],
  ['guppy', 'Poecilia reticulata', 'freshwater'],
  ['harlequin-rasbora', 'Trigonostigma heteromorpha', 'freshwater'],
  ['hermit-crab', 'Clibanarius tricolor', 'reef'],
  ['neon-tetra', 'Paracheirodon innesi', 'freshwater'],
  ['nerite-snail', 'Neritina natalensis', 'freshwater'],
  ['ocellaris-clownfish', 'Amphiprion ocellaris', 'reef'],
  ['orange-chromide', 'Pseudetroplus maculatus', 'mangrove'],
  ['royal-gramma', 'Gramma loreto', 'reef'],
  ['rummy-nose-tetra', 'Petitella bleheri', 'blackwater'],
  ['silver-mono', 'Monodactylus argenteus', 'mangrove'],
  ['six-line-wrasse', 'Pseudocheilinus hexataenia', 'reef'],
  ['yellow-tang', 'Zebrasoma flavescens', 'reef'],
] as const;

const CICHLID_ROSTER = [
  ['altolamprologus-calvus', 'Altolamprologus calvus', 'cichlid'],
  ['aulonocara-baenschi', 'Aulonocara baenschi', 'cichlid'],
  ['labidochromis-caeruleus', 'Labidochromis caeruleus', 'cichlid'],
  ['melanochromis-auratus', 'Melanochromis auratus', 'cichlid'],
  ['neolamprologus-brichardi', 'Neolamprologus brichardi', 'cichlid'],
  ['neolamprologus-multifasciatus', 'Neolamprologus multifasciatus', 'cichlid'],
  ['pseudotropheus-demasoni', 'Chindongo demasoni', 'cichlid'],
] as const;

function sortedKeysDeep(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(sortedKeysDeep);
  if (value === null || typeof value !== 'object') return true;
  const keys = Object.keys(value);
  const sorted = [...keys].sort();
  return (
    keys.every((k, n) => k === sorted[n]) &&
    Object.values(value as Record<string, unknown>).every(sortedKeysDeep)
  );
}

describe('content/species', () => {
  it('ships the MVP and expansion rosters', () => {
    const byId = (a: readonly string[], b: readonly string[]) =>
      String(a[0]).localeCompare(String(b[0]));
    const shipped = roster.map(({ species: s }) => [s.id, s.scientificName, s.biome]).sort(byId);
    expect(shipped).toEqual([...MVP_ROSTER, ...CICHLID_ROSTER].map((r) => [...r]).sort(byId));
  });

  it.each(roster)('$file is valid, named by id and keeps sorted keys', ({ file, raw, species }) => {
    expect(file).toBe(`${species.id}.json`);
    expect(sortedKeysDeep(raw)).toBe(true);
    const sim = toSimSpecies(species);
    expect(sim.cruiseSpeed).toBeLessThanOrEqual(sim.maxSpeed);
  });
});

function fishCount(species: ReturnType<typeof speciesContentSchema.parse>): number {
  if (species.behaviour.schooling) return 10;
  return species.behaviour.territorial ? 2 : 6;
}

/** Male length over the species length, as apps/web/src/fish/profiles.ts draws and simulates it. */
const MALE_LENGTH_FACTOR: Readonly<Record<string, number>> = {
  'apistogramma-hongsloi': 0.05 / 0.03,
  'aulonocara-baenschi': 1.33,
};

/** The species' fish, the last one a full-grown male where males outgrow the species length. */
function spawnsOf(species: ReturnType<typeof speciesContentSchema.parse>, count: number) {
  const fish = spawnMany(species.id, count);
  const factor = MALE_LENGTH_FACTOR[species.id];
  if (factor === undefined) return fish;
  const male = {
    id: `${species.id}-male`,
    species: species.id,
    bodyLengthM: species.lifecycle.maxSizeM * factor,
  };
  return [...fish.slice(0, -1), male];
}

/** Spine-chain clearance computed from the primitives directly, not through the world's grid. */
function bruteClearance(w: World, tank: TankDimensions, decor: readonly Collider[]) {
  const tankSdf = new TankSdf(tank);
  const solids = decor.filter((c) => c.hard).map(compileCollider);
  const n = new Float64Array(3);
  return (i: number): number => {
    const o = i * 3;
    const yaw = w.yaw[i] ?? 0;
    const pitch = w.pitch[i] ?? 0;
    const fx = Math.sin(yaw) * Math.cos(pitch);
    const fy = Math.sin(pitch);
    const fz = Math.cos(yaw) * Math.cos(pitch);
    let worst = Infinity;
    for (const s of BEHAVIOUR.bodySampleOffsets) {
      const k = s * (w.bodyLength[i] ?? 0);
      const x = (w.position[o] ?? 0) + fx * k;
      const y = (w.position[o + 1] ?? 0) + fy * k;
      const z = (w.position[o + 2] ?? 0) + fz * k;
      worst = Math.min(worst, tankSdf.sample(x, y, z, n));
      for (const p of solids) worst = Math.min(worst, p.sample(x, y, z, n));
    }
    return worst - (w.thickness[i] ?? 0);
  };
}

describe('every shipped species in its decorated tank', { timeout: LONG }, () => {
  const species = roster.map((r) => r.species);

  it.each(
    roster.map((r) => ({
      id: r.species.id,
      biome: r.species.biome,
      s: r.species,
    })),
  )('never penetrates glass or rock over 10 000 steps: $id', ({ biome, s }) => {
    const reef = biome === 'reef';
    const tank = reef ? REEF_TANK : SHOW_TANK;
    const decor = reef ? REEF_DECOR : SHOW_DECOR;
    let worst = Infinity;
    let contacts = 0;
    let fishSteps = 0;
    for (const seed of CONTACT_SEEDS) {
      const w = new World({
        seed,
        tank,
        species,
        decor,
        anchors: reef ? REEF_ANCHORS : [],
        fish: spawnsOf(s, fishCount(s)),
      });
      const clearance = bruteClearance(w, tank, decor);
      for (let t = 0; t < 10_000; t++) {
        w.step();
        for (let i = 0; i < w.count; i++) worst = Math.min(worst, clearance(i));
      }
      contacts += w.contacts;
      fishSteps += w.count * 10_000;
    }
    expect(worst).toBeGreaterThanOrEqual(-1e-9);
    // The hard constraint is a backstop; steering should keep it almost idle.
    expect(contacts / fishSteps).toBeLessThan(1e-3);
  });
});

describe('barred mudskippers foraging round the show-tank driftwood', { timeout: LONG }, () => {
  it('do not rise under the log and grind between wood and sand (#1257)', () => {
    const mud = byId('barred-mudskipper');
    const wood = SHOW_DECOR.find((c) => c.id === 'driftwood');
    if (!wood) throw new Error('SHOW_DECOR lost its driftwood');
    const log = compileCollider(wood);
    const n = new Float64Array(3);
    // Seed 7 pinned a fish in the crevice under the log's low end for 186 contacts there.
    const w = new World({
      seed: 7,
      tank: SHOW_TANK,
      species: [mud],
      decor: SHOW_DECOR,
      fish: spawnMany(mud.id, 6),
    });
    const seen = new Uint32Array(w.count);
    let atLog = 0;
    for (let t = 0; t < 10_000; t++) {
      w.step();
      for (let i = 0; i < w.count; i++) {
        const c = w.contactCount[i] ?? 0;
        if (c === seen[i]) continue;
        seen[i] = c;
        const o = i * 3;
        const p = w.position;
        if (log.sample(p[o] ?? 0, p[o + 1] ?? 0, p[o + 2] ?? 0, n) < 0.03) atLog++;
      }
    }
    expect(atLog).toBeLessThan(30);
  });
});

describe('a cory due a breath under the show-tank driftwood', { timeout: LONG }, () => {
  const base = byId('bronze-corydoras');
  // Far above the content cap, so the breath falls due within a step or two of the start.
  const cory = { ...base, behaviour: { ...base.behaviour, airGulp: { perHour: 3600 } } };
  const wood = SHOW_DECOR.find((c) => c.id === 'driftwood');
  if (!wood) throw new Error('SHOW_DECOR lost its driftwood');
  const log = compileCollider(wood);
  /** A 3.5 s dash up from the sand, plus a slide of a few body lengths out from under the log. */
  const BREATH_WITHIN_S = 12;
  const starts = [
    [-0.27, -0.08],
    [-0.24, -0.06],
  ].flatMap(([x, z]) =>
    [0, 90, 180, -90].flatMap((yawDeg) =>
      [1, 2, 3].map((seed) => ({ x: x ?? 0, z: z ?? 0, yawDeg, seed })),
    ),
  );

  it.each(starts)(
    'slides out and reaches the surface (#1283): x $x z $z heading $yawDeg seed $seed',
    ({ x, z, yawDeg, seed }) => {
      const y = 0.012;
      const n = new Float64Array(3);
      let overhead = Infinity;
      for (let k = 1; k <= 20; k++)
        overhead = Math.min(overhead, log.sample(x, y + k * 0.004, z, n));
      expect(overhead).toBeLessThan(0);

      const w = new World({
        seed,
        tank: SHOW_TANK,
        species: [cory],
        decor: SHOW_DECOR,
        fish: spawnMany(cory.id, 1),
      });
      w.position.set([x, y, z]);
      w.yaw[0] = (yawDeg * Math.PI) / 180;
      w.pitch[0] = 0;
      const wait = w.behaviour.gulpWait;
      let before = 0;
      let breathS = Infinity;
      for (let t = 1; t <= 30 * 2 * BREATH_WITHIN_S; t++) {
        w.step();
        const now = wait[0] ?? 0;
        if (now === 0 && before > 0) {
          breathS = t / 30;
          break;
        }
        before = now;
      }
      expect(breathS).toBeLessThan(BREATH_WITHIN_S);
    },
  );
});

describe('a cory startled on its way up for air', { timeout: LONG }, () => {
  const base = byId('bronze-corydoras');
  const LONGEST_WAIT_S = BEHAVIOUR.gulpOverdueS + 2 * BEHAVIOUR.gulpTimeoutS;

  it.each([1, 2, 3, 4, 5])('keeps the breath due and still surfaces (#1283): seed %i', (seed) => {
    // Far above the content cap, so the first breath falls due within a step or two.
    const cory = { ...base, behaviour: { ...base.behaviour, airGulp: { perHour: 3600 } } };
    const w = new World({
      seed,
      tank: SHOW_TANK,
      species: [cory],
      fish: spawnMany(cory.id, 1),
    });
    const wait = w.behaviour.gulpWait;
    const startled = w.behaviour.startledAt;
    let rising = 0;
    for (let t = 0; t < 30 * 60 && rising < 15; t++) {
      w.step();
      rising = w.state[0] === FishState.Gulp && (wait[0] ?? 0) > 0 ? rising + 1 : 0;
    }
    expect(rising).toBe(15);

    const p = w.position;
    w.startle({ position: [p[0] ?? 0, p[1] ?? 0, (p[2] ?? 0) + 0.05], intensity: 1 });
    w.step();
    expect(startled[0]).toBe(w.tick - 1);

    let before = wait[0] ?? 0;
    let waited = Infinity;
    let frozen = 0;
    for (let t = 1; t <= 30 * 2 * LONGEST_WAIT_S; t++) {
      w.step();
      const now = wait[0] ?? 0;
      if (now === 0) {
        waited = before;
        break;
      }
      if (now === before) frozen++;
      before = now;
    }
    expect(frozen).toBe(0);
    expect(waited).toBeLessThan(LONGEST_WAIT_S);
  });
});

describe('every shipped species in a full-power wave maker current', { timeout: LONG }, () => {
  const species = roster.map((r) => r.species);

  it.each(
    roster.map((r) => ({
      id: r.species.id,
      biome: r.species.biome,
      s: r.species,
    })),
  )('is never carried through glass or rock over 10 000 steps: $id', ({ biome, s }) => {
    const reef = biome === 'reef';
    const tank = reef ? REEF_TANK : SHOW_TANK;
    const decor = reef ? REEF_DECOR : SHOW_DECOR;
    const w = new World({
      seed: CONTACT_SEEDS[0] ?? 4,
      tank,
      species,
      decor,
      anchors: reef ? REEF_ANCHORS : [],
      fish: spawnsOf(s, fishCount(s)),
      waveMaker: {
        direction: [1, 0.3],
        speedMps: WAVE_MAKER.maxSpeedMps,
        mode: 'steady',
        periodS: WAVE_MAKER.pulsePeriodS,
      },
    });
    const clearance = bruteClearance(w, tank, decor);
    let worst = Infinity;
    for (let t = 0; t < 10_000; t++) {
      w.step();
      for (let i = 0; i < w.count; i++) worst = Math.min(worst, clearance(i));
    }
    expect(worst).toBeGreaterThanOrEqual(-1e-9);
    expect(w.contacts / (w.count * 10_000)).toBeLessThan(1e-3);
  });
});

describe('air-gulp darts in a full-power wave maker current', { timeout: LONG }, () => {
  const MAX_GULPS_PER_HOUR = 120;
  const gulpers = roster
    .map((r) => r.species)
    .filter((s) => s.behaviour.traits.includes('air-gulp'))
    .map((s) => ({
      ...s,
      behaviour: { ...s.behaviour, airGulp: { perHour: MAX_GULPS_PER_HOUR } },
    }));

  it('finds every air-gulping species', () => {
    expect(gulpers.map((s) => s.id).sort()).toEqual([
      'barred-mudskipper',
      'blue-spotted-mudskipper',
      'bronze-corydoras',
    ]);
  });

  /**
   * A due breath is only ever deferred: after gulpOverdueS of waiting the fish climbs the glass,
   * and one climb plus one failed attempt each spend at most gulpTimeoutS.
   */
  const LONGEST_WAIT_S = BEHAVIOUR.gulpOverdueS + 2 * BEHAVIOUR.gulpTimeoutS;
  const cases = gulpers.flatMap((s) => {
    const configured = roster.find((r) => r.species.id === s.id)?.species;
    if (configured === undefined) throw new Error(`${s.id} is missing from the roster`);
    return [
      { id: s.id, rate: `${MAX_GULPS_PER_HOUR}/h`, s },
      { id: s.id, rate: 'configured', s: configured },
    ];
  });

  it.each(cases)(
    'reach the surface within the cap and stay under the contact budget: $id at $rate',
    ({ s }) => {
      const species = [...roster.map((r) => r.species).filter((r) => r.id !== s.id), s];
      let worst = Infinity;
      let contacts = 0;
      let fishSteps = 0;
      let breaths = 0;
      let longestWait = 0;
      for (const seed of CONTACT_SEEDS) {
        const w = new World({
          seed,
          tank: SHOW_TANK,
          species,
          decor: SHOW_DECOR,
          fish: spawnsOf(s, fishCount(s)),
          waveMaker: {
            direction: [1, 0.3],
            speedMps: WAVE_MAKER.maxSpeedMps,
            mode: 'steady',
            periodS: WAVE_MAKER.pulsePeriodS,
          },
        });
        const clearance = bruteClearance(w, SHOW_TANK, SHOW_DECOR);
        const wait = w.behaviour.gulpWait;
        const before = new Float64Array(w.count);
        for (let t = 0; t < 10_000; t++) {
          w.step();
          for (let i = 0; i < w.count; i++) {
            worst = Math.min(worst, clearance(i));
            const now = wait[i] ?? 0;
            if (now === 0 && (before[i] ?? 0) > 0) breaths++;
            longestWait = Math.max(longestWait, now);
            before[i] = now;
          }
        }
        contacts += w.contacts;
        fishSteps += w.count * 10_000;
      }
      expect(worst).toBeGreaterThanOrEqual(-1e-9);
      expect(contacts / fishSteps).toBeLessThan(1e-3);
      expect(breaths).toBeGreaterThan(0);
      expect(longestWait).toBeLessThan(LONGEST_WAIT_S);
    },
  );
});

describe('a mixed community left alone', { timeout: LONG }, () => {
  const species = roster.map((r) => r.species);
  const reef = [
    ...spawnMany('ocellaris-clownfish', 2),
    ...spawnMany('banggai-cardinalfish', 8),
    ...spawnMany('royal-gramma', 1),
    ...spawnMany('yellow-tang', 1),
  ];
  const freshwater = [
    ...spawnMany('betta', 1),
    ...spawnMany('angelfish', 2),
    ...spawnMany('bronze-corydoras', 6),
    ...spawnMany('neon-tetra', 20),
    ...spawnMany('guppy', 6),
  ];
  const blackwater = [
    ...spawnMany('cardinal-tetra', 10),
    ...spawnMany('rummy-nose-tetra', 10),
    ...spawnMany('dwarf-pencilfish', 6),
    ...spawnsOf(byId('apistogramma-hongsloi'), 2),
  ];

  it.each([
    { name: 'reef', fish: reef, reef: true },
    { name: 'clownfish pair', fish: reef.slice(0, 2), reef: true },
    { name: 'freshwater', fish: freshwater, reef: false },
    { name: 'blackwater', fish: blackwater, reef: false },
  ])('$name: territorial chases set off no escape responses', ({ fish, reef: isReef }) => {
    const minutes = 10;
    const w = new World({
      seed: 3,
      tank: isReef ? REEF_TANK : SHOW_TANK,
      species,
      decor: isReef ? REEF_DECOR : SHOW_DECOR,
      anchors: isReef ? REEF_ANCHORS : [],
      fish,
    });
    const last = new Float64Array(w.behaviour.startledAt);
    let onsets = 0;
    for (let t = 0; t < minutes * 60 * 30; t++) {
      w.step();
      for (let i = 0; i < w.count; i++) {
        const tick = w.behaviour.startledAt[i] ?? -1;
        if (tick !== last[i]) onsets++;
        last[i] = tick;
      }
    }
    expect(onsets / minutes).toBeLessThan(0.5);
  });
});
