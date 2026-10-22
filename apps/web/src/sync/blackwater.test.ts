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
import { tankReportLines } from './life';
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

  it('says a high pH settles on its own and never suggests CO2', () => {
    const g = blackwaterPhGuidance(apistoTank, species, 7.2);
    expect(g?.standing).toBe('too-high');
    expect(g?.text).toMatch(/drifts back toward pH 6 on its own/);
    expect(g?.text).toMatch(/will not lower it/);
    expect(g?.text).not.toMatch(/change some water/i);
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
    const g = blackwaterPhGuidance(t, [tetra, far], 6);
    expect(g?.standing).toBe('no-overlap');
    expect(g?.text).toMatch(/do not share/);
  });

  it('never blames fish whose species is not loaded', () => {
    const t = tank([fishFixture(FISH_1, { species: 'mystery' })]);
    expect(blackwaterPhGuidance(t, [tetra], 6)).toBeNull();
    expect(blackwaterReportLines(t, [tetra])).toEqual([]);
  });

  it('ignores an unloaded species next to a known one', () => {
    const t = tank([
      fishFixture(FISH_1, { species: 'mystery' }),
      fishFixture(FISH_2, { species: 'apisto' }),
    ]);
    expect(blackwaterPhGuidance(t, [apisto], 6)?.standing).toBe('in-range');
  });

  it('compares the rounded value it shows', () => {
    const g = blackwaterPhGuidance(apistoTank, species, 6.54);
    expect(g?.standing).toBe('near-edge');
    expect(g?.text).toMatch(/^pH 6\.5 /);
    const edge = tank([fishFixture(FISH_1, { species: 'cardinal' })]);
    const high = blackwaterPhGuidance(edge, species, 7.04);
    expect(high?.standing).not.toBe('too-high');
    expect(high?.text).toMatch(/^pH 7\.0 /);
    expect(blackwaterPhGuidance(edge, species, 7.06)?.standing).toBe('too-high');
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

  it('keeps the live pH number out of the report', () => {
    for (const ph of [4.9, 5.6, 6.04, 7.4]) {
      const t = tank([fishFixture(FISH_2, { species: 'apisto' })]);
      const lines = blackwaterReportLines({ ...t, chemistry: { ...t.chemistry, ph } }, [
        apisto,
      ]).join(' ');
      expect(lines).not.toContain(ph.toFixed(1));
      expect(lines).not.toMatch(/pH \d/);
    }
  });

  it('reaches the report through tankReportLines', () => {
    const t = tank([fishFixture(FISH_2, { species: 'apisto' })]);
    expect(tankReportLines(t, [apisto]).join(' ')).toMatch(/pH range/);
    expect(tankReportLines(tankFixture(), [apisto]).join(' ')).not.toMatch(/pH range/);
  });
});
