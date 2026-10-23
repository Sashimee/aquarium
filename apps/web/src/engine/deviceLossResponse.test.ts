// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type DeviceLostInfo,
  type LossResponder,
  type LossSource,
  LOST_NOTICE,
  respondToDeviceLoss,
  type SessionStore,
  watchDeviceLoss,
  WEBGPU_LOST_KEY,
} from './deviceLoss';
import { showDeviceNotice } from './deviceNotice';

const HREF = 'https://devfish.bas.lu/tank?seed=4';

const WEBGL_LOSS: DeviceLostInfo = {
  api: 'WebGL',
  message: 'context lost',
  reason: null,
  originalEvent: null,
};

const WEBGPU_LOSS: DeviceLostInfo = {
  api: 'WebGPU',
  message: 'GPU process was lost',
  reason: 'unknown',
  originalEvent: null,
};

class MemoryStore implements SessionStore {
  readonly items = new Map<string, string>();
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
}

function responder(store: SessionStore | null = null) {
  const steps: string[] = [];
  const location = {
    href: HREF,
    reload: vi.fn(() => steps.push('reload')),
    replace: vi.fn((url: string | URL) => steps.push(`replace ${String(url)}`)),
  };
  const report = vi.fn((message: string) => steps.push(`report ${message}`));
  const r: LossResponder = {
    halt: () => steps.push('halt'),
    announce: (event) => steps.push(`announce ${event.api} ${event.recovery}`),
    report,
    location,
    store,
    notify: (message, action) => {
      steps.push('notify');
      return showDeviceNotice(document.body, message, action);
    },
  };
  return { r, steps, location, report };
}

function notice(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>('[role="alert"]');
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('respondToDeviceLoss', () => {
  it('halts the loop before anything else, then announces and logs the loss', () => {
    const { r, steps } = responder();
    respondToDeviceLoss(WEBGL_LOSS, 'auto', r);
    expect(steps.slice(0, 3)).toEqual([
      'halt',
      'announce WebGL reload',
      'report The WebGL device was lost: context lost',
    ]);
  });

  it('logs the reason the device gave', () => {
    const { r, report } = responder();
    respondToDeviceLoss(WEBGPU_LOSS, 'webgpu', r);
    expect(report).toHaveBeenCalledWith(
      'The WebGPU device was lost: GPU process was lost (reason: unknown)',
      WEBGPU_LOSS,
    );
  });

  it('shows a visible message with a Reload button when WebGL 2 is lost', () => {
    const { r, location } = responder();
    const remove = respondToDeviceLoss(WEBGL_LOSS, 'auto', r);

    const box = notice();
    expect(box?.textContent).toContain(LOST_NOTICE);
    expect(box?.parentElement?.style.position).toBe('fixed');
    expect(Number(box?.parentElement?.style.zIndex)).toBeGreaterThan(20);
    expect(location.reload).not.toHaveBeenCalled();

    const button = box?.querySelector('button');
    expect(button?.textContent).toBe('Reload');
    button?.click();
    expect(location.reload).toHaveBeenCalledTimes(1);
    expect(notice()).toBeNull();
    expect(remove).toBeTypeOf('function');
  });

  it('asks for a reload when WebGPU was chosen by name, instead of switching backend', () => {
    const { r, location } = responder(new MemoryStore());
    expect(respondToDeviceLoss(WEBGPU_LOSS, 'webgpu', r)).toBeTypeOf('function');
    expect(notice()).not.toBeNull();
    expect(location.replace).not.toHaveBeenCalled();
    expect(location.reload).not.toHaveBeenCalled();
  });

  it('returns a remover that takes the message down', () => {
    const { r } = responder();
    const remove = respondToDeviceLoss(WEBGL_LOSS, 'webgl', r);
    remove?.();
    expect(notice()).toBeNull();
  });

  it('asks for a reload onto WebGL 2 after an automatic WebGPU loss, remembering it for the tab', () => {
    const store = new MemoryStore();
    const { r, steps, location } = responder(store);
    respondToDeviceLoss(WEBGPU_LOSS, 'auto', r);
    expect(store.items.get(WEBGPU_LOST_KEY)).toBe('1');
    expect(steps[0]).toBe('halt');
    expect(notice()?.textContent).toContain(LOST_NOTICE);
    expect(location.reload).not.toHaveBeenCalled();

    notice()?.querySelector('button')?.click();
    expect(location.reload).toHaveBeenCalledTimes(1);
    expect(location.replace).not.toHaveBeenCalled();
  });

  it('carries ?backend=webgl in the reload when there is no session storage', () => {
    const { r, location } = responder(null);
    respondToDeviceLoss(WEBGPU_LOSS, 'auto', r);
    expect(notice()).not.toBeNull();
    expect(location.replace).not.toHaveBeenCalled();

    notice()?.querySelector('button')?.click();
    expect(location.replace).toHaveBeenCalledWith(`${HREF}&backend=webgl`);
    expect(location.reload).not.toHaveBeenCalled();
  });

  it('answers a lost WebGL context delivered through the renderer exactly once', () => {
    const renderer = {
      onDeviceLost: vi.fn<(info: DeviceLostInfo) => void>(),
      onError: vi.fn<LossSource['onError']>(),
      backend: {},
    };
    const watcher = watchDeviceLoss(renderer);
    const { r, steps } = responder();
    watcher.onLost((info) => respondToDeviceLoss(info, 'auto', r));

    renderer.onDeviceLost(WEBGL_LOSS);
    renderer.onDeviceLost(WEBGL_LOSS);

    expect(steps.filter((s) => s === 'halt')).toHaveLength(1);
    expect(document.body.querySelectorAll('[role="alert"]')).toHaveLength(1);
  });

  it('answers an out-of-memory error as a loss, after three has logged it', () => {
    const threeOnError = vi.fn<LossSource['onError']>();
    const renderer: LossSource = { onDeviceLost: vi.fn(), onError: threeOnError, backend: {} };
    const watcher = watchDeviceLoss(renderer);
    const { r, steps } = responder(new MemoryStore());
    watcher.onLost((info) => respondToDeviceLoss(info, 'auto', r));

    const oom = { api: 'WebGPU', type: 'GPUOutOfMemoryError', message: 'createTexture failed' };
    // three r186 passes this object; @types/three says a string.
    Reflect.apply(renderer.onError, renderer, [oom]);
    Reflect.apply(renderer.onError, renderer, [oom]);

    expect(threeOnError).toHaveBeenCalledTimes(2);
    expect(steps.filter((s) => s === 'halt')).toHaveLength(1);
    expect(steps).toContain('announce WebGPU webgl');
    expect(notice()?.textContent).toContain(LOST_NOTICE);
  });

  it('leaves other uncaptured errors to three', () => {
    const renderer: LossSource = { onDeviceLost: vi.fn(), onError: vi.fn(), backend: {} };
    const watcher = watchDeviceLoss(renderer);
    const onLost = vi.fn();
    watcher.onLost(onLost);

    Reflect.apply(renderer.onError, renderer, [
      { api: 'WebGPU', type: 'GPUValidationError', message: 'bad binding' },
    ]);
    Reflect.apply(renderer.onError, renderer, ['a string message']);

    expect(onLost).not.toHaveBeenCalled();
    expect(notice()).toBeNull();
  });
});
