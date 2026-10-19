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
    bus.emit('tank:loaded', {
      backgroundId: 'bg-fw-planted-stream',
      tankId: 't1',
      biome: 'reef',
      fish: [],
      decorLayout: layout,
      decorEdited: true,
    });
    decor.mount('reef');
    await settle();
    expect(made).toEqual([
      {
        scene: 'reef',
        initial: { tankId: 't1', biome: 'reef', layout, edited: true },
        disposed: false,
      },
    ]);
    expect(decor.system).not.toBeNull();
  });

  it('gives a rebuilt scene the latest layout, including another device edit between mounts', async () => {
    const { bus, decor, made } = setup();
    bus.emit('tank:loaded', {
      backgroundId: 'bg-fw-planted-stream',
      tankId: 't1',
      biome: 'reef',
      fish: [],
      decorLayout: layout,
      decorEdited: true,
    });
    decor.mount('first');
    await settle();
    decor.unmount();
    expect(made[0]?.disposed).toBe(true);
    expect(decor.system).toBeNull();
    bus.emit('tank:decor', { tankId: 'other', layout: [], edited: true });
    bus.emit('tank:decor', { tankId: 't1', layout: moved, edited: true });
    decor.mount('second');
    await settle();
    expect(made[1]).toEqual({
      scene: 'second',
      initial: { tankId: 't1', biome: 'reef', layout: moved, edited: true },
      disposed: false,
    });
  });

  it('forgets the saved tank once it unloads', async () => {
    const { bus, decor, made } = setup();
    bus.emit('tank:loaded', {
      backgroundId: 'bg-fw-planted-stream',
      tankId: 't1',
      biome: 'reef',
      fish: [],
      decorLayout: layout,
      decorEdited: true,
    });
    bus.emit('tank:unloaded', { tankId: 't1', reason: 'reset' });
    bus.emit('tank:decor', { tankId: 't1', layout: moved, edited: true });
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
    bus.emit('tank:loaded', {
      backgroundId: 'bg-fw-planted-stream',
      tankId: 't1',
      biome: 'reef',
      fish: [],
      decorLayout: layout,
      decorEdited: true,
    });
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

  describe('after the decor chunk failed to load', () => {
    it('says so, and a new decorate request tries again', async () => {
      let attempts = 0;
      const { bus, decor, made, factory } = setup(() =>
        ++attempts === 1 ? Promise.reject(new Error('chunk 404')) : Promise.resolve(factory),
      );
      const seen: (string | null)[] = [];
      bus.on('decor:load-failed', ({ message }) => seen.push(message));
      decor.mount('reef');
      await settle();
      expect(seen).toEqual([expect.stringMatching(/could not load/)]);
      bus.emit('decor:request-mode', { active: true });
      await settle();
      expect(attempts).toBe(2);
      expect(made).toHaveLength(1);
      expect(seen.at(-1)).toBeNull();
    });

    it('starts one load for two quick retries and shows no error after it succeeds', async () => {
      let attempts = 0;
      const { bus, decor, made, factory } = setup(() => {
        attempts++;
        if (attempts === 1) return Promise.reject(new Error('chunk 404'));
        if (attempts === 2) return Promise.resolve(factory);
        return Promise.reject(new Error('second press'));
      });
      const seen: (string | null)[] = [];
      bus.on('decor:load-failed', ({ message }) => seen.push(message));
      decor.mount('reef');
      await settle();
      bus.emit('decor:request-mode', { active: true });
      bus.emit('decor:request-mode', { active: true });
      await settle();
      expect(attempts).toBe(2);
      expect(made).toHaveLength(1);
      expect(seen.at(-1)).toBeNull();
    });

    it('reports each failed retry and keeps no system', async () => {
      const { bus, decor } = setup(() => Promise.reject(new Error('chunk 404')));
      const seen: (string | null)[] = [];
      bus.on('decor:load-failed', ({ message }) => seen.push(message));
      decor.mount('reef');
      await settle();
      bus.emit('decor:request-mode', { active: true });
      await settle();
      expect(seen).toHaveLength(2);
      expect(decor.system).toBeNull();
    });
  });

  describe('a decorate request made before the system exists', () => {
    const requests = (bus: EventBus<InteractionEvents>) => {
      const seen: boolean[] = [];
      bus.on('decor:request-mode', ({ active }) => seen.push(active));
      return seen;
    };

    it('is replayed once the system is up', async () => {
      const { bus, decor } = setup();
      const seen = requests(bus);
      bus.emit('decor:request-mode', { active: true });
      decor.mount('reef');
      await settle();
      expect(seen).toEqual([true, true]);
    });

    it('is replayed after a scene rebuild when still wanted', async () => {
      const { bus, decor } = setup();
      decor.mount('first');
      await settle();
      decor.unmount();
      bus.emit('decor:request-mode', { active: true });
      const seen = requests(bus);
      decor.mount('second');
      await settle();
      expect(seen).toEqual([true]);
    });

    it('is not replayed after the user asked to leave', async () => {
      const { bus, decor } = setup();
      bus.emit('decor:request-mode', { active: true });
      bus.emit('decor:request-mode', { active: false });
      const seen = requests(bus);
      decor.mount('reef');
      await settle();
      expect(seen).toEqual([]);
    });

    it('is not replayed once the mode reports it ended', async () => {
      const { bus, decor } = setup();
      bus.emit('decor:request-mode', { active: true });
      bus.emit('decor:mode-changed', { active: false });
      const seen = requests(bus);
      decor.mount('reef');
      await settle();
      expect(seen).toEqual([]);
    });
  });
});
