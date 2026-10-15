import { describe, expect, it, vi } from 'vitest';
import { type LoopRenderer, RenderLoop } from './renderLoop';

class FakeRenderer implements LoopRenderer {
  callback: ((time: number) => void) | null = null;
  setAnimationLoop(callback: ((time: number) => void) | null): void {
    this.callback = callback;
  }
}

describe('RenderLoop', () => {
  it('runs the frame callback once started and stops it again', () => {
    const renderer = new FakeRenderer();
    const frame = vi.fn();
    const loop = new RenderLoop(renderer, frame);
    expect(renderer.callback).toBeNull();

    expect(loop.start()).toBe(true);
    renderer.callback?.(16);
    expect(frame).toHaveBeenCalledWith(16);

    loop.stop();
    expect(renderer.callback).toBeNull();
  });

  it('stays off when the device was lost before start()', () => {
    const renderer = new FakeRenderer();
    const setAnimationLoop = vi.spyOn(renderer, 'setAnimationLoop');
    const loop = new RenderLoop(renderer, vi.fn());

    loop.halt();

    expect(loop.start()).toBe(false);
    expect(loop.isHalted).toBe(true);
    expect(renderer.callback).toBeNull();
    expect(setAnimationLoop).not.toHaveBeenCalledWith(expect.any(Function));
  });

  it('turns a running loop off for good on a loss', () => {
    const renderer = new FakeRenderer();
    const loop = new RenderLoop(renderer, vi.fn());
    loop.start();

    loop.halt();
    expect(renderer.callback).toBeNull();
    expect(loop.start()).toBe(false);
    expect(renderer.callback).toBeNull();
  });
});
