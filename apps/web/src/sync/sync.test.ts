import { describe, expect, it, vi } from 'vitest';
import { AteBatcher } from './ateBatcher';
import { FeedGate } from './feedGate';

describe('FeedGate', () => {
  it('enforces the cooldown between feeds', () => {
    const gate = new FeedGate({ cooldownMs: 1000 });
    expect(gate.tryFeed(0)).toEqual({ ok: true });
    expect(gate.tryFeed(400)).toEqual({ ok: false, retryAfterMs: 600 });
    expect(gate.tryFeed(1000)).toEqual({ ok: true });
  });

  it('refuses beyond the windowed maximum and recovers when the window slides', () => {
    const gate = new FeedGate({ max: 3, windowMs: 10_000, cooldownMs: 0 });
    for (let i = 0; i < 3; i++) expect(gate.tryFeed(i * 100).ok).toBe(true);
    expect(gate.tryFeed(500)).toEqual({ ok: false, retryAfterMs: 9_500 });
    expect(gate.tryFeed(10_000).ok).toBe(true);
  });

  it('does not count refused attempts', () => {
    const gate = new FeedGate({ max: 1, windowMs: 1000, cooldownMs: 0 });
    gate.tryFeed(0);
    gate.tryFeed(100);
    gate.tryFeed(200);
    expect(gate.tryFeed(1000).ok).toBe(true);
  });
});

function timers() {
  const queue: (() => void)[] = [];
  return {
    queue,
    api: {
      setTimeout: (cb: () => void) => {
        queue.push(cb);
        return queue.length;
      },
      clearTimeout: () => {
        queue.length = 0;
      },
    },
  };
}

describe('AteBatcher', () => {
  const FISH_A = '11111111-1111-4111-8111-111111111111';
  const FISH_B = '22222222-2222-4222-8222-222222222222';

  it('merges portions per fish and sends them on the timer', async () => {
    const flush = vi.fn().mockResolvedValue(undefined);
    const t = timers();
    const batcher = new AteBatcher({
      flush,
      timers: t.api,
      now: () => new Date('2026-01-01T00:00:00Z'),
    });
    batcher.add(FISH_A, 0.2);
    batcher.add(FISH_A, 0.3);
    batcher.add(FISH_B, 0.5);
    expect(t.queue).toHaveLength(1);
    t.queue[0]?.();
    await vi.waitFor(() => expect(flush).toHaveBeenCalledTimes(1));
    expect(flush.mock.calls[0]?.[0]).toEqual([
      { fishId: FISH_A, portion: 0.5, at: '2026-01-01T00:00:00.000Z' },
      { fishId: FISH_B, portion: 0.5, at: '2026-01-01T00:00:00.000Z' },
    ]);
    expect(batcher.size).toBe(0);
  });

  it('drops crumbs below the server minimum and non-positive portions', async () => {
    const flush = vi.fn().mockResolvedValue(undefined);
    const batcher = new AteBatcher({ flush, timers: timers().api });
    batcher.add(FISH_A, 0.001);
    batcher.add(FISH_B, 0);
    batcher.add(FISH_B, -1);
    await batcher.flushNow();
    expect(flush).not.toHaveBeenCalled();
  });

  it('splits batches at the server limit', async () => {
    const flush = vi.fn().mockResolvedValue(undefined);
    const batcher = new AteBatcher({ flush, maxPerBatch: 2, timers: timers().api });
    for (const id of ['a', 'b', 'c', 'd', 'e']) batcher.add(id, 0.1);
    await batcher.flushNow();
    expect(flush.mock.calls.map((c) => (c[0] as unknown[]).length)).toEqual([2, 2, 1]);
  });

  it('caps a merged portion at the schema maximum', async () => {
    const flush = vi.fn().mockResolvedValue(undefined);
    const batcher = new AteBatcher({ flush, timers: timers().api });
    batcher.add(FISH_A, 8);
    batcher.add(FISH_A, 8);
    await batcher.flushNow();
    expect((flush.mock.calls[0]?.[0] as { portion: number }[])[0]?.portion).toBe(10);
  });

  it('re-queues a failed batch and rethrows', async () => {
    const flush = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
    const batcher = new AteBatcher({ flush, timers: timers().api });
    batcher.add(FISH_A, 0.4);
    await expect(batcher.flushNow()).rejects.toThrow('offline');
    expect(batcher.size).toBe(1);
    await batcher.flushNow();
    expect(flush).toHaveBeenCalledTimes(2);
    expect(batcher.size).toBe(0);
  });
});
