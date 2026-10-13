import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../engine/events';
import type { InteractionEvents } from '../events';
import type { SavedTank } from './binding';
import { item } from './fixtures';
import { SceneDecor, type DecorFactory } from './sceneDecor';
import type { DecorSystem } from './system';

interface Made {
  scene: string;
  initial: SavedTank | null;
  disposed: boolean;
}

function fakeSystem(made: Made): DecorSystem {
  return {
    active: false,
    claimsDrag: false,
    tap: () => undefined,
    pointerDown: () => undefined,
    pointerMove: () => undefined,
    pointerUp: () => undefined,
    dispose: () => {
      made.disposed = true;
    },
  };
}

function setup(load?: () => Promise<DecorFactory<string>>) {
  const bus = new EventBus<InteractionEvents>();
  const made: Made[] = [];
  const factory: DecorFactory<string> = (scene, initial) => {
    const entry = { scene, initial, disposed: false };
    made.push(entry);
    return fakeSystem(entry);
  };
  const report = vi.fn();
  const decor = new SceneDecor<string>(bus, load ?? (() => Promise.resolve(factory)), report);
  return { bus, decor, made, report, factory };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const layout = [item('boulder-01', 0.1, 0.1)];
const moved = [item('boulder-01', -0.2, 0.05)];

describe('SceneDecor', () => {
  it('hands a scene built after the tank loaded the saved layout', async () => {
    const { bus, decor, made } = setup();
    bus.emit('tank:loaded', { tankId: 't1', biome: 'reef', fish: [], decorLayout: layout });
    decor.mount('reef');
    await settle();
    expect(made).toEqual([
      { scene: 'reef', initial: { tankId: 't1', biome: 'reef', layout }, disposed: false },
    ]);
    expect(decor.system).not.toBeNull();
  });

  it('gives a rebuilt scene the latest layout, including another device edit between mounts', async () => {
    const { bus, decor, made } = setup();
    bus.emit('tank:loaded', { tankId: 't1', biome: 'reef', fish: [], decorLayout: layout });
    decor.mount('first');
    await settle();
    decor.unmount();
    expect(made[0]?.disposed).toBe(true);
    expect(decor.system).toBeNull();
    bus.emit('tank:decor', { tankId: 'other', layout: [] });
    bus.emit('tank:decor', { tankId: 't1', layout: moved });
    decor.mount('second');
    await settle();
    expect(made[1]).toEqual({
      scene: 'second',
      initial: { tankId: 't1', biome: 'reef', layout: moved },
      disposed: false,
    });
  });

  it('forgets the saved tank once it unloads', async () => {
    const { bus, decor, made } = setup();
    bus.emit('tank:loaded', { tankId: 't1', biome: 'reef', fish: [], decorLayout: layout });
    bus.emit('tank:unloaded', { tankId: 't1', reason: 'reset' });
    bus.emit('tank:decor', { tankId: 't1', layout: moved });
    decor.mount('demo');
    await settle();
    expect(made[0]?.initial).toBeNull();
  });

  it('gives no system to a scene unmounted before the decor code arrived', async () => {
    let resolve!: (factory: DecorFactory<string>) => void;
    const pending = new Promise<DecorFactory<string>>((r) => (resolve = r));
    const { decor, made, factory } = setup(() => pending);
    decor.mount('stale');
    decor.unmount();
    decor.mount('current');
    resolve(factory);
    await settle();
    expect(made.map((m) => m.scene)).toEqual(['current']);
  });

  it('builds nothing once disposed and stops following the tank', async () => {
    const { bus, decor, made } = setup();
    decor.mount('reef');
    await settle();
    decor.dispose();
    expect(made[0]?.disposed).toBe(true);
    bus.emit('tank:loaded', { tankId: 't1', biome: 'reef', fish: [], decorLayout: layout });
    decor.mount('again');
    await settle();
    expect(made).toHaveLength(1);
    expect(decor.system).toBeNull();
  });

  it('reports a decor chunk that fails to load', async () => {
    const { decor, report } = setup(() => Promise.reject(new Error('chunk 404')));
    decor.mount('reef');
    await settle();
    expect(report).toHaveBeenCalledWith('Decor failed to load', expect.any(Error));
    expect(decor.system).toBeNull();
  });
});
