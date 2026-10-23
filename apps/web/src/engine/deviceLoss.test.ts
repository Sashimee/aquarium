import { describe, expect, it, vi } from 'vitest';
import {
  type DeviceLossWatch,
  type DeviceLostInfo,
  type LossSource,
  outOfMemoryLoss,
  recoveryFor,
  sessionBackend,
  type SessionStore,
  watchDeviceLoss,
  WEBGPU_LOST_KEY,
  webglFallbackUrl,
} from './deviceLoss';

interface LostReport {
  reason: string;
  message: string;
}

function fakeRenderer(withDevice: boolean) {
  let resolveLost: (info: LostReport) => void = () => undefined;
  const lost = new Promise<LostReport>((resolve) => {
    resolveLost = resolve;
  });
  const threeHandler = vi.fn<(info: DeviceLostInfo) => void>();
  const threeOnError = vi.fn<LossSource['onError']>();
  const renderer: LossSource = {
    onDeviceLost: threeHandler,
    onError: threeOnError,
    backend: withDevice ? { device: { lost } } : {},
  };
  return { renderer, threeHandler, threeOnError, loseDevice: resolveLost, lost };
}

function watch(renderer: LossSource, onLost: (info: DeviceLostInfo) => void): DeviceLossWatch {
  const watcher = watchDeviceLoss(renderer);
  watcher.watchDevice();
  watcher.onLost(onLost);
  return watcher;
}

const WEBGL_LOSS: DeviceLostInfo = {
  api: 'WebGL',
  message: 'context lost',
  reason: null,
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

describe('watchDeviceLoss', () => {
  it("reports a loss three delivers, after three's own handler stopped drawing", () => {
    const { renderer, threeHandler } = fakeRenderer(false);
    const order: string[] = [];
    threeHandler.mockImplementation(() => order.push('three'));
    watch(renderer, () => order.push('engine'));

    renderer.onDeviceLost(WEBGL_LOSS);

    expect(threeHandler).toHaveBeenCalledWith(WEBGL_LOSS);
    expect(order).toEqual(['three', 'engine']);
  });

  it('reports only the first loss', () => {
    const { renderer } = fakeRenderer(false);
    const onLost = vi.fn();
    watch(renderer, onLost);

    renderer.onDeviceLost(WEBGL_LOSS);
    renderer.onDeviceLost(WEBGL_LOSS);

    expect(onLost).toHaveBeenCalledOnce();
  });

  it('treats a WebGPU device destroyed by the browser as lost, which three skips', async () => {
    const { renderer, threeHandler, loseDevice, lost } = fakeRenderer(true);
    const onLost = vi.fn();
    watch(renderer, onLost);

    loseDevice({ reason: 'destroyed', message: 'Device was destroyed.' });
    await lost;
    await Promise.resolve();

    const expected = expect.objectContaining({
      api: 'WebGPU',
      reason: 'destroyed',
      message: 'Device was destroyed.',
    });
    expect(onLost).toHaveBeenCalledWith(expected);
    expect(threeHandler).toHaveBeenCalledWith(expected);
  });

  it('leaves other WebGPU reasons to three, which calls the hook itself', async () => {
    const { renderer, loseDevice, lost } = fakeRenderer(true);
    const onLost = vi.fn();
    watch(renderer, onLost);

    loseDevice({ reason: 'unknown', message: 'GPU process crashed' });
    await lost;
    await Promise.resolve();

    expect(onLost).not.toHaveBeenCalled();
  });

  it("ignores the destroy that the renderer's own dispose causes once stopped", async () => {
    const { renderer, threeHandler, loseDevice, lost } = fakeRenderer(true);
    const onLost = vi.fn();
    const { stop } = watch(renderer, onLost);

    stop();
    loseDevice({ reason: 'destroyed', message: 'Device was destroyed.' });
    await lost;
    await Promise.resolve();

    expect(onLost).not.toHaveBeenCalled();
    expect(renderer.onDeviceLost).toBe(threeHandler);
  });

  it('gives the renderer its own error handler back once stopped', () => {
    const { renderer, threeOnError } = fakeRenderer(false);
    const onLost = vi.fn();
    const { stop } = watch(renderer, onLost);
    expect(renderer.onError).not.toBe(threeOnError);

    stop();
    Reflect.apply(renderer.onError, renderer, [{ type: 'GPUOutOfMemoryError', message: '' }]);

    expect(renderer.onError).toBe(threeOnError);
    expect(onLost).not.toHaveBeenCalled();
  });

  it('holds a loss during start-up until a handler takes it', () => {
    const { renderer } = fakeRenderer(false);
    const watcher = watchDeviceLoss(renderer);

    renderer.onDeviceLost(WEBGL_LOSS);
    const onLost = vi.fn();
    watcher.onLost(onLost);

    expect(onLost).toHaveBeenCalledOnce();
    expect(onLost).toHaveBeenCalledWith(WEBGL_LOSS);
  });

  it('holds a WebGPU device destroyed before the engine was built', async () => {
    const { renderer, loseDevice, lost } = fakeRenderer(true);
    const watcher = watchDeviceLoss(renderer);
    watcher.watchDevice();

    loseDevice({ reason: 'destroyed', message: 'Device was destroyed.' });
    await lost;
    await Promise.resolve();
    const onLost = vi.fn();
    watcher.onLost(onLost);

    expect(onLost).toHaveBeenCalledWith(expect.objectContaining({ api: 'WebGPU' }));
  });

  it('drops a held loss once stopped, as when a failed start is cleaned up', () => {
    const { renderer } = fakeRenderer(false);
    const watcher = watchDeviceLoss(renderer);

    renderer.onDeviceLost(WEBGL_LOSS);
    watcher.stop();
    const onLost = vi.fn();
    watcher.onLost(onLost);

    expect(onLost).not.toHaveBeenCalled();
  });

  it('takes one handler only', () => {
    const { renderer } = fakeRenderer(false);
    const watcher = watchDeviceLoss(renderer);
    watcher.onLost(vi.fn());
    expect(() => watcher.onLost(vi.fn())).toThrow(/already given a handler/);
  });
});

describe('outOfMemoryLoss', () => {
  it('reads a WebGPU out-of-memory error as a loss of the WebGPU device', () => {
    const error = { api: 'WebGPU', type: 'GPUOutOfMemoryError', message: 'createTexture' };
    expect(outOfMemoryLoss(error)).toEqual({
      api: 'WebGPU',
      message: 'createTexture',
      reason: 'out-of-memory',
      originalEvent: error,
    });
  });

  it('names the cause when the error has no message', () => {
    expect(outOfMemoryLoss({ type: 'GPUOutOfMemoryError', message: '' })?.message).toBe(
      'Out of GPU memory',
    );
  });

  it('ignores every other error', () => {
    expect(outOfMemoryLoss({ type: 'GPUValidationError', message: 'x' })).toBeNull();
    expect(outOfMemoryLoss('GPUOutOfMemoryError')).toBeNull();
    expect(outOfMemoryLoss(null)).toBeNull();
  });
});

describe('recoveryFor', () => {
  it('falls back to WebGL 2 only from a WebGPU loss the user did not pin', () => {
    expect(recoveryFor('WebGPU', 'auto')).toBe('webgl');
    expect(recoveryFor('WebGPU', 'webgpu')).toBe('reload');
    expect(recoveryFor('WebGL', 'auto')).toBe('reload');
    expect(recoveryFor('WebGL', 'webgl')).toBe('reload');
  });
});

describe('sessionBackend', () => {
  it('keeps the preference when this tab never lost WebGPU', () => {
    expect(sessionBackend('auto', new MemoryStore())).toEqual({ backend: 'auto', fellBack: false });
    expect(sessionBackend('auto', null)).toEqual({ backend: 'auto', fellBack: false });
  });

  it('starts auto on WebGL 2 after a loss in this tab', () => {
    const store = new MemoryStore();
    store.setItem(WEBGPU_LOST_KEY, '1');
    expect(sessionBackend('auto', store)).toEqual({ backend: 'webgl', fellBack: true });
  });

  it('never overrides a backend named in the URL', () => {
    const store = new MemoryStore();
    store.setItem(WEBGPU_LOST_KEY, '1');
    expect(sessionBackend('webgpu', store)).toEqual({ backend: 'webgpu', fellBack: false });
    expect(sessionBackend('webgl', store)).toEqual({ backend: 'webgl', fellBack: false });
  });
});

describe('webglFallbackUrl', () => {
  const href = 'https://devfish.bas.lu/tank/7?tier=high#care';

  it('records the loss and reloads the same page', () => {
    const store = new MemoryStore();
    expect(webglFallbackUrl(href, store)).toBe(href);
    expect(sessionBackend('auto', store).fellBack).toBe(true);
  });

  it('puts ?backend=webgl in the URL when there is no session storage', () => {
    expect(webglFallbackUrl(href, null)).toBe(
      'https://devfish.bas.lu/tank/7?tier=high&backend=webgl#care',
    );
  });

  it('puts ?backend=webgl in the URL when the storage refuses the write', () => {
    const full: SessionStore = {
      getItem: () => null,
      setItem: () => {
        throw new DOMException('quota', 'QuotaExceededError');
      },
    };
    expect(new URL(webglFallbackUrl(href, full)).searchParams.get('backend')).toBe('webgl');
  });
});
