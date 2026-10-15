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
import { World, type WorldConfig } from './world.ts';

const LONG = 120_000;
const dir = join(import.meta.dirname, '../../../content/species');

const pendingDir = join(import.meta.dirname, '../../../content/species-pending');

function load(from: string) {
  return readdirSync(from)
    .filter((f) => f.endsWith('.json'))
    .map((file) => {
      const raw: unknown = JSON.parse(readFileSync(join(from, file), 'utf8'));
      return { file, raw, species: speciesContentSchema.parse(raw) };
    });
}

const roster = load(dir);
const pending = load(pendingDir);

const MVP_ROSTER = [
  ['angelfish', 'Pterophyllum scalare', 'freshwater'],
  ['banggai-cardinalfish', 'Pterapogon kauderni', 'reef'],
  ['betta', 'Betta splendens', 'freshwater'],
  ['blue-tang', 'Paracanthurus hepatus', 'reef'],
  ['bristlenose-pleco', 'Ancistrus cirrhosus', 'freshwater'],
  ['bronze-corydoras', 'Corydoras aeneus', 'freshwater'],
  ['discus', 'Symphysodon aequifasciatus', 'freshwater'],
  ['firefish', 'Nemateleotris magnifica', 'reef'],
  ['guppy', 'Poecilia reticulata', 'freshwater'],
  ['harlequin-rasbora', 'Trigonostigma heteromorpha', 'freshwater'],
  ['neon-tetra', 'Paracheirodon innesi', 'freshwater'],
  ['ocellaris-clownfish', 'Amphiprion ocellaris', 'reef'],
  ['royal-gramma', 'Gramma loreto', 'reef'],
  ['six-line-wrasse', 'Pseudocheilinus hexataenia', 'reef'],
  ['yellow-tang', 'Zebrasoma flavescens', 'reef'],
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
  it('ships the MVP roster', () => {
    const shipped = roster
      .map(({ species: s }) => [s.id, s.scientificName, s.biome])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    expect(shipped).toEqual(MVP_ROSTER.map((r) => [...r]));
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

describe('every shipped and pending species in its decorated tank', { timeout: LONG }, () => {
  const species = [...roster, ...pending].map((r) => r.species);

  it.each(
    [...roster, ...pending].map((r) => ({
      id: r.species.id,
      biome: r.species.biome,
      s: r.species,
    })),
  )('never penetrates glass or rock over 10 000 steps: $id', ({ biome, s }) => {
    const reef = biome === 'reef';
    const tank = reef ? REEF_TANK : SHOW_TANK;
    const decor = reef ? REEF_DECOR : SHOW_DECOR;
    const config: WorldConfig = {
      seed: 11,
      tank,
      species,
      decor,
      anchors: reef ? REEF_ANCHORS : [],
      fish: spawnMany(s.id, fishCount(s)),
    };
    const w = new World(config);
    const clearance = bruteClearance(w, tank, decor);
    let worst = Infinity;
    for (let t = 0; t < 10_000; t++) {
      w.step();
      for (let i = 0; i < w.count; i++) worst = Math.min(worst, clearance(i));
    }
    expect(worst).toBeGreaterThanOrEqual(-1e-9);
    // The hard constraint is a backstop; steering should keep it almost idle.
    expect(w.contacts / (w.count * 10_000)).toBeLessThan(1e-3);
  });
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

  it.each([
    { name: 'reef', fish: reef, reef: true },
    { name: 'clownfish pair', fish: reef.slice(0, 2), reef: true },
    { name: 'freshwater', fish: freshwater, reef: false },
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
