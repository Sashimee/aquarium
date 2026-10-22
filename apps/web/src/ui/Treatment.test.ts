import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Tank } from '@aquarium/shared';
import { FISH_1, FISH_2, fishFixture, speciesFixture, tankFixture } from '../sync/fixtures';
import { speciesNameMap } from '../sync/life';
import type { TankSession } from '../sync/session';
import { INITIAL_STATE, type SessionState } from '../sync/state';
import { FishCard } from './FishCard';
import {
  DoseConfirmation,
  DoseWarning,
  PendingDoseWarning,
  QuarantineSection,
  Treatment,
} from './Treatment';
import type { ApiClient } from './api';

vi.mock('./context', async (original) => ({
  ...(await original<typeof import('./context')>()),
  useApi: () => ({}) as ApiClient,
}));

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

describe('Treatment held refusal', () => {
  const sickTank = tankFixture({ fish: [fishFixture(FISH_1, { disease: ich })] });
  const refusal = {
    kind: 'ich' as const,
    message: 'The water is too dirty for medicine.',
    waterChange: true,
  };
  const render = (heldTankId: string) =>
    renderToStaticMarkup(
      createElement(Treatment, {
        session,
        state: state(),
        tank: sickTank,
        initialHeld: { tankId: heldTankId, pending: null, refusal },
      }),
    );

  it('shows a refusal held for this tank', () => {
    expect(render(sickTank.id)).toContain('The water is too dirty for medicine.');
  });

  it('drops a refusal held for another tank, so coming back to this one starts clean', () => {
    expect(render('00000000-0000-4000-8000-0000000000bb')).not.toContain(
      'The water is too dirty for medicine.',
    );
  });
});

describe('DoseConfirmation', () => {
  it('asks for the Pearl price of a premium dose next to the buttons', () => {
    const html = renderToStaticMarkup(
      createElement(DoseConfirmation, {
        pending: {
          kind: 'ich',
          potency: 'premium',
          warnings: ['The water already holds a dose.'],
        },
        balance: 100,
        onConfirm: () => undefined,
        onCancel: () => undefined,
      }),
    );
    expect(html).toContain('Buy premium');
    expect(html).toContain('60 Pearls left');
    expect(html).toContain('Dose anyway');
    expect(html).toContain('Keep things as they are');
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

describe('moving sick fish', () => {
  const q = tankFixture({
    id: '00000000-0000-4000-8000-0000000000aa',
    name: 'Quarantine',
    quarantine: true,
  });
  const sickTank = tankFixture({ fish: [fishFixture(FISH_1, { name: 'Pip', disease: ich })] });

  it('offers to move a sick fish to the quarantine tank', () => {
    const html = treatment(sickTank, state({ tanks: [sickTank, q] }));
    expect(html).toContain('Move Pip to Quarantine');
  });

  it('offers nothing when there is no quarantine tank', () => {
    expect(treatment(sickTank, state({ tanks: [sickTank] }))).not.toContain('Move Pip');
  });

  it('offers to move a sick fish back from the quarantine tank to the display tank', () => {
    const sickInQ = { ...q, fish: [fishFixture(FISH_2, { name: 'Dot', disease: ich })] };
    expect(treatment(sickInQ, state({ tanks: [sickTank, sickInQ] }))).toContain(
      'Move Dot to Home tank',
    );
  });

  it('lists every living fish in the quarantine tank to move back', () => {
    const inQ = {
      ...q,
      fish: [
        fishFixture(FISH_2, { name: 'Dot' }),
        fishFixture(FISH_1, { name: 'Gone', status: 'dead', diedAt: '2026-02-01T00:00:00.000Z' }),
      ],
    };
    const html = renderToStaticMarkup(
      createElement(QuarantineSection, {
        session,
        state: state({ tanks: [sickTank, inQ] }),
        tank: inQ,
      }),
    );
    expect(html).toContain('Move Dot to Home tank');
    expect(html).not.toContain('Move Gone');
  });

  it('leaves a sick fish to its treatment card instead of listing it twice', () => {
    const sickInQ = { ...q, fish: [fishFixture(FISH_2, { name: 'Dot', disease: ich })] };
    const html = renderToStaticMarkup(
      createElement(QuarantineSection, {
        session,
        state: state({ tanks: [sickTank, sickInQ] }),
        tank: sickInQ,
      }),
    );
    expect(html).not.toContain('Move Dot');
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

describe('PendingDoseWarning', () => {
  const warnings = ['The water already holds a dose.'];

  it('puts the Pearl price of a premium dose into the confirmation', () => {
    const html = renderToStaticMarkup(
      createElement(PendingDoseWarning, {
        pending: { kind: 'ich', potency: 'premium', warnings },
        balance: 100,
      }),
    );
    expect(html).toContain('Pearls?');
    expect(html).toContain('60 Pearls left');
  });

  it('asks for no price when the confirmed dose is the free one', () => {
    const html = renderToStaticMarkup(
      createElement(PendingDoseWarning, {
        pending: { kind: 'ich', potency: 'standard', warnings },
        balance: 100,
      }),
    );
    expect(html).toContain('The water already holds a dose.');
    expect(html).not.toContain('Pearls');
  });
});
