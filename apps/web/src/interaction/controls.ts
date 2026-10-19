import type { CameraRig } from './camera';
import { attachPointerInput } from './domInput';
import { GestureRecognizer, type TapEvent } from './gestures';

const KEY_STEP_RADIANS = 0.12;
const KEY_ZOOM_FACTOR = 0.85;
const WHEEL_ZOOM_RATE = 0.12;

/** Takes the camera gestures from the orbit rig while it returns non-null (photo mode). */
export interface CameraOverride {
  drag(dx: number, dy: number): void;
  /** Above 1 moves away (widens), below 1 moves closer. */
  zoom(factor: number): void;
}

export interface ControlHandlers {
  override?(): CameraOverride | null;
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
      const override = handlers.override?.();
      if (override) override.drag(e.dx, e.dy);
      else if (!handlers.claimDrag?.()) rig.drag(e.dx, e.dy);
    },
    pinch: (e) => (handlers.override?.() ?? rig).zoom(1 / e.scale),
    tap: (e) => handlers.tap?.(e),
    longPress: (e) => handlers.longPress?.(e),
  });
  const detachPointer = attachPointerInput(element, recognizer, {
    wheel: (e) => (handlers.override?.() ?? rig).zoom(Math.exp(e.delta * WHEEL_ZOOM_RATE)),
  });

  const onKey = (e: KeyboardEvent) => {
    if (e.altKey || e.ctrlKey || e.metaKey || handlers.override?.()) return;
    if (applyCameraKey(rig, e.key)) e.preventDefault();
  };
  const onDown = (e: PointerEvent) => {
    const rect = element.getBoundingClientRect();
    handlers.pointerDown?.(e.clientX - rect.left, e.clientY - rect.top);
  };
  const onMove = (e: PointerEvent) => {
    const rect = element.getBoundingClientRect();
    handlers.pointerMove?.(e.clientX - rect.left, e.clientY - rect.top);
  };
  const onUp = () => handlers.pointerUp?.();
  const onLeave = () => handlers.pointerLeave?.();
  element.addEventListener('keydown', onKey);
  element.addEventListener('pointerdown', onDown);
  element.addEventListener('pointermove', onMove);
  element.addEventListener('pointerup', onUp);
  element.addEventListener('pointercancel', onUp);
  element.addEventListener('lostpointercapture', onUp);
  element.addEventListener('pointerleave', onLeave);
  return () => {
    element.removeEventListener('keydown', onKey);
    element.removeEventListener('pointerdown', onDown);
    element.removeEventListener('pointermove', onMove);
    element.removeEventListener('pointerup', onUp);
    element.removeEventListener('pointercancel', onUp);
    element.removeEventListener('lostpointercapture', onUp);
    element.removeEventListener('pointerleave', onLeave);
    detachPointer();
  };
}
