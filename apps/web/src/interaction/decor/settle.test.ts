import { describe, expect, it } from 'vitest';
import { startDrop, stepDrop, type DropBody } from './settle';

function fall(
  from: number,
  rest: number,
  dt = 1 / 60,
): { body: DropBody; frames: number; lowest: number } {
  let body = startDrop(from);
  let frames = 0;
  let lowest = from;
  while (!body.settled && frames < 600) {
    body = stepDrop(body, dt, rest);
    lowest = Math.min(lowest, body.y);
    frames++;
  }
  return { body, frames, lowest };
}

describe('stepDrop', () => {
  it('comes to rest exactly on the substrate and never sinks below it', () => {
    const { body, lowest } = fall(0.3, 0.05);
    expect(body.settled).toBe(true);
    expect(body.y).toBe(0.05);
    expect(lowest).toBeGreaterThanOrEqual(0.05);
  });

  it('falls slowly, like a stone in water rather than in air', () => {
    const { frames } = fall(0.3, 0.05);
    expect(frames / 60).toBeGreaterThan(0.4);
    expect(frames / 60).toBeLessThan(3);
  });

  it('is deterministic whatever the frame rate', () => {
    const slow = fall(0.3, 0.05, 1 / 20).body;
    const fast = fall(0.3, 0.05, 1 / 120).body;
    expect(slow.y).toBe(fast.y);
  });

  it('is already settled when released on the ground', () => {
    const { body } = fall(0.05, 0.05);
    expect(body.settled).toBe(true);
    expect(body.y).toBe(0.05);
  });

  it('leaves a settled body alone', () => {
    const rest = { y: 0.05, vy: 0, settled: true };
    expect(stepDrop(rest, 1, 0.05)).toBe(rest);
  });
});
