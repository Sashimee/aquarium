import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../engine/events';
import type { InteractionEvents } from './events';
import type { Vec3 } from './camera';
import { broodTarget, followAnyFish } from './follow';

describe('followAnyFish', () => {
  it('focuses the camera on a fish without announcing anything', () => {
    const bus = new EventBus<InteractionEvents>();
    const heard = vi.fn();
    bus.on('camera:follow-unavailable', heard);
    const focusOn = vi.fn();
    const target = () => null;
    followAnyFish(target, focusOn, bus);
    expect(focusOn).toHaveBeenCalledWith(target);
    expect(heard).not.toHaveBeenCalled();
  });

  it.each([null, undefined])('says there is no fish to follow when given %s', (none) => {
    const bus = new EventBus<InteractionEvents>();
    const heard = vi.fn();
    bus.on('camera:follow-unavailable', heard);
    const focusOn = vi.fn();
    followAnyFish(none, focusOn, bus);
    expect(focusOn).not.toHaveBeenCalled();
    expect(heard).toHaveBeenCalledTimes(1);
  });
});

describe('broodTarget', () => {
  it('follows the centre of the brood fish that can be seen, frame by frame', () => {
    const points = new Map<string, Vec3>([
      ['a', { x: 0, y: 0.2, z: 0 }],
      ['b', { x: 0.2, y: 0.4, z: -0.1 }],
    ]);
    const target = broodTarget(['a', 'b', 'hidden'], (id) => points.get(id));
    if (target === null) throw new Error('no target');
    expect(target()).toEqual({ x: 0.1, y: expect.closeTo(0.3, 9), z: -0.05 });
    points.delete('a');
    expect(target()).toEqual({ x: 0.2, y: 0.4, z: -0.1 });
    points.delete('b');
    expect(target()).toBeNull();
  });

  it('reads a shared point once per fish, so a reused buffer does not skew the centre', () => {
    const shared = { x: 0, y: 0, z: 0 };
    const at: Record<string, Vec3> = { a: { x: 1, y: 0, z: 0 }, b: { x: 3, y: 0, z: 0 } };
    const target = broodTarget(['a', 'b'], (id) => Object.assign(shared, at[id]));
    expect(target?.()).toEqual({ x: 2, y: 0, z: 0 });
  });

  it('is null when none of the brood can be seen now, or there is none', () => {
    expect(broodTarget(['a'], () => null)).toBeNull();
    expect(broodTarget(['a'], () => undefined)).toBeNull();
    expect(broodTarget([], () => ({ x: 0, y: 0, z: 0 }))).toBeNull();
  });
});
