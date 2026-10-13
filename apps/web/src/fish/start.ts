import type { Biome } from '@aquarium/shared';
import type { Stimulus } from '@aquarium/sim';
import type { Engine } from '../engine/Engine';
import type { EventBus } from '../engine/events';
import type { TankDimensions } from '../engine/tank/dimensions';
import type { InteractionEvents } from '../interaction/events';
import type { SceneAnchor } from '../scene/anemone';
import type { FishSystem } from './FishSystem';

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
  /** Engine-space homes; held until the fish are up, then forwarded. */
  setAnchors(anchors: readonly SceneAnchor[]): void;
  stop(): void;
}

export interface StartFishOptions {
  readonly tank: TankDimensions;
  readonly assetRoot: string;
  /** Picks the demo stock shown while no saved tank is loaded. */
  readonly biome: Biome;
  readonly interaction: EventBus<InteractionEvents>;
}

/**
 * Starts the fish without blocking boot. The fish code (loaders, sim client) is a separate chunk,
 * since nothing swims before the models arrive anyway; saved-tank events that arrive meanwhile
 * are queued and replayed in order.
 */
export function startFish(engine: Engine, options: StartFishOptions): FishHandle {
  const { interaction } = options;
  const abort = new AbortController();
  const ateListeners = new Set<(events: readonly FishBite[]) => void>();
  let queue: TankEvent[] | null = [];
  let ready: FishSystem | null = null;
  let anchors: readonly SceneAnchor[] | null = null;

  const deliver = (event: TankEvent): void => {
    if (ready !== null) ready.handle(event);
    else queue?.push(event);
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
      const pending = queue ?? [];
      queue = null;
      for (const event of pending) fish.handle(event);
      return fish;
    })
    .catch((cause: unknown) => {
      queue = null;
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
    stop() {
      abort.abort();
      for (const off of unsubscribe) off();
      ateListeners.clear();
      queue = null;
      ready = null;
      void system.then((fish) => fish?.dispose());
    },
  };
}
