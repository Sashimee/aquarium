import type { Coral } from '@aquarium/shared';
import { describe, expect, it } from 'vitest';
import type { PlacedCoral } from './coralColliders';
import { PICK_MARGIN_M, pickCoral } from './coralPick';
import { item } from './fixtures';
import type { DecorSpec } from './spec';

const coral = (key: string): Coral => ({
  key,
  assetId: 'acropora-cytherea',
  tintSeed: 1,
  parentKey: null,
  position: null,
  size: 1,
  minSize: 0.4,
  maxSize: 2,
  fragMinSize: 1.5,
  bleach: 0,
});

const box = { min: [-0.1, 0, -0.1], max: [0.1, 0.1, 0.1] } as const;
const specs = new Map<string, DecorSpec>([
  ['acropora-cytherea', { assetId: 'acropora-cytherea', kind: 'coral', label: 'Acropora', box }],
]);
const placedAt = (
  key: string,
  x: number,
  z: number,
  assetId = 'acropora-cytherea',
  scale = 1,
): PlacedCoral => ({ coral: coral(key), item: item(assetId, x, z, { scale }, 0) });
const ahead = (x: number, y = 0.05) => ({
  origin: { x, y, z: 1 },
  dir: { x: 0, y: 0, z: -1 },
});
const noBounds = () => null;

describe('pickCoral', () => {
  it('returns the coral the ray enters and null when it passes by', () => {
    const placed = [placedAt('a', 0, 0)];
    expect(pickCoral(placed, specs, noBounds, ahead(0))?.key).toBe('a');
    expect(pickCoral(placed, specs, noBounds, ahead(0.5))).toBeNull();
  });

  it('takes the nearer of two corals on the same ray', () => {
    const placed = [placedAt('back', 0, -0.5), placedAt('front', 0, 0.3)];
    expect(pickCoral(placed, specs, noBounds, ahead(0))?.key).toBe('front');
    expect(pickCoral([...placed].reverse(), specs, noBounds, ahead(0))?.key).toBe('front');
  });

  it('forgives a tap just outside the model box, but not far outside', () => {
    const placed = [placedAt('a', 0, 0)];
    expect(pickCoral(placed, specs, noBounds, ahead(0.1 + PICK_MARGIN_M / 2))?.key).toBe('a');
    expect(pickCoral(placed, specs, noBounds, ahead(0.1 + PICK_MARGIN_M * 2))).toBeNull();
  });

  it('misses over the top of a low coral', () => {
    expect(pickCoral([placedAt('a', 0, 0)], specs, noBounds, ahead(0, 0.3))).toBeNull();
  });

  it('measures a coral with no spec by its model bounds', () => {
    const placed = [placedAt('e', 0, 0, 'euphyllia-hammer-3')];
    const bounds = (id: string) => (id === 'euphyllia-hammer-3' ? box : null);
    expect(pickCoral(placed, specs, bounds, ahead(0))?.key).toBe('e');
  });

  it('skips a coral it cannot measure', () => {
    const placed = [placedAt('e', 0, 0, 'euphyllia-hammer-3')];
    expect(pickCoral(placed, specs, noBounds, ahead(0))).toBeNull();
  });

  it('sizes the box by the item scale', () => {
    const big = [placedAt('a', 0, 0, 'acropora-cytherea', 3)];
    expect(pickCoral(big, specs, noBounds, ahead(0.25))?.key).toBe('a');
    expect(pickCoral([placedAt('a', 0, 0)], specs, noBounds, ahead(0.25))).toBeNull();
  });
});
