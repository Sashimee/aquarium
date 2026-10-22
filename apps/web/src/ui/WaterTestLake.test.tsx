// @vitest-environment happy-dom
import { newTankChemistry, speciesChemistrySchema } from '@aquarium/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fishFixture, speciesFixture, tankFixture } from '../sync/fixtures';
import { dipStrip, rawValues } from '../sync/waterTest';
import { putDip } from './dipStore';
import WaterTest from './WaterTest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const demasoni = speciesFixture({
  id: 'pseudotropheus-demasoni',
  biome: 'cichlid',
  chemistry: speciesChemistrySchema.parse({ khMin: 6, phRange: [7.5, 8.6] }),
});

function lakeTank(kh: number, biome: 'cichlid' | 'freshwater' = 'cichlid') {
  const chemistry = { ...newTankChemistry(biome), kh };
  return tankFixture({
    biome,
    chemistry,
    fish: [fishFixture('10000000-0000-4000-8000-000000000001', { species: demasoni.id })],
  });
}

describe('the lake notes in the water test kit', () => {
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

  const show = (tank: ReturnType<typeof lakeTank>, revealed: boolean, onWaterChange = vi.fn()) => {
    putDip(tank.id, {
      at: Date.now(),
      strip: dipStrip(tank.biome, rawValues(tank)),
      temperatureC: tank.chemistry.temperatureC,
      guesses: {},
      revealed,
    });
    act(() =>
      root.render(<WaterTest tank={tank} species={[demasoni]} onWaterChange={onWaterChange} />),
    );
    return onWaterChange;
  };

  it('warns about soft water and changes the water on request', () => {
    const onWaterChange = show(lakeTank(3), true);
    const note = container.querySelector('[data-metric="kh"]');
    expect(note?.getAttribute('data-level')).toBe('danger');
    act(() =>
      container.querySelector<HTMLButtonElement>('[data-action="lake-water-change"]')?.click(),
    );
    expect(onWaterChange).toHaveBeenCalledTimes(1);
  });

  it('stays silent for hard water', () => {
    show(lakeTank(10), true);
    expect(container.querySelector('[data-testid="lake-notes"]')).toBeNull();
  });

  it('does not leak the hardness before the player has read the pad', () => {
    show(lakeTank(3), false);
    expect(container.querySelector('[data-testid="lake-notes"]')).toBeNull();
  });

  it('adds nothing to other biomes', () => {
    show(lakeTank(3, 'freshwater'), true);
    expect(container.querySelector('[data-testid="lake-notes"]')).toBeNull();
  });
});
