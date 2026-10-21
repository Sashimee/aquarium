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

/** A relay following a client whose world began at host epoch 2, with a scene bound to it. */
function running(daylight = 1): { relay: PolypRelay; client: FakeClient; signal: PolypSignal } {
  const relay = new PolypRelay(daylight);
  const client = new FakeClient();
  relay.follow(client);
  relay.world(2);
  const signal = new PolypSignal();
  signal.bind(relay);
  return { relay, client, signal };
}

describe('PolypRelay', () => {
  it('starts at the darkness before any world, and follows the light', () => {
    const relay = new PolypRelay(0.25);
    const signal = new PolypSignal();
    signal.bind(relay);
    expect(signal.extension).toBeCloseTo(0.75);
    relay.setDaylight(1);
    expect(signal.extension).toBe(0);
    relay.setDaylight(0);
    expect(signal.extension).toBe(1);
  });

  it('passes on the running world and hands a late listener its latest event at once', () => {
    const { relay, client, signal } = running();
    client.emit(0.3, 2, 10);
    expect(signal.extension).toBeCloseTo(0.3);
    const seen: number[] = [];
    relay.onPolyps((extension) => seen.push(extension));
    client.emit(0.6, 3, 40);
    expect(seen).toEqual([0.3, 0.6]);
  });

  it('lets a running world override the light, and the light back once the world stops', () => {
    const { relay, client, signal } = running(0);
    client.emit(0.4, 2, 0);
    relay.setDaylight(1);
    expect(signal.extension).toBeCloseTo(0.4);
    relay.world(null);
    expect(signal.extension).toBe(0);
  });

  it('never replays a stopped world to a scene mounted after it stopped', () => {
    const { relay, client } = running(0);
    client.emit(1, 2, 900);
    relay.setDaylight(1);
    relay.world(null);
    const next = new PolypSignal();
    next.bind(relay);
    expect(next.extension).toBe(0);
  });

  it('brings polyps that a stopped world left out back in as the light comes up', () => {
    const { relay, client, signal } = running(0);
    client.emit(1, 2, 900);
    relay.world(null);
    expect(signal.extension).toBe(1);
    relay.setDaylight(0.5);
    expect(signal.extension).toBeCloseTo(0.5);
    relay.setDaylight(1);
    expect(signal.extension).toBe(0);
  });

  it("drops a stopped world's late events until the next world begins, then takes that one's", () => {
    const { relay, client, signal } = running(1);
    relay.world(null);
    client.emit(0.9, 2, 30);
    client.emit(0.9, 3, 31);
    expect(signal.extension).toBe(0);
    relay.world(4);
    client.emit(0.9, 3, 32);
    expect(signal.extension).toBe(0);
    client.emit(0.2, 4, 0);
    expect(signal.extension).toBeCloseTo(0.2);
  });

  it('follows the light while a new world has said nothing yet', () => {
    const { relay, signal } = running(1);
    relay.world(null);
    relay.world(5);
    relay.setDaylight(0);
    expect(signal.extension).toBe(1);
  });

  it("drops the old client on follow and takes a replacement worker's low epochs", () => {
    const { relay, client: stuck, signal } = running(0);
    stuck.emit(0.9, 7, 300);
    relay.world(null);
    const fresh = new FakeClient();
    relay.follow(fresh);
    expect(stuck.listeners.size).toBe(0);
    relay.world(1);
    stuck.emit(0.1, 7, 301);
    expect(signal.extension).toBe(1);
    fresh.emit(0.4, 1, 0);
    expect(signal.extension).toBeCloseTo(0.4);
  });

  it('ignores a new client until its world begins', () => {
    const { relay, signal } = running(1);
    const fresh = new FakeClient();
    relay.follow(fresh);
    fresh.emit(0.8, 1, 0);
    expect(signal.extension).toBe(0);
  });

  it('refuses a daylight outside 0..1', () => {
    expect(() => new PolypRelay(Number.NaN)).toThrow(RangeError);
    expect(() => new PolypRelay(0).setDaylight(1.5)).toThrow(RangeError);
  });

  it('stops a listener that unsubscribed, and everything on dispose', () => {
    const { relay, client } = running();
    const kept: number[] = [];
    const dropped: number[] = [];
    relay.onPolyps((extension) => kept.push(extension));
    const off = relay.onPolyps((extension) => dropped.push(extension));
    client.emit(0.2, 2, 1);
    off();
    client.emit(0.4, 2, 2);
    relay.dispose();
    expect(client.listeners.size).toBe(0);
    client.emit(0.8, 2, 3);
    relay.setDaylight(0);
    expect(kept).toEqual([0, 0.2, 0.4]);
    expect(dropped).toEqual([0, 0.2]);
  });
});
