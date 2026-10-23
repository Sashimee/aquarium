// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { preventPageZoom } from './pageZoom';

let remove: (() => void) | null = null;

afterEach(() => {
  vi.restoreAllMocks();
  remove?.();
  remove = null;
  document.documentElement.style.touchAction = '';
  document.body.replaceChildren();
});

function dispatch(event: Event, target: EventTarget = document.body): Event {
  target.dispatchEvent(event);
  return event;
}

function touch(type: string, fingers: number): Event {
  const touches = Array.from({ length: fingers }, (_, i) => ({ identifier: i }));
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'touches', { value: touches });
  return event;
}

function touchMove(fingers: number): Event {
  return touch('touchmove', fingers);
}

function fingersDown(fingers: number): void {
  dispatch(touch('touchstart', fingers));
}

function gesture(type: string): Event {
  return new Event(type, { bubbles: true, cancelable: true });
}

function wheel(init: WheelEventInit): WheelEvent {
  const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, ...init });
  // happy-dom's WheelEvent is not a MouseEvent and drops the modifier keys.
  Object.defineProperty(event, 'ctrlKey', { value: init.ctrlKey ?? false });
  return event;
}

describe('preventPageZoom', () => {
  it("cancels WebKit's pinch gestures wherever they start", () => {
    remove = preventPageZoom(document);
    for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
      expect(dispatch(gesture(type)).defaultPrevented).toBe(true);
    }
  });

  it('cancels a two-finger move but leaves a one-finger pan to the page', () => {
    remove = preventPageZoom(document);
    fingersDown(1);
    expect(dispatch(touchMove(1)).defaultPrevented).toBe(false);
    fingersDown(2);
    expect(dispatch(touchMove(2)).defaultPrevented).toBe(true);
  });

  it('blocks on touchmove only while two fingers are down, so a one-finger scroll stays async', () => {
    const add = vi.spyOn(document, 'addEventListener');
    const drop = vi.spyOn(document, 'removeEventListener');
    const blocking = () =>
      add.mock.calls.filter(
        ([type, , options]) =>
          type === 'touchmove' && typeof options === 'object' && options.passive === false,
      ).length - drop.mock.calls.filter(([type]) => type === 'touchmove').length;
    remove = preventPageZoom(document);
    expect(blocking()).toBe(0);

    fingersDown(1);
    expect(blocking()).toBe(0);
    fingersDown(2);
    fingersDown(3);
    expect(blocking()).toBe(1);

    dispatch(touch('touchend', 2));
    expect(blocking()).toBe(1);
    dispatch(touch('touchend', 1));
    expect(blocking()).toBe(0);
    expect(dispatch(touchMove(2)).defaultPrevented).toBe(false);

    fingersDown(2);
    expect(blocking()).toBe(1);
    dispatch(touch('touchcancel', 0));
    expect(blocking()).toBe(0);
  });

  it('cancels a trackpad pinch but not a plain scroll', () => {
    remove = preventPageZoom(document);
    expect(dispatch(wheel({ ctrlKey: true })).defaultPrevented).toBe(true);
    expect(dispatch(wheel({ deltaY: 40 })).defaultPrevented).toBe(false);
  });

  it('still delivers the pinch to the canvas, which zooms the camera with it', () => {
    remove = preventPageZoom(document);
    const canvas = document.body.appendChild(document.createElement('canvas'));
    let seen = 0;
    canvas.addEventListener('wheel', () => seen++);
    dispatch(wheel({ ctrlKey: true }), canvas);
    expect(seen).toBe(1);
  });

  it('allows only panning on the page, and restores everything when removed', () => {
    document.documentElement.style.touchAction = 'auto';
    const stop = preventPageZoom(document);
    expect(document.documentElement.style.touchAction).toBe('pan-x pan-y');
    fingersDown(2);

    stop();
    expect(document.documentElement.style.touchAction).toBe('auto');
    expect(dispatch(gesture('gesturestart')).defaultPrevented).toBe(false);
    fingersDown(2);
    expect(dispatch(touchMove(2)).defaultPrevented).toBe(false);
    expect(dispatch(wheel({ ctrlKey: true })).defaultPrevented).toBe(false);
  });
});
