import type { DecorLayout } from '@aquarium/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SaveStatus } from '../interaction/events';
import { LayoutSaver } from './layout';
import { apiError } from './fixtures';

const layoutAt = (x: number): DecorLayout => [
  { assetId: 'boulder-01', position: [x, 0.05, 0], rotationY: 0, scale: 1 },
];

function setup(send = vi.fn().mockResolvedValue(undefined)) {
  const reports: { status: SaveStatus; message: string | null }[] = [];
  const saver = new LayoutSaver({
    send,
    report: (status, message) => reports.push({ status, message }),
    debounceMs: 500,
    sleep: async () => undefined,
  });
  return { saver, send, reports };
}

afterEach(() => vi.useRealTimers());

describe('LayoutSaver', () => {
  it('waits for the burst to end and sends only the newest layout', async () => {
    vi.useFakeTimers();
    const { saver, send, reports } = setup();
    saver.submit('t1', layoutAt(0.1));
    await vi.advanceTimersByTimeAsync(300);
    saver.submit('t1', layoutAt(0.2));
    await vi.advanceTimersByTimeAsync(300);
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('t1', layoutAt(0.2));
    expect(reports.at(-1)).toEqual({ status: 'saved', message: null });
  });

  it('says it is saving as soon as an edit is made', () => {
    vi.useFakeTimers();
    const { saver, reports } = setup();
    saver.submit('t1', layoutAt(0.1));
    expect(reports).toEqual([{ status: 'saving', message: null }]);
    expect(saver.busy).toBe(true);
  });

  it('sends one request at a time and keeps an edit made mid-flight', async () => {
    vi.useFakeTimers();
    let finish: () => void = () => undefined;
    const send = vi
      .fn()
      .mockImplementationOnce(() => new Promise<void>((resolve) => (finish = resolve)))
      .mockResolvedValue(undefined);
    const { saver } = setup(send);
    saver.submit('t1', layoutAt(0.1));
    await vi.advanceTimersByTimeAsync(500);
    expect(send).toHaveBeenCalledTimes(1);
    saver.submit('t1', layoutAt(0.3));
    await vi.advanceTimersByTimeAsync(500);
    expect(send).toHaveBeenCalledTimes(1);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith('t1', layoutAt(0.3));
    expect(saver.busy).toBe(false);
  });

  it('retries a network failure with backoff and then succeeds quietly', async () => {
    vi.useFakeTimers();
    const send = vi.fn().mockRejectedValueOnce(apiError(0, 'network')).mockResolvedValue(undefined);
    const { saver, reports } = setup(send);
    saver.submit('t1', layoutAt(0.1));
    await vi.advanceTimersByTimeAsync(500);
    expect(send).toHaveBeenCalledTimes(2);
    expect(reports.map((r) => r.status)).toEqual(['saving', 'saved']);
  });

  it('reports a rejected layout once and offers a retry that resends it', async () => {
    vi.useFakeTimers();
    const send = vi
      .fn()
      .mockRejectedValueOnce(apiError(400, 'validation_failed'))
      .mockResolvedValue(undefined);
    const { saver, reports } = setup(send);
    saver.submit('t1', layoutAt(0.1));
    await vi.advanceTimersByTimeAsync(500);
    expect(send).toHaveBeenCalledTimes(1);
    expect(reports.at(-1)?.status).toBe('error');
    expect(reports.at(-1)?.message).toBeTruthy();
    saver.retry();
    await vi.advanceTimersByTimeAsync(500);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith('t1', layoutAt(0.1));
    expect(reports.at(-1)).toEqual({ status: 'saved', message: null });
  });

  it('does nothing on retry when nothing failed', async () => {
    vi.useFakeTimers();
    const { saver, send } = setup();
    saver.retry();
    await vi.advanceTimersByTimeAsync(1000);
    expect(send).not.toHaveBeenCalled();
  });

  it('flush sends at once without waiting for the pause', async () => {
    vi.useFakeTimers();
    const { saver, send } = setup();
    saver.submit('t1', layoutAt(0.1));
    await saver.flush();
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('keeps tanks apart: switching tanks does not drop the first tank edit', async () => {
    vi.useFakeTimers();
    const { saver, send } = setup();
    saver.submit('t1', layoutAt(0.1));
    saver.submit('t2', layoutAt(0.2));
    await saver.flush();
    expect(send.mock.calls.map((c) => c[0]).sort()).toEqual(['t1', 't2']);
  });

  it('sends what is pending when disposed, and accepts nothing after', async () => {
    vi.useFakeTimers();
    const { saver, send } = setup();
    saver.submit('t1', layoutAt(0.1));
    saver.dispose();
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(1);
    saver.submit('t1', layoutAt(0.5));
    await vi.advanceTimersByTimeAsync(1000);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('reset drops a waiting edit and a failed save', async () => {
    vi.useFakeTimers();
    const send = vi.fn().mockRejectedValue(apiError(400, 'validation_failed'));
    const { saver, reports } = setup(send);
    saver.submit('t1', layoutAt(0.1));
    saver.reset();
    await vi.advanceTimersByTimeAsync(1000);
    expect(send).not.toHaveBeenCalled();
    expect(saver.busy).toBe(false);
    expect(reports.at(-1)).toEqual({ status: 'idle', message: null });

    saver.submit('t1', layoutAt(0.2));
    await vi.advanceTimersByTimeAsync(500);
    expect(saver.busy).toBe(true);
    saver.reset();
    saver.retry();
    await vi.advanceTimersByTimeAsync(1000);
    expect(send).toHaveBeenCalledTimes(1);
    expect(saver.busy).toBe(false);
  });

  it('reset stops retrying an in-flight save and stays quiet about its outcome', async () => {
    vi.useFakeTimers();
    let fail: (e: unknown) => void = () => undefined;
    const send = vi.fn().mockImplementation(() => new Promise<void>((_r, reject) => (fail = reject)));
    const { saver, reports } = setup(send);
    saver.submit('t1', layoutAt(0.1));
    await vi.advanceTimersByTimeAsync(500);
    saver.reset();
    fail(apiError(0, 'network'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(send).toHaveBeenCalledTimes(1);
    expect(reports.map((r) => r.status)).toEqual(['saving', 'idle']);
  });

  it('stays busy while a failed save waits for Retry', async () => {
    vi.useFakeTimers();
    const send = vi.fn().mockRejectedValue(apiError(400, 'validation_failed'));
    const { saver } = setup(send);
    saver.submit('t1', layoutAt(0.1));
    await vi.advanceTimersByTimeAsync(500);
    expect(saver.busy).toBe(true);
  });
});
