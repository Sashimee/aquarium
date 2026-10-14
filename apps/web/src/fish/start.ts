import type { Biome, Collider } from '@aquarium/shared';
import type { Stimulus } from '@aquarium/sim';
import type { Engine } from '../engine/Engine';
import type { EventBus } from '../engine/events';
import type { TankDimensions } from '../engine/tank/dimensions';
import type { InteractionEvents } from '../interaction/events';
import type { SceneAnchor } from '../scene/anemone';
import type { Collider as SceneCollider } from '../scene/colliders';
import type { FishSystem } from './FishSystem';
import { SimColliders } from './simColliders';

type TankEventName =
  | 'tank:loaded'
  | 'tank:unloaded'
  | 'tank:fish-added'
  | 'tank:fish-released'
  | 'tank:fish-died'
  | 'tank:fish-removed';

export type TankEvent = {
  [K in TankEventName]: { readonly type: K; readonly payload: InteractionEvents[K] };
}[TankEventName];

export interface FishBite {
  readonly fishId: string;
  readonly foodId: number;
  readonly portion: number;
}

export interface PickRay {
  readonly origin: { readonly x: number; readonly y: number; readonly z: number };
  readonly dir: { readonly x: number; readonly y: number; readonly z: number };
}

/** What the play layer drives; every call before the fish are up is dropped. */
export interface FishSimBridge {
  startle(stimulus: Stimulus): void;
  setFood(buffer: Float32Array): void;
  /** Bites by the ids the app knows: server fish ids while a saved tank is shown. */
  onAte(listener: (events: readonly FishBite[]) => void): () => void;
  /** The net tool tapped along `ray`; emits `net:tap` when it hits a dead fish. */
  netTap(ray: PickRay): void;
}

export interface FishHandle {
  readonly sim: FishSimBridge;
  /** Scene homes; held until the fish are up, then forwarded. */
  setAnchors(anchors: readonly SceneAnchor[]): void;
  /**
   * The mounted scene's colliders, or none between scenes. The decor layer's `decor:colliders`
   * then replace the scene's hard ones; both are held until the fish are up.
   */
  setSceneColliders(colliders: readonly SceneCollider[]): void;
  /** Swaps the demo stock; held until the fish are up. */
  setDemoBiome(biome: Biome): void;
  stop(): void;
}

export interface TankEventQueue {
  /** Hands every buffered event to `sink` in order, then each later one as it arrives. */
  drain(sink: (event: TankEvent) => void): void;
  stop(): void;
}

/**
 * Subscribes to the saved-tank events at once and buffers them. The session can load a tank
 * before the engine is up, and the bus drops events nobody listens to, so this must exist before
 * the UI mounts.
 */
export function queueTankEvents(interaction: EventBus<InteractionEvents>): TankEventQueue {
  let buffer: TankEvent[] | null = [];
  let sink: ((event: TankEvent) => void) | null = null;
  const deliver = (event: TankEvent): void => {
    if (sink !== null) sink(event);
    else buffer?.push(event);
  };
  const unsubscribe = [
    interaction.on('tank:loaded', (payload) => deliver({ type: 'tank:loaded', payload })),
    interaction.on('tank:unloaded', (payload) => deliver({ type: 'tank:unloaded', payload })),
    interaction.on('tank:fish-added', (payload) => deliver({ type: 'tank:fish-added', payload })),
    interaction.on('tank:fish-released', (payload) =>
      deliver({ type: 'tank:fish-released', payload }),
    ),
    interaction.on('tank:fish-died', (payload) => deliver({ type: 'tank:fish-died', payload })),
    interaction.on('tank:fish-removed', (payload) =>
      deliver({ type: 'tank:fish-removed', payload }),
    ),
  ];
  return {
    drain(next) {
      if (sink !== null) throw new Error('queueTankEvents: already drained');
      const pending = buffer ?? [];
      buffer = null;
      sink = next;
      for (const event of pending) next(event);
    },
    stop() {
      for (const off of unsubscribe) off();
      buffer = null;
      sink = null;
    },
  };
}

export interface StartFishOptions {
  readonly tank: TankDimensions;
  readonly assetRoot: string;
  /** Picks the demo stock shown while no saved tank is loaded. */
  readonly biome: Biome;
  readonly interaction: EventBus<InteractionEvents>;
  /** Created before the UI mounts; drained into the fish once they are up, stopped with them. */
  readonly tankEvents: TankEventQueue;
}

/**
 * Starts the fish without blocking boot. The fish code (loaders, sim client) is a separate chunk,
 * since nothing swims before the models arrive anyway; `tankEvents` holds the saved-tank events
 * until then.
 */
export function startFish(engine: Engine, options: StartFishOptions): FishHandle {
  const { interaction, tankEvents } = options;
  const abort = new AbortController();
  const ateListeners = new Set<(events: readonly FishBite[]) => void>();
  let ready: FishSystem | null = null;
  let anchors: readonly SceneAnchor[] | null = null;
  let demoBiome = options.biome;
  const colliders = new SimColliders();
  const updateColliders = (update: () => readonly Collider[]): void => {
    const before = colliders.list;
    let next: readonly Collider[];
    try {
      next = update();
    } catch (cause) {
      const kept = colliders.list === before;
      engine.events.emit('engine:error', {
        message: kept
          ? 'Fish keep their previous obstacles: the new colliders are invalid'
          : "Fish swim without obstacles: the new scene's colliders are invalid",
        cause,
      });
      if (!kept) ready?.setColliders(colliders.list);
      return;
    }
    ready?.setColliders(next);
  };
  const stopDecor = interaction.on('decor:colliders', ({ colliders: pieces }) =>
    updateColliders(() => colliders.setDecor(pieces)),
  );

  const system = import('./FishSystem')
    .then(({ FishSystem }) =>
      FishSystem.create(engine, {
        tank: options.tank,
        assetRoot: options.assetRoot,
        biome: options.biome,
        interaction,
        signal: abort.signal,
      }),
    )
    .then((fish) => {
      if (abort.signal.aborted) return fish;
      fish.onAte((events) => {
        for (const listener of ateListeners) listener(events);
      });
      ready = fish;
      if (anchors !== null) fish.setAnchors(anchors);
      fish.setColliders(colliders.list);
      if (demoBiome !== options.biome) fish.setDemoBiome(demoBiome);
      tankEvents.drain((event) => fish.handle(event));
      return fish;
    })
    .catch((cause: unknown) => {
      tankEvents.stop();
      stopDecor();
      if (!abort.signal.aborted) {
        engine.events.emit('engine:error', { message: 'Fish failed to start', cause });
      }
      return null;
    });

  return {
    sim: {
      startle: (stimulus) => ready?.startle(stimulus),
      setFood: (buffer) => ready?.setFood(buffer),
      onAte(listener) {
        ateListeners.add(listener);
        return () => ateListeners.delete(listener);
      },
      netTap: (ray) => ready?.netTap(ray),
    },
    setAnchors(next) {
      anchors = next;
      ready?.setAnchors(next);
    },
    setSceneColliders(next) {
      updateColliders(() => colliders.setScene(next));
    },
    setDemoBiome(next) {
      demoBiome = next;
      ready?.setDemoBiome(next);
    },
    stop() {
      abort.abort();
      tankEvents.stop();
      stopDecor();
      ateListeners.clear();
      ready = null;
      void system.then((fish) => fish?.dispose());
    },
  };
}
