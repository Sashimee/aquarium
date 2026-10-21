import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Tank } from '@aquarium/shared';
import { FISH_1, FISH_2, fishFixture, speciesFixture, tankFixture } from '../sync/fixtures';
import { speciesNameMap } from '../sync/life';
import type { TankSession } from '../sync/session';
import { INITIAL_STATE, type SessionState } from '../sync/state';
import { FishCard } from './FishCard';
import { DoseWarning, QuarantineSection, Treatment } from './Treatment';

const ich = {
  kind: 'ich' as const,
  since: '2026-02-01T00:00:00.000Z',
  severity: 0.5,
  treatedUntil: null,
};
const session = {} as TankSession;
const coolTetra = speciesFixture({
  chemistry: { ...speciesFixture().chemistry, temperatureC: [22, 28] },
});
const state = (overrides: Partial<SessionState> = {}): SessionState => ({
  ...INITIAL_STATE,
  species: [coolTetra],
  ...overrides,
});

function treatment(tank: Tank, s = state()) {
  return renderToStaticMarkup(createElement(Treatment, { session, state: s, tank }));
}

describe('Treatment', () => {
  it('says so when nobody is sick and offers no dose', () => {
    const html = treatment(tankFixture({ fish: [fishFixture(FISH_1)] }));
    expect(html).toContain('No fish in this tank look sick');
    expect(html).not.toContain('Give standard medicine');
  });

  it('offers a free and a premium dose with the Pearl price and the symptoms', () => {
    const html = treatment(
      tankFixture({ fish: [fishFixture(FISH_1, { name: 'Pip', disease: ich })] }),
    );
    expect(html).toContain('Pip shows tiny white spots');
    expect(html).toContain('Give standard medicine (free, 4 days)');
    expect(html).toContain('Give premium medicine (40 Pearls, 2 days)');
  });

  it('does not present heat as a general cure', () => {
    const html = treatment(tankFixture({ fish: [fishFixture(FISH_1, { disease: ich })] }));
    expect(html).toContain('Heat is not a cure for these fish');
  });

  it('disables the doses while a request is running', () => {
    const html = treatment(
      tankFixture({ fish: [fishFixture(FISH_1, { disease: ich })] }),
      state({ busy: true }),
    );
    expect(html.match(/disabled=""/g)).toHaveLength(2);
  });
});

describe('FishCard symptoms', () => {
  const names = speciesNameMap([speciesFixture()]);

  it('shows the illness on a sick fish and nothing on a healthy one', () => {
    const sick = renderToStaticMarkup(
      createElement(FishCard, { fish: fishFixture(FISH_1, { disease: ich }), names }),
    );
    expect(sick).toContain('Ich');
    expect(sick).toContain('clearly sick');
    const well = renderToStaticMarkup(
      createElement(FishCard, { fish: fishFixture(FISH_2), names }),
    );
    expect(well).not.toContain('symptom');
  });
});

describe('QuarantineSection', () => {
  const render = (tanks: Tank[], tank: Tank) =>
    renderToStaticMarkup(
      createElement(QuarantineSection, { session, state: state({ tanks }), tank }),
    );

  it('offers to set one up when there is none', () => {
    const tank = tankFixture();
    expect(render([tank], tank)).toContain('Set up the quarantine tank');
  });

  it('offers to open it from a display tank, and says so inside it', () => {
    const tank = tankFixture();
    const q = tankFixture({
      id: '00000000-0000-4000-8000-0000000000aa',
      name: 'Quarantine',
      quarantine: true,
    });
    const away = render([tank, q], tank);
    expect(away).toContain('Open Quarantine');
    expect(away).not.toContain('Set up the quarantine tank');
    expect(render([tank, q], q)).toContain('You are looking at the quarantine tank');
  });
});

describe('DoseWarning', () => {
  const warnings = ['The water already holds a dose.'];

  it('shows the warning and, for a premium dose, the price once', () => {
    const html = renderToStaticMarkup(
      createElement(DoseWarning, {
        warnings,
        cost: { label: 'premium ich medicine', price: 40 },
        balance: 100,
      }),
    );
    expect(html).toContain('The water already holds a dose.');
    expect(html).toContain('Buy premium ich medicine for 40 Pearls?');
    expect(html).toContain('60 Pearls left');
  });

  it('shows no price for a free dose', () => {
    const html = renderToStaticMarkup(
      createElement(DoseWarning, { warnings, cost: null, balance: 100 }),
    );
    expect(html).not.toContain('Buy');
  });
});
