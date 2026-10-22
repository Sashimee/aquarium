// @vitest-environment happy-dom
import { newTankChemistry } from '@aquarium/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BUNDLED_CHEMISTRY } from '../sync/bundledEconomy';
import { FISH_1, fishFixture, speciesFixture, tankFixture } from '../sync/fixtures';
import { readPad } from '../sync/waterTest';
import type { Dip } from './dipStore';
import { PhAdvice } from './WaterTest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const base = speciesFixture({ id: 'apisto', biome: 'blackwater' });
const apisto = {
  ...base,
  chemistry: { ...base.chemistry, phRange: [5.5, 6.5] as [number, number] },
};
const blackwater = tankFixture({
  biome: 'blackwater',
  chemistry: newTankChemistry('blackwater'),
  fish: [fishFixture(FISH_1, { species: 'apisto' })],
});

const pad = readPad('ph', 7.04);
const dip = (over: Partial<Dip>): Dip => ({
  at: 0,
  strip: pad ? { ph: pad } : {},
  temperatureC: 26,
  guesses: {},
  revealed: false,
  ...over,
});

describe('PhAdvice', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const render = (tank: typeof blackwater, d: Dip) =>
    act(() => root.render(<PhAdvice tank={tank} species={[apisto]} dip={d} />));

  it('waits until the player has read the pad', () => {
    render(blackwater, dip({}));
    expect(container.querySelector('.ph-advice')).toBeNull();
  });

  it('shows advice at the chart step once the pad is guessed', () => {
    render(blackwater, dip({ guesses: { ph: 3 } }));
    const p = container.querySelector('.ph-advice');
    expect(p?.getAttribute('data-ph-standing')).toBe('too-high');
    expect(p?.textContent).toContain('pH 7.0 is above');
  });

  it('shows advice once all readings are revealed', () => {
    render(blackwater, dip({ revealed: true }));
    expect(container.querySelector('.ph-advice')).not.toBeNull();
  });

  it('points a too-high reading at the botanicals button', () => {
    render(blackwater, dip({ revealed: true }));
    const p = container.querySelector('.ph-advice');
    expect(p?.textContent).toContain('Botanicals release humic acids');
    expect(p?.querySelector('button')?.textContent).toBe('Go to add botanicals');
  });

  it('falls back to waiting when the botanicals are at their ceiling', () => {
    const dark = {
      ...blackwater,
      water: { ...blackwater.water, tannin: BUNDLED_CHEMISTRY.tannin.ceiling.blackwater },
    };
    render(dark, dip({ revealed: true }));
    const p = container.querySelector('.ph-advice');
    expect(p?.textContent).toContain('wait and test again');
    expect(p?.querySelector('button')).toBeNull();
  });

  it('stays silent outside blackwater', () => {
    render(tankFixture(), dip({ revealed: true }));
    expect(container.querySelector('.ph-advice')).toBeNull();
  });
});
