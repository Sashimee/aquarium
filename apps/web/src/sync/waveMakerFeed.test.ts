import { describe, expect, it } from 'vitest';
import { EventBus } from '../engine/events';
import type { InteractionEvents } from '../interaction/events';
import type { FlowField } from '@aquarium/sim';
import { WaveMakerFeed, type PumpScene } from './waveMakerFeed';

function setup() {
  const bus = new EventBus<InteractionEvents>();
  const feed = new WaveMakerFeed(bus);
  const tiers: number[] = [];
  const loaded = (tankId: string) =>
    bus.emit('tank:loaded', {
      tankId,
      biome: 'reef',
      size: 'standard',
      fish: [],
      decorLayout: [],
      decorEdited: false,
      backgroundId: 'reef-blue',
    } as unknown as InteractionEvents['tank:loaded']);
  return { bus, feed, tiers, sink: { setWaveMakerTier: (t: number) => tiers.push(t) }, loaded };
}

describe('WaveMakerFeed', () => {
  it('sends nothing but tier 0 to a tank without a wave maker', () => {
    const { feed, sink, tiers, loaded, bus } = setup();
    feed.attach(sink);
    loaded('a');
    bus.emit('tank:wave-maker', { tankId: 'a', tier: 0 });
    expect(tiers).toEqual([0]);
  });

  it('follows a purchase, an upgrade and a removal', () => {
    const { feed, sink, tiers, loaded, bus } = setup();
    feed.attach(sink);
    loaded('a');
    bus.emit('tank:wave-maker', { tankId: 'a', tier: 1 });
    bus.emit('tank:wave-maker', { tankId: 'a', tier: 3 });
    bus.emit('tank:wave-maker', { tankId: 'a', tier: 0 });
    expect(tiers).toEqual([0, 1, 3, 0]);
  });

  it('holds the tier of a tank loaded before the fish are up', () => {
    const { feed, sink, tiers, loaded, bus } = setup();
    loaded('a');
    bus.emit('tank:wave-maker', { tankId: 'a', tier: 2 });
    feed.attach(sink);
    expect(tiers).toEqual([2]);
  });

  it('removes the wave maker on a tank switch and applies the next tank own tier', () => {
    const { feed, sink, tiers, loaded, bus } = setup();
    feed.attach(sink);
    loaded('a');
    bus.emit('tank:wave-maker', { tankId: 'a', tier: 2 });
    bus.emit('tank:unloaded', { tankId: 'a', reason: 'switch' });
    loaded('b');
    bus.emit('tank:wave-maker', { tankId: 'b', tier: 0 });
    bus.emit('tank:unloaded', { tankId: 'b', reason: 'switch' });
    loaded('c');
    bus.emit('tank:wave-maker', { tankId: 'c', tier: 1 });
    expect(tiers).toEqual([0, 2, 0, 1]);
  });

  it('ignores a tier for a tank that is not the active one, and clears when no tank is coming', () => {
    const { feed, sink, tiers, loaded, bus } = setup();
    feed.attach(sink);
    loaded('a');
    bus.emit('tank:wave-maker', { tankId: 'other', tier: 3 });
    bus.emit('tank:wave-maker', { tankId: 'a', tier: 1 });
    bus.emit('tank:none', {});
    bus.emit('tank:wave-maker', { tankId: 'a', tier: 2 });
    expect(tiers).toEqual([0, 1, 0]);
  });

  describe('scene', () => {
    function withScene() {
      const t = setup();
      const calls: string[] = [];
      let now = 0;
      const scene: PumpScene = {
        setWaveMaker: (field, time) =>
          calls.push(`set ${field === null ? 'null' : String(field.settings.speedMps)} @${time}`),
        syncWaveMaker: (time) => calls.push(`sync @${time}`),
      };
      const source = {
        field: (tier: number) =>
          tier === 0 ? null : ({ settings: { speedMps: tier } } as unknown as FlowField),
        simTimeS: () => now,
      };
      return { ...t, calls, scene, source, setNow: (v: number) => (now = v) };
    }

    it('installs the pump on load, switch, purchase and removal', () => {
      const { feed, scene, source, calls, loaded, bus, setNow } = withScene();
      feed.attachScene(scene, source);
      loaded('a');
      setNow(4);
      bus.emit('tank:wave-maker', { tankId: 'a', tier: 2 });
      setNow(6);
      bus.emit('tank:wave-maker', { tankId: 'a', tier: 0 });
      bus.emit('tank:wave-maker', { tankId: 'a', tier: 3 });
      setNow(9);
      bus.emit('tank:unloaded', { tankId: 'a', reason: 'switch' });
      expect(calls).toEqual(['set null @0', 'set 2 @4', 'set null @6', 'set 3 @6', 'set null @9']);
    });

    it('hands a scene mounted late the pump held so far', () => {
      const { feed, scene, source, calls, loaded, bus, setNow } = withScene();
      loaded('a');
      bus.emit('tank:wave-maker', { tankId: 'a', tier: 1 });
      setNow(3);
      feed.attachScene(scene, source);
      expect(calls).toEqual(['set 1 @3']);
    });

    it('syncs the pump to the sim time every frame, and not once the scene is gone', () => {
      const { feed, scene, source, calls, setNow } = withScene();
      feed.attachScene(scene, source);
      calls.length = 0;
      setNow(1.5);
      feed.syncScene();
      setNow(1.55);
      feed.syncScene();
      feed.detachScene();
      feed.syncScene();
      expect(calls).toEqual(['sync @1.5', 'sync @1.55']);
    });
  });
});
