const PRESS_EVENTS = ['pointerdown', 'wheel', 'keydown'] as const;

/**
 * Calls `onInput` for the input that steers the camera inside `element`: a press, a drag, a wheel
 * turn or a key. Hovering does not count. Listens in the capture phase, so a control that stops
 * the event still counts. Returns the remover.
 */
export function watchCameraInput(element: EventTarget, onInput: () => void): () => void {
  const pressed = () => onInput();
  const moved = (event: Event) => {
    const buttons: unknown = Reflect.get(event, 'buttons');
    if (typeof buttons === 'number' && buttons !== 0) onInput();
  };
  const options = { capture: true, passive: true } as const;
  for (const type of PRESS_EVENTS) element.addEventListener(type, pressed, options);
  element.addEventListener('pointermove', moved, options);
  return () => {
    for (const type of PRESS_EVENTS) element.removeEventListener(type, pressed, options);
    element.removeEventListener('pointermove', moved, options);
  };
}
