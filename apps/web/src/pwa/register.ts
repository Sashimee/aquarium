import { installState } from './install';

export interface WorkerHost {
  serviceWorker?: { register(url: string, options: { scope: string }): Promise<unknown> };
}

export function registerServiceWorker(
  host: WorkerHost = navigator,
  secure: boolean = window.isSecureContext,
): Promise<void> {
  if (!host.serviceWorker || !secure) return Promise.resolve();
  return host.serviceWorker.register('/sw.js', { scope: '/' }).then(
    () => undefined,
    (cause: unknown) => console.error('Service worker registration failed', cause),
  );
}

let started = false;

/** Skipped in dev, where a cache-first worker would serve stale modules over Vite's HMR. */
export function startPwa(): void {
  if (started) return;
  started = true;
  installState.attach();
  if (import.meta.env.PROD) void registerServiceWorker();
}
