import type { Collider } from '@aquarium/shared';
import type { Anchor, FishSpawn, SimReady, TankSpaceWorldConfig } from '@aquarium/sim';
import type { SceneAnchor } from '../scene/anemone';
import { sceneAnchorsToSim, type DemoTank } from './demoStock';
import { bodyLengthOf } from './profiles';
import type { RosterFish } from './roster';
import { allSpeciesInputs, speciesInput } from './species';

/**
 * What every sim world is built from. A world is rebuilt only when the tank or demo stock is
 * swapped; fish come and go through `layoutChanges`. A new world knows only its config, so the
 * scene's homes and colliders live here and ride along each time.
 */
export class SimWorldSpec {
  private simAnchors: readonly Anchor[] = [];
  private simDecor: readonly Collider[] = [];

  constructor(
    private readonly demo: DemoTank,
    private readonly seed: number,
  ) {}

  get anchors(): readonly Anchor[] {
    return this.simAnchors;
  }

  /** Scene anchors; returns them as the sim takes them, for the running world. */
  setAnchors(anchors: readonly SceneAnchor[]): readonly Anchor[] {
    this.simAnchors = sceneAnchorsToSim(anchors, this.demo);
    return this.simAnchors;
  }

  get decor(): readonly Collider[] {
    return this.simDecor;
  }

  /** Already in the shared format and tank space; see `SimColliders`. */
  setDecor(colliders: readonly Collider[]): void {
    this.simDecor = colliders;
  }

  /**
   * What the scene changed after `config` was built. A world takes a while to start, and an update
   * in that window reached neither the config nor the world, so it has to follow once it is up.
   */
  changedSince(config: TankSpaceWorldConfig): {
    decor: readonly Collider[] | null;
    anchors: readonly Anchor[] | null;
  } {
    return {
      decor: config.decor === this.simDecor ? null : this.simDecor,
      anchors: config.anchors === this.simAnchors ? null : this.simAnchors,
    };
  }

  /**
   * Null when none of `swimming` has content in this build, so there is no world to run. The world
   * knows every content species, since one can't be added to it later.
   */
  config(swimming: readonly RosterFish[]): TankSpaceWorldConfig | null {
    const fish: FishSpawn[] = [];
    for (const f of swimming) {
      const input = speciesInput(f.species);
      if (input === undefined) continue;
      fish.push({
        id: f.simId,
        species: f.species,
        bodyLengthM: bodyLengthOf(f, input.locomotion.bodyLengthM),
      });
    }
    if (fish.length === 0) return null;
    return {
      seed: this.seed,
      space: this.demo.config.space,
      species: allSpeciesInputs(),
      fish,
      decor: this.simDecor,
      anchors: this.simAnchors,
    };
  }
}

/** What turns a running world holding `inWorld` into one holding exactly `wanted`. */
export function layoutChanges(
  inWorld: Iterable<string>,
  wanted: readonly FishSpawn[],
): { readonly remove: string[]; readonly add: FishSpawn[] } {
  const present = new Set(inWorld);
  const keep = new Set(wanted.map((f) => f.id));
  return {
    remove: [...present].filter((id) => !keep.has(id)),
    add: wanted.filter((f) => !present.has(f.id)),
  };
}

/** The part of `SimClient` that brings up a world once its `init` has answered. */
export interface WorldControls {
  setLight(level: number): void;
  setDecor(colliders: readonly Collider[]): void;
  setAnchors(anchors: readonly Anchor[]): void;
  start(): void;
}

export interface WorldStart {
  /** False once the world being started was dropped, so it must not run. */
  current(): boolean;
  light(): number;
  /** Runs before the world starts, so nothing it posts can arrive ahead of its layout. */
  begin(ready: SimReady): void;
}

/**
 * Starts the world `init` was asked to build from `config`. Light, colliders and homes that changed
 * while it was starting reached neither the config nor the world, so they follow first. A world
 * dropped before `init` answered is left unstarted.
 */
export async function startWorld(
  sim: WorldControls,
  spec: SimWorldSpec,
  config: TankSpaceWorldConfig,
  init: Promise<SimReady>,
  hooks: WorldStart,
): Promise<void> {
  const ready = await init;
  if (!hooks.current()) return;
  sim.setLight(hooks.light());
  const { decor, anchors } = spec.changedSince(config);
  if (decor !== null) sim.setDecor(decor);
  if (anchors !== null) sim.setAnchors(anchors);
  hooks.begin(ready);
  sim.start();
}

/** A sim worker that never answered `init`; it is stuck and must be replaced. */
export class SimInitTimeout extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Fish sim did not answer init within ${timeoutMs / 1000} s`);
    this.name = 'SimInitTimeout';
  }
}

type WorkerError = Pick<ErrorEvent, 'message'>;

/** The part of the worker `initSim` watches; a `Worker` is one. */
export interface SimWorkerErrors {
  addEventListener(type: 'error', listener: (event: WorkerError) => void): void;
  removeEventListener(type: 'error', listener: (event: WorkerError) => void): void;
}

export interface SimInit {
  readonly client: { init(config: TankSpaceWorldConfig): Promise<SimReady> };
  readonly worker: SimWorkerErrors;
  readonly config: TankSpaceWorldConfig;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
}

/**
 * Asks the worker to build `config`. A worker whose script fails to load never answers `init`, so
 * its error event settles it; one that hangs is settled by the timeout.
 */
export function initSim({ client, worker, config, signal, timeoutMs }: SimInit): Promise<SimReady> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const settle = (finish: () => void): void => {
      clearTimeout(timer);
      worker.removeEventListener('error', onError);
      signal.removeEventListener('abort', onAbort);
      finish();
    };
    const onError = (event: WorkerError): void =>
      settle(() => reject(new Error(`Fish sim worker failed to start: ${event.message}`)));
    const onAbort = (): void => settle(() => reject(signal.reason));
    const timer = setTimeout(() => settle(() => reject(new SimInitTimeout(timeoutMs))), timeoutMs);
    worker.addEventListener('error', onError);
    signal.addEventListener('abort', onAbort);
    client.init(config).then(
      (ready) => settle(() => resolve(ready)),
      (cause: unknown) => settle(() => reject(cause)),
    );
  });
}

/**
 * Takes the sim errors no request waits for from the first `init` on, so none is ever thrown as
 * unheard. Until `open` they are held: a worker failure while the system starts also rejects that
 * start, which reports it, so held errors reach `report` only once the start has succeeded.
 */
export class SimErrorGate {
  private held: string[] | null = [];

  constructor(private readonly report: (message: string) => void) {}

  readonly receive = (message: string): void => {
    if (this.held === null) this.report(message);
    else this.held.push(message);
  };

  open(): void {
    const held = this.held ?? [];
    this.held = null;
    for (const message of held) this.report(message);
  }
}
