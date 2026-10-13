import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Engine } from '../engine/Engine';
import { EventBus, type EngineEvents } from '../engine/events';
import type { InteractionEvents } from '../interaction/events';
import type { SceneAnchor } from '../scene/anemone';
import { FISH_1, FISH_2, TANK_A, fishFixture } from '../sync/fixtures';
import type { FishBite, PickRay, TankEvent } from './start';

class FakeFishSystem {
  readonly handled: TankEvent[] = [];
  readonly food: Float32Array[] = [];
  readonly taps: PickRay[] = [];
  /** Tank event types and `anchors` calls, in arrival order. */
  readonly log: string[] = [];
  readonly anchors: (readonly SceneAnchor[])[] = [];
  disposed = false;
  private ate: ((events: readonly FishBite[]) => void) | null = null;

  handle(event: TankEvent): void {
    this.handled.push(event);
    this.log.push(event.type);
  }
  setAnchors(anchors: readonly SceneAnchor[]): void {
    this.anchors.push(anchors);
    this.log.push('anchors');
  }
  onAte(listener: (events: readonly FishBite[]) => void): () => void {
    this.ate = listener;
    return () => undefined;
  }
  bite(events: readonly FishBite[]): void {
    this.ate?.(events);
  }
  startle(): void {}
  setFood(buffer: Float32Array): void {
    this.food.push(buffer);
  }
  netTap(ray: PickRay): void {
    this.taps.push(ray);
  }
  dispose(): void {
    this.disposed = true;
  }
}

const create = vi.hoisted(() => vi.fn());
vi.mock('./FishSystem', () => ({ FishSystem: { create } }));

const { startFish } = await import('./start');

function setup(result: Promise<FakeFishSystem>) {
  create.mockReturnValueOnce(result);
  const events = new EventBus<EngineEvents>();
  const errors: string[] = [];
  events.on('engine:error', ({ message }) => errors.push(message));
  const interaction = new EventBus<InteractionEvents>();
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

describe('startFish', () => {
  it('replays tank events that arrived before the fish were up, in order', async () => {
    const fish = new FakeFishSystem();
    const pending = deferred<FakeFishSystem>();
    const { interaction } = setup(pending.promise);
    interaction.emit('tank:loaded', {
      tankId: TANK_A,
      biome: 'freshwater',
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
    interaction.emit('tank:unloaded', { tankId: TANK_A });
    expect(fish.handled.map((e) => e.type).slice(3)).toEqual([
      'tank:fish-died',
      'tank:fish-removed',
      'tank:unloaded',
    ]);
    expect(fish.handled[5]).toEqual({ type: 'tank:unloaded', payload: { tankId: TANK_A } });
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
    interaction.emit('tank:loaded', { tankId: TANK_A, biome: 'reef', fish: [] });
    handle.setAnchors(latest);
    pending.resolve(fish);
    await flush();
    expect(fish.log).toEqual(['anchors', 'tank:loaded']);
    expect(fish.anchors).toEqual([latest]);

    handle.setAnchors(first);
    expect(fish.anchors).toEqual([latest, first]);
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
    handle.sim.netTap(ray);
    pending.resolve(fish);
    await flush();
    expect(fish.food).toHaveLength(0);
    handle.sim.setFood(new Float32Array(5));
    handle.sim.netTap(ray);
    expect(fish.food).toHaveLength(1);
    expect(fish.taps).toEqual([ray]);
  });

  it('stops listening and disposes the fish on stop', async () => {
    const fish = new FakeFishSystem();
    const { handle, interaction } = setup(Promise.resolve(fish));
    await flush();
    handle.stop();
    await flush();
    expect(fish.disposed).toBe(true);
    interaction.emit('tank:unloaded', { tankId: TANK_A });
    expect(fish.handled).toHaveLength(0);
  });

  it('reports a failed start once and drops the queued events', async () => {
    const pending = deferred<FakeFishSystem>();
    const { interaction, errors } = setup(pending.promise);
    interaction.emit('tank:unloaded', { tankId: TANK_A });
    pending.reject(new Error('no WebGPU'));
    await flush();
    expect(errors).toEqual(['Fish failed to start']);
    interaction.emit('tank:unloaded', { tankId: TANK_A });
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
