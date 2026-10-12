import { describe, expect, it } from 'vitest';
import { RateLimiter } from './rate-limit.ts';

describe('RateLimiter', () => {
  const limit = { max: 2, windowMs: 10_000 };

  it('allows up to max hits, then reports seconds until the oldest expires', () => {
    let now = 0;
    const limiter = new RateLimiter(() => now);
    expect(limiter.consume('k', limit)).toBe(0);
    now = 4000;
    expect(limiter.consume('k', limit)).toBe(0);
    now = 5000;
    expect(limiter.consume('k', limit)).toBe(5);
    expect(limiter.remaining('k', limit)).toBe(5);
  });

  it('frees a slot once the window has passed and keeps keys independent', () => {
    let now = 0;
    const limiter = new RateLimiter(() => now);
    limiter.consume('a', limit);
    limiter.consume('a', limit);
    expect(limiter.consume('b', limit)).toBe(0);
    now = 10_000;
    expect(limiter.consume('a', limit)).toBe(0);
  });

  it('does not count rejected hits against the caller', () => {
    let now = 0;
    const limiter = new RateLimiter(() => now);
    limiter.consume('k', limit);
    limiter.consume('k', limit);
    for (let i = 0; i < 20; i++) limiter.consume('k', limit);
    now = 10_000;
    expect(limiter.consume('k', limit)).toBe(0);
  });

  it("sweeps each key by its own window, not the caller's", () => {
    let now = 0;
    const limiter = new RateLimiter(() => now);
    const long = { max: 2, windowMs: 3_600_000 };
    const short = { max: 1000, windowMs: 1000 };
    limiter.consume('long', long);
    limiter.consume('long', long);
    expect(limiter.consume('long', long)).toBeGreaterThan(0);
    now = 61_000;
    for (let i = 0; i < 1100; i++) limiter.consume(`short-${i}`, short);
    expect(limiter.consume('long', long)).toBeGreaterThan(0);
  });
});
