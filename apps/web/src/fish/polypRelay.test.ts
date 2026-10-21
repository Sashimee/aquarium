import { describe, expect, it } from 'vitest';
import type { SimPolyps } from '@aquarium/sim';
import { PolypSignal } from '../scene/polyps';
import { PolypRelay } from './polypRelay';

class FakeClient {
  readonly listeners = new Set<(extension: number, event: SimPolyps) => void>();
  onPolyps(listener: (extension: number, event: SimPolyps) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(extension: number, epoch: number, tick: number): void {
    for (const l of this.listeners) l(extension, { type: 'polyps', epoch, tick, extension });
  }
}

describe('PolypRelay', () => {
  it('passes on the followed client and hands a late listener the latest event at once', () => {
    const relay = new PolypRelay();
    const client = new FakeClient();
    relay.follow(client);
    client.emit(0.3, 2, 10);
    const seen: [number, SimPolyps][] = [];
    relay.onPolyps((extension, event) => seen.push([extension, event]));
    client.emit(0.6, 2, 40);
    expect(seen).toEqual([
      [0.3, { type: 'polyps', epoch: 2, tick: 10, extension: 0.3 }],
      [0.6, { type: 'polyps', epoch: 2, tick: 40, extension: 0.6 }],
    ]);
  });

  it('replays nothing before the first event', () => {
    const relay = new PolypRelay();
    relay.follow(new FakeClient());
    const seen: number[] = [];
    relay.onPolyps((extension) => seen.push(extension));
    expect(seen).toEqual([]);
  });

  it("drops the old client on follow and moves a new worker's epochs past every earlier one", () => {
    const relay = new PolypRelay();
    const signal = new PolypSignal();
    signal.bind(relay);
    const stuck = new FakeClient();
    relay.follow(stuck);
    stuck.emit(0.9, 5, 300);
    expect(signal.extension).toBeCloseTo(0.9);

    const fresh = new FakeClient();
    relay.follow(fresh);
    expect(stuck.listeners.size).toBe(0);
    stuck.emit(0.1, 5, 301);
    expect(signal.extension).toBeCloseTo(0.9);
    fresh.emit(0.4, 1, 0);
    expect(signal.extension).toBeCloseTo(0.4);

    const third = new FakeClient();
    relay.follow(third);
    third.emit(0.2, 1, 0);
    expect(signal.extension).toBeCloseTo(0.2);
  });

  it('keeps the epoch base when a replacement says nothing before being replaced itself', () => {
    const relay = new PolypRelay();
    const signal = new PolypSignal();
    signal.bind(relay);
    const first = new FakeClient();
    relay.follow(first);
    first.emit(0.5, 3, 9);
    relay.follow(new FakeClient());
    const third = new FakeClient();
    relay.follow(third);
    third.emit(0.7, 1, 0);
    expect(signal.extension).toBeCloseTo(0.7);
  });

  it('stops a listener that unsubscribed, and everything on dispose', () => {
    const relay = new PolypRelay();
    const client = new FakeClient();
    relay.follow(client);
    const kept: number[] = [];
    const dropped: number[] = [];
    relay.onPolyps((extension) => kept.push(extension));
    const off = relay.onPolyps((extension) => dropped.push(extension));
    client.emit(0.2, 1, 1);
    off();
    client.emit(0.4, 1, 2);
    relay.dispose();
    expect(client.listeners.size).toBe(0);
    client.emit(0.8, 1, 3);
    expect(kept).toEqual([0.2, 0.4]);
    expect(dropped).toEqual([0.2]);
  });
});
