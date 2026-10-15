import { describe, expect, it, vi } from 'vitest';
import { initRenderer, type StartableRenderer } from './Engine';
import { DisposeStack } from './lifecycle';
import type { EngineOptions } from './options';

class FakeRenderer implements StartableRenderer {
  readonly dispose = vi.fn();
  onDeviceLost = vi.fn<StartableRenderer['onDeviceLost']>();
  constructor(
    readonly backend: object,
    private readonly initResult: () => Promise<unknown>,
  ) {}
  init(): Promise<unknown> {
    return this.initResult();
  }
}

function options(backend: EngineOptions['backend']): EngineOptions {
  return { backend, tier: null, adaptive: true, clock: null, stats: false };
}

describe('initRenderer', () => {
  it('returns the renderer and its backend kind, with disposal registered', async () => {
    const cleanup = new DisposeStack();
    const fake = new FakeRenderer({ isWebGPUBackend: true }, () => Promise.resolve());
    const { renderer, backend } = await initRenderer(options('auto'), cleanup, () => fake, 1);
    expect(renderer).toBe(fake);
    expect(backend).toBe('webgpu');
    expect(fake.dispose).not.toHaveBeenCalled();
    await cleanup.dispose();
    expect(fake.dispose).toHaveBeenCalledOnce();
  });

  it('passes the backend request and antialiasing choice to the factory', async () => {
    const create = vi.fn(() => new FakeRenderer({}, () => Promise.resolve()));
    const { backend } = await initRenderer(options('webgl'), new DisposeStack(), create, 2);
    expect(backend).toBe('webgl2');
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ forceWebGL: true, antialias: false, trackTimestamp: true }),
    );
  });

  it('leaves the renderer on the cleanup stack when init() rejects', async () => {
    const cleanup = new DisposeStack();
    const failure = new Error('no adapter');
    const fake = new FakeRenderer({}, () => Promise.reject(failure));
    await expect(initRenderer(options('auto'), cleanup, () => fake, 1)).rejects.toBe(failure);
    await cleanup.dispose();
    expect(fake.dispose).toHaveBeenCalledOnce();
  });

  it('hands on a context lost while init() was pending', async () => {
    const fake: FakeRenderer = new FakeRenderer({}, () => {
      fake.onDeviceLost({ api: 'WebGL', message: 'lost', reason: null, originalEvent: null });
      return Promise.resolve();
    });
    const { deviceLoss } = await initRenderer(options('auto'), new DisposeStack(), () => fake, 1);
    const onLost = vi.fn();
    deviceLoss.onLost(onLost);
    expect(onLost).toHaveBeenCalledWith(expect.objectContaining({ api: 'WebGL' }));
  });

  it('stops watching before it disposes the renderer', async () => {
    const cleanup = new DisposeStack();
    const fake = new FakeRenderer({}, () => Promise.resolve());
    const threeHandler = fake.onDeviceLost;
    await initRenderer(options('auto'), cleanup, () => fake, 1);
    expect(fake.onDeviceLost).not.toBe(threeHandler);
    fake.dispose.mockImplementation(() => expect(fake.onDeviceLost).toBe(threeHandler));
    await cleanup.dispose();
    expect(fake.dispose).toHaveBeenCalledOnce();
  });

  it('refuses a WebGL2 fallback when WebGPU was requested, after registering disposal', async () => {
    const cleanup = new DisposeStack();
    const fake = new FakeRenderer({}, () => Promise.resolve());
    await expect(initRenderer(options('webgpu'), cleanup, () => fake, 1)).rejects.toThrow(
      /WebGPU was requested/,
    );
    await cleanup.dispose();
    expect(fake.dispose).toHaveBeenCalledOnce();
  });
});
