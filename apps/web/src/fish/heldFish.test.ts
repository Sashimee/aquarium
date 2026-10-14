import { describe, expect, it } from 'vitest';
import { HeldFish, HOLD_TIMEOUT_S, type HoldCandidate } from './heldFish';

function swimming(id: string, extra: Partial<HoldCandidate> = {}): HoldCandidate {
  return { id, shown: true, phase: 'swimming', bagged: false, scripted: false, ...extra };
}

/** a and b held at t = 10 s, after an add or remove failed and the world was dropped. */
function holding(): HeldFish {
  const held = new HeldFish();
  held.hold([swimming('a'), swimming('b')], 10);
  return held;
}

describe('HeldFish', () => {
  it('holds only shown swimming fish that no bag or death script is posing', () => {
    const held = new HeldFish();
    held.hold(
      [
        swimming('swim'),
        swimming('unseen', { shown: false }),
        swimming('bag', { phase: 'bagged', bagged: true }),
        swimming('dying', { scripted: true }),
        swimming('dead', { phase: 'dead', scripted: true }),
      ],
      0,
    );
    expect(held.step('swim', 0, 'no-frame')).toBe('wait');
    for (const id of ['unseen', 'bag', 'dying', 'dead']) {
      expect(held.step(id, 0, 'no-frame')).toBe('free');
    }
  });

  it('keeps held fish waiting while the rebuilt world has posted nothing', () => {
    const held = holding();
    expect(held.step('a', 10, 'no-frame')).toBe('wait');
    expect(held.step('b', 12, 'no-frame')).toBe('wait');
    expect(held.step('a', 10 + HOLD_TIMEOUT_S - 0.01, 'no-frame')).toBe('wait');
  });

  it('blends a held fish into the first frame that has it, and lets it go after', () => {
    const held = holding();
    expect(held.step('a', 11, 'present')).toBe('join');
    expect(held.step('a', 11, 'present')).toBe('free');
    expect(held.step('a', 11, 'no-frame')).toBe('free');
    expect(held.step('b', 11, 'no-frame')).toBe('wait');
  });

  it('lets go of a held fish missing from the new world, with nothing to blend into', () => {
    const held = holding();
    expect(held.step('a', 11, 'missing')).toBe('free');
    expect(held.step('a', 11, 'no-frame')).toBe('free');
    expect(held.step('b', 11, 'present')).toBe('join');
  });

  it('lets every fish go when the rebuild fails, the world stops or the stock is swapped', () => {
    const held = holding();
    held.releaseAll();
    expect(held.step('a', 11, 'no-frame')).toBe('free');
    expect(held.step('b', 11, 'present')).toBe('free');
  });

  it('lets a fish go when it dies or leaves the tank, and keeps holding the rest', () => {
    const held = holding();
    held.release('a');
    expect(held.step('a', 11, 'no-frame')).toBe('free');
    expect(held.step('b', 11, 'no-frame')).toBe('wait');
    held.release('b');
    expect(held.step('b', 11, 'no-frame')).toBe('free');
  });

  it('lets every fish go once the rebuilt world has posted nothing for the timeout', () => {
    const held = holding();
    expect(held.step('a', 10 + HOLD_TIMEOUT_S, 'no-frame')).toBe('free');
    expect(held.step('b', 10 + HOLD_TIMEOUT_S, 'no-frame')).toBe('free');
    expect(held.step('b', 10 + HOLD_TIMEOUT_S, 'present')).toBe('free');
  });

  it('restarts the timeout and replaces the held set on a new hold', () => {
    const held = holding();
    held.hold([swimming('b'), swimming('c')], 14);
    expect(held.step('a', 14, 'no-frame')).toBe('free');
    expect(held.step('b', 10 + HOLD_TIMEOUT_S, 'no-frame')).toBe('wait');
    expect(held.step('c', 14 + HOLD_TIMEOUT_S - 0.01, 'no-frame')).toBe('wait');
    expect(held.step('c', 14 + HOLD_TIMEOUT_S, 'no-frame')).toBe('free');
  });

  it('holds nothing before the first hold', () => {
    expect(new HeldFish().step('a', 0, 'no-frame')).toBe('free');
  });
});
