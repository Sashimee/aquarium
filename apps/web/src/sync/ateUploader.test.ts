import type { AteReport } from '@aquarium/shared';
import { describe, expect, it, vi } from 'vitest';
import { AteUploader, type DropReason } from './ateUploader';
import { apiError, FISH_1, FISH_2 } from './fixtures';

function harness(
  send: (r: AteReport[]) => Promise<void>,
  extra: Partial<ConstructorParameters<typeof AteUploader>[0]> = {},
) {
  let clock = new Date('2026-03-01T12:00:00.000Z');
  const dropped: { reason: DropReason; count: number }[] = [];
  const sleeps: number[] = [];
  const queue: (() => void)[] = [];
  const uploader = new AteUploader({
    send,
    onDropped: (reason, reports) => dropped.push({ reason, count: reports.length }),
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0.5,
    timers: {
      setTimeout: (cb) => queue.push(cb),
      clearTimeout: () => undefined,
    },
    ...extra,
  });
  return {
    uploader,
    dropped,
    sleeps,
    advance: (ms: number) => (clock = new Date(clock.getTime() + ms)),
  };
}

describe('AteUploader', () => {
  it('delivers after a transient failure with exponential backoff', async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(apiError(0, 'network'))
      .mockRejectedValueOnce(apiError(503, 'internal'))
      .mockResolvedValue(undefined);
    const h = harness(send);
    h.uploader.add(FISH_1, 0.5);
    await h.uploader.flushNow();
    expect(send).toHaveBeenCalledTimes(3);
    expect(h.sleeps).toEqual([1000, 2000]);
    expect(h.dropped).toEqual([]);
    expect(h.uploader.size).toBe(0);
  });

  it('reuses one batch id across retries and uses a fresh one for the next batch', async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(apiError(0, 'network'))
      .mockRejectedValueOnce(apiError(0, 'timeout'))
      .mockResolvedValue(undefined);
    const h = harness(send);
    h.uploader.add(FISH_1, 0.5);
    await h.uploader.flushNow();
    const ids = send.mock.calls.map((c) => c[1] as string);
    expect(ids).toHaveLength(3);
    expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Set(ids).size).toBe(1);
    h.uploader.add(FISH_1, 0.5);
    await h.uploader.flushNow();
    expect(send.mock.calls[3]?.[1]).not.toBe(ids[0]);
  });

  it('keeps the original timestamps across retries', async () => {
    const send = vi.fn().mockRejectedValueOnce(apiError(0, 'network')).mockResolvedValue(undefined);
    const h = harness(send);
    h.uploader.add(FISH_1, 0.5);
    h.advance(30_000);
    await h.uploader.flushNow();
    expect(send.mock.calls[1]?.[0]).toEqual([
      { fishId: FISH_1, portion: 0.5, at: '2026-03-01T12:00:00.000Z' },
    ]);
  });

  it('drops a rejected batch instead of retrying it forever', async () => {
    const send = vi.fn().mockRejectedValue(apiError(422, 'feeding_rejected'));
    const h = harness(send);
    h.uploader.add(FISH_1, 0.5);
    await h.uploader.flushNow();
    expect(send).toHaveBeenCalledTimes(1);
    expect(h.dropped).toEqual([{ reason: 'rejected', count: 1 }]);
    expect(h.uploader.size).toBe(0);
  });

  it('gives up after the attempt limit while offline, bounded in time and memory', async () => {
    const send = vi.fn().mockRejectedValue(apiError(0, 'network'));
    const h = harness(send, { maxAttempts: 4 });
    h.uploader.add(FISH_1, 0.5);
    h.uploader.add(FISH_2, 0.5);
    await h.uploader.flushNow();
    expect(send).toHaveBeenCalledTimes(4);
    expect(h.dropped).toEqual([{ reason: 'gave-up', count: 2 }]);
    expect(h.uploader.size).toBe(0);
  });

  it('drops reports older than the server feeding window before sending', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const h = harness(send, { maxAgeMs: 60_000 });
    h.uploader.add(FISH_1, 0.5);
    h.advance(61_000);
    h.uploader.add(FISH_2, 0.5);
    await h.uploader.flushNow();
    expect(send).toHaveBeenCalledTimes(1);
    expect((send.mock.calls[0]?.[0] as AteReport[]).map((r) => r.fishId)).toEqual([FISH_2]);
    expect(h.dropped).toEqual([{ reason: 'expired', count: 1 }]);
  });

  it('expires a report that ages out while waiting to retry', async () => {
    const attempts = vi.fn(async () => {
      h.advance(40_000);
      throw apiError(0, 'network');
    });
    const h = harness(attempts, { maxAgeMs: 60_000, maxAttempts: 10 });
    h.uploader.add(FISH_1, 0.5);
    await h.uploader.flushNow();
    expect(attempts).toHaveBeenCalledTimes(2);
    expect(h.dropped).toEqual([{ reason: 'expired', count: 1 }]);
  });

  it('merges one fish eating repeatedly into a single report', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const h = harness(send);
    for (let i = 0; i < 50; i++) h.uploader.add(FISH_1, 0.1);
    expect(h.uploader.size).toBe(1);
    await h.uploader.flushNow();
    expect(send).toHaveBeenCalledTimes(1);
    expect((send.mock.calls[0]?.[0] as AteReport[])[0]?.portion).toBeCloseTo(5);
  });

  it('abandons a retry in progress when disposed', async () => {
    const send = vi.fn().mockRejectedValue(apiError(0, 'network'));
    let sleeping = false;
    const h = harness(send, {
      sleep: (_ms, signal) =>
        new Promise<void>((_resolve, reject) => {
          sleeping = true;
          signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    });
    h.uploader.add(FISH_1, 0.5);
    const pending = h.uploader.flushNow();
    await vi.waitFor(() => expect(sleeping).toBe(true));
    h.uploader.dispose();
    await pending.catch(() => undefined);
    expect(send).toHaveBeenCalledTimes(1);
    expect(h.dropped).toEqual([]);
  });
});
