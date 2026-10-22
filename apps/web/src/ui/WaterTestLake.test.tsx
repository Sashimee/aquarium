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

  it('links the hardness note to the buffer dose button', () => {
    show(lakeTank(3), true);
    const link = container.querySelector('[data-metric="kh"] button');
    expect(link?.textContent).toBe('Go to add buffer');
    expect(container.querySelector('[data-metric="ph"] button')).toBeNull();
  });

  it('warns about soft water and changes the water on request', () => {
    const onWaterChange = show(lakeTank(3), true);
    const note = container.querySelector('[data-metric="kh"]');
    expect(note?.getAttribute('data-level')).toBe('danger');
    act(() =>
      container.querySelector<HTMLButtonElement>('[data-action="lake-water-change"]')?.click(),
    );
    expect(onWaterChange).toHaveBeenCalledTimes(1);
  });

  it('disables the button while the water change is in flight', async () => {
    let finish = (): void => undefined;
    const onWaterChange = vi.fn(() => new Promise<void>((r) => (finish = r)));
    show(lakeTank(3), true, onWaterChange);
    const button = () =>
      container.querySelector<HTMLButtonElement>('[data-action="lake-water-change"]');
    act(() => button()?.click());
    expect(button()?.disabled).toBe(true);
    act(() => button()?.click());
    expect(onWaterChange).toHaveBeenCalledTimes(1);
    await act(async () => finish());
    expect(button()?.disabled).toBe(false);
  });

  it('keeps the notes a valid list inside a live region', () => {
    show(lakeTank(3), true);
    expect(container.querySelector('[role="status"] > ul > li[data-metric="kh"]')).not.toBeNull();
    expect(container.querySelector('li[role]')).toBeNull();
  });

  it('shows hardness at the chart step', () => {
    show(lakeTank(3.04), true);
    expect(container.querySelector('[data-metric="kh"]')?.textContent).toMatch(
      /Hardness is (\d+(\.\d)?) dKH/,
    );
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
