import { newTankChemistry, speciesChemistrySchema, type DecorItem } from '@aquarium/shared';
import { describe, expect, it } from 'vitest';
import { CAVE_MOUTHS } from '../scene/caves';
import { FISH_1, fishFixture, speciesFixture, tankFixture } from './fixtures';
import {
  SHELTER_ASSET_IDS,
  isShelterAsset,
  isTerritorial,
  lakeWaterNotes,
  shelterCount,
  territoryWarning,
} from './cichlid';

const chemistry = (khMin: number, phRange: [number, number]) =>
  speciesChemistrySchema.parse({ khMin, phRange });

const demasoni = speciesFixture({
  id: 'pseudotropheus-demasoni',
  commonName: 'Demasoni cichlid',
  biome: 'cichlid',
  chemistry: chemistry(6, [7.5, 8.6]),
});
const yellowLab = speciesFixture({
  id: 'labidochromis-caeruleus',
  commonName: 'Electric yellow',
  biome: 'cichlid',
  chemistry: chemistry(5, [7.8, 8.6]),
});
const peacock = speciesFixture({
  id: 'aulonocara-baenschi',
  commonName: 'Benga peacock',
  biome: 'cichlid',
  chemistry: chemistry(6, [7.6, 8.8]),
});
const brichardi = speciesFixture({
  id: 'neolamprologus-brichardi',
  commonName: 'Princess of Burundi',
  biome: 'cichlid',
});
const all = [demasoni, yellowLab, peacock, brichardi];

const item = (assetId: string): DecorItem => ({
  assetId,
  position: [0, 0, 0],
  rotationY: 0,
  scale: 1,
});

const lakeTank = (species: string[], extra: Parameters<typeof tankFixture>[0] = {}) =>
  tankFixture({
    biome: 'cichlid',
    chemistry: newTankChemistry('cichlid'),
    fish: species.map((s, i) =>
      fishFixture(`10000000-0000-4000-8000-00000000001${i}`, { species: s }),
    ),
    ...extra,
  });

describe('lakeWaterNotes', () => {
  it('says nothing for an empty tank', () => {
    expect(lakeWaterNotes(lakeTank([]), all, { kh: 1, ph: 6 })).toEqual([]);
  });

  it('says nothing while hardness and pH are comfortably in range', () => {
    const tank = lakeTank(['pseudotropheus-demasoni']);
    expect(lakeWaterNotes(tank, all, { kh: 10, ph: 8.2 })).toEqual([]);
  });

  it('says nothing for a reading the player has not read yet', () => {
    const tank = lakeTank(['pseudotropheus-demasoni']);
    expect(lakeWaterNotes(tank, all, {})).toEqual([]);
  });

  it('warns below the hardest species floor and offers a water change when tap is harder', () => {
    const tank = lakeTank(['pseudotropheus-demasoni', 'labidochromis-caeruleus']);
    const [note] = lakeWaterNotes(tank, all, { kh: 5 });
    expect(note).toMatchObject({ metric: 'kh', level: 'caution', fix: 'water-change' });
    expect(note?.text).toContain('at least 6');
  });

  it('turns dangerous two dKH below the floor', () => {
    const tank = lakeTank(['pseudotropheus-demasoni']);
    expect(lakeWaterNotes(tank, all, { kh: 4 })[0]?.level).toBe('danger');
  });

  it('flags a reading close above the floor as a watch', () => {
    const tank = lakeTank(['pseudotropheus-demasoni']);
    expect(lakeWaterNotes(tank, all, { kh: 7 })[0]).toMatchObject({ level: 'watch' });
    expect(lakeWaterNotes(tank, all, { kh: 7.5 })).toEqual([]);
  });

  it('has no fix when the tank is already as hard as the source water', () => {
    const tank = lakeTank(['pseudotropheus-demasoni']);
    const hardFish = speciesFixture({ ...demasoni, chemistry: chemistry(12, [7.5, 8.6]) });
    const [note] = lakeWaterNotes(tank, [hardFish], { kh: 10 });
    expect(note).toMatchObject({ metric: 'kh', fix: 'no-fix' });
    expect(note?.text).not.toMatch(/buffer/i);
  });

  it('blames nitrate for low pH without CO2 and offers a water change', () => {
    const tank = lakeTank(['pseudotropheus-demasoni']);
    const [note] = lakeWaterNotes(tank, all, { kh: 10, ph: 7 });
    expect(note).toMatchObject({ metric: 'ph', level: 'caution', fix: 'water-change' });
    expect(note?.text).toContain('Nitrate');
  });

  it('blames the CO2 system for low pH even when hardness is fine', () => {
    const base = lakeTank(['pseudotropheus-demasoni']);
    const tank = { ...base, equipment: { ...base.equipment, co2: { tier: 1 } } };
    const [note] = lakeWaterNotes(tank, all, { kh: 10, ph: 7.2 });
    expect(note).toMatchObject({ metric: 'ph', fix: 'no-fix' });
    expect(note?.text).toContain('CO2');
    expect(note?.text).not.toContain('hardness');
  });

  it('says the ranges clash when no pH suits every species', () => {
    const tank = lakeTank(['pseudotropheus-demasoni', 'aulonocara-baenschi']);
    const lowFish = speciesFixture({ ...demasoni, chemistry: chemistry(6, [7, 7.5]) });
    const highFish = speciesFixture({ ...peacock, chemistry: chemistry(6, [8, 8.8]) });
    const [note] = lakeWaterNotes(tank, [lowFish, highFish], { ph: 7.8 });
    expect(note).toMatchObject({ metric: 'ph', fix: null });
    expect(note?.text).toContain('do not overlap');
  });

  it('uses the narrowest pH window across species', () => {
    const tank = lakeTank(['pseudotropheus-demasoni', 'aulonocara-baenschi']);
    expect(lakeWaterNotes(tank, all, { ph: 8.7 })[0]).toMatchObject({ metric: 'ph' });
    expect(lakeWaterNotes(tank, all, { ph: 8.5 })).toEqual([]);
  });

  it('ignores dead fish', () => {
    const tank = lakeTank([], {
      fish: [fishFixture(FISH_1, { species: 'pseudotropheus-demasoni', status: 'dead' })],
    });
    expect(lakeWaterNotes(tank, all, { kh: 1 })).toEqual([]);
  });
});

describe('shelters', () => {
  it('keeps the asset list in step with the scene', () => {
    const mouths = Object.keys(CAVE_MOUTHS);
    for (const id of mouths) expect(isShelterAsset(id)).toBe(true);
    expect(SHELTER_ASSET_IDS).toEqual(new Set(mouths));
    expect(isShelterAsset('malawi-boulder-03')).toBe(false);
  });

  it('counts the preset while the layout is unedited', () => {
    expect(shelterCount(tankFixture({ biome: 'cichlid' }))).toBeGreaterThanOrEqual(8);
  });

  it('counts the saved layout once edited, including an emptied tank', () => {
    const layout = [item('neothauma-shell'), item('rock-pile-cave'), item('malawi-rock-07')];
    expect(
      shelterCount(tankFixture({ biome: 'cichlid', decorEdited: true, decorLayout: layout })),
    ).toBe(2);
    expect(
      shelterCount(tankFixture({ biome: 'cichlid', decorEdited: true, decorLayout: [] })),
    ).toBe(0);
  });
});

describe('territoryWarning', () => {
  const bare = (fish: string[]) =>
    lakeTank(fish, { decorEdited: true, decorLayout: [item('malawi-rock-07')] });

  it('knows which lake species hold territory', () => {
    expect(isTerritorial('pseudotropheus-demasoni')).toBe(true);
    expect(isTerritorial('labidochromis-caeruleus')).toBe(false);
  });

  it('is silent outside the cichlid biome', () => {
    expect(territoryWarning(tankFixture(), demasoni, all)).toBeNull();
  });

  it('warns when a territorial fish has no hiding place left', () => {
    const text = territoryWarning(bare([]), demasoni, all);
    expect(text).toContain('this tank has 0.');
    expect(text).not.toContain('for 0 fish');
  });

  it('counts the residents that already claim a shelter', () => {
    const roomy = lakeTank(['pseudotropheus-demasoni', 'neolamprologus-brichardi'], {
      decorEdited: true,
      decorLayout: [item('neothauma-shell'), item('rock-pile-cave'), item('rock-pile-stack')],
    });
    expect(territoryWarning(roomy, demasoni, all)).not.toContain('hiding place');
    const tight = lakeTank(['pseudotropheus-demasoni', 'neolamprologus-brichardi'], {
      decorEdited: true,
      decorLayout: [item('neothauma-shell'), item('rock-pile-cave')],
    });
    expect(territoryWarning(tight, demasoni, all)).toContain('2 for 2');
  });

  it('does not ask a peaceful species to find shelter', () => {
    expect(territoryWarning(bare([]), yellowLab, all)).toBeNull();
  });

  it('warns about rivals when shelters suffice', () => {
    const tank = lakeTank(['pseudotropheus-demasoni']);
    expect(territoryWarning(tank, peacock, all)).toContain('defends a territory');
  });

  it('does not call a species its own rival', () => {
    const tank = lakeTank(['pseudotropheus-demasoni']);
    expect(territoryWarning(tank, demasoni, all)).toBeNull();
  });

  it('stays quiet when an empty roomy tank gets its first territorial fish', () => {
    expect(territoryWarning(lakeTank([]), peacock, all)).toBeNull();
  });
});
