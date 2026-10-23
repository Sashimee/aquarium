/** WebKit's own pinch events, which only it fires; cancelling them is what stops its page zoom. */
const GESTURE_EVENTS = ['gesturestart', 'gesturechange', 'gestureend'] as const;

/**
 * Keeps the browser from zooming the page, so a pinch only ever reaches the camera. iOS ignores
 * `user-scalable=no`, and `touch-action: none` holds only on the canvas: a pinch that lands on or
 * starts over the overlay UI scaled the whole page, the canvas with it, on an iPhone (#1456).
 * Panning with one finger stays the page's. Returns the remover.
 */
export function preventPageZoom(document: Document): () => void {
  const cancel = (event: Event) => event.preventDefault();
  const multiTouch = (event: TouchEvent) => {
    if (event.touches.length > 1) event.preventDefault();
  };
  // A trackpad pinch arrives as a ctrl-wheel: the camera still takes it on the canvas.
  const ctrlWheel = (event: WheelEvent) => {
    if (event.ctrlKey) event.preventDefault();
  };
  const root = document.documentElement;
  const touchAction = root.style.touchAction;
  root.style.touchAction = 'pan-x pan-y';

  const active = { passive: false } as const;
  for (const type of GESTURE_EVENTS) document.addEventListener(type, cancel, active);
  document.addEventListener('touchmove', multiTouch, active);
  document.addEventListener('wheel', ctrlWheel, active);

  return () => {
    for (const type of GESTURE_EVENTS) document.removeEventListener(type, cancel);
    document.removeEventListener('touchmove', multiTouch);
    document.removeEventListener('wheel', ctrlWheel);
    root.style.touchAction = touchAction;
  };
}
