import type { SpeciesSummary } from '@aquarium/shared';
import { BIOLOAD_CAPACITY_BY_SIZE } from '@aquarium/sim/lifecycle';
import { describe, expect, it } from 'vitest';
import { FISH_1, FISH_2, TANK_A, fishFixture, speciesFixture, tankFixture } from './fixtures';
import {
  canBuy,
  deadFish,
  describeAway,
  birthSentence,
  formatDuration,
  memorialLine,
  netPrompt,
  newborns,
  shouldShowAway,
  speciesNameMap,
  tankCapacity,
  tankSizeLabel,
  tankSizeShort,
  TANK_SIZE_ORDER,
  tankReportLines,
  waterReport,
} from './life';

const species = [
  speciesFixture(),
  speciesFixture({
    id: 'oscar',
    commonName: 'Oscar',
    lifecycle: { ...speciesFixture().lifecycle, bioload: 6 },
  }),
  speciesFixture({ id: 'clownfish', commonName: 'Clownfish', biome: 'reef' }),
];
const [tetra, oscar, clown] = species as [SpeciesSummary, SpeciesSummary, SpeciesSummary];
const names = speciesNameMap(species);

const deadTetra = fishFixture(FISH_1, {
  name: 'Pip',
  status: 'dead',
  diedAt: '2026-02-03T00:00:00.000Z',
  cause: 'starvation',
});

describe('while you were away', () => {
  it('shows only when long enough or when something died', () => {
    expect(shouldShowAway(undefined)).toBe(false);
    expect(shouldShowAway({ elapsedMinutes: 30, capped: false, deaths: [] })).toBe(false);
    expect(shouldShowAway({ elapsedMinutes: 60, capped: false, deaths: [] })).toBe(true);
    const death = {
      fishId: FISH_1,
      name: 'Pip',
      species: 'neon-tetra',
      cause: 'ammonia' as const,
      diedAt: '2026-02-03T00:00:00.000Z',
    };
    expect(shouldShowAway({ elapsedMinutes: 20, capped: false, deaths: [death] })).toBe(true);
  });

  it('renders the server payload: duration, cap and each death with its cause', () => {
    const report = describeAway(
      {
        elapsedMinutes: 60 * 24 * 5,
        capped: true,
        deaths: [
          {
            fishId: FISH_1,
            name: 'Pip',
            species: 'neon-tetra',
            cause: 'starvation',
            diedAt: '2026-02-03T00:00:00.000Z',
          },
          {
            fishId: FISH_2,
            name: 'Ollie',
            species: 'oscar',
            cause: 'old_age',
            diedAt: '2026-02-04T00:00:00.000Z',
          },
        ],
      },
      names,
    );
    expect(report.tone).toBe('loss');
    expect(report.title).toBe('We are sorry');
    expect(report.lines[0]).toBe('You were away for 5 days.');
    expect(report.lines).toContain('2 fish died while you were gone.');
    expect(report.lines.some((l) => l.includes('60 days'))).toBe(true);
    expect(report.deaths.map((d) => d.sentence)).toEqual([
      'Pip the neon tetra went too long without food.',
      'Ollie the oscar died of old age after a full life.',
    ]);
    expect(report.deaths[0]?.advice).toMatch(/food each day/);
  });

  it('is calm when nobody died', () => {
    const report = describeAway({ elapsedMinutes: 180, capped: false, deaths: [] }, names);
    expect(report.tone).toBe('calm');
    expect(report.lines).toEqual(['You were away for 3 hours.', 'Everyone is still alive.']);
    expect(report.deaths).toEqual([]);
  });

  it('falls back to the species id when the catalogue lacks a name', () => {
    const report = describeAway(
      {
        elapsedMinutes: 90,
        capped: false,
        deaths: [
          {
            fishId: FISH_1,
            name: 'Pip',
            species: 'blue-gourami',
            cause: 'unknown',
            diedAt: '2026-02-03T00:00:00.000Z',
          },
        ],
      },
      names,
    );
    expect(report.deaths[0]?.sentence).toBe(
      'Pip the blue gourami died of a cause we could not tell.',
    );
  });

  it('formats durations at each scale', () => {
    expect(formatDuration(5)).toBe('5 minutes');
    expect(formatDuration(60)).toBe('1 hour');
    expect(formatDuration(47 * 60)).toBe('47 hours');
    expect(formatDuration(72 * 60)).toBe('3 days');
  });
});

describe('net and memorial', () => {
  it('prompts with the name and cause, and labels the confirm button with the name', () => {
    const step = netPrompt(deadTetra, names);
    expect(step.prompt).toBe(
      'Pip the neon tetra went too long without food. Net Pip and add them to the memorial?',
    );
    expect(step.confirmLabel).toBe('Net Pip');
  });

  it('refuses to build a prompt for a living fish', () => {
    expect(() => netPrompt(fishFixture(FISH_2), names)).toThrow(/dead fish/);
  });

  it('lists only dead fish as nettable', () => {
    const tank = tankFixture({ fish: [fishFixture(FISH_2), deadTetra] });
    expect(deadFish(tank).map((f) => f.name)).toEqual(['Pip']);
  });

  it('writes a memorial line with lifespan, date and cause', () => {
    expect(
      memorialLine(
        {
          id: FISH_1,
          tankId: TANK_A,
          fishName: 'Pip',
          species: 'neon-tetra',
          bornAt: '2026-01-01T00:00:00.000Z',
          diedAt: '2026-01-11T09:00:00.000Z',
          cause: 'ammonia',
        },
        names,
      ),
    ).toBe(
      'Pip, neon tetra. Lived 10 days, died 2026-01-11: was poisoned by ammonia in the water.',
    );
  });
});

describe('shop capacity', () => {
  it('counts only living fish toward the load', () => {
    const tank = tankFixture({ fish: [fishFixture(FISH_2), deadTetra] });
    expect(tankCapacity(tank, species)).toMatchObject({ usedBioload: 0.25, livingFish: 1 });
  });

  it('allows a fish that fits', () => {
    expect(canBuy(tankFixture(), tetra, species)).toEqual({ ok: true });
  });

  describe('tank length gate', () => {
    const mono = speciesFixture({ id: 'silver-mono', commonName: 'Silver mono' });
    const all = [mono];

    it('refuses a tank shorter than the minimum', () => {
      expect(canBuy(tankFixture({ size: 'standard' }), mono, all)).toEqual({
        ok: false,
        reason: 'Silver mono needs a tank at least 150 cm long.',
      });
    });

    it('allows a tank exactly at the minimum', () => {
      expect(canBuy(tankFixture({ size: 'long300' }), mono, all)).toEqual({ ok: true });
    });

    it('exempts quarantine tanks', () => {
      expect(canBuy(tankFixture({ size: 'standard', quarantine: true }), mono, all)).toEqual({
        ok: true,
      });
    });

    it('leaves ungated species alone', () => {
      expect(canBuy(tankFixture({ size: 'standard' }), tetra, species)).toEqual({ ok: true });
    });
  });

  describe('adult length gate', () => {
    const tang = speciesFixture({
      id: 'blue-tang',
      commonName: 'Blue tang',
      biome: 'reef',
      lifecycle: { ...speciesFixture().lifecycle, maxSizeM: 0.267 },
    });

    it('refuses a species that outgrows a nano tank and names the limit', () => {
      const verdict = canBuy(tankFixture({ size: 'nano30', biome: 'reef' }), tang, [tang]);
      expect(verdict.ok).toBe(false);
      expect(verdict.ok ? '' : verdict.reason).toMatch(
        /^Blue tang grows to 27 cm, but this tank only holds fish up to \d+ cm/,
      );
    });

    it('does not let quarantine bypass it', () => {
      const quarantine = tankFixture({ size: 'nano30', biome: 'reef', quarantine: true });
      expect(canBuy(quarantine, tang, [tang]).ok).toBe(false);
    });

    it('allows it in a bigger tank', () => {
      expect(canBuy(tankFixture({ size: 'standard', biome: 'reef' }), tang, [tang])).toEqual({
        ok: true,
      });
    });
  });

  it('refuses the wrong biome with a plain reason', () => {
    const verdict = canBuy(tankFixture(), clown, species);
    expect(verdict).toEqual({ ok: false, reason: 'Clownfish needs a reef tank.' });
  });

  it('refuses when the bioload would be exceeded and says how to make room', () => {
    const oscars = [FISH_1, FISH_2].map((id) => fishFixture(id, { species: 'oscar' }));
    const tank = tankFixture({ fish: oscars });
    const verdict = canBuy(tank, oscar, species);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok ? '' : verdict.reason).toMatch(
      /^This tank is full: Oscar would push the water load past \d+\. Start another tank/,
    );
  });

  it('does not count dead fish against the capacity', () => {
    const dead = [FISH_1, FISH_2].map((id) =>
      fishFixture(id, {
        species: 'oscar',
        status: 'dead',
        diedAt: '2026-02-01T00:00:00.000Z',
        cause: 'starvation',
      }),
    );
    const tank = tankFixture({ fish: dead });
    expect(canBuy(tank, oscar, species)).toEqual({ ok: true });
  });
});

describe('shop capacity per tank size', () => {
  const unit = (id: string, bioload: number): SpeciesSummary =>
    speciesFixture({
      id,
      lifecycle: { ...speciesFixture().lifecycle, bioload },
    });
  const stock = (n: number, speciesId = 'unit') =>
    Array.from({ length: n }, (_, i) =>
      fishFixture(`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, {
        species: speciesId,
        name: `Fish ${i}`,
      }),
    );

  it.each(TANK_SIZE_ORDER)('%s reports its own bioload capacity', (size) => {
    expect(tankCapacity(tankFixture({ size }), species).capacity).toBe(
      BIOLOAD_CAPACITY_BY_SIZE[size],
    );
  });

  it.each(TANK_SIZE_ORDER)(
    '%s accepts a fish that reaches the cap exactly and refuses one over',
    (size) => {
      const cap = BIOLOAD_CAPACITY_BY_SIZE[size];
      const unitFish = unit('unit', 1);
      const half = unit('half', 0.5);
      const all = [unitFish, half];
      const tank = tankFixture({ size, fish: stock(cap - 1) });
      expect(canBuy(tank, unitFish, all)).toEqual({ ok: true });
      const full = tankFixture({ size, fish: stock(cap) });
      expect(canBuy(full, half, all).ok).toBe(false);
      expect(canBuy(full, unitFish, all).ok).toBe(false);
      const nearly = tankFixture({ size, fish: stock(cap - 1) });
      expect(canBuy(nearly, unit('over', 1.01), [...all, unit('over', 1.01)]).ok).toBe(false);
    },
  );

  it('applies the nano cap where the standard tank would still have room', () => {
    const fish = stock(3);
    expect(
      canBuy(tankFixture({ size: 'nano30', fish }), unit('unit', 1), [unit('unit', 1)]).ok,
    ).toBe(false);
    expect(
      canBuy(tankFixture({ size: 'standard', fish }), unit('unit', 1), [unit('unit', 1)]),
    ).toEqual({ ok: true });
  });

  it('refuses at the animal cap of a nano even when the load fits', () => {
    const tiny = unit('unit', 0.01);
    const fish = stock(12);
    expect(canBuy(tankFixture({ size: 'nano30', fish: fish.slice(0, 11) }), tiny, [tiny]).ok).toBe(
      true,
    );
    expect(canBuy(tankFixture({ size: 'nano30', fish }), tiny, [tiny]).ok).toBe(false);
    const full = canBuy(tankFixture({ size: 'nano30', fish }), tiny, [tiny]);
    expect(full.ok ? '' : full.reason).toContain('holds at most 12 animals');
  });

  it('labels each size with litres, length and capacity', () => {
    expect(tankSizeLabel('nano30')).toBe('Nano, 30 L, 0.4 m long (up to 12 animals, load 3)');
    expect(tankSizeLabel('std200')).toContain('1.0 m long');
  });

  it('tells the two 300 L tanks apart by their length', () => {
    expect(tankSizeLabel('standard')).toContain('300 L, 1.2 m long');
    expect(tankSizeLabel('long300')).toContain('300 L, 1.5 m long');
    expect(tankSizeLabel('standard')).not.toBe(tankSizeLabel('long300'));
  });

  it('shortens a size to name and litres for the tank switcher', () => {
    expect(tankSizeShort('nano30')).toBe('Nano 30 L');
    expect(tankSizeShort('long300')).toBe('Long 300 L');
  });
});

describe('water report', () => {
  const tank = tankFixture({ fish: [fishFixture(FISH_1)] });

  it('rates ammonia against the strictest living fish', () => {
    expect(
      waterReport({ ammonia: 0, nitrate: 0, algae: 0, tannin: 0, uneatenFood: 0 }, tank, species)
        .ammonia,
    ).toBe('good');
    expect(
      waterReport({ ammonia: 0.1, nitrate: 0, algae: 0, tannin: 0, uneatenFood: 0 }, tank, species)
        .ammonia,
    ).toBe('fair');
    expect(
      waterReport({ ammonia: 0.2, nitrate: 0, algae: 0, tannin: 0, uneatenFood: 0 }, tank, species)
        .ammonia,
    ).toBe('poor');
  });

  it('asks for the gravel vacuum once leftovers pile up', () => {
    expect(
      waterReport({ ammonia: 0, nitrate: 0, algae: 0, tannin: 0, uneatenFood: 2 }, tank, species)
        .needsVacuum,
    ).toBe(false);
    expect(
      waterReport({ ammonia: 0, nitrate: 0, algae: 0, tannin: 0, uneatenFood: 3 }, tank, species)
        .needsVacuum,
    ).toBe(true);
  });

  it('reads out as text for the tank report', () => {
    const lines = tankReportLines(
      tankFixture({
        fish: [fishFixture(FISH_2, { name: 'Dot', hunger: 0.8 }), deadTetra],
        water: { ammonia: 0, nitrate: 0, algae: 0, tannin: 0, uneatenFood: 5 },
      }),
      species,
    );
    expect(lines).toContain('1 fish alive: Dot the neon tetra, starving.');
    expect(lines).toContain('Pip has died and can be netted.');
    expect(lines).toContain('Leftover food is building up. Vacuum the gravel.');
  });
});

describe('births', () => {
  const fry = (id: string, over = {}) => fishFixture(id, { stage: 'fry', name: 'Tiny', ...over });

  it('counts only live fry the player did not buy as newborns', () => {
    const dead = fry(FISH_2, {
      status: 'dead',
      diedAt: '2026-02-01T00:00:00.000Z',
      cause: 'unknown',
    });
    const adult = fishFixture('10000000-0000-4000-8000-000000000009');
    expect(newborns([fry(FISH_1), dead, adult], false).map((f) => f.id)).toEqual([FISH_1]);
    expect(newborns([fry(FISH_1)], true)).toEqual([]);
    expect(newborns([], false)).toEqual([]);
  });

  it('names a single fry and counts a brood', () => {
    expect(birthSentence([fry(FISH_1)], names)).toBe(
      'A neon tetra fry was born. Say hello to Tiny.',
    );
    expect(birthSentence([fry(FISH_1), fry(FISH_2)], names)).toBe('2 neon tetra fry were born.');
    expect(birthSentence([fry(FISH_1), fry(FISH_2, { species: 'oscar' })], names)).toBe(
      '2 fry were born.',
    );
  });

  it('refuses an empty brood', () => {
    expect(() => birthSentence([], names)).toThrow();
  });

  it('tells births that happened while away and shows the screen for them', () => {
    const birth = {
      fishId: FISH_1,
      parentId: FISH_2,
      name: 'Tiny',
      species: 'neon-tetra',
      bornAt: '2026-02-01T00:00:00.000Z',
    };
    const away = {
      elapsedMinutes: 5,
      capped: false,
      deaths: [],
      births: [birth],
    };
    expect(shouldShowAway(away)).toBe(true);
    expect(describeAway(away, names).lines).toContain('One fry was born.');
    expect(describeAway({ ...away, births: [birth, birth] }, names).lines).toContain(
      '2 fry were born.',
    );
    expect(shouldShowAway({ ...away, births: [] })).toBe(false);
  });
});
