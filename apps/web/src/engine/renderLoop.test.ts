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

  it('stops drawing while the page is hidden and resumes once shown', () => {
    const renderer = new FakeRenderer();
    const loop = new RenderLoop(renderer, vi.fn());
    loop.start();

    loop.setHidden(true);
    expect(renderer.callback).toBeNull();
    loop.setHidden(false);
    expect(renderer.callback).toEqual(expect.any(Function));
  });

  it('starts paused on a hidden page and draws from the moment it shows', () => {
    const renderer = new FakeRenderer();
    const loop = new RenderLoop(renderer, vi.fn());
    loop.setHidden(true);

    expect(loop.start()).toBe(true);
    expect(renderer.callback).toBeNull();
    loop.setHidden(false);
    expect(renderer.callback).toEqual(expect.any(Function));
  });

  it('does not start a loop that was never started when the page shows', () => {
    const renderer = new FakeRenderer();
    const setAnimationLoop = vi.spyOn(renderer, 'setAnimationLoop');
    const loop = new RenderLoop(renderer, vi.fn());

    loop.setHidden(true);
    loop.setHidden(false);
    expect(setAnimationLoop).not.toHaveBeenCalled();
  });

  it('keeps a halted loop off when the page shows again', () => {
    const renderer = new FakeRenderer();
    const loop = new RenderLoop(renderer, vi.fn());
    loop.start();
    loop.setHidden(true);
    loop.halt();

    loop.setHidden(false);
    expect(renderer.callback).toBeNull();
  });

  it('stays stopped after stop() whatever the page visibility does', () => {
    const renderer = new FakeRenderer();
    const loop = new RenderLoop(renderer, vi.fn());
    loop.start();
    loop.stop();

    loop.setHidden(true);
    loop.setHidden(false);
    expect(renderer.callback).toBeNull();
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
