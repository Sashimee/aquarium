/** WebKit's own pinch events, which only it fires; cancelling them is what stops its page zoom. */
const GESTURE_EVENTS = ['gesturestart', 'gesturechange', 'gestureend'] as const;
const FINGER_EVENTS = ['touchstart', 'touchend', 'touchcancel'] as const;

/**
 * Keeps the browser from zooming the page, so a pinch only ever reaches the camera. iOS ignores
 * `user-scalable=no`, and `touch-action: none` holds only on the canvas: a pinch that lands on or
 * starts over the overlay UI scaled the whole page, the canvas with it, on an iPhone (#1456).
 * Panning with one finger stays the page's: the cancelling `touchmove` listener is attached only
 * while two fingers are down, so a one-finger scroll never waits on the main thread. Returns the
 * remover.
 */
export function preventPageZoom(document: Document): () => void {
  const active = { passive: false } as const;
  const passive = { passive: true } as const;
  const cancel = (event: Event) => event.preventDefault();
  const multiTouch = (event: TouchEvent) => {
    if (event.touches.length > 1) event.preventDefault();
  };
  let watching = false;
  const fingersChanged = (event: TouchEvent) => {
    const pinching = event.touches.length > 1;
    if (pinching === watching) return;
    watching = pinching;
    if (pinching) document.addEventListener('touchmove', multiTouch, active);
    else document.removeEventListener('touchmove', multiTouch);
  };
  // A trackpad pinch arrives as a ctrl-wheel: the camera still takes it on the canvas.
  const ctrlWheel = (event: WheelEvent) => {
    if (event.ctrlKey) event.preventDefault();
  };
  const root = document.documentElement;
  const touchAction = root.style.touchAction;
  root.style.touchAction = 'pan-x pan-y';

  for (const type of GESTURE_EVENTS) document.addEventListener(type, cancel, active);
  for (const type of FINGER_EVENTS) document.addEventListener(type, fingersChanged, passive);
  document.addEventListener('wheel', ctrlWheel, active);

  return () => {
    for (const type of GESTURE_EVENTS) document.removeEventListener(type, cancel);
    for (const type of FINGER_EVENTS) document.removeEventListener(type, fingersChanged);
    document.removeEventListener('touchmove', multiTouch);
    document.removeEventListener('wheel', ctrlWheel);
    root.style.touchAction = touchAction;
  };
}
