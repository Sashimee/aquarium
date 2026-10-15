import type { WebGPURenderer } from 'three/webgpu';
import type { BackendPreference } from './options';

export type DeviceLostInfo = Parameters<WebGPURenderer['onDeviceLost']>[0];

/** The part of the renderer that reports a lost GPU device or WebGL context. */
export interface LossSource {
  onDeviceLost: (info: DeviceLostInfo) => void;
  readonly backend: object;
}

interface LosableDevice {
  readonly lost: Promise<{ readonly reason: string; readonly message: string }>;
}

function isLosable(device: unknown): device is LosableDevice {
  return (
    typeof device === 'object' &&
    device !== null &&
    'lost' in device &&
    device.lost instanceof Promise
  );
}

/**
 * Calls `onLost` once when the renderer's WebGPU device or WebGL context goes away, after three's
 * own handler has stopped it drawing. three ignores a WebGPU loss with reason `destroyed`, but
 * Chromium reports that reason too when its GPU process drops the device, so `device.lost` is
 * watched as well; the stop function excuses the `destroyed` that the renderer's own dispose causes.
 */
export function watchDeviceLoss(
  renderer: LossSource,
  onLost: (info: DeviceLostInfo) => void,
): () => void {
  let watching = true;
  const threeHandler = renderer.onDeviceLost;
  const hook = (info: DeviceLostInfo): void => {
    threeHandler.call(renderer, info);
    if (!watching) return;
    watching = false;
    onLost(info);
  };
  renderer.onDeviceLost = hook;

  const device: unknown = Reflect.get(renderer.backend, 'device');
  if (isLosable(device)) {
    void device.lost.then((lost) => {
      if (lost.reason !== 'destroyed' || !watching) return;
      hook({
        api: 'WebGPU',
        message: lost.message || 'Unknown reason',
        reason: lost.reason,
        originalEvent: lost,
      });
    });
  }

  return () => {
    watching = false;
    if (renderer.onDeviceLost === hook) renderer.onDeviceLost = threeHandler;
  };
}

/**
 * `webgl`: start again on WebGL 2. `reload`: ask the user to reload, because WebGL 2 already
 * failed or WebGPU was asked for by name.
 */
export type LossRecovery = 'webgl' | 'reload';

export function recoveryFor(
  api: DeviceLostInfo['api'],
  preference: BackendPreference,
): LossRecovery {
  return api === 'WebGPU' && preference === 'auto' ? 'webgl' : 'reload';
}

export interface SessionStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const WEBGPU_LOST_KEY = 'aquarium:webgpu-lost';

/**
 * The backend to start on: once WebGPU has been lost in this tab, `auto` means WebGL 2 until the
 * tab closes, so a flaky device is not retried on every reload. A named backend always wins.
 */
export function sessionBackend(
  preference: BackendPreference,
  store: SessionStore | null,
): { backend: BackendPreference; fellBack: boolean } {
  if (preference !== 'auto' || store?.getItem(WEBGPU_LOST_KEY) == null) {
    return { backend: preference, fellBack: false };
  }
  return { backend: 'webgl', fellBack: true };
}

/**
 * Records the loss and returns the page to load next, which then starts on WebGL 2. Without
 * session storage the page URL carries `?backend=webgl` instead.
 */
export function webglFallbackUrl(href: string, store: SessionStore | null): string {
  if (store !== null) {
    try {
      store.setItem(WEBGPU_LOST_KEY, '1');
      return href;
    } catch {
      // Storage full or blocked: the query flag below has the same effect.
    }
  }
  const url = new URL(href);
  url.searchParams.set('backend', 'webgl');
  return url.toString();
}

/** `window.sessionStorage`, or null where the browser refuses access to it (sandboxed frames). */
export function browserSessionStore(): SessionStore | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}
