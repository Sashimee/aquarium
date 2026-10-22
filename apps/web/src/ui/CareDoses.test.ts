import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Biome, Tank } from '@aquarium/shared';
import { newTankChemistry } from '@aquarium/shared';
import { BUNDLED_CHEMISTRY } from '../sync/bundledEconomy';
import { tankFixture } from '../sync/fixtures';
import { waterReport } from '../sync/life';
import type { TankSession } from '../sync/session';
import { INITIAL_STATE } from '../sync/state';
import { Care } from './TankPanel';

function render(tank: Tank): string {
  const state = { ...INITIAL_STATE, tanks: [tank] };
  return renderToStaticMarkup(
    createElement(Care, {
      session: {} as TankSession,
      state,
      tank,
      water: waterReport(tank.water, tank, state.species),
      salinity: null,
    }),
  );
}

function tankOf(biome: Biome): Tank {
  return tankFixture({ biome, chemistry: newTankChemistry(biome) });
}

const doseActions = (html: string): string[] =>
  [...html.matchAll(/data-action="(salt_dose|buffer_dose|add_botanicals)"/g)].map(
    (m) => m[1] ?? '',
  );

describe('the water dose list', () => {
  it.each([
    ['freshwater', ['buffer_dose', 'add_botanicals']],
    ['reef', ['salt_dose']],
    ['cichlid', ['buffer_dose']],
    ['blackwater', ['add_botanicals']],
    ['mangrove', ['salt_dose', 'buffer_dose']],
  ] as const)('%s renders only its doses', (biome, expected) => {
    expect(doseActions(render(tankOf(biome)))).toEqual(expected);
  });

  it('shows the reason and disables the salt button on a reef tank at the mix', () => {
    const html = render(tankOf('reef'));
    expect(html).toContain('The water is already as salty as a salt dose can make it.');
    expect(html).toMatch(/data-action="salt_dose"[^>]*disabled=""/);
  });

  it('shows the hint and enables the salt button below the mix', () => {
    const reef = tankOf('reef');
    const html = render({
      ...reef,
      chemistry: { ...reef.chemistry, salinity: BUNDLED_CHEMISTRY.salinity.target.reef - 5 },
    });
    expect(html).toContain('Raises the salinity');
    expect(html).not.toMatch(/data-action="salt_dose"[^>]*disabled/);
  });

  it('shows the buffer reason when the hardness is at the ceiling', () => {
    const cichlid = tankOf('cichlid');
    const html = render({
      ...cichlid,
      chemistry: { ...cichlid.chemistry, kh: BUNDLED_CHEMISTRY.kh.bufferCeiling.cichlid },
    });
    expect(html).toContain('already as hard');
    expect(html).toMatch(/data-action="buffer_dose"[^>]*disabled=""/);
  });
});
