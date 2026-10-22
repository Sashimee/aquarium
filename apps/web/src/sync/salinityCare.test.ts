import { newTankChemistry } from '@aquarium/shared';
import { describe, expect, it } from 'vitest';
import { FISH_1, FISH_2, fishFixture, speciesFixture, tankFixture } from './fixtures';
import { salinityNotice } from './salinityCare';

const base = speciesFixture().chemistry;
const brackish = speciesFixture({
  id: 'mudskipper',
  commonName: 'Mudskipper',
  chemistry: { ...base, salinityPpt: [8, 20] },
});
const hardy = speciesFixture({
  id: 'molly',
  commonName: 'Molly',
  chemistry: { ...base, salinityPpt: [0, 12] },
});

const mangrove = (salinity: number, fish = [fishFixture(FISH_1, { species: 'mudskipper' })]) =>
  tankFixture({
    biome: 'mangrove',
    fish,
    chemistry: { ...newTankChemistry('mangrove'), salinity },
  });

describe('salinityNotice', () => {
  it('is silent while salinity sits inside every range', () => {
    expect(salinityNotice(mangrove(10), [brackish])).toBeNull();
  });

  it('is silent exactly on the range edges', () => {
    expect(salinityNotice(mangrove(8), [brackish])).toBeNull();
    expect(salinityNotice(mangrove(20), [brackish])).toBeNull();
  });

  it('warns when the water is too fresh, as a caution under the full-stress gap', () => {
    const n = salinityNotice(mangrove(6), [brackish]);
    expect(n).toMatchObject({ direction: 'low', severity: 'caution', speciesIds: ['mudskipper'] });
    expect(n?.text).toContain('too fresh for mudskipper');
    expect(n?.text).toContain('6.0 ppt');
  });

  it('raises danger once the gap reaches the full-stress deviation', () => {
    expect(salinityNotice(mangrove(3), [brackish])?.severity).toBe('danger');
    expect(salinityNotice(mangrove(25), [brackish])).toMatchObject({
      direction: 'high',
      severity: 'danger',
    });
  });

  it('names only the species that are off', () => {
    const tank = mangrove(15, [
      fishFixture(FISH_1, { species: 'molly' }),
      fishFixture(FISH_2, { species: 'mudskipper' }),
    ]);
    const n = salinityNotice(tank, [brackish, hardy]);
    expect(n?.direction).toBe('high');
    expect(n?.speciesIds).toEqual(['molly']);
  });

  it('ignores dead fish, an empty tank and unknown species', () => {
    expect(salinityNotice(mangrove(1, []), [brackish])).toBeNull();
    const dead = [fishFixture(FISH_1, { species: 'mudskipper', status: 'dead' })];
    expect(salinityNotice(mangrove(1, dead), [brackish])).toBeNull();
    expect(salinityNotice(mangrove(1), [])).toBeNull();
  });

  it('does not apply to a freshwater tank', () => {
    const tank = tankFixture({
      biome: 'freshwater',
      fish: [fishFixture(FISH_1, { species: 'mudskipper' })],
    });
    expect(salinityNotice(tank, [brackish])).toBeNull();
  });
});
