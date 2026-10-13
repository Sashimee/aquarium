import { afterEach, describe, expect, it, vi } from 'vitest';
import { Mesh, Scene } from 'three/webgpu';
import type { Biome } from '@aquarium/shared';
import { EventBus } from '../engine/events';
import type { InteractionEvents } from '../interaction/events';
import { BiomeScene, TankBiome } from './biomeScene';

class FakeScene {
  readonly object = new Mesh();
  disposed = false;

  constructor(
    readonly biome: Biome,
    readonly root: Scene,
  ) {
    this.object.name = biome;
    root.add(this.object);
  }

  dispose(): Promise<void> {
    if (this.disposed) throw new Error(`${this.biome} scene disposed twice`);
    this.disposed = true;
    this.object.removeFromParent();
    return Promise.resolve();
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

function harness(url: Biome, options: { gate?: boolean; failing?: Biome } = {}) {
  const interaction = new EventBus<InteractionEvents>();
  const tankBiome = new TankBiome(interaction, url);
  const root = new Scene();
  const built: FakeScene[] = [];
  const gates: { biome: Biome; release: () => void }[] = [];
  const mounted: Biome[] = [];
  const unmounted: Biome[] = [];
  const errors: string[] = [];
  const scenes = new BiomeScene<FakeScene>(tankBiome, {
    ready: Promise.resolve(),
    build: async (biome) => {
      if (options.gate) {
        const gate = deferred();
        gates.push({ biome, release: gate.resolve });
        await gate.promise;
      }
      if (biome === options.failing) throw new Error(`no ${biome} assets`);
      const scene = new FakeScene(biome, root);
      built.push(scene);
      return scene;
    },
    mounted: (scene) => mounted.push(scene.biome),
    unmounting: (scene) => unmounted.push(scene.biome),
    onError: (message) => errors.push(message),
    timeoutMs: 90_000,
  });
  const load = (tankId: string, biome: Biome) =>
    interaction.emit('tank:loaded', { tankId, biome, fish: [] });
  const unload = (tankId: string) => interaction.emit('tank:unloaded', { tankId });
  return {
    interaction,
    tankBiome,
    root,
    built,
    gates,
    mounted,
    unmounted,
    errors,
    scenes,
    load,
    unload,
  };
}

const shownNames = (root: Scene) => root.children.map((c) => c.name);

afterEach(() => {
  vi.useRealTimers();
});

describe('TankBiome', () => {
  it('follows the loaded tank and falls back to the URL biome when it unloads', () => {
    const { tankBiome, load, unload } = harness('freshwater');
    const seen: Biome[] = [];
    tankBiome.onChange((b) => seen.push(b));
    expect(tankBiome.current).toBe('freshwater');
    load('t1', 'reef');
    expect(tankBiome.current).toBe('reef');
    unload('someone-else');
    expect(tankBiome.current).toBe('reef');
    unload('t1');
    expect(tankBiome.current).toBe('freshwater');
    expect(seen).toEqual(['reef', 'freshwater']);
  });

  it('keeps an explicit ?biome= while no tank is loaded', () => {
    const { tankBiome } = harness('reef');
    expect(tankBiome.current).toBe('reef');
  });

  it('stops listening once stopped', () => {
    const { tankBiome, load } = harness('freshwater');
    tankBiome.stop();
    load('t1', 'reef');
    expect(tankBiome.current).toBe('freshwater');
  });
});

describe('BiomeScene', () => {
  it('builds the URL biome for an anonymous visitor', async () => {
    const { scenes, root, mounted } = harness('reef');
    await scenes.settled();
    expect(mounted).toEqual(['reef']);
    expect(shownNames(root)).toEqual(['reef']);
  });

  it('switches to a reef tank loaded on the default URL', async () => {
    const { scenes, root, built, mounted, unmounted, load } = harness('freshwater');
    await scenes.settled();
    load('t1', 'reef');
    await scenes.settled();
    expect(mounted).toEqual(['freshwater', 'reef']);
    expect(unmounted).toEqual(['freshwater']);
    expect(built.map((s) => [s.biome, s.disposed])).toEqual([
      ['freshwater', true],
      ['reef', false],
    ]);
    expect(shownNames(root)).toEqual(['reef']);
    expect(scenes.scene?.biome).toBe('reef');
  });

  it('builds only the tank biome when the tank loads before the first build', async () => {
    const { scenes, root, built, load } = harness('freshwater');
    load('t1', 'reef');
    await scenes.settled();
    expect(built.map((s) => s.biome)).toEqual(['reef']);
    expect(shownNames(root)).toEqual(['reef']);
  });

  it('does nothing when the loaded tank matches the shown biome', async () => {
    const { scenes, built, mounted, unmounted, load } = harness('reef');
    await scenes.settled();
    load('t1', 'reef');
    await scenes.settled();
    expect(built).toHaveLength(1);
    expect(mounted).toEqual(['reef']);
    expect(unmounted).toEqual([]);
  });

  it('does not rebuild on a switch between two tanks of the same biome', async () => {
    const { scenes, built, load, unload } = harness('freshwater');
    load('t1', 'reef');
    await scenes.settled();
    unload('t1');
    load('t2', 'reef');
    await scenes.settled();
    expect(built.map((s) => s.biome)).toEqual(['reef']);
  });

  it('round-trips freshwater -> reef -> freshwater without leaking scene objects', async () => {
    const { scenes, root, built, mounted, unmounted, load, unload } = harness('freshwater');
    await scenes.settled();
    load('t1', 'reef');
    await scenes.settled();
    unload('t1');
    await scenes.settled();
    load('t2', 'reef');
    await scenes.settled();
    unload('t2');
    await scenes.settled();
    expect(mounted).toEqual(['freshwater', 'reef', 'freshwater', 'reef', 'freshwater']);
    expect(unmounted).toEqual(['freshwater', 'reef', 'freshwater', 'reef']);
    expect(built.filter((s) => !s.disposed).map((s) => s.biome)).toEqual(['freshwater']);
    expect(shownNames(root)).toEqual(['freshwater']);

    await scenes.dispose();
    expect(built.every((s) => s.disposed)).toBe(true);
    expect(root.children).toHaveLength(0);
    expect(unmounted.at(-1)).toBe('freshwater');
  });

  it('drops a build that is no longer wanted when it lands', async () => {
    const h = harness('freshwater', { gate: true });
    await vi.waitFor(() => expect(h.gates).toHaveLength(1));
    h.gates[0]?.release();
    await vi.waitFor(() => expect(h.mounted).toEqual(['freshwater']));
    h.load('t1', 'reef');
    await vi.waitFor(() => expect(h.gates).toHaveLength(2));
    h.unload('t1');
    h.gates[1]?.release();
    await vi.waitFor(() => expect(h.gates).toHaveLength(3));
    expect(h.gates[2]?.biome).toBe('freshwater');
    h.gates[2]?.release();
    await h.scenes.settled();
    expect(h.mounted).toEqual(['freshwater', 'freshwater']);
    expect(h.built.map((s) => [s.biome, s.disposed])).toEqual([
      ['freshwater', true],
      ['reef', true],
      ['freshwater', false],
    ]);
    expect(shownNames(h.root)).toEqual(['freshwater']);
  });

  it('disposes a build that lands after the scene was disposed', async () => {
    const h = harness('freshwater', { gate: true });
    await vi.waitFor(() => expect(h.gates).toHaveLength(1));
    const disposing = h.scenes.dispose();
    h.gates[0]?.release();
    await disposing;
    expect(h.mounted).toEqual([]);
    expect(h.built.every((s) => s.disposed)).toBe(true);
    expect(h.root.children).toHaveLength(0);
  });

  it('reports a failed build once and recovers on the next biome change', async () => {
    const { scenes, root, errors, mounted, load, unload } = harness('freshwater', {
      failing: 'reef',
    });
    await scenes.settled();
    load('t1', 'reef');
    await scenes.settled();
    expect(errors).toEqual(['Could not build the reef preset']);
    expect(root.children).toHaveLength(0);
    unload('t1');
    await scenes.settled();
    expect(mounted).toEqual(['freshwater', 'freshwater']);
    expect(shownNames(root)).toEqual(['freshwater']);
  });

  it('disposes a build that outlives the timeout instead of showing it late', async () => {
    vi.useFakeTimers();
    const h = harness('reef', { gate: true });
    await vi.waitFor(() => expect(h.gates).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(90_000);
    expect(h.errors).toEqual([
      'The reef preset did not finish loading in 90 s; showing the empty tank',
    ]);
    h.gates[0]?.release();
    await h.scenes.settled();
    expect(h.mounted).toEqual([]);
    expect(h.root.children).toHaveLength(0);
  });
});
