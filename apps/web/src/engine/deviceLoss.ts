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

export interface DeviceLossWatch {
  /** Watches the WebGPU device too; call once `init()` has created it. */
  watchDevice(): void;
  /** Hands the loss to `handler`, at once if it happened before there was one to take it. */
  onLost(handler: (info: DeviceLostInfo) => void): void;
  /** Excuses the `destroyed` that the renderer's own dispose causes. */
  stop(): void;
}

/**
 * Reports the first time the renderer's WebGPU device or WebGL context goes away, after three's
 * own handler has stopped it drawing. Start it before `init()`: a loss while the engine starts
 * is held until the engine takes it. three ignores a WebGPU loss with reason `destroyed`, but
 * Chromium reports that reason too when its GPU process drops the device, so `device.lost` is
 * watched as well.
 */
export function watchDeviceLoss(renderer: LossSource): DeviceLossWatch {
  let watching = true;
  let handler: ((info: DeviceLostInfo) => void) | null = null;
  let held: DeviceLostInfo | null = null;
  const threeHandler = renderer.onDeviceLost;
  const hook = (info: DeviceLostInfo): void => {
    threeHandler.call(renderer, info);
    if (!watching) return;
    watching = false;
    if (handler === null) held = info;
    else handler(info);
  };
  renderer.onDeviceLost = hook;

  return {
    watchDevice() {
      const device: unknown = Reflect.get(renderer.backend, 'device');
      if (!isLosable(device)) return;
      void device.lost.then((lost) => {
        if (lost.reason !== 'destroyed' || !watching) return;
        hook({
          api: 'WebGPU',
          message: lost.message || 'Unknown reason',
          reason: lost.reason,
          originalEvent: lost,
        });
      });
    },
    onLost(next) {
      if (handler !== null)
        throw new Error('watchDeviceLoss: onLost() was already given a handler');
      handler = next;
      if (held === null) return;
      const info = held;
      held = null;
      next(info);
    },
    stop() {
      watching = false;
      held = null;
      if (renderer.onDeviceLost === hook) renderer.onDeviceLost = threeHandler;
    },
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

export const LOST_NOTICE =
  'The graphics device stopped responding, so the tank cannot be drawn. Reload to try again.';

/** The engine's side of a loss, injected so the response runs without a renderer or a window. */
export interface LossResponder {
  halt(): void;
  announce(event: { api: DeviceLostInfo['api']; message: string; recovery: LossRecovery }): void;
  report(message: string, info: DeviceLostInfo): void;
  readonly location: Pick<Location, 'href' | 'reload' | 'replace'>;
  readonly store: SessionStore | null;
  /** Shows `message` with a button that runs `action`, and returns what removes it. */
  notify(message: string, action: { readonly label: string; run(): void }): () => void;
}

export function lossMessage(info: DeviceLostInfo): string {
  const reason = info.reason ? ` (reason: ${info.reason})` : '';
  return `The ${info.api} device was lost: ${info.message}${reason}`;
}

/**
 * Stops drawing first, so the page never sits on a frozen or black canvas, then either reloads
 * onto WebGL 2 or asks the user to reload. Returns the notice's remover when it shows one.
 */
export function respondToDeviceLoss(
  info: DeviceLostInfo,
  preference: BackendPreference,
  responder: LossResponder,
): (() => void) | null {
  responder.halt();
  const recovery = recoveryFor(info.api, preference);
  responder.announce({ api: info.api, message: info.message, recovery });
  responder.report(lossMessage(info), info);
  const { location } = responder;
  if (recovery === 'webgl') {
    const here = location.href;
    const next = webglFallbackUrl(here, responder.store);
    if (next === here) location.reload();
    else location.replace(next);
    return null;
  }
  return responder.notify(LOST_NOTICE, { label: 'Reload', run: () => location.reload() });
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
