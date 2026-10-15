import type { Fish, SpeciesSummary, Tank } from '@aquarium/shared';
import { describe, expect, it } from 'vitest';
import { gaugeSummary, tankGauges, timeOfDay, toneFor } from './tankStatus';

function fish(over: Partial<Fish>): Fish {
  return {
    id: 'f',
    name: 'Pip',
    species: 'neon-tetra',
    status: 'alive',
    hunger: 0,
    health: 1,
    ...over,
  } as Fish;
}

function tank(fishList: Fish[], water: Partial<Tank['water']> = {}): Tank {
  return {
    id: 't',
    name: 'Tank',
    biome: 'freshwater',
    water: { ammonia: 0, nitrate: 0, algae: 0, uneatenFood: 0, ...water },
    fish: fishList,
    memorials: [],
  } as unknown as Tank;
}

const species: SpeciesSummary[] = [];

describe('tankGauges', () => {
  it('averages health and fullness over the living fish only', () => {
    const gauges = tankGauges(
      tank([
        fish({ id: 'a', health: 1, hunger: 0 }),
        fish({ id: 'b', health: 0.5, hunger: 0.5 }),
        fish({ id: 'c', status: 'dead', health: 0, hunger: 1 }),
      ]),
      species,
    );
    expect(gauges.find((g) => g.key === 'health')?.value).toBeCloseTo(0.75);
    expect(gauges.find((g) => g.key === 'fed')?.value).toBeCloseTo(0.75);
  });

  it('shows only the water gauge when nothing is alive', () => {
    const gauges = tankGauges(tank([fish({ status: 'dead' })]), species);
    expect(gauges.map((g) => g.key)).toEqual(['water']);
  });

  it('takes the worst water reading', () => {
    const clean = tankGauges(tank([]), species).find((g) => g.key === 'water');
    const dirty = tankGauges(tank([], { uneatenFood: 20 }), species).find((g) => g.key === 'water');
    expect(clean?.tone).toBe('good');
    expect(dirty?.tone).toBe('poor');
  });
});

describe('toneFor', () => {
  it('splits at the thresholds', () => {
    expect(toneFor(1)).toBe('good');
    expect(toneFor(0.66)).toBe('good');
    expect(toneFor(0.5)).toBe('fair');
    expect(toneFor(0.33)).toBe('fair');
    expect(toneFor(0.1)).toBe('poor');
  });
});

describe('gaugeSummary', () => {
  it('reads each gauge as a percentage and is empty without gauges', () => {
    expect(gaugeSummary([{ key: 'water', label: 'Water', value: 0.55, tone: 'fair' }])).toBe(
      'water 55 percent',
    );
    expect(gaugeSummary([])).toBe('');
  });
});

describe('timeOfDay', () => {
  it('names the photoperiod', () => {
    expect(timeOfDay(1)).toBe('Day');
    expect(timeOfDay(0.4)).toBe('Dawn or dusk');
    expect(timeOfDay(0)).toBe('Night');
  });
});
