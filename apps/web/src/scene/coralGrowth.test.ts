import { describe, expect, it } from 'vitest';
import type { Coral, DecorItem } from '@aquarium/shared';
import { grownCoralItem, matchLayoutCorals, placeFragments, type CoralSlot } from './coralGrowth';

const item = (tintSeed: number, x = 0, scale = 1): DecorItem => ({
  assetId: 'acropora-cytherea',
  position: [x, 0.05, 0],
  rotationY: 0,
  scale,
  tintSeed,
});

const slot = (it: DecorItem): CoralSlot => ({ assetId: it.assetId, item: it });

const coral = (key: string, over: Partial<Coral> = {}): Coral => ({
  key,
  assetId: 'acropora-cytherea',
  tintSeed: null,
  parentKey: null,
  position: null,
  size: 1,
  minSize: 0.3,
  maxSize: 2.5,
  fragMinSize: 1.5,
  bleach: 0,
  ...over,
});

const flat = () => 0.04;

describe('matchLayoutCorals', () => {
  it('matches nothing when the tank has no coral state', () => {
    expect(matchLayoutCorals([slot(item(5))], []).size).toBe(0);
  });

  it('matches by tint seed and numbers repeated seeds in layout order', () => {
    const slots = [slot(item(5)), slot(item(5, 0.1)), slot(item(9, 0.2))];
    const corals = [coral('s5', { size: 1.2 }), coral('s5-2', { size: 1.7 }), coral('s9')];
    const matched = matchLayoutCorals(slots, corals);
    expect(matched.get(0)?.size).toBe(1.2);
    expect(matched.get(1)?.size).toBe(1.7);
    expect(matched.get(2)?.key).toBe('s9');
  });

  it('does not match a coral of another asset under the same key', () => {
    const matched = matchLayoutCorals([slot(item(5))], [coral('s5', { assetId: 'brain-coral' })]);
    expect(matched.size).toBe(0);
  });

  it('ignores fragments when matching layout pieces', () => {
    const matched = matchLayoutCorals(
      [slot(item(5))],
      [coral('s5.1', { parentKey: 's5', position: [0, 0] })],
    );
    expect(matched.size).toBe(0);
  });
});

describe('grownCoralItem', () => {
  it('leaves an item with no coral state as laid out', () => {
    const base = item(1, 0, 0.8);
    expect(grownCoralItem(base, undefined)).toBe(base);
  });

  it('keeps the placed scale at size 1', () => {
    const base = item(1, 0, 0.8);
    expect(grownCoralItem(base, coral('s1'))).toBe(base);
  });

  it('scales by the colony size', () => {
    expect(grownCoralItem(item(1, 0, 0.8), coral('s1', { size: 1.5 })).scale).toBeCloseTo(1.2);
  });

  it('holds at the species maximum', () => {
    expect(grownCoralItem(item(1), coral('s1', { size: 9 })).scale).toBe(2.5);
  });

  it('holds at the species minimum after fragging', () => {
    expect(grownCoralItem(item(1), coral('s1', { size: 0.01 })).scale).toBe(0.3);
  });

  it('keeps its size when fully bleached', () => {
    expect(grownCoralItem(item(1), coral('s1', { size: 1.4, bleach: 1 })).scale).toBeCloseTo(1.4);
  });
});

describe('placeFragments', () => {
  const root = coral('s5', { size: 1.6 });
  const frag = coral('s5.1', { parentKey: 's5', position: [0.1, 0.05], size: 0.3 });

  it('keeps a fragment visible when the cap against the glass is zero', () => {
    const [placed] = placeFragments([slot(item(5, 0, 0.8))], [root, frag], flat, () => 0);
    expect(placed?.item.scale).toBeGreaterThan(0);
  });

  it('places nothing when there are no fragments or no state', () => {
    expect(placeFragments([slot(item(5))], [root], flat)).toEqual([]);
    expect(placeFragments([slot(item(5))], [], flat)).toEqual([]);
  });

  it('stands a fragment on the substrate, sized from its colony item', () => {
    const [placed] = placeFragments([slot(item(5, 0, 0.8))], [root, frag], flat);
    expect(placed?.item.position).toEqual([0.1, 0.04, 0.05]);
    expect(placed?.item.scale).toBeCloseTo(0.24);
    expect(placed?.item.tintSeed).toBe(5);
    expect(placed?.rootIndex).toBe(0);
  });

  it('follows a fragment of a fragment back to the layout colony', () => {
    const grand = coral('s5.1.1', { parentKey: 's5.1', position: [-0.1, 0], size: 0.4 });
    const placed = placeFragments([slot(item(5))], [root, frag, grand], flat);
    expect(placed.map((p) => p.coral.key)).toEqual(['s5.1', 's5.1.1']);
    expect(placed[1]?.rootIndex).toBe(0);
  });

  it('gives the same key the same yaw every time', () => {
    const a = placeFragments([slot(item(5))], [root, frag], flat)[0]?.item.rotationY;
    const b = placeFragments([slot(item(5))], [root, frag], flat)[0]?.item.rotationY;
    expect(a).toBe(b);
  });

  it('drops a fragment whose colony left the layout', () => {
    expect(placeFragments([slot(item(9))], [root, frag], flat)).toEqual([]);
  });

  it('drops a fragment with a cyclic parent chain instead of looping', () => {
    const a = coral('a', { parentKey: 'b', position: [0, 0] });
    const b = coral('b', { parentKey: 'a', position: [0, 0] });
    expect(placeFragments([slot(item(5))], [a, b], flat)).toEqual([]);
  });

  it('uses the ground height at the fragment spot', () => {
    const [placed] = placeFragments([slot(item(5))], [root, frag], (x) => x);
    expect(placed?.item.position[1]).toBeCloseTo(0.1);
  });
});
