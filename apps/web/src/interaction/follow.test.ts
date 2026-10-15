import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../engine/events';
import type { InteractionEvents } from './events';
import { followAnyFish } from './follow';

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
