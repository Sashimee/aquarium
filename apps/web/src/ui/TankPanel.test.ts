import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { tankFixture } from '../sync/fixtures';
import type { TankSession } from '../sync/session';
import { INITIAL_STATE } from '../sync/state';
import { NewTankForm } from './TankPanel';
import { QuarantineSection } from './Treatment';

const session = {} as TankSession;
const state = { ...INITIAL_STATE, tanks: [tankFixture()] };

describe('tank type pickers', () => {
  it('the new tank form offers freshwater and reef, not cichlid', () => {
    const html = renderToStaticMarkup(
      createElement(NewTankForm, { session, state, initialBiome: 'freshwater' }),
    );
    expect(html).toContain('value="freshwater"');
    expect(html).toContain('value="reef"');
    expect(html).not.toContain('value="cichlid"');
  });

  it('the quarantine form offers freshwater and reef, not cichlid', () => {
    const tank = tankFixture();
    const html = renderToStaticMarkup(
      createElement(QuarantineSection, { session, state: { ...state, tanks: [tank] }, tank }),
    );
    expect(html).not.toContain('value="cichlid"');
  });
});
