import { describe, expect, it, vi } from 'vitest';
import { EventBus } from './events';

interface TestEvents {
  ping: { n: number };
  other: string;
}

describe('EventBus', () => {
  it('delivers payloads to every handler of a type and nothing else', () => {
    const bus = new EventBus<TestEvents>();
    const a = vi.fn();
    const b = vi.fn();
    const other = vi.fn();
    bus.on('ping', a);
    bus.on('ping', b);
    bus.on('other', other);
    bus.emit('ping', { n: 1 });
    expect(a).toHaveBeenCalledWith({ n: 1 });
    expect(b).toHaveBeenCalledWith({ n: 1 });
    expect(other).not.toHaveBeenCalled();
  });

  it('emitting with no listeners is a no-op', () => {
    expect(() => new EventBus<TestEvents>().emit('other', 'x')).not.toThrow();
  });

  it('unsubscribes through the returned function and off()', () => {
    const bus = new EventBus<TestEvents>();
    const a = vi.fn();
    const b = vi.fn();
    const offA = bus.on('ping', a);
    bus.on('ping', b);
    offA();
    bus.off('ping', b);
    bus.emit('ping', { n: 2 });
    expect(a).not.toHaveBeenCalled();
    expect(b).not.toHaveBeenCalled();
    expect(bus.listenerCount('ping')).toBe(0);
  });

  it('once() fires a single time', () => {
    const bus = new EventBus<TestEvents>();
    const h = vi.fn();
    bus.once('other', h);
    bus.emit('other', 'a');
    bus.emit('other', 'b');
    expect(h).toHaveBeenCalledTimes(1);
    expect(h).toHaveBeenCalledWith('a');
  });

  it('a handler removing itself during emit does not skip the others', () => {
    const bus = new EventBus<TestEvents>();
    const calls: string[] = [];
    const off = bus.on('ping', () => {
      calls.push('first');
      off();
    });
    bus.on('ping', () => calls.push('second'));
    bus.emit('ping', { n: 0 });
    bus.emit('ping', { n: 0 });
    expect(calls).toEqual(['first', 'second', 'second']);
  });

  it('a throwing handler is reported and does not stop the others or the emitter', () => {
    const reported: [unknown, PropertyKey][] = [];
    const bus = new EventBus<TestEvents>((error, type) => reported.push([error, type]));
    const boom = new Error('boom');
    const after = vi.fn();
    bus.on('ping', () => {
      throw boom;
    });
    bus.on('ping', after);
    expect(() => bus.emit('ping', { n: 3 })).not.toThrow();
    expect(after).toHaveBeenCalledWith({ n: 3 });
    expect(reported).toEqual([[boom, 'ping']]);
  });

  it('rethrows handler errors asynchronously by default', async () => {
    const bus = new EventBus<TestEvents>();
    const boom = new Error('late boom');
    bus.on('other', () => {
      throw boom;
    });
    const thrown = new Promise<unknown>((resolve) => {
      const original = globalThis.queueMicrotask;
      globalThis.queueMicrotask = (task) => {
        globalThis.queueMicrotask = original;
        try {
          task();
        } catch (error) {
          resolve(error);
        }
      };
    });
    expect(() => bus.emit('other', 'x')).not.toThrow();
    await expect(thrown).resolves.toBe(boom);
  });

  it('clear() removes all handlers', () => {
    const bus = new EventBus<TestEvents>();
    bus.on('ping', vi.fn());
    bus.on('other', vi.fn());
    bus.clear();
    expect(bus.listenerCount('ping')).toBe(0);
    expect(bus.listenerCount('other')).toBe(0);
  });

  describe('sticky events', () => {
    it('lets a late subscriber read the last payload emitted before it existed', () => {
      const bus = new EventBus<TestEvents>(undefined, ['ping']);
      bus.emit('ping', { n: 1 });
      bus.emit('ping', { n: 2 });
      expect(bus.peek('ping')).toEqual({ n: 2 });
    });

    it('is undefined before the first emit and for types that are not sticky', () => {
      const bus = new EventBus<TestEvents>(undefined, ['ping']);
      expect(bus.peek('ping')).toBeUndefined();
      bus.emit('other', 'x');
      expect(bus.peek('other')).toBeUndefined();
    });

    it('is forgotten by clear', () => {
      const bus = new EventBus<TestEvents>(undefined, ['ping']);
      bus.emit('ping', { n: 1 });
      bus.clear();
      expect(bus.peek('ping')).toBeUndefined();
    });

    it('records the payload even when a handler throws', () => {
      const bus = new EventBus<TestEvents>(vi.fn(), ['ping']);
      bus.on('ping', () => {
        throw new Error('boom');
      });
      bus.emit('ping', { n: 3 });
      expect(bus.peek('ping')).toEqual({ n: 3 });
    });
  });
});
