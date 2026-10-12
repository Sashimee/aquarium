import type { CameraRig } from './camera';
import { attachPointerInput } from './domInput';
import { GestureRecognizer, type TapEvent } from './gestures';

const KEY_STEP_RADIANS = 0.12;
const KEY_ZOOM_FACTOR = 0.85;
const WHEEL_ZOOM_RATE = 0.12;

export interface ControlHandlers {
  tap?(event: TapEvent): void;
  longPress?(event: TapEvent): void;
}

/** Returns true when the key was a camera key, so the caller can stop it scrolling the page. */
export function applyCameraKey(rig: CameraRig, key: string): boolean {
  switch (key) {
    case 'ArrowLeft':
      rig.rotateBy(-KEY_STEP_RADIANS, 0);
      return true;
    case 'ArrowRight':
      rig.rotateBy(KEY_STEP_RADIANS, 0);
      return true;
    case 'ArrowUp':
      rig.rotateBy(0, -KEY_STEP_RADIANS);
      return true;
    case 'ArrowDown':
      rig.rotateBy(0, KEY_STEP_RADIANS);
      return true;
    case '+':
    case '=':
      rig.zoom(KEY_ZOOM_FACTOR);
      return true;
    case '-':
    case '_':
      rig.zoom(1 / KEY_ZOOM_FACTOR);
      return true;
    case 'Escape':
      rig.exit();
      return true;
    default:
      return false;
  }
}

/**
 * One finger or the left mouse button orbits (or looks, when diving); two fingers and the wheel
 * zoom; the keyboard does the same once the canvas has focus.
 */
export function bindCameraControls(
  element: HTMLElement,
  rig: CameraRig,
  handlers: ControlHandlers = {},
): () => void {
  const recognizer = new GestureRecognizer({
    drag: (e) => rig.drag(e.dx, e.dy),
    pinch: (e) => rig.zoom(1 / e.scale),
    tap: (e) => handlers.tap?.(e),
    longPress: (e) => handlers.longPress?.(e),
  });
  const detachPointer = attachPointerInput(element, recognizer, {
    wheel: (e) => rig.zoom(Math.exp(e.delta * WHEEL_ZOOM_RATE)),
  });

  const onKey = (e: KeyboardEvent) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (applyCameraKey(rig, e.key)) e.preventDefault();
  };
  element.addEventListener('keydown', onKey);
  return () => {
    element.removeEventListener('keydown', onKey);
    detachPointer();
  };
}
