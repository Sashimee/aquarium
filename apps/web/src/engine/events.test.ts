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

  it('clear() removes all handlers', () => {
    const bus = new EventBus<TestEvents>();
    bus.on('ping', vi.fn());
    bus.on('other', vi.fn());
    bus.clear();
    expect(bus.listenerCount('ping')).toBe(0);
    expect(bus.listenerCount('other')).toBe(0);
  });
});
