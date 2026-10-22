import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { speciesContentSchema } from '@aquarium/shared';
import { describe, expect, it } from 'vitest';
import { ARCHETYPES, betta, SHOW_DECOR, SHOW_TANK, spawnMany } from './fixtures.ts';
import { toSimSpecies } from './species.ts';
import { STEP_HZ, World, type FishSpawn } from './world.ts';

const LONG = 60_000;

const PUFFER = speciesContentSchema.parse(
  JSON.parse(
    readFileSync(
      join(import.meta.dirname, '../../../content/species/figure-8-puffer.json'),
      'utf8',
    ),
  ) as unknown,
);

function at(a: ArrayLike<number>, i: number): number {
  const v = a[i];
  if (v === undefined) throw new RangeError(`index ${i} out of range`);
  return v;
}

function tank(fish: FishSpawn[], seed = 3): World {
  return new World({
    seed,
    tank: SHOW_TANK,
    species: [PUFFER, ...ARCHETYPES],
    decor: SHOW_DECOR,
    fish,
  });
}

const PUFFER_AND_BETTA = [...spawnMany(PUFFER.id, 1), ...spawnMany(betta.id, 1)];

describe('figure-8 puffer', { timeout: LONG }, () => {
  it('runs the same trajectory from the same seed', () => {
    const a = tank(PUFFER_AND_BETTA);
    const b = tank(PUFFER_AND_BETTA);
    const c = tank(PUFFER_AND_BETTA, 4);
    for (let t = 0; t < 60 * STEP_HZ; t++) {
      a.step();
      b.step();
      c.step();
    }
    expect(Array.from(b.position)).toEqual(Array.from(a.position));
    expect(Array.from(c.position)).not.toEqual(Array.from(a.position));
  });

  it('hovers slowly, keeps a station and holds the lower water column', () => {
    const sp = toSimSpecies(PUFFER);
    expect(sp.home).toBe('station');
    const w = tank(spawnMany(PUFFER.id, 1));
    const speeds: number[] = [];
    let low = 0;
    const steps = 300 * STEP_HZ;
    for (let t = 0; t < steps; t++) {
      w.step();
      speeds.push(at(w.speed, 0));
      if (at(w.position, 1) < 0.75 * SHOW_TANK.height) low++;
    }
    speeds.sort((x, y) => x - y);
    expect(at(speeds, Math.floor(speeds.length / 2))).toBeLessThanOrEqual(sp.cruiseSpeed * 1.05);
    expect(low / steps).toBeGreaterThan(0.9);
  });

  it('charges a long-finned tankmate of another species', () => {
    const w = tank(PUFFER_AND_BETTA);
    let charges = 0;
    let wasTargeting = false;
    for (let t = 0; t < 600 * STEP_HZ; t++) {
      w.step();
      const targeting = at(w.behaviour.territoryTarget, 0) === 1;
      if (targeting && !wasTargeting) charges++;
      wasTargeting = targeting;
    }
    expect(charges).toBeGreaterThan(2);
  });
});
