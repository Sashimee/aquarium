import { GestureRecognizer, type PointerKind } from './gestures';

export interface WheelInput {
  /** Positive zooms out. Normalised to roughly one unit per mouse-wheel notch. */
  delta: number;
  x: number;
  y: number;
}

export interface DomInputHandlers {
  wheel?(event: WheelInput): void;
}

const LINE_HEIGHT_PX = 16;
const PAGE_HEIGHT_PX = 800;
const NOTCH_PX = 100;

export function normaliseWheel(deltaY: number, deltaMode: number): number {
  const pixels =
    deltaMode === 1 ? deltaY * LINE_HEIGHT_PX : deltaMode === 2 ? deltaY * PAGE_HEIGHT_PX : deltaY;
  return pixels / NOTCH_PX;
}

function kindOf(pointerType: string): PointerKind {
  return pointerType === 'touch' || pointerType === 'pen' ? pointerType : 'mouse';
}

/** Feeds a recognizer from DOM pointer events. Returns a function that detaches everything. */
export function attachPointerInput(
  element: HTMLElement,
  recognizer: GestureRecognizer,
  handlers: DomInputHandlers = {},
): () => void {
  const sample = (e: PointerEvent) => {
    const rect = element.getBoundingClientRect();
    return {
      id: e.pointerId,
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
      time: e.timeStamp,
      kind: kindOf(e.pointerType),
      button: e.button,
    };
  };

  const down = (e: PointerEvent) => {
    element.setPointerCapture(e.pointerId);
    recognizer.pointerDown(sample(e));
  };
  const move = (e: PointerEvent) => recognizer.pointerMove(sample(e));
  const up = (e: PointerEvent) => recognizer.pointerUp(sample(e));
  const cancel = (e: PointerEvent) => recognizer.pointerCancel(e.pointerId);
  const wheel = (e: WheelEvent) => {
    e.preventDefault();
    const rect = element.getBoundingClientRect();
    handlers.wheel?.({
      delta: normaliseWheel(e.deltaY, e.deltaMode),
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    });
  };
  const contextMenu = (e: Event) => e.preventDefault();
  const blur = () => recognizer.cancelAll();

  element.addEventListener('pointerdown', down);
  element.addEventListener('pointermove', move);
  element.addEventListener('pointerup', up);
  element.addEventListener('pointercancel', cancel);
  element.addEventListener('wheel', wheel, { passive: false });
  element.addEventListener('contextmenu', contextMenu);
  window.addEventListener('blur', blur);
  return () => {
    element.removeEventListener('pointerdown', down);
    element.removeEventListener('pointermove', move);
    element.removeEventListener('pointerup', up);
    element.removeEventListener('pointercancel', cancel);
    element.removeEventListener('wheel', wheel);
    element.removeEventListener('contextmenu', contextMenu);
    window.removeEventListener('blur', blur);
    recognizer.cancelAll();
  };
}
