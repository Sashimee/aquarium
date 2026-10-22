import { newTankChemistry } from '@aquarium/shared';
import { describe, expect, it } from 'vitest';
import {
  NO_CO2_NOTE,
  blackwaterPhGuidance,
  blackwaterReportLines,
  equipmentNote,
  sharedPhRange,
} from './blackwater';
import { devicesForBiome } from './equipment';
import { FISH_1, FISH_2, fishFixture, speciesFixture, tankFixture } from './fixtures';

const withPh = (id: string, phRange: [number, number]) => {
  const s = speciesFixture({ id, biome: 'blackwater' });
  return { ...s, chemistry: { ...s.chemistry, phRange } };
};
const tetra = withPh('cardinal', [5.0, 7.0]);
const apisto = withPh('apisto', [5.5, 6.5]);

function tank(fish = [fishFixture(FISH_1, { species: 'cardinal' })]) {
  return tankFixture({ biome: 'blackwater', chemistry: newTankChemistry('blackwater'), fish });
}

describe('sharedPhRange', () => {
  it('intersects the ranges of living fish', () => {
    const t = tank([
      fishFixture(FISH_1, { species: 'cardinal' }),
      fishFixture(FISH_2, { species: 'apisto' }),
    ]);
    expect(sharedPhRange(t, [tetra, apisto])).toEqual([5.5, 6.5]);
  });

  it('is null for an empty tank and for ranges that do not overlap', () => {
    expect(sharedPhRange(tank([]), [tetra])).toBeNull();
    const far = withPh('far', [7.5, 8.5]);
    const t = tank([
      fishFixture(FISH_1, { species: 'cardinal' }),
      fishFixture(FISH_2, { species: 'far' }),
    ]);
    expect(sharedPhRange(t, [tetra, far])).toBeNull();
  });
});

describe('blackwaterPhGuidance', () => {
  const species = [tetra, apisto];
  const apistoTank = tank([fishFixture(FISH_2, { species: 'apisto' })]);

  it('only speaks for blackwater tanks', () => {
    expect(blackwaterPhGuidance(tankFixture(), species, 6)).toBeNull();
  });

  it('ignores a non-finite reading', () => {
    expect(blackwaterPhGuidance(apistoTank, species, Number.NaN)).toBeNull();
  });

  it('reports a pH in the middle of the range as fine', () => {
    expect(blackwaterPhGuidance(apistoTank, species, 6)?.standing).toBe('in-range');
  });

  it('warns near either edge', () => {
    expect(blackwaterPhGuidance(apistoTank, species, 5.6)?.standing).toBe('near-edge');
    expect(blackwaterPhGuidance(apistoTank, species, 6.4)?.standing).toBe('near-edge');
  });

  it('recommends a water change when pH is too high, never CO2', () => {
    const g = blackwaterPhGuidance(apistoTank, species, 7.2);
    expect(g?.standing).toBe('too-high');
    expect(g?.text).toMatch(/change some water/i);
    expect(g?.text).toMatch(/CO₂ is not used/);
  });

  it('recommends vacuum and water change when pH is too low', () => {
    const g = blackwaterPhGuidance(apistoTank, species, 5.0);
    expect(g?.standing).toBe('too-low');
    expect(g?.text).toMatch(/vacuum/i);
  });

  it('describes an empty tank without judging the pH', () => {
    expect(blackwaterPhGuidance(tank([]), species, 6)?.standing).toBe('no-fish');
  });

  it('flags fish that cannot share water', () => {
    const far = withPh('far', [7.5, 8.5]);
    const t = tank([
      fishFixture(FISH_1, { species: 'cardinal' }),
      fishFixture(FISH_2, { species: 'far' }),
    ]);
    expect(blackwaterPhGuidance(t, [tetra, far], 6)?.text).toMatch(/do not share/);
  });
});

describe('blackwater shop and report', () => {
  it('explains the missing CO2 system and does not sell one', () => {
    expect(devicesForBiome('blackwater')).not.toContain('co2');
    expect(equipmentNote('blackwater')).toBe(NO_CO2_NOTE);
    expect(equipmentNote('freshwater')).toBeNull();
  });

  it('adds a pH line to the text report only for blackwater', () => {
    expect(blackwaterReportLines(tank(), [tetra])).toHaveLength(1);
    expect(blackwaterReportLines(tankFixture(), [tetra])).toEqual([]);
  });
});
