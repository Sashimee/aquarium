import type { SpeciesSummary } from '@aquarium/shared';
import { describe, expect, it } from 'vitest';
import { FISH_1, FISH_2, TANK_A, fishFixture, speciesFixture, tankFixture } from './fixtures';
import {
  canBuy,
  deadFish,
  describeAway,
  formatDuration,
  memorialLine,
  netPrompt,
  shouldShowAway,
  speciesNameMap,
  tankCapacity,
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

  it('refuses the wrong biome with a plain reason', () => {
    const verdict = canBuy(tankFixture(), clown, species);
    expect(verdict).toEqual({ ok: false, reason: 'Clownfish needs a reef tank.' });
  });

  it('refuses when the bioload would be exceeded and says how to make room', () => {
    const oscars = [FISH_1, FISH_2].map((id) => fishFixture(id, { species: 'oscar' }));
    const tank = tankFixture({ fish: oscars });
    const verdict = canBuy(tank, oscar, species);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok ? '' : verdict.reason).toBe(
      'This tank is full. Start another tank for more fish.',
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

describe('water report', () => {
  const tank = tankFixture({ fish: [fishFixture(FISH_1)] });

  it('rates ammonia against the strictest living fish', () => {
    expect(
      waterReport({ ammonia: 0, nitrate: 0, algae: 0, uneatenFood: 0 }, tank, species).ammonia,
    ).toBe('good');
    expect(
      waterReport({ ammonia: 0.1, nitrate: 0, algae: 0, uneatenFood: 0 }, tank, species).ammonia,
    ).toBe('fair');
    expect(
      waterReport({ ammonia: 0.2, nitrate: 0, algae: 0, uneatenFood: 0 }, tank, species).ammonia,
    ).toBe('poor');
  });

  it('asks for the gravel vacuum once leftovers pile up', () => {
    expect(
      waterReport({ ammonia: 0, nitrate: 0, algae: 0, uneatenFood: 2 }, tank, species).needsVacuum,
    ).toBe(false);
    expect(
      waterReport({ ammonia: 0, nitrate: 0, algae: 0, uneatenFood: 3 }, tank, species).needsVacuum,
    ).toBe(true);
  });

  it('reads out as text for the tank report', () => {
    const lines = tankReportLines(
      tankFixture({
        fish: [fishFixture(FISH_2, { name: 'Dot', hunger: 0.8 }), deadTetra],
        water: { ammonia: 0, nitrate: 0, algae: 0, uneatenFood: 5 },
      }),
      species,
    );
    expect(lines).toContain('1 fish alive: Dot the neon tetra, starving.');
    expect(lines).toContain('Pip has died and can be netted.');
    expect(lines).toContain('Leftover food is building up. Vacuum the gravel.');
  });
});
