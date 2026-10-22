import { describe, expect, it } from 'vitest';
import { FrameCap } from './framePacing';

/** A deterministic jitter in [-amplitude, amplitude]. */
function jitter(seed: number, amplitude: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return (state / 2147483648 - 0.5) * 2 * amplitude;
  };
}

interface Run {
  ticks: number;
  drawn: number;
  fps: number;
  frameMs: number[];
}

/** Ticks a display at `hz` for `seconds` through `cap`. */
function run(cap: FrameCap, hz: number, seconds = 10, jitterMs = 0, startMs = 0): Run {
  const next = jitter(7, jitterMs);
  const ticks = Math.round(hz * seconds);
  const frameMs: number[] = [];
  for (let i = 0; i < ticks; i++) {
    const ms = cap.tick(startMs + (i * 1000) / hz + next());
    if (ms !== null) frameMs.push(ms);
  }
  return { ticks, drawn: frameMs.length, fps: frameMs.length / seconds, frameMs };
}

const CAP_MS = 1000 / 60;

describe('FrameCap', () => {
  it('draws the first tick and reports no frame time for it', () => {
    expect(new FrameCap(60).tick(1234)).toBe(0);
    expect(new FrameCap(null).tick(1234)).toBe(0);
  });

  it('draws every tick at the raw interval when uncapped', () => {
    const cap = new FrameCap(null);
    const r = run(cap, 144, 2);
    expect(r.drawn).toBe(r.ticks);
    for (const ms of r.frameMs.slice(1)) expect(ms).toBeCloseTo(1000 / 144, 6);
    expect(cap.fps).toBeNull();
  });

  it('never drops a frame on a 60 Hz display with a millisecond of timestamp jitter', () => {
    const r = run(new FrameCap(60), 60, 10, 1);
    expect(r.drawn).toBe(r.ticks);
  });

  it('draws every tick of a display a little off 60 Hz', () => {
    for (const hz of [59.94, 60.5, 61]) {
      const r = run(new FrameCap(60), hz, 20, 0.3);
      expect(r.drawn, `${hz} Hz`).toBe(r.ticks);
    }
  });

  it('draws every second tick of a 120 Hz display', () => {
    const r = run(new FrameCap(60), 120, 10, 0.5);
    expect(r.drawn).toBe(r.ticks / 2);
  });

  it('holds 60 fps on displays that are not a multiple of 60', () => {
    for (const hz of [75, 90, 100, 144, 165, 240, 360]) {
      const { fps } = run(new FrameCap(60), hz, 20, 0.3);
      expect(fps, `${hz} Hz`).toBeGreaterThanOrEqual(59);
      expect(fps, `${hz} Hz`).toBeLessThanOrEqual(62);
    }
  });

  it('times frames that kept up at the cap interval, however uneven their tick gaps', () => {
    for (const hz of [100, 144, 165]) {
      const { frameMs } = run(new FrameCap(60), hz, 5, 0.3);
      for (const ms of frameMs.slice(1)) expect(ms, `${hz} Hz`).toBeCloseTo(CAP_MS, 6);
    }
  });

  it('draws every tick of a display slower than the cap and reports its real interval', () => {
    const r = run(new FrameCap(60), 50, 4);
    expect(r.drawn).toBe(r.ticks);
    for (const ms of r.frameMs.slice(1)) expect(ms).toBeCloseTo(20, 6);
  });

  it('reports a slow frame as it was', () => {
    const cap = new FrameCap(60);
    cap.tick(0);
    expect(cap.tick(40)).toBe(40);
  });

  it('resumes after a long gap without a burst of catch-up frames', () => {
    const cap = new FrameCap(60);
    run(cap, 144, 1);
    const after = run(cap, 144, 2, 0, 60_000);
    expect(after.frameMs[0]).toBeGreaterThan(1000);
    expect(after.fps).toBeGreaterThanOrEqual(59);
    expect(after.fps).toBeLessThanOrEqual(62);
  });

  it('can be raised to the display rate and capped again', () => {
    const cap = new FrameCap(60);
    cap.setFps(null);
    expect(run(cap, 144, 1).drawn).toBe(144);
    cap.setFps(60);
    expect(cap.fps).toBeCloseTo(60, 9);
    const { fps } = run(cap, 144, 5, 0, 10_000);
    expect(fps).toBeLessThanOrEqual(62);
  });

  it('rejects a cap that is not a positive rate', () => {
    for (const fps of [0, -30, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new FrameCap(fps)).toThrow(RangeError);
    }
  });
});
