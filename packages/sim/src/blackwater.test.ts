import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  colliderListSchema,
  speciesContentSchema,
  tankSpaceSchema,
  type Collider,
  type TankSpace,
} from '@aquarium/shared';
import { describe, expect, it } from 'vitest';
import { findNooks } from './nooks.ts';
import type { Anchor } from './behaviour.ts';
import { World, type FishSpawn } from './world.ts';

const LONG = 120_000;
const CAVE_DWELLER = 'apistogramma-hongsloi';
const SPECIES = ['cardinal-tetra', 'rummy-nose-tetra', 'dwarf-pencilfish', CAVE_DWELLER].map((id) =>
  speciesContentSchema.parse(
    JSON.parse(
      readFileSync(join(import.meta.dirname, `../../../content/species/${id}.json`), 'utf8'),
    ),
  ),
);

type Size = 'standard' | 'long300';
type Layer = 'hulls' | 'decor';
const SIZES: readonly Size[] = ['standard', 'long300'];
const LAYERS: readonly Layer[] = ['hulls', 'decor'];
const SEEDS = [1, 2] as const;

interface Preset {
  readonly space: TankSpace;
  readonly hulls: Collider[];
  readonly decor: Collider[];
  readonly fish: Readonly<Record<string, FishSpawn[]>>;
}

function at(a: ArrayLike<number>, i: number): number {
  const v = a[i];
  if (v === undefined) throw new RangeError(`index ${i} out of range`);
  return v;
}

function record(v: unknown, what: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null) {
    throw new Error(`blackwater fixture: ${what} is not an object`);
  }
  return v as Record<string, unknown>;
}

function spawns(v: unknown, what: string): FishSpawn[] {
  if (!Array.isArray(v)) throw new Error(`blackwater fixture: ${what} is not a list`);
  return v.map((f, k) => {
    const { id, species, bodyLengthM } = record(f, `${what}[${k}]`);
    if (
      typeof id !== 'string' ||
      typeof species !== 'string' ||
      !SPECIES.some((s) => s.id === species) ||
      typeof bodyLengthM !== 'number'
    ) {
      throw new Error(`blackwater fixture: ${what}[${k}] is not a blackwater demo fish`);
    }
    return { id, species, bodyLengthM };
  });
}

/** The fitted blackwater presets and demo stock as the web app hands them to the sim. */
const PRESETS: Readonly<Record<Size, Preset>> = (() => {
  const raw = record(
    JSON.parse(readFileSync(join(import.meta.dirname, 'blackwater.fixture.json'), 'utf8')),
    'root',
  );
  const presets = record(raw['presets'], 'presets');
  const preset = (size: Size): Preset => {
    const p = record(presets[size], size);
    const fish = record(p['fish'], `${size}.fish`);
    return {
      space: tankSpaceSchema.parse(p['space']),
      hulls: colliderListSchema.parse(p['hulls']),
      decor: colliderListSchema.parse(p['decor']),
      fish: Object.fromEntries(SEEDS.map((s) => [s, spawns(fish[s], `${size}.fish.${s}`)])),
    };
  };
  return { standard: preset('standard'), long300: preset('long300') };
})();

function world(size: Size, layer: Layer, seed: number): World {
  const p = PRESETS[size];
  const fish = p.fish[seed];
  if (fish === undefined) throw new Error(`blackwater fixture: no demo stock for seed ${seed}`);
  return new World({ seed, space: p.space, species: SPECIES, decor: p[layer], fish });
}

function caveDwellers(w: World): number[] {
  const k = w.species.findIndex((s) => s.id === CAVE_DWELLER);
  return Array.from({ length: w.count }, (_, i) => i).filter((i) => w.speciesIndex[i] === k);
}

/** The length the crevices are sized for. */
function longestCaveDweller(w: World): number {
  return Math.max(...caveDwellers(w).map((i) => at(w.bodyLength, i)));
}

function crevices(w: World): string[] {
  return caveDwellers(w).flatMap((i) => {
    const a = w.behaviour.homes[w.behaviour.anchor[i] ?? -1];
    return a?.id.startsWith('nook:') === true ? [a.id] : [];
  });
}

describe('the blackwater presets, which have no scene cave', { timeout: LONG }, () => {
  const cases = SIZES.flatMap((size) =>
    LAYERS.flatMap((layer) => SEEDS.map((seed) => ({ size, layer, seed }))),
  );

  it.each(cases)(
    '$size, $layer, seed $seed: every cave-dweller gets a crevice it can turn in (#1464)',
    ({ size, layer, seed }) => {
      const w = world(size, layer, seed);
      const decorSdf = w.decorSdf;
      if (decorSdf === null) throw new Error('the preset has no hard decor');
      const dwellers = caveDwellers(w);
      expect(dwellers).toHaveLength(2);
      const length = longestCaveDweller(w);
      const room = w.bodyTurnRoom(length);
      const found = findNooks(
        { basin: w.basin, cover: w.substrateSdf, water: w.sceneSdf, rock: decorSdf },
        length,
        room,
        'nook:',
        w.decorShapes,
      );
      expect(found.length).toBeGreaterThanOrEqual(dwellers.length);
      const dealt = crevices(w);
      expect(new Set(dealt).size).toBe(dealt.length);
      expect(dealt).toHaveLength(dwellers.length);
      for (const { a } of homesOf(w)) expect(a.radius, a.id).toBeGreaterThanOrEqual(room);
    },
  );

  it.each(cases)(
    '$size, $layer, seed $seed: every cave-dweller holds its crevice all night',
    ({ size, layer, seed }) => {
      const w = world(size, layer, seed);
      const homes = homesOf(w);
      expect(homes).toHaveLength(2);
      night(w, homes).forEach(({ held }, j) => {
        expect(held, homes[j]?.a.id).toBeGreaterThan(0.8);
      });
    },
  );

  // The crevice found for one apistogramma here before the finer grid (#1464): roomy, but its
  // mouth opens on a gap between the wood and the front glass narrower than the fish can turn in.
  // Drifting out of it at night, the fish swam on along the gap, away from home (#1465).
  it('standard, hulls, seed 2: a cave-dweller drifting out along a slot backs home (#1465)', () => {
    const w = world('standard', 'hulls', 2);
    w.setAnchors([
      {
        id: 'front-glass-crevice',
        kind: 'cave',
        position: [-0.396, 0.091, 0.219],
        radius: 0.62 * longestCaveDweller(w),
        facing: [-0.84, 0, -0.55],
      },
    ]);
    const homes = homesOf(w);
    expect(homes).toHaveLength(1);
    const [stay] = night(w, homes);
    expect(stay?.held).toBeGreaterThan(0.95);
    expect(stay?.farthest).toBeLessThan(2);
  });
});

function homesOf(w: World): { i: number; a: Anchor }[] {
  return caveDwellers(w).flatMap((i) => {
    const a = w.behaviour.homes[w.behaviour.anchor[i] ?? -1];
    return a === undefined ? [] : [{ i, a }];
  });
}

/**
 * Over the second half of a 200 s night, the share of the time each fish spends within a body
 * length of its home, and how many body lengths past the home's radius it strays at most.
 */
function night(
  w: World,
  homes: readonly { i: number; a: Anchor }[],
): { held: number; farthest: number }[] {
  w.setLight(0);
  const stays = homes.map(() => ({ held: 0, farthest: 0 }));
  let steps = 0;
  for (let t = 0; t < 6000; t++) {
    w.step();
    if (t < 3000) continue;
    steps++;
    homes.forEach(({ i, a }, j) => {
      const stay = stays[j];
      if (stay === undefined) throw new RangeError(`no stay for home ${j}`);
      const length = at(w.bodyLength, i);
      const d = Math.hypot(
        at(w.position, 3 * i) - a.position[0],
        at(w.position, 3 * i + 1) - a.position[1],
        at(w.position, 3 * i + 2) - a.position[2],
      );
      if (d < a.radius + length) stay.held++;
      stay.farthest = Math.max(stay.farthest, (d - a.radius) / length);
    });
  }
  return stays.map(({ held, farthest }) => ({ held: held / steps, farthest }));
}
