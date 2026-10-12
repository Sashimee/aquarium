import type { CameraRig } from './camera';
import { attachPointerInput } from './domInput';
import { GestureRecognizer, type TapEvent } from './gestures';

const KEY_STEP_RADIANS = 0.12;
const KEY_ZOOM_FACTOR = 0.85;
const WHEEL_ZOOM_RATE = 0.12;

export interface ControlHandlers {
  tap?(event: TapEvent): void;
  longPress?(event: TapEvent): void;
  /** While true a one-finger drag belongs to a tool, not the camera. */
  claimDrag?(): boolean;
  pointerDown?(x: number, y: number): void;
  pointerMove?(x: number, y: number): void;
  pointerUp?(): void;
  pointerLeave?(): void;
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
    drag: (e) => {
      if (!handlers.claimDrag?.()) rig.drag(e.dx, e.dy);
    },
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
  const local = (e: PointerEvent) => {
    const rect = element.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };
  const onDown = (e: PointerEvent) => handlers.pointerDown?.(local(e).x, local(e).y);
  const onMove = (e: PointerEvent) => handlers.pointerMove?.(local(e).x, local(e).y);
  const onUp = () => handlers.pointerUp?.();
  const onLeave = () => handlers.pointerLeave?.();
  element.addEventListener('keydown', onKey);
  element.addEventListener('pointerdown', onDown);
  element.addEventListener('pointermove', onMove);
  element.addEventListener('pointerup', onUp);
  element.addEventListener('pointercancel', onUp);
  element.addEventListener('pointerleave', onLeave);
  return () => {
    element.removeEventListener('keydown', onKey);
    element.removeEventListener('pointerdown', onDown);
    element.removeEventListener('pointermove', onMove);
    element.removeEventListener('pointerup', onUp);
    element.removeEventListener('pointercancel', onUp);
    element.removeEventListener('pointerleave', onLeave);
    detachPointer();
  };
}
