import { describe, expect, it, vi } from 'vitest';
import {
  type DeviceLostInfo,
  type LossSource,
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
  const renderer: LossSource = {
    onDeviceLost: threeHandler,
    backend: withDevice ? { device: { lost } } : {},
  };
  return { renderer, threeHandler, loseDevice: resolveLost, lost };
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
    watchDeviceLoss(renderer, () => order.push('engine'));

    renderer.onDeviceLost(WEBGL_LOSS);

    expect(threeHandler).toHaveBeenCalledWith(WEBGL_LOSS);
    expect(order).toEqual(['three', 'engine']);
  });

  it('reports only the first loss', () => {
    const { renderer } = fakeRenderer(false);
    const onLost = vi.fn();
    watchDeviceLoss(renderer, onLost);

    renderer.onDeviceLost(WEBGL_LOSS);
    renderer.onDeviceLost(WEBGL_LOSS);

    expect(onLost).toHaveBeenCalledOnce();
  });

  it('treats a WebGPU device destroyed by the browser as lost, which three skips', async () => {
    const { renderer, threeHandler, loseDevice, lost } = fakeRenderer(true);
    const onLost = vi.fn();
    watchDeviceLoss(renderer, onLost);

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
    watchDeviceLoss(renderer, onLost);

    loseDevice({ reason: 'unknown', message: 'GPU process crashed' });
    await lost;
    await Promise.resolve();

    expect(onLost).not.toHaveBeenCalled();
  });

  it("ignores the destroy that the renderer's own dispose causes once stopped", async () => {
    const { renderer, threeHandler, loseDevice, lost } = fakeRenderer(true);
    const onLost = vi.fn();
    const stop = watchDeviceLoss(renderer, onLost);

    stop();
    loseDevice({ reason: 'destroyed', message: 'Device was destroyed.' });
    await lost;
    await Promise.resolve();

    expect(onLost).not.toHaveBeenCalled();
    expect(renderer.onDeviceLost).toBe(threeHandler);
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
