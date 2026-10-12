import { describe, expect, it } from 'vitest';
import { RebuildQueue } from './rebuildQueue';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

function harness() {
  const installed: string[] = [];
  const dropped: string[] = [];
  const gates = new Map<string, ReturnType<typeof deferred>>();
  const errors: unknown[] = [];
  const queue = new RebuildQueue<string>(
    (a, b) => a === b,
    async (key, isStale) => {
      const gate = gates.get(key);
      if (gate) await gate.promise;
      if (key === 'broken') throw new Error('load failed');
      if (isStale()) {
        dropped.push(key);
        return false;
      }
      installed.push(key);
      return true;
    },
    (cause) => errors.push(cause),
  );
  queue.adopt('A');
  return { queue, installed, dropped, gates, errors };
}

describe('RebuildQueue', () => {
  it('ignores a request for the tier already shown', async () => {
    const { queue, installed } = harness();
    queue.request('A');
    await queue.settled();
    expect(installed).toEqual([]);
  });

  it('installs a plain switch', async () => {
    const { queue, installed } = harness();
    queue.request('B');
    await queue.settled();
    expect(installed).toEqual(['B']);
    expect(queue.shownKey).toBe('B');
  });

  it('drops B when the tier returns to A while B is still loading', async () => {
    const { queue, installed, dropped, gates } = harness();
    gates.set('B', deferred());
    queue.request('B');
    queue.request('A');
    gates.get('B')?.resolve();
    await queue.settled();
    expect(installed).toEqual([]);
    expect(dropped).toEqual(['B']);
    expect(queue.shownKey).toBe('A');
  });

  it('builds only the latest of several queued requests', async () => {
    const { queue, installed, dropped, gates } = harness();
    gates.set('B', deferred());
    queue.request('B');
    queue.request('C');
    gates.get('B')?.resolve();
    await queue.settled();
    expect(dropped).toEqual(['B']);
    expect(installed).toEqual(['C']);
  });

  it('allows a retry after a failed build', async () => {
    const { queue, errors } = harness();
    queue.request('broken');
    await queue.settled();
    expect(errors).toHaveLength(1);
    expect(queue.shownKey).toBe('A');
    queue.request('broken');
    await queue.settled();
    expect(errors).toHaveLength(2);
  });

  it('stops building after stop()', async () => {
    const { queue, installed } = harness();
    await queue.stop();
    queue.request('B');
    await queue.settled();
    expect(installed).toEqual([]);
  });
});
