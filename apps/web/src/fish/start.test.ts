import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Collider } from '@aquarium/shared';
import type { Point3 } from '@aquarium/sim';
import type { Engine } from '../engine/Engine';
import { EventBus, type EngineEvents } from '../engine/events';
import type { InteractionEvents } from '../interaction/events';
import type { SceneAnchor } from '../scene/anemone';
import type { Collider as SceneCollider } from '../scene/colliders';
import { FISH_1, FISH_2, TANK_A, fishFixture } from '../sync/fixtures';
import type { FishBite, PickRay, TankEvent } from './start';

class FakeFishSystem {
  readonly handled: TankEvent[] = [];
  readonly food: Float32Array[] = [];
  readonly taps: PickRay[] = [];
  /** Tank event types and `anchors` calls, in arrival order. */
  readonly log: string[] = [];
  readonly anchors: (readonly SceneAnchor[])[] = [];
  readonly colliders: (readonly Collider[])[] = [];
  disposed = false;
  /** What `synced()` hands out; resolve it to finish loading the stock handed in. */
  sync: Promise<void> = Promise.resolve();
  private ate: ((events: readonly FishBite[]) => void) | null = null;

  handle(event: TankEvent): void {
    this.handled.push(event);
    this.log.push(event.type);
  }
  setAnchors(anchors: readonly SceneAnchor[]): void {
    this.anchors.push(anchors);
    this.log.push('anchors');
  }
  setColliders(colliders: readonly Collider[]): void {
    this.colliders.push(colliders);
  }
  onAte(listener: (events: readonly FishBite[]) => void): () => void {
    this.ate = listener;
    return () => undefined;
  }
  bite(events: readonly FishBite[]): void {
    this.ate?.(events);
  }
  startle(): void {}
  readonly lures: (Point3 | null)[] = [];
  setLure(position: Point3 | null): void {
    this.lures.push(position);
  }
  setFood(buffer: Float32Array): void {
    this.food.push(buffer);
  }
  demoBiomes: string[] = [];
  setDemoBiome(biome: string): void {
    this.demoBiomes.push(biome);
  }
  netTap(ray: PickRay): void {
    this.taps.push(ray);
  }
  synced(): Promise<void> {
    return this.sync;
  }
  dispose(): void {
    this.disposed = true;
  }
}

const create = vi.hoisted(() => vi.fn());
vi.mock('./FishSystem', () => ({ FishSystem: { create } }));

const { queueTankEvents, startFish } = await import('./start');

/** `beforeStart` runs after the queue exists but before `startFish`, like a fast session at boot. */
function setup(
  result: Promise<FakeFishSystem>,
  beforeStart: (interaction: EventBus<InteractionEvents>) => void = () => undefined,
) {
  create.mockReturnValueOnce(result);
  const events = new EventBus<EngineEvents>();
  const errors: string[] = [];
  events.on('engine:error', ({ message }) => errors.push(message));
  const interaction = new EventBus<InteractionEvents>();
  const tankEvents = queueTankEvents(interaction);
  beforeStart(interaction);
  const engine = { events } as unknown as Engine;
  const handle = startFish(engine, {
    tank: {
      length: 1,
      depth: 0.5,
      height: 0.5,
      glass: 0.01,
      freeboard: 0.03,
      substrateFront: 0.04,
      substrateBack: 0.1,
    },
    assetRoot: '/assets/',
    biome: 'freshwater',
    interaction,
    tankEvents,
  });
  return { handle, interaction, errors };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  create.mockReset();
});

describe('queueTankEvents', () => {
  it('tells whether a saved tank is coming from the first tank:loaded or tank:none', async () => {
    const interaction = new EventBus<InteractionEvents>();
    const saved = queueTankEvents(interaction);
    interaction.emit('tank:loaded', {
      tankId: TANK_A,
      biome: 'freshwater',
      decorLayout: [],
      fish: [],
    });
    interaction.emit('tank:none', {});
    await expect(saved.stock).resolves.toBe('saved');
    const none = queueTankEvents(interaction);
    interaction.emit('tank:none', {});
    await expect(none.stock).resolves.toBe('none');
  });

  it('buffers events until drained, then passes each later one straight on', () => {
    const interaction = new EventBus<InteractionEvents>();
    const queue = queueTankEvents(interaction);
    interaction.emit('tank:loaded', {
      tankId: TANK_A,
      biome: 'freshwater',
      decorLayout: [],
      fish: [],
    });
    interaction.emit('tank:fish-released', { tankId: TANK_A, fishId: FISH_1 });
    const seen: string[] = [];
    queue.drain((event) => seen.push(event.type));
    expect(seen).toEqual(['tank:loaded', 'tank:fish-released']);
    interaction.emit('tank:unloaded', { tankId: TANK_A, reason: 'switch' });
    expect(seen).toEqual(['tank:loaded', 'tank:fish-released', 'tank:unloaded']);
    expect(() => queue.drain(() => undefined)).toThrow(/already drained/);
  });

  it('stops listening and drops the buffer on stop', () => {
    const interaction = new EventBus<InteractionEvents>();
    const queue = queueTankEvents(interaction);
    interaction.emit('tank:unloaded', { tankId: TANK_A, reason: 'switch' });
    queue.stop();
    interaction.emit('tank:unloaded', { tankId: TANK_A, reason: 'switch' });
    const seen: string[] = [];
    queue.drain((event) => seen.push(event.type));
    expect(seen).toEqual([]);
  });
});

describe('startFish', () => {
  it('shows a saved tank the session loaded before the fish were even started', async () => {
    const fish = new FakeFishSystem();
    setup(Promise.resolve(fish), (interaction) => {
      interaction.emit('tank:loaded', {
        tankId: TANK_A,
        biome: 'freshwater',
        decorLayout: [],
        fish: [fishFixture(FISH_1)],
      });
      interaction.emit('tank:fish-added', {
        tankId: TANK_A,
        fish: fishFixture(FISH_2),
        acclimate: true,
      });
    });
    await flush();
    expect(fish.handled.map((e) => e.type)).toEqual(['tank:loaded', 'tank:fish-added']);
    expect(fish.handled[0]?.payload).toMatchObject({ tankId: TANK_A });
  });

  it('replays tank events that arrived before the fish were up, in order', async () => {
    const fish = new FakeFishSystem();
    const pending = deferred<FakeFishSystem>();
    const { interaction } = setup(pending.promise);
    interaction.emit('tank:loaded', {
      tankId: TANK_A,
      biome: 'freshwater',
      decorLayout: [],
      fish: [fishFixture(FISH_1)],
    });
    interaction.emit('tank:fish-added', {
      tankId: TANK_A,
      fish: fishFixture(FISH_2),
      acclimate: true,
    });
    interaction.emit('tank:fish-released', { tankId: TANK_A, fishId: FISH_2 });
    pending.resolve(fish);
    await flush();
    expect(fish.handled.map((e) => e.type)).toEqual([
      'tank:loaded',
      'tank:fish-added',
      'tank:fish-released',
    ]);

    interaction.emit('tank:fish-died', {
      tankId: TANK_A,
      fish: fishFixture(FISH_1, { status: 'dead' }),
    });
    interaction.emit('tank:fish-removed', { tankId: TANK_A, fishId: FISH_1, reason: 'netted' });
    interaction.emit('tank:unloaded', { tankId: TANK_A, reason: 'switch' });
    expect(fish.handled.map((e) => e.type).slice(3)).toEqual([
      'tank:fish-died',
      'tank:fish-removed',
      'tank:unloaded',
    ]);
    expect(fish.handled[5]).toEqual({
      type: 'tank:unloaded',
      payload: { tankId: TANK_A, reason: 'switch' },
    });
  });

  it('applies a demo biome chosen before the fish were up, and later ones at once', async () => {
    const fish = new FakeFishSystem();
    const pending = deferred<FakeFishSystem>();
    const { handle } = setup(pending.promise);
    handle.setDemoBiome('reef');
    pending.resolve(fish);
    await flush();
    expect(fish.demoBiomes).toEqual(['reef']);
    handle.setDemoBiome('freshwater');
    expect(fish.demoBiomes).toEqual(['reef', 'freshwater']);
  });

  it('does not touch the demo stock when the biome never changed', async () => {
    const fish = new FakeFishSystem();
    const { handle } = setup(Promise.resolve(fish));
    await flush();
    expect(fish.demoBiomes).toEqual([]);
    handle.stop();
  });

  it('holds the scene anchors until the fish are up, ahead of the queued tank events', async () => {
    const fish = new FakeFishSystem();
    const pending = deferred<FakeFishSystem>();
    const { handle, interaction } = setup(pending.promise);
    const first: SceneAnchor[] = [
      { id: 'anemone-1', kind: 'anemone', position: [0.1, 0.2, 0], radius: 0.05 },
    ];
    const latest: SceneAnchor[] = [
      { id: 'anemone-1', kind: 'anemone', position: [-0.1, 0.2, 0], radius: 0.05 },
    ];
    handle.setAnchors(first);
    interaction.emit('tank:loaded', { tankId: TANK_A, biome: 'reef', decorLayout: [], fish: [] });
    handle.setAnchors(latest);
    pending.resolve(fish);
    await flush();
    expect(fish.log).toEqual(['anchors', 'tank:loaded']);
    expect(fish.anchors).toEqual([latest]);

    handle.setAnchors(first);
    expect(fish.anchors).toEqual([latest, first]);
  });

  it('holds scene and decor colliders until the fish are up, then sends them as one list', async () => {
    const fish = new FakeFishSystem();
    const pending = deferred<FakeFishSystem>();
    const { handle, interaction } = setup(pending.promise);
    const plant: SceneCollider = {
      kind: 'capsule',
      hard: false,
      a: [0, 0.1, 0],
      b: [0, 0.3, 0],
      radius: 0.02,
    };
    const wood: SceneCollider = { ...plant, hard: true, a: [0.2, 0.12, 0], b: [0.4, 0.12, 0] };
    handle.setSceneColliders([plant, wood]);
    pending.resolve(fish);
    await flush();
    expect(fish.colliders.map((list) => list.map((c) => c.id))).toEqual([['scene:0', 'scene:1']]);

    interaction.emit('decor:colliders', {
      colliders: [
        {
          id: 'decor:p1',
          solid: true,
          shape: { kind: 'capsule', a: [0.2, 0.15, 0], b: [0.4, 0.15, 0], radius: 0.03 },
        },
      ],
    });
    expect(fish.colliders.at(-1)?.map((c) => c.id)).toEqual(['scene:0', 'decor:p1']);
    handle.setSceneColliders([]);
    expect(fish.colliders.at(-1)).toEqual([]);
    handle.stop();
  });

  it('reports colliders the sim would reject and keeps the last good ones', async () => {
    const fish = new FakeFishSystem();
    const { handle, interaction, errors } = setup(Promise.resolve(fish));
    await flush();
    const piece = {
      id: 'decor:p1',
      solid: true,
      shape: { kind: 'sphere' as const, center: [0, 0.2, 0] as const, radius: 0.05 },
    };
    interaction.emit('decor:colliders', { colliders: [piece] });
    interaction.emit('decor:colliders', { colliders: [piece, piece] });
    expect(errors).toEqual(['Fish keep their previous obstacles: the new colliders are invalid']);
    expect(fish.colliders.map((list) => list.map((c) => c.id))).toEqual([[], ['decor:p1']]);
    handle.stop();
    interaction.emit('decor:colliders', { colliders: [] });
    expect(fish.colliders).toHaveLength(2);
  });

  it("clears the old tank's obstacles when the new scene's colliders are broken", async () => {
    const fish = new FakeFishSystem();
    const { handle, errors } = setup(Promise.resolve(fish));
    await flush();
    const plant: SceneCollider = {
      kind: 'capsule',
      hard: false,
      a: [0.1, 0.1, 0],
      b: [0.1, 0.3, 0],
      radius: 0.02,
    };
    handle.setSceneColliders([plant]);
    handle.setSceneColliders([{ ...plant, radius: -1 }]);
    expect(errors).toEqual(["Fish swim without obstacles: the new scene's colliders are invalid"]);
    expect(fish.colliders.map((list) => list.map((c) => c.id))).toEqual([[], ['scene:0'], []]);
    handle.stop();
  });

  it('passes bites to listeners that subscribed before the fish were up', async () => {
    const fish = new FakeFishSystem();
    const { handle } = setup(Promise.resolve(fish));
    const seen: FishBite[][] = [];
    handle.sim.onAte((events) => seen.push([...events]));
    await flush();
    fish.bite([{ fishId: FISH_1, foodId: 7, portion: 0.2 }]);
    expect(seen).toEqual([[{ fishId: FISH_1, foodId: 7, portion: 0.2 }]]);
  });

  it('drops play calls until the fish are up, then forwards them', async () => {
    const fish = new FakeFishSystem();
    const pending = deferred<FakeFishSystem>();
    const { handle } = setup(pending.promise);
    const ray: PickRay = { origin: { x: 0, y: 0, z: 1 }, dir: { x: 0, y: 0, z: -1 } };
    handle.sim.setFood(new Float32Array(5));
    handle.sim.setLure([0.1, 0.2, 0.3]);
    handle.sim.netTap(ray);
    pending.resolve(fish);
    await flush();
    expect(fish.food).toHaveLength(0);
    handle.sim.setFood(new Float32Array(5));
    handle.sim.setLure([0.1, 0.2, 0.3]);
    handle.sim.setLure(null);
    handle.sim.netTap(ray);
    expect(fish.food).toHaveLength(1);
    expect(fish.lures).toEqual([[0.1, 0.2, 0.3], null]);
    expect(fish.taps).toEqual([ray]);
  });

  it('stops listening and disposes the fish on stop', async () => {
    const fish = new FakeFishSystem();
    const { handle, interaction } = setup(Promise.resolve(fish));
    await flush();
    handle.stop();
    await flush();
    expect(fish.disposed).toBe(true);
    interaction.emit('tank:unloaded', { tankId: TANK_A, reason: 'switch' });
    expect(fish.handled).toHaveLength(0);
  });

  it('reports a failed start once and drops the queued events', async () => {
    const pending = deferred<FakeFishSystem>();
    const { interaction, errors } = setup(pending.promise);
    interaction.emit('tank:unloaded', { tankId: TANK_A, reason: 'switch' });
    pending.reject(new Error('no WebGPU'));
    await flush();
    expect(errors).toEqual(['Fish failed to start']);
    interaction.emit('tank:unloaded', { tankId: TANK_A, reason: 'switch' });
  });

  it('settles once the fish are up and the session has no saved tank', async () => {
    const pending = deferred<FakeFishSystem>();
    const { handle, interaction } = setup(pending.promise);
    let settled = false;
    void handle.settled.then(() => (settled = true));
    pending.resolve(new FakeFishSystem());
    await flush();
    expect(settled).toBe(false);
    interaction.emit('tank:none', {});
    await flush();
    expect(settled).toBe(true);
  });

  it('stops listening for a stop once settled', async () => {
    const pending = deferred<FakeFishSystem>();
    const { handle, interaction } = setup(pending.promise);
    await flush();
    const options: unknown = create.mock.lastCall?.[1];
    if (!(typeof options === 'object' && options !== null && 'signal' in options)) {
      throw new Error('FishSystem.create was not given a signal');
    }
    const signal = options.signal;
    if (!(signal instanceof AbortSignal)) throw new Error('expected an AbortSignal');
    const added = vi.spyOn(signal, 'addEventListener');
    const removed = vi.spyOn(signal, 'removeEventListener');
    pending.resolve(new FakeFishSystem());
    await flush();
    interaction.emit('tank:none', {});
    await handle.settled;
    const aborts = (calls: unknown[][]) => calls.filter(([type]) => type === 'abort');
    expect(aborts(added.mock.calls)).toHaveLength(1);
    expect(aborts(removed.mock.calls).map(([, listener]) => listener)).toEqual(
      aborts(added.mock.calls).map(([, listener]) => listener),
    );
  });

  it("waits for a saved tank's own fish before settling", async () => {
    const fish = new FakeFishSystem();
    const loading = deferred<undefined>();
    fish.sync = loading.promise;
    const { handle } = setup(Promise.resolve(fish), (interaction) => {
      interaction.emit('tank:loaded', {
        tankId: TANK_A,
        biome: 'freshwater',
        decorLayout: [],
        fish: [fishFixture(FISH_1)],
      });
    });
    let settled = false;
    void handle.settled.then(() => (settled = true));
    await flush();
    expect(fish.handled.map((e) => e.type)).toEqual(['tank:loaded']);
    expect(settled).toBe(false);
    loading.resolve(undefined);
    await flush();
    expect(settled).toBe(true);
  });

  it('waits for a saved tank that loads after the fish are up', async () => {
    const fish = new FakeFishSystem();
    const loading = deferred<undefined>();
    const { handle, interaction } = setup(Promise.resolve(fish));
    let settled = false;
    void handle.settled.then(() => (settled = true));
    await flush();
    fish.sync = loading.promise;
    interaction.emit('tank:loaded', {
      tankId: TANK_A,
      biome: 'freshwater',
      decorLayout: [],
      fish: [fishFixture(FISH_1)],
    });
    await flush();
    expect(settled).toBe(false);
    loading.resolve(undefined);
    await flush();
    expect(settled).toBe(true);
  });

  it('settles on stop while waiting for the stock', async () => {
    const fish = new FakeFishSystem();
    fish.sync = new Promise(() => undefined);
    const { handle, interaction } = setup(Promise.resolve(fish));
    let settled = false;
    void handle.settled.then(() => (settled = true));
    await flush();
    handle.stop();
    await flush();
    expect(settled).toBe(true);
    interaction.emit('tank:none', {});
  });

  it('settles on stop while the saved tank is still loading', async () => {
    const fish = new FakeFishSystem();
    fish.sync = new Promise(() => undefined);
    const { handle } = setup(Promise.resolve(fish), (interaction) => {
      interaction.emit('tank:loaded', {
        tankId: TANK_A,
        biome: 'freshwater',
        decorLayout: [],
        fish: [fishFixture(FISH_1)],
      });
    });
    let settled = false;
    void handle.settled.then(() => (settled = true));
    await flush();
    expect(settled).toBe(false);
    handle.stop();
    await flush();
    expect(settled).toBe(true);
  });

  it('settles after a failed start too', async () => {
    const { handle } = setup(Promise.reject(new Error('no WebGPU')));
    await expect(handle.settled).resolves.toBeUndefined();
  });

  it('reports nothing when stopped while still loading', async () => {
    const fish = new FakeFishSystem();
    const pending = deferred<FakeFishSystem>();
    const { handle, errors } = setup(pending.promise);
    handle.stop();
    pending.resolve(fish);
    await flush();
    expect(errors).toEqual([]);
    expect(fish.disposed).toBe(true);
  });
});
