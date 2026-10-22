import { describe, expect, it } from 'vitest';
import { Scene } from 'three/webgpu';
import type { Engine } from '../../engine/Engine';
import { EventBus, type EngineEvents } from '../../engine/events';
import { TANK_DIMENSIONS } from '../../engine/tank/dimensions';
import type { Tier } from '../../engine/quality/tiers';
import { mountRoom } from './mount';
import { RoomPreference } from './preference';

function harness(initial: string | null = 'office') {
  const events = new EventBus<EngineEvents>();
  const state = { dimensions: TANK_DIMENSIONS.standard, tier: 'high' as Tier };
  const scene = new Scene();
  const engine = {
    scene,
    events,
    tank: {
      get dimensions() {
        return state.dimensions;
      },
    },
    quality: {
      get tier() {
        return state.tier;
      },
    },
  } as unknown as Engine;
  const store = { value: initial };
  const preference = new RoomPreference(
    { getItem: () => store.value, setItem: (_k, v) => void (store.value = v) },
    null,
  );
  return { engine, events, state, scene, preference };
}

describe('mountRoom', () => {
  it('adds the room to the scene and builds the chosen layout', () => {
    const { engine, scene, preference } = harness();
    const mounted = mountRoom(engine, preference);
    expect(scene.children).toContain(mounted.backdrop.group);
    expect(mounted.backdrop.layout?.preset).toBe('office');
  });

  it('refits when the tank is resized', () => {
    const { engine, events, state, preference } = harness();
    const { backdrop } = mountRoom(engine, preference);
    const before = backdrop.layout?.tank.max[0];
    state.dimensions = TANK_DIMENSIONS.nano30;
    events.emit('engine:tank-resized', {
      size: 'nano30',
      dimensions: state.dimensions,
      litres: 30,
    });
    expect(backdrop.layout?.tank.max[0]).toBeCloseTo(TANK_DIMENSIONS.nano30.length / 2);
    expect(backdrop.layout?.tank.max[0]).not.toBe(before);
  });

  it('refits when the quality tier changes', () => {
    const { engine, events, state, preference } = harness();
    const { backdrop } = mountRoom(engine, preference);
    expect(backdrop.group.children.map((c) => c.name)).toContain('room-ceiling');
    state.tier = 'low';
    events.emit('quality:tier-changed', { from: 'high', to: 'low', reason: 'manual' });
    expect(backdrop.group.children.map((c) => c.name)).not.toContain('room-ceiling');
  });

  it('refits when the preference changes, and removes the room for none', () => {
    const { engine, preference } = harness();
    const { backdrop } = mountRoom(engine, preference);
    preference.set('living-room');
    expect(backdrop.layout?.preset).toBe('living-room');
    preference.set('none');
    expect(backdrop.group.children).toHaveLength(0);
  });

  it('stops listening and leaves the scene on dispose', () => {
    const { engine, events, state, scene, preference } = harness();
    const mounted = mountRoom(engine, preference);
    mounted.dispose();
    expect(scene.children).not.toContain(mounted.backdrop.group);
    state.tier = 'low';
    events.emit('quality:tier-changed', { from: 'high', to: 'low', reason: 'manual' });
    preference.set('living-room');
    state.dimensions = TANK_DIMENSIONS.nano30;
    events.emit('engine:tank-resized', {
      size: 'nano30',
      dimensions: state.dimensions,
      litres: 30,
    });
    expect(mounted.backdrop.group.children).toHaveLength(0);
    expect(mounted.backdrop.layout).toBeNull();
  });
});
