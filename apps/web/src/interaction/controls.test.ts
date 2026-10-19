import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CameraRig } from './camera';
import { bindCameraControls } from './controls';

class FakeElement extends EventTarget {
  getBoundingClientRect() {
    return { left: 0, top: 0 };
  }
  setPointerCapture() {}
}

function pointer(type: string, id: number): Event {
  const event = new Event(type);
  const values = { pointerId: id, clientX: 10, clientY: 10, pointerType: 'touch', button: 0 };
  for (const [key, value] of Object.entries(values)) {
    Object.defineProperty(event, key, { value });
  }
  return event;
}

describe('bindCameraControls', () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each(['pointerup', 'pointercancel', 'lostpointercapture'])(
    'ends a tool drag on %s',
    (type) => {
      vi.stubGlobal('window', new EventTarget());
      const element = new FakeElement();
      const pointerUp = vi.fn();
      bindCameraControls(element as unknown as HTMLElement, {} as CameraRig, { pointerUp });
      element.dispatchEvent(pointer('pointerdown', 1));
      element.dispatchEvent(pointer(type, 1));
      expect(pointerUp).toHaveBeenCalledTimes(1);
    },
  );

  it('leaves the orbit keys alone while a camera override is active', () => {
    vi.stubGlobal('window', new EventTarget());
    const element = new FakeElement();
    const rotateBy = vi.fn();
    let override: { drag(): void; zoom(): void } | null = null;
    bindCameraControls(element as unknown as HTMLElement, { rotateBy } as unknown as CameraRig, {
      override: () => override,
    });
    const press = () => {
      const event = new Event('keydown');
      Object.defineProperties(event, { key: { value: 'ArrowLeft' }, cancelable: { value: true } });
      element.dispatchEvent(event);
    };
    press();
    expect(rotateBy).toHaveBeenCalledTimes(1);
    override = { drag: vi.fn(), zoom: vi.fn() };
    press();
    expect(rotateBy).toHaveBeenCalledTimes(1);
  });
});
