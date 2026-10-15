import { describe, expect, it } from 'vitest';
import { BatchCache } from './batchCache';

interface Batch {
  readonly key: string;
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function setup(initial: string[] = []) {
  const wanted = new Set(initial);
  const released: Batch[] = [];
  const cache = new BatchCache<Batch>(
    (batch) => released.push(batch),
    () => wanted,
  );
  const loads: string[] = [];
  const loader = (key: string) => () => {
    loads.push(key);
    return Promise.resolve<Batch>({ key });
  };
  return { cache, wanted, released, loads, loader };
}

describe('BatchCache', () => {
  it('shares one load between concurrent requests for a key', async () => {
    const { cache, loads, loader } = setup(['guppy']);
    await Promise.all([cache.load('guppy', loader('guppy')), cache.load('guppy', loader('guppy'))]);
    await cache.load('guppy', loader('guppy'));
    expect(loads).toEqual(['guppy']);
    expect(cache.get('guppy')).toEqual({ key: 'guppy' });
  });

  it('does not retry a key whose load could not give a batch', async () => {
    const { cache } = setup(['ghost']);
    let calls = 0;
    const load = () => {
      calls++;
      return Promise.resolve(null);
    };
    await cache.load('ghost', load);
    await cache.load('ghost', load);
    expect(calls).toBe(1);
    expect(cache.get('ghost')).toBeUndefined();
  });

  it('releases a batch that loads after its key stopped being wanted, and keeps nothing', async () => {
    const { cache, wanted, released } = setup(['neon']);
    const late = deferred<Batch>();
    const loading = cache.load('neon', () => late.promise);
    wanted.delete('neon');
    late.resolve({ key: 'neon' });
    await loading;
    expect(released).toEqual([{ key: 'neon' }]);
    expect([...cache.values()]).toEqual([]);
    cache.dispose();
    expect(released).toHaveLength(1);
  });

  it('releases a batch that loads after disposal, once', async () => {
    const { cache, released } = setup(['neon']);
    const late = deferred<Batch>();
    const loading = cache.load('neon', () => late.promise);
    cache.dispose();
    expect(released).toEqual([]);
    late.resolve({ key: 'neon' });
    await loading;
    expect(released).toEqual([{ key: 'neon' }]);
    expect(cache.get('neon')).toBeUndefined();
  });

  it('loads nothing after disposal', async () => {
    const { cache, loads, loader } = setup(['neon']);
    cache.dispose();
    await cache.load('neon', loader('neon'));
    expect(loads).toEqual([]);
  });

  it('evicts exactly the unwanted batches, and disposal does not release them again', async () => {
    const { cache, wanted, released, loader } = setup(['guppy', 'neon']);
    await cache.load('guppy', loader('guppy'));
    await cache.load('neon', loader('neon'));
    wanted.delete('neon');
    cache.evictUnwanted();
    expect(released).toEqual([{ key: 'neon' }]);
    expect(cache.get('neon')).toBeUndefined();
    cache.evictUnwanted();
    expect(released).toHaveLength(1);
    cache.dispose();
    expect(released).toEqual([{ key: 'neon' }, { key: 'guppy' }]);
    cache.dispose();
    expect(released).toHaveLength(2);
  });

  it('loads an evicted key afresh once it is wanted again', async () => {
    const { cache, wanted, loads, loader } = setup(['neon']);
    await cache.load('neon', loader('neon'));
    wanted.clear();
    cache.evictUnwanted();
    wanted.add('neon');
    await cache.load('neon', loader('neon'));
    expect(loads).toEqual(['neon', 'neon']);
    expect(cache.get('neon')).toEqual({ key: 'neon' });
  });

  it('keeps a batch whose key is wanted again before its load finishes', async () => {
    const { cache, wanted, released } = setup(['neon']);
    const late = deferred<Batch>();
    const loading = cache.load('neon', () => late.promise);
    wanted.delete('neon');
    cache.evictUnwanted();
    wanted.add('neon');
    late.resolve({ key: 'neon' });
    await loading;
    expect(released).toEqual([]);
    expect(cache.get('neon')).toEqual({ key: 'neon' });
  });
});
