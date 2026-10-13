import { afterEach, describe, expect, it, vi } from 'vitest';
import { attachPointerInput } from './domInput';
import { GestureRecognizer } from './gestures';

class FakeElement extends EventTarget {
  getBoundingClientRect() {
    return { left: 0, top: 0 };
  }
  setPointerCapture() {}
}

function pointer(type: string, init: { id: number; x: number; y: number; kind: string }): Event {
  const event = new Event(type);
  const values = {
    pointerId: init.id,
    clientX: init.x,
    clientY: init.y,
    pointerType: init.kind,
    button: 0,
    timeStamp: 0,
  };
  for (const [key, value] of Object.entries(values)) {
    Object.defineProperty(event, key, { value });
  }
  return event;
}

function setup() {
  vi.stubGlobal('window', new EventTarget());
  const element = new FakeElement();
  const drag = vi.fn();
  const pinch = vi.fn();
  const recognizer = new GestureRecognizer({ drag, pinch });
  const detach = attachPointerInput(element as unknown as HTMLElement, recognizer);
  return { element, drag, pinch, recognizer, detach };
}

describe('attachPointerInput', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('lets a mouse drag orbit even when the previous release never arrived', () => {
    const { element, drag, pinch } = setup();
    element.dispatchEvent(pointer('pointerdown', { id: 1, x: 10, y: 10, kind: 'mouse' }));
    element.dispatchEvent(pointer('pointerdown', { id: 2, x: 50, y: 50, kind: 'mouse' }));
    element.dispatchEvent(pointer('pointermove', { id: 2, x: 90, y: 50, kind: 'mouse' }));
    expect(pinch).not.toHaveBeenCalled();
    expect(drag).toHaveBeenCalled();
  });

  it('forgets a touch whose capture was lost without a release', () => {
    const { element, recognizer } = setup();
    element.dispatchEvent(pointer('pointerdown', { id: 1, x: 10, y: 10, kind: 'touch' }));
    expect(recognizer.activePointers).toBe(1);
    element.dispatchEvent(pointer('lostpointercapture', { id: 1, x: 10, y: 10, kind: 'touch' }));
    expect(recognizer.activePointers).toBe(0);
  });

  it('stops listening once detached', () => {
    const { element, recognizer, detach } = setup();
    detach();
    element.dispatchEvent(pointer('pointerdown', { id: 1, x: 0, y: 0, kind: 'touch' }));
    expect(recognizer.activePointers).toBe(0);
  });
});
