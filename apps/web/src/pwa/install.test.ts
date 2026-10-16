import { describe, expect, it, vi } from 'vitest';
import {
  InstallState,
  installMode,
  isIosSafari,
  type Environment,
  type InstallPromptEvent,
} from './install';
import { registerServiceWorker } from './register';

const IPHONE_SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const IPHONE_CHROME =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0 Mobile/15E148 Safari/604.1';
const IPAD_DESKTOP_MODE =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';
const MAC_SAFARI = IPAD_DESKTOP_MODE;
const ANDROID_CHROME =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36';

const env = (over: Partial<Environment>): Environment => ({
  userAgent: ANDROID_CHROME,
  platform: 'Linux armv8l',
  maxTouchPoints: 5,
  standalone: false,
  ...over,
});

describe('isIosSafari', () => {
  it('accepts iPhone Safari and iPadOS in desktop mode', () => {
    expect(isIosSafari({ userAgent: IPHONE_SAFARI, platform: 'iPhone', maxTouchPoints: 5 })).toBe(
      true,
    );
    expect(
      isIosSafari({ userAgent: IPAD_DESKTOP_MODE, platform: 'MacIntel', maxTouchPoints: 5 }),
    ).toBe(true);
  });

  it('rejects other iOS browsers, desktop Safari and Android', () => {
    expect(isIosSafari({ userAgent: IPHONE_CHROME, platform: 'iPhone', maxTouchPoints: 5 })).toBe(
      false,
    );
    expect(isIosSafari({ userAgent: MAC_SAFARI, platform: 'MacIntel', maxTouchPoints: 0 })).toBe(
      false,
    );
    expect(isIosSafari({ userAgent: ANDROID_CHROME, platform: 'Linux', maxTouchPoints: 5 })).toBe(
      false,
    );
  });
});

describe('installMode', () => {
  it('reports installed whenever it runs standalone', () => {
    expect(installMode(env({ standalone: true }), true)).toBe('installed');
  });

  it('offers the browser prompt when one was deferred', () => {
    expect(installMode(env({}), true)).toBe('prompt');
  });

  it('shows the Add to Home Screen hint on iOS Safari only', () => {
    const ios = env({ userAgent: IPHONE_SAFARI, platform: 'iPhone' });
    expect(installMode(ios, false)).toBe('ios-hint');
    expect(installMode(env({}), false)).toBe('none');
  });
});

function fakePrompt(outcome: 'accepted' | 'dismissed') {
  const event = new Event('beforeinstallprompt', { cancelable: true }) as InstallPromptEvent;
  const prompt = vi.fn(async () => undefined);
  Object.assign(event, { prompt, userChoice: Promise.resolve({ outcome }) });
  return { event, prompt };
}

describe('InstallState', () => {
  it('defers the browser prompt and runs it once on request', async () => {
    const target = new EventTarget();
    const state = new InstallState();
    state.attach(target as unknown as Window);
    const seen = vi.fn();
    state.subscribe(seen);

    const { event, prompt } = fakePrompt('accepted');
    target.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(state.hasPrompt).toBe(true);
    expect(seen).toHaveBeenCalledTimes(1);

    expect(await state.prompt()).toBe('accepted');
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(state.phase).toBe('accepted');
    expect(await state.prompt()).toBe('unavailable');
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it('keeps offering the install until the dialog is answered', async () => {
    const target = new EventTarget();
    const state = new InstallState();
    state.attach(target as unknown as Window);
    const event = new Event('beforeinstallprompt', { cancelable: true }) as InstallPromptEvent;
    let answer: (choice: { outcome: 'accepted' | 'dismissed' }) => void = () => undefined;
    Object.assign(event, {
      prompt: async () => undefined,
      userChoice: new Promise((resolve) => {
        answer = resolve;
      }),
    });
    target.dispatchEvent(event);

    const pending = state.prompt();
    await Promise.resolve();
    expect(state.phase).toBe('asking');
    expect(state.hasPrompt).toBe(true);
    expect(await state.prompt()).toBe('unavailable');

    answer({ outcome: 'dismissed' });
    expect(await pending).toBe('dismissed');
    expect(state.phase).toBe('dismissed');
    expect(state.hasPrompt).toBe(true);
  });

  it('reports a rejected prompt() instead of leaving the card stuck', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const target = new EventTarget();
    const state = new InstallState();
    state.attach(target as unknown as Window);
    const event = new Event('beforeinstallprompt', { cancelable: true }) as InstallPromptEvent;
    Object.assign(event, {
      prompt: async () => {
        throw new Error('not allowed');
      },
      userChoice: new Promise(() => undefined),
    });
    target.dispatchEvent(event);

    expect(await state.prompt()).toBe('failed');
    expect(state.phase).toBe('failed');
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('starts a fresh round when the browser offers another prompt', async () => {
    const target = new EventTarget();
    const state = new InstallState();
    state.attach(target as unknown as Window);
    target.dispatchEvent(fakePrompt('dismissed').event);
    await state.prompt();
    expect(state.phase).toBe('dismissed');
    target.dispatchEvent(fakePrompt('accepted').event);
    expect(state.phase).toBe('idle');
  });

  it('forgets the prompt and records the install on appinstalled', () => {
    const target = new EventTarget();
    const state = new InstallState();
    state.attach(target as unknown as Window);
    target.dispatchEvent(fakePrompt('accepted').event);
    target.dispatchEvent(new Event('appinstalled'));
    expect(state.hasPrompt).toBe(false);
    expect(state.wasInstalled).toBe(true);
  });

  it('stops listening after detach', () => {
    const target = new EventTarget();
    const state = new InstallState();
    const detach = state.attach(target as unknown as Window);
    detach();
    target.dispatchEvent(fakePrompt('accepted').event);
    expect(state.hasPrompt).toBe(false);
  });
});

describe('registerServiceWorker', () => {
  it('registers /sw.js at the root scope in a secure context', async () => {
    const register = vi.fn(async () => ({}));
    await registerServiceWorker({ serviceWorker: { register } }, true);
    expect(register).toHaveBeenCalledWith('/sw.js', { scope: '/' });
  });

  it('does nothing without service worker support or a secure context', async () => {
    const register = vi.fn(async () => ({}));
    await registerServiceWorker({}, true);
    await registerServiceWorker({ serviceWorker: { register } }, false);
    expect(register).not.toHaveBeenCalled();
  });

  it('logs a failed registration instead of throwing', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failure = new Error('blocked');
    await registerServiceWorker(
      {
        serviceWorker: {
          register: async () => {
            throw failure;
          },
        },
      },
      true,
    );
    expect(error).toHaveBeenCalledWith('Service worker registration failed', failure);
    error.mockRestore();
  });
});
