import type { DecorItem } from '@aquarium/shared';
import type { DecorCollider } from '@aquarium/sim';
import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../engine/events';
import type { CatalogEntry } from '../../scene/assets';
import type { InteractionEvents } from '../events';
import { SavedDecor } from './binding';
import { item, must } from './fixtures';
import catalog from '../../../public/assets/index.json';
import { layoutKey } from './key';
import { hasVacationFeeder } from './layout';
import { VACATION_FEEDER_ASSET_ID } from './spec';
import { FeederLayer } from './feederLayer';
import { DecorWorld, type DecorScenePort } from './world';

const preset: DecorItem[] = [item('boulder-01', -0.3, 0), item('coast-rocks-05', 0.3, 0.05)];
const plant: DecorItem = item('host-anemone', 0.1, -0.1);

function fakeScene() {
  const hard: DecorItem[][] = [];
  const moves: [number, DecorItem][] = [];
  const scene: DecorScenePort = {
    biome: 'freshwater',
    presetHardDecor: preset,
    fixedDecor: [plant],
    catalogEntries: () => catalog.assets as unknown as CatalogEntry[],
    groundHeight: () => 0.06,
    setHardDecor: (items) => {
      hard.push([...items]);
      return Promise.resolve();
    },
    moveHardDecor: (index, it) => {
      moves.push([index, it]);
    },
  };
  return { scene, hard, moves };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup() {
  const bus = new EventBus<InteractionEvents>();
  const colliders: (readonly DecorCollider[])[] = [];
  bus.on('decor:colliders', (e) => colliders.push(e.colliders));
  const { scene, hard, moves } = fakeScene();
  const feeders = new FeederLayer();
  const world = new DecorWorld(scene, bus, feeders);
  return { bus, world, feeders, hard, moves, colliders };
}

describe('DecorWorld', () => {
  it('starts on the preset pieces, numbered', () => {
    const { world } = setup();
    expect(world.pieces.map((p) => p.id)).toEqual(['p1', 'p2']);
  });

  it('composes the saved layout from the fixed plants and the pieces', () => {
    const { world } = setup();
    expect(world.layout()).toEqual([plant, ...preset]);
  });

  it('shows a saved layout and tells the sim about its colliders', async () => {
    const { world, hard, colliders } = setup();
    const saved = [plant, item('boulder-01', 0.1, 0.1)];
    await world.showSaved(saved);
    expect(hard.at(-1)).toEqual([saved[1]]);
    expect(must(colliders.at(-1)).map((c) => c.id)).toEqual(['decor:p1']);
  });

  it('reads an empty saved layout as an unedited tank and keeps the preset', async () => {
    const { world, hard } = setup();
    await world.showSaved([]);
    expect(hard.at(-1)).toEqual(preset);
  });

  it('keeps the vacation feeder out of the hardscape but in the layout and colliders', async () => {
    const { world, feeders, hard, colliders } = setup();
    const feeder = item(VACATION_FEEDER_ASSET_ID, 0, 0.1);
    await world.showSaved([plant, ...preset, feeder]);
    expect(hard.at(-1)).toEqual(preset);
    expect(must(colliders.at(-1)).map((c) => c.id)).toContain('decor:p3');
    expect(feeders.group.children).toHaveLength(1);
    const layout = world.layout();
    expect(hasVacationFeeder(layout)).toBe(true);
    expect(layout).toHaveLength(4);
  });

  it('removes the feeder visual when the feeder goes', async () => {
    const { world, feeders } = setup();
    await world.showSaved([item(VACATION_FEEDER_ASSET_ID, 0, 0.1), ...preset]);
    expect(feeders.group.children).toHaveLength(1);
    await world.showSaved(preset);
    expect(feeders.group.children).toHaveLength(0);
  });

  it('previews a move on the scene piece with the right index', async () => {
    const { world, moves } = setup();
    await world.showSaved([item(VACATION_FEEDER_ASSET_ID, 0, 0.1), ...preset]);
    const moved = { id: 'p3', item: item('coast-rocks-05', 0.2, 0.2) };
    world.preview(moved);
    expect(moves).toEqual([[1, moved.item]]);
    expect(must(world.pieces.find((p) => p.id === 'p3')).item.position[0]).toBe(0.2);
  });

  it('recognises the unedited preset layout', () => {
    const { world } = setup();
    expect(world.isPresetLayout(preset)).toBe(true);
    expect(world.isPresetLayout([plant, ...preset])).toBe(true);
    expect(world.isPresetLayout([preset[0] as DecorItem])).toBe(false);
  });

  it('applies rebuilds in order even when one is slow', async () => {
    const bus = new EventBus<InteractionEvents>();
    const order: number[] = [];
    const { scene } = fakeScene();
    let release: () => void = () => undefined;
    const slow: DecorScenePort = {
      ...scene,
      setHardDecor: (items) => {
        const n = items.length;
        if (n === 2) {
          return new Promise<void>((resolve) => {
            release = () => {
              order.push(n);
              resolve();
            };
          });
        }
        order.push(n);
        return Promise.resolve();
      },
    };
    const world = new DecorWorld(slow, bus, new FeederLayer());
    const first = world.show(world.pieces);
    const second = world.show(world.pieces.slice(0, 1));
    await settle();
    release();
    await Promise.all([first, second]);
    expect(order).toEqual([2, 1]);
  });
});

describe('layoutKey', () => {
  it('is the same for equal layouts and differs when anything moves', () => {
    expect(layoutKey(preset)).toBe(layoutKey(preset.map((i) => ({ ...i }))));
    expect(layoutKey(preset)).not.toBe(layoutKey([preset[1] as DecorItem, preset[0] as DecorItem]));
    expect(layoutKey([item('boulder-01', 0, 0)])).not.toBe(
      layoutKey([item('boulder-01', 0, 0, { rotationY: 0.1 })]),
    );
  });
});

describe('SavedDecor', () => {
  const fish: never[] = [];

  it('waits for the scene, then shows the tank that loaded first', async () => {
    const { bus, world, hard } = setup();
    const report = vi.fn();
    const saved = new SavedDecor(bus, report);
    const layout = [plant, item('boulder-01', 0.1, 0.1)];
    bus.emit('tank:loaded', { tankId: 't1', biome: 'freshwater', fish, decorLayout: layout });
    expect(saved.tankId).toBe('t1');
    saved.attach(world);
    await settle();
    expect(hard.at(-1)).toEqual([layout[1]]);
    expect(report).not.toHaveBeenCalled();
  });

  it('shows a tank that loaded before it existed', async () => {
    const { bus, world, hard } = setup();
    const layout = [item('boulder-01', 0.1, 0.1)];
    const saved = new SavedDecor(bus, vi.fn(), {
      tankId: 't1',
      biome: 'freshwater',
      layout,
    });
    expect(saved.tankId).toBe('t1');
    saved.attach(world);
    await settle();
    expect(hard.at(-1)).toEqual(layout);
  });

  it('leaves the demo tank alone when nothing was ever customised', () => {
    const { bus, world, hard } = setup();
    const saved = new SavedDecor(bus, vi.fn());
    saved.attach(world);
    bus.emit('tank:unloaded', { tankId: 'x', reason: 'reset' });
    expect(hard).toHaveLength(0);
  });

  it('goes back to the preset when the saved tank is unloaded', async () => {
    const { bus, world, hard } = setup();
    const saved = new SavedDecor(bus, vi.fn());
    saved.attach(world);
    bus.emit('tank:loaded', {
      tankId: 't1',
      biome: 'freshwater',
      fish,
      decorLayout: [item('boulder-01', 0.1, 0.1)],
    });
    bus.emit('tank:unloaded', { tankId: 't1', reason: 'reset' });
    await settle();
    expect(hard.at(-1)).toEqual(preset);
    expect(saved.tankId).toBeNull();
  });

  it('waits for the next tank across a switch instead of flashing the preset', async () => {
    const { bus, world, hard } = setup();
    const saved = new SavedDecor(bus, vi.fn());
    saved.attach(world);
    bus.emit('tank:loaded', {
      tankId: 't1',
      biome: 'freshwater',
      fish,
      decorLayout: [item('boulder-01', 0.1, 0.1)],
    });
    await settle();
    const before = hard.length;
    bus.emit('tank:unloaded', { tankId: 't1', reason: 'switch' });
    await settle();
    expect(hard).toHaveLength(before);
    expect(saved.tankId).toBeNull();
    bus.emit('tank:loaded', {
      tankId: 't2',
      biome: 'freshwater',
      fish,
      decorLayout: [item('boulder-01', -0.2, 0.1)],
    });
    await settle();
    expect(hard.slice(before)).toEqual([[item('boulder-01', -0.2, 0.1)]]);
  });

  it('goes back to the preset when no tank follows a switch', async () => {
    const { bus, world, hard } = setup();
    const saved = new SavedDecor(bus, vi.fn());
    saved.attach(world);
    bus.emit('tank:loaded', {
      tankId: 't1',
      biome: 'freshwater',
      fish,
      decorLayout: [item('boulder-01', 0.1, 0.1)],
    });
    bus.emit('tank:unloaded', { tankId: 't1', reason: 'switch' });
    bus.emit('tank:none', {});
    await settle();
    expect(hard.at(-1)).toEqual(preset);
  });

  it('ignores a layout of a tank with another biome', () => {
    const { bus, world, hard } = setup();
    const saved = new SavedDecor(bus, vi.fn());
    saved.attach(world);
    bus.emit('tank:loaded', {
      tankId: 't1',
      biome: 'reef',
      fish,
      decorLayout: [item('boulder-01', 0.1, 0.1)],
    });
    expect(hard).toHaveLength(0);
    expect(saved.editable).toBe(false);
  });

  it('does not rebuild while editing, then accepts another device afterwards', async () => {
    const { bus, world, hard } = setup();
    const saved = new SavedDecor(bus, vi.fn());
    saved.attach(world);
    bus.emit('tank:loaded', { tankId: 't1', biome: 'freshwater', fish, decorLayout: [] });
    bus.emit('decor:mode-changed', { active: true });
    const before = hard.length;
    bus.emit('tank:decor', { tankId: 't1', layout: [item('boulder-01', 0.2, 0.2)] });
    expect(hard).toHaveLength(before);
    bus.emit('decor:mode-changed', { active: false });
    bus.emit('tank:decor', { tankId: 't1', layout: [item('boulder-01', 0.2, 0.2)] });
    await settle();
    expect(hard.at(-1)).toEqual([item('boulder-01', 0.2, 0.2)]);
  });

  it('ignores a layout pushed for a tank that is not the active one', async () => {
    const { bus, world, hard } = setup();
    const saved = new SavedDecor(bus, vi.fn());
    saved.attach(world);
    bus.emit('tank:loaded', { tankId: 't1', biome: 'freshwater', fish, decorLayout: [] });
    await settle();
    const before = hard.length;
    bus.emit('tank:decor', { tankId: 'other', layout: [item('boulder-01', 0.2, 0.2)] });
    await settle();
    expect(hard).toHaveLength(before);
  });

  it('leaves a customised scene alone when the next tank is of another biome', async () => {
    const { bus, world, hard } = setup();
    const saved = new SavedDecor(bus, vi.fn());
    saved.attach(world);
    bus.emit('tank:loaded', {
      tankId: 't1',
      biome: 'freshwater',
      fish,
      decorLayout: [item('boulder-01', 0.1, 0.1)],
    });
    await settle();
    const before = hard.length;
    bus.emit('tank:unloaded', { tankId: 't1', reason: 'switch' });
    bus.emit('tank:loaded', { tankId: 't2', biome: 'reef', fish, decorLayout: [] });
    await settle();
    expect(hard).toHaveLength(before);
  });

  it('reports a failed rebuild instead of swallowing it', async () => {
    const bus = new EventBus<InteractionEvents>();
    const { scene } = fakeScene();
    const failing: DecorScenePort = {
      ...scene,
      setHardDecor: () => Promise.reject(new Error('gpu lost')),
    };
    const report = vi.fn();
    const saved = new SavedDecor(bus, report);
    saved.attach(new DecorWorld(failing, bus, new FeederLayer()));
    bus.emit('tank:loaded', {
      tankId: 't1',
      biome: 'freshwater',
      fish,
      decorLayout: [item('boulder-01', 0.1, 0.1)],
    });
    await settle();
    expect(report).toHaveBeenCalledWith('Could not arrange the decor', expect.any(Error));
  });
});
