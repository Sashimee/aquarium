import { afterEach, describe, expect, it, vi } from 'vitest';
import { Mesh, Scene } from 'three/webgpu';
import type { Biome, Tank } from '@aquarium/shared';
import { EventBus } from '../engine/events';
import type { InteractionEvents } from '../interaction/events';
import { FISH_1, TANK_A, TANK_B, fishFixture, speciesFixture, tankFixture } from '../sync/fixtures';
import { TankSession } from '../sync/session';
import type { ApiClient } from '../ui/api';
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
    interaction.emit('tank:loaded', {
      tankId,
      biome,
      fish: [],
      decorLayout: [],
      decorEdited: false,
    });
  const unload = (tankId: string, reason: 'switch' | 'reset' = 'reset') =>
    interaction.emit('tank:unloaded', { tankId, reason });
  const none = () => interaction.emit('tank:none', {});
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
    none,
  };
}

const shownNames = (root: Scene) => root.children.map((c) => c.name);

afterEach(() => {
  vi.useRealTimers();
});

describe('TankBiome', () => {
  it('retargets the demo biome and notifies only while no saved tank is loaded', () => {
    const { tankBiome, load, none } = harness('freshwater');
    const seen: Biome[] = [];
    tankBiome.onChange((b) => seen.push(b));
    tankBiome.setFallback('freshwater');
    tankBiome.setFallback('reef');
    expect(seen).toEqual(['reef']);
    expect(tankBiome.fallback).toBe('reef');
    load('t1', 'freshwater');
    tankBiome.setFallback('freshwater');
    expect(seen).toEqual(['reef', 'freshwater']);
    tankBiome.setFallback('reef');
    expect(tankBiome.current).toBe('freshwater');
    none();
    expect(tankBiome.current).toBe('reef');
  });

  it('follows the loaded tank and falls back to the URL biome once no tank is coming', () => {
    const { tankBiome, load, none } = harness('freshwater');
    const seen: Biome[] = [];
    tankBiome.onChange((b) => seen.push(b));
    expect(tankBiome.current).toBe('freshwater');
    load('t1', 'reef');
    expect(tankBiome.current).toBe('reef');
    none();
    expect(tankBiome.current).toBe('freshwater');
    expect(seen).toEqual(['reef', 'freshwater']);
  });

  it('never changes the biome on an unload, whatever the reason', () => {
    const { tankBiome, load, unload } = harness('freshwater');
    const seen: Biome[] = [];
    tankBiome.onChange((b) => seen.push(b));
    load('t1', 'reef');
    unload('t1', 'switch');
    expect(tankBiome.current).toBe('reef');
    unload('t1', 'reset');
    expect(tankBiome.current).toBe('reef');
    load('t2', 'freshwater');
    expect(tankBiome.current).toBe('freshwater');
    expect(seen).toEqual(['reef', 'freshwater']);
  });

  it('falls back when no tank comes after a switch already unloaded the last one', () => {
    const { tankBiome, load, unload, none } = harness('freshwater');
    load('t1', 'reef');
    unload('t1', 'switch');
    none();
    expect(tankBiome.current).toBe('freshwater');
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
    const { scenes, built, mounted, load, unload } = harness('freshwater');
    load('t1', 'reef');
    await scenes.settled();
    unload('t1', 'switch');
    await new Promise((r) => setTimeout(r, 20));
    await scenes.settled();
    load('t2', 'reef');
    await scenes.settled();
    expect(built.map((s) => s.biome)).toEqual(['reef']);
    expect(mounted).toEqual(['reef']);
  });

  it('switches straight to the next tank biome across a slow switch', async () => {
    const { scenes, built, root, load, unload } = harness('freshwater');
    load('t1', 'reef');
    await scenes.settled();
    unload('t1', 'switch');
    await new Promise((r) => setTimeout(r, 20));
    load('t2', 'freshwater');
    await scenes.settled();
    expect(built.map((s) => s.biome)).toEqual(['reef', 'freshwater']);
    expect(shownNames(root)).toEqual(['freshwater']);
  });

  describe('with the real session', () => {
    const verified = { emailVerified: true };
    const reefA = tankFixture({ id: TANK_A, biome: 'reef', fish: [fishFixture(FISH_1)] });
    const reefB = tankFixture({ id: TANK_B, name: 'Reef 2', biome: 'reef', fish: [] });

    function withSession(tanks: Tank[]) {
      const h = harness('freshwater');
      const api = {
        species: vi.fn().mockResolvedValue([speciesFixture()]),
        tanks: vi.fn().mockResolvedValue(tanks),
        tank: vi.fn((id: string) => Promise.resolve(tanks.find((t) => t.id === id))),
        reportAte: vi.fn(
          () => new Promise<Tank>((resolve) => setTimeout(() => resolve(reefA), 15)),
        ),
      };
      const session = new TankSession({
        api: api as unknown as ApiClient,
        interaction: h.interaction,
        sleep: async () => undefined,
        now: () => Date.parse('2026-02-01T12:00:00.000Z'),
      });
      return { ...h, api, session };
    }

    it('keeps the reef scene through a switch that waits on the eating-report flush', async () => {
      const h = withSession([reefA, reefB]);
      await h.scenes.settled();
      await h.session.setUser(verified);
      await h.scenes.settled();
      h.interaction.emit('food:ate', { eaten: [{ fishId: FISH_1, portion: 0.3 }] });
      await h.session.select(TANK_B);
      await h.scenes.settled();
      expect(h.api.reportAte).toHaveBeenCalled();
      expect(h.built.map((s) => s.biome)).toEqual(['freshwater', 'reef']);
      expect(h.mounted).toEqual(['freshwater', 'reef']);
      expect(shownNames(h.root)).toEqual(['reef']);
      h.session.dispose();
    });

    it('goes back to the URL biome on sign-out', async () => {
      const h = withSession([reefA]);
      await h.session.setUser(verified);
      await h.scenes.settled();
      expect(shownNames(h.root)).toEqual(['reef']);
      await h.session.setUser(null);
      await h.scenes.settled();
      expect(shownNames(h.root)).toEqual(['freshwater']);
      h.session.dispose();
    });

    it('goes back to the URL biome on sign-out during a switch flush', async () => {
      const h = withSession([reefA, reefB]);
      await h.session.setUser(verified);
      await h.scenes.settled();
      h.interaction.emit('food:ate', { eaten: [{ fishId: FISH_1, portion: 0.3 }] });
      const switching = h.session.select(TANK_B);
      await h.session.setUser(null);
      await switching;
      await h.scenes.settled();
      expect(h.tankBiome.current).toBe('freshwater');
      expect(shownNames(h.root)).toEqual(['freshwater']);
      h.session.dispose();
    });

    it('goes back to the URL biome when a reload fails, and stays there on sign-out', async () => {
      const h = withSession([reefA]);
      await h.session.setUser(verified);
      await h.scenes.settled();
      expect(shownNames(h.root)).toEqual(['reef']);
      h.api.tanks.mockRejectedValue(new Error('network down'));
      await h.session.setUser(verified);
      expect(h.session.getState().phase).toBe('offline');
      await h.scenes.settled();
      expect(shownNames(h.root)).toEqual(['freshwater']);
      await h.session.setUser(null);
      await h.scenes.settled();
      expect(h.tankBiome.current).toBe('freshwater');
      expect(shownNames(h.root)).toEqual(['freshwater']);
      h.session.dispose();
    });
  });

  it('round-trips freshwater -> reef -> freshwater without leaking scene objects', async () => {
    const { scenes, root, built, mounted, unmounted, load, none } = harness('freshwater');
    await scenes.settled();
    load('t1', 'reef');
    await scenes.settled();
    none();
    await scenes.settled();
    load('t2', 'reef');
    await scenes.settled();
    none();
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
    h.none();
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

  it('reports a throwing mount hook instead of rejecting unobserved', async () => {
    const interaction = new EventBus<InteractionEvents>();
    const errors: string[] = [];
    const root = new Scene();
    const scenes = new BiomeScene<FakeScene>(new TankBiome(interaction, 'reef'), {
      ready: Promise.resolve(),
      build: (biome) => Promise.resolve(new FakeScene(biome, root)),
      mounted: () => {
        throw new Error('play setup failed');
      },
      unmounting: () => undefined,
      onError: (message) => errors.push(message),
      timeoutMs: 90_000,
    });
    await scenes.settled();
    expect(errors).toEqual(['Scene mounted hook failed']);
    expect(scenes.scene?.biome).toBe('reef');
    await scenes.dispose();
    expect(root.children).toHaveLength(0);
  });

  it('reports a failed build once and recovers on the next biome change', async () => {
    const { scenes, root, errors, mounted, load, none } = harness('freshwater', {
      failing: 'reef',
    });
    await scenes.settled();
    load('t1', 'reef');
    await scenes.settled();
    expect(errors).toEqual(['Could not build the reef preset']);
    expect(root.children).toHaveLength(0);
    none();
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
