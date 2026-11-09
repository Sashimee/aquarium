// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { watchCameraInput } from './cameraInput';

let remove: (() => void) | null = null;

afterEach(() => {
  remove?.();
  remove = null;
  document.body.replaceChildren();
});

function pointerMove(buttons: number): Event {
  const event = new Event('pointermove', { bubbles: true });
  Object.defineProperty(event, 'buttons', { value: buttons });
  return event;
}

function setup() {
  const container = document.createElement('div');
  const canvas = document.createElement('canvas');
  container.append(canvas);
  document.body.append(container);
  const onInput = vi.fn();
  remove = watchCameraInput(container, onInput);
  return { container, canvas, onInput };
}

describe('watchCameraInput', () => {
  it('counts presses, wheel turns and keys on anything inside the element', () => {
    const { canvas, onInput } = setup();
    for (const type of ['pointerdown', 'wheel', 'keydown']) {
      canvas.dispatchEvent(new Event(type, { bubbles: true }));
    }
    expect(onInput).toHaveBeenCalledTimes(3);
  });

  it('counts a drag but not a hover', () => {
    const { canvas, onInput } = setup();
    canvas.dispatchEvent(pointerMove(0));
    expect(onInput).not.toHaveBeenCalled();
    canvas.dispatchEvent(pointerMove(1));
    expect(onInput).toHaveBeenCalledOnce();
  });

  it('still counts input a control on the canvas stops', () => {
    const { canvas, onInput } = setup();
    canvas.addEventListener('pointerdown', (event) => event.stopPropagation());
    canvas.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(onInput).toHaveBeenCalledOnce();
  });

  it('ignores input outside the element and stops on remove', () => {
    const { container, onInput } = setup();
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(onInput).not.toHaveBeenCalled();
    remove?.();
    remove = null;
    container.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(onInput).not.toHaveBeenCalled();
  });
});
