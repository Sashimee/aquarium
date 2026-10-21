import type { Collider, FishStage, Personality } from '@aquarium/shared';
import type { Anchor, Stimulus } from './behaviour.ts';
import type { SimBrood } from './brood.ts';
import type { Point3 } from './decor.ts';
import type { CrewTally } from './crew.ts';
import { FOOD_STRIDE, type AteEvent } from './food.ts';
import type { Visitor } from './greeting.ts';
import { SNAPSHOT_STRIDE, type Snapshot } from './snapshot.ts';
import type { SimToy, ToyNudge } from './toys.ts';
import type { WaveMakerSettings } from './waveMaker.ts';
import {
  STEP_HZ,
  World,
  type AnyWorldConfig,
  type FishPlacement,
  type FishSpawn,
} from './world.ts';

/**
 * Every position crossing the bridge (startle stimuli, food, decor colliders, anchors, and the
 * fish in snapshots) is in the world's frame, which `init` fixes: tank space when the config has
 * `space`, so scene coordinates pass through unchanged; the legacy flat-floor box when it has
 * `tank`. Never map positions by subtracting the local sand height: food would sink under the
 * fish's floor where the sand is low and startles would land in the wrong place.
 *
 * `init` is answered by a `ready` event carrying the same `request` number, or by an `error` event
 * carrying it.
 *
 * `addFish` and `removeFish` change the running world in place and are answered by a `layout`
 * event carrying the same `request` number, or by an `error` event carrying it. `canGrazeAt`
 * changes nothing and is answered by a `grazeReach` event, or an `error` event, with its `request`;
 * `nestSite` likewise by a `nestSite` event.
 */
export type SimCommand =
  | { readonly type: 'init'; readonly request: number; readonly config: AnyWorldConfig }
  | { readonly type: 'start' }
  | { readonly type: 'stop' }
  | { readonly type: 'step'; readonly steps: number }
  | { readonly type: 'recycle'; readonly buffer: ArrayBuffer }
  | { readonly type: 'startle'; readonly stimulus: Stimulus }
  | { readonly type: 'light'; readonly level: number }
  /** The wave maker, or null when there is none; see `World.setWaveMaker`. */
  | { readonly type: 'waveMaker'; readonly settings: WaveMakerSettings | null }
  /** A laser dot or fingertip on the glass, or null once it is gone; see `World.setLure`. */
  | { readonly type: 'lure'; readonly position: Point3 | null }
  /** The full collider set in the shared format; hard ones block fish, soft ones (plants) push them aside. */
  | { readonly type: 'decor'; readonly colliders: readonly Collider[] }
  | { readonly type: 'anchors'; readonly anchors: readonly Anchor[] }
  /** Every toy in the tank, `[]` for none; resend a drifting ball as it moves. See `World.setToys`. */
  | { readonly type: 'toys'; readonly toys: readonly SimToy[] }
  /** Every clutch being tended and every pregnancy; resend when either changes. See `World.setBrood`. */
  | { readonly type: 'brood'; readonly brood: SimBrood }
  /** A fish grew into `stage`; see `World.setStage`. */
  | { readonly type: 'stage'; readonly id: string; readonly stage: FishStage }
  /** Fish `id`'s boldness, greed and sociability; see `World.setPersonality`. */
  | { readonly type: 'personality'; readonly id: string; readonly personality: Personality }
  /** The owner at the front glass, or null once they leave; see `World.setVisitor`. */
  | { readonly type: 'visitor'; readonly visitor: Visitor | null }
  /** Float32 records of `[id, x, y, z, typeIndex]`; see `World.setFood`. */
  | { readonly type: 'food'; readonly buffer: ArrayBuffer }
  /** The lifecycle's algae cover, 0 to 1; see `World.setAlgae`. */
  | { readonly type: 'algae'; readonly cover: number }
  | {
      readonly type: 'addFish';
      readonly request: number;
      readonly spawn: FishSpawn;
      readonly at?: FishPlacement;
    }
  | { readonly type: 'removeFish'; readonly request: number; readonly id: string }
  /** See `World.canGrazeAt`. */
  | {
      readonly type: 'canGrazeAt';
      readonly request: number;
      readonly species: string;
      readonly position: Point3;
    }
  /** See `World.nestSite`. */
  | { readonly type: 'nestSite'; readonly request: number; readonly parents: readonly string[] };

export interface SimReady {
  readonly type: 'ready';
  /** The `init` this answers. */
  readonly request: number;
  readonly epoch: number;
  readonly fishIds: readonly string[];
  readonly stride: number;
  readonly stepHz: number;
}

export type SimEvent =
  | SimReady
  | {
      readonly type: 'snapshot';
      readonly epoch: number;
      readonly tick: number;
      readonly time: number;
      readonly buffer: ArrayBuffer;
    }
  | SimAte
  | SimToyNudges
  | SimCrew
  | SimPolyps
  | SimLayout
  | SimGrazeReach
  | SimNestSite
  /**
   * `request` is set when the failed command was an `init`, `addFish`, `removeFish`, `canGrazeAt`
   * or `nestSite`.
   */
  | { readonly type: 'error'; readonly message: string; readonly request?: number };

/**
 * The world gained or lost a fish and every later message uses the new layout. The sequence on
 * the port is: any bites taken before the change (`ate`, old epoch), this event, then a snapshot
 * of the changed world in the new epoch at the same tick. Ticks carry on across a layout epoch;
 * they restart at 0 only after `init`.
 *
 * `fishIds` is the snapshot order: fish `fishIds[i]` is record `i`, at float offset `i * stride`.
 * An added fish is appended at the end and every other fish keeps its record. A removed fish's
 * record is gone and the fish after it each move down one. Snapshots whose `epoch` is older than
 * `epoch` use the previous layout.
 */
export interface SimLayout {
  readonly type: 'layout';
  readonly epoch: number;
  readonly request: number;
  readonly fishIds: readonly string[];
  readonly stride: number;
  readonly change: { readonly kind: 'add' | 'remove'; readonly id: string };
}

/** The answer to the `canGrazeAt` command with the same `request`. */
export interface SimGrazeReach {
  readonly type: 'grazeReach';
  readonly request: number;
  readonly reachable: boolean;
}

/** The answer to the `nestSite` command with the same `request`. */
export interface SimNestSite {
  readonly type: 'nestSite';
  readonly request: number;
  readonly position: Point3 | null;
}

/** Bites taken in the steps leading up to the snapshot at `tick`, which follows it. */
export interface SimAte {
  readonly type: 'ate';
  readonly epoch: number;
  readonly tick: number;
  readonly events: readonly AteEvent[];
}

/** Balls fish bumped in the steps leading up to the snapshot at `tick`, which follows it. */
export interface SimToyNudges {
  readonly type: 'toyNudge';
  readonly epoch: number;
  readonly tick: number;
  readonly nudges: readonly ToyNudge[];
}

/**
 * Algae grazed and settled food scavenged since the last `crew` event, up to the snapshot at
 * `tick`, which follows it. Sent about once a second while there is any, and before a layout change.
 */
export interface SimCrew {
  readonly type: 'crew';
  readonly epoch: number;
  readonly tick: number;
  readonly tally: readonly CrewTally[];
}

/**
 * How far coral polyps are out in the current world, 0 (retracted) to 1 (fully out), as of the
 * snapshot at `tick`, which follows it. Sent with the first snapshot after `init` and then
 * whenever it has moved by `POLYP_EPSILON` since the last one sent.
 */
export interface SimPolyps {
  readonly type: 'polyps';
  readonly epoch: number;
  readonly tick: number;
  readonly extension: number;
}

/** Smallest polyp change worth a message: one step of an 8-bit channel. */
export const POLYP_EPSILON = 1 / 256;

/** The structural slice of `Worker`, `DedicatedWorkerGlobalScope` and `MessagePort` we use. */
export interface MessagePortLike {
  postMessage(message: unknown, transfer: ArrayBuffer[]): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  start?(): void;
}

/**
 * What `SimClient` uses of a `Worker` or `MessagePort`: its messages, and the `error` and
 * `messageerror` events that say the worker failed or a reply was lost.
 */
export interface SimClientPort extends MessagePortLike {
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  addEventListener(type: 'error' | 'messageerror', listener: (event: Event) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'error' | 'messageerror', listener: (event: Event) => void): void;
}

function failureText(event: Event): string {
  if (event.type === 'messageerror') return 'sim: a message from the worker could not be read';
  const detail = 'message' in event && typeof event.message === 'string' ? event.message : '';
  return `sim worker failed${detail === '' ? '' : `: ${detail}`}`;
}

const COMMAND_TYPES = new Set([
  'init',
  'start',
  'stop',
  'step',
  'recycle',
  'startle',
  'light',
  'waveMaker',
  'lure',
  'decor',
  'anchors',
  'toys',
  'brood',
  'stage',
  'personality',
  'visitor',
  'food',
  'algae',
  'addFish',
  'removeFish',
  'canGrazeAt',
  'nestSite',
]);
const EVENT_TYPES = new Set([
  'ready',
  'snapshot',
  'ate',
  'toyNudge',
  'crew',
  'polyps',
  'layout',
  'grazeReach',
  'nestSite',
  'error',
]);

function messageType(data: unknown, allowed: ReadonlySet<string>): string {
  if (typeof data === 'object' && data !== null && 'type' in data) {
    const type = (data as { type: unknown }).type;
    if (typeof type === 'string' && allowed.has(type)) return type;
  }
  const text = JSON.stringify(data) ?? String(data);
  const shown = text.length > 200 ? `${text.slice(0, 200)}…` : text;
  throw new TypeError(`unexpected sim bridge message: ${shown}`);
}

function requestOf(data: unknown): number | undefined {
  if (typeof data !== 'object' || data === null || !('request' in data)) return undefined;
  const request = (data as { request: unknown }).request;
  return Number.isSafeInteger(request) ? (request as number) : undefined;
}

export interface SimHostOptions {
  /** Steps run per wake-up before the backlog is dropped (e.g. after a suspended tab). */
  readonly maxCatchUpSteps?: number;
  readonly now?: () => number;
}

export interface SimHost {
  dispose(): void;
}

/** Runs a `World` behind a message port at a fixed 30 Hz and streams transferable snapshots. */
export function createSimHost(port: MessagePortLike, options: SimHostOptions = {}): SimHost {
  const maxCatchUp = options.maxCatchUpSteps ?? 4;
  const now = options.now ?? (() => performance.now());
  const stepMs = 1000 / STEP_HZ;
  const pool: ArrayBuffer[] = [];
  let world: World | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let last = 0;
  let backlog = 0;
  let epoch = 0;
  let crewTick = 0;
  let polypSent = Number.NaN;

  const send = (event: SimEvent, transfer: ArrayBuffer[] = []): void => {
    port.postMessage(event, transfer);
  };

  const emitEvents = (w: World, flushCrew = false): void => {
    const events = w.takeAteEvents();
    if (events.length > 0) send({ type: 'ate', epoch, tick: w.tick, events });
    const nudges = w.takeToyNudges();
    if (nudges.length > 0) send({ type: 'toyNudge', epoch, tick: w.tick, nudges });
    if (flushCrew || w.tick - crewTick >= STEP_HZ) {
      crewTick = w.tick;
      const tally = w.takeCrewTally();
      if (tally.length > 0) send({ type: 'crew', epoch, tick: w.tick, tally });
    }
    const extension = w.polypExtension;
    if (!(Math.abs(extension - polypSent) < POLYP_EPSILON)) {
      polypSent = extension;
      send({ type: 'polyps', epoch, tick: w.tick, extension });
    }
  };

  const emitSnapshot = (w: World): void => {
    emitEvents(w);
    const bytes = w.count * SNAPSHOT_STRIDE * Float32Array.BYTES_PER_ELEMENT;
    let buffer = pool.pop();
    while (buffer !== undefined && buffer.byteLength !== bytes) buffer = pool.pop();
    buffer ??= new ArrayBuffer(bytes);
    w.writeSnapshot(new Float32Array(buffer));
    send({ type: 'snapshot', epoch, tick: w.tick, time: w.time, buffer }, [buffer]);
  };

  const stop = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  const sendError = (error: unknown, request?: number): void => {
    const message = error instanceof Error ? error.message : String(error);
    send(request === undefined ? { type: 'error', message } : { type: 'error', message, request });
  };

  const loop = (): void => {
    timer = null;
    const w = world;
    if (w === null) return;
    try {
      const t = now();
      backlog += t - last;
      last = t;
      let steps = 0;
      while (backlog >= stepMs && steps < maxCatchUp) {
        w.step();
        backlog -= stepMs;
        steps++;
      }
      if (backlog >= stepMs) backlog = 0;
      if (steps > 0) emitSnapshot(w);
    } catch (error) {
      // A throw here would escape the timer unseen; report it and stay stopped until "start".
      sendError(error);
      return;
    }
    timer = setTimeout(loop, Math.max(0, stepMs - backlog));
  };

  const requireWorld = (type: SimCommand['type']): World => {
    if (world === null) throw new Error(`sim: "${type}" before "init"`);
    return world;
  };

  const changeLayout = (
    w: World,
    request: number,
    change: SimLayout['change'],
    apply: () => void,
  ): void => {
    // Bites and bumps so far belong to the old layout's epoch, so they go out before it changes.
    emitEvents(w, true);
    apply();
    epoch++;
    send({ type: 'layout', epoch, request, fishIds: w.fishIds, stride: SNAPSHOT_STRIDE, change });
    emitSnapshot(w);
  };

  const handle = (command: SimCommand): void => {
    switch (command.type) {
      case 'init': {
        // Checked before anything changes: a `ready` with an unusable request would be refused
        // by the client after the world it describes had already replaced the old one.
        if (!Number.isSafeInteger(command.request)) {
          throw new TypeError(
            `sim: "init" needs a safe integer request, got ${String(command.request)}`,
          );
        }
        stop();
        world = new World(command.config);
        crewTick = 0;
        polypSent = Number.NaN;
        pool.length = 0;
        epoch++;
        send({
          type: 'ready',
          request: command.request,
          epoch,
          fishIds: world.fishIds,
          stride: SNAPSHOT_STRIDE,
          stepHz: STEP_HZ,
        });
        emitSnapshot(world);
        return;
      }
      case 'start': {
        if (world === null) throw new Error('sim: "start" before "init"');
        if (timer !== null) return;
        world.settleLight();
        last = now();
        backlog = 0;
        timer = setTimeout(loop, stepMs);
        return;
      }
      case 'stop':
        stop();
        return;
      case 'step': {
        if (world === null) throw new Error('sim: "step" before "init"');
        if (!Number.isInteger(command.steps) || command.steps < 1) {
          throw new RangeError(`sim: "step" needs a positive integer, got ${command.steps}`);
        }
        for (let i = 0; i < command.steps; i++) world.step();
        emitSnapshot(world);
        return;
      }
      case 'recycle':
        if (pool.length < 8) pool.push(command.buffer);
        return;
      case 'startle':
        requireWorld(command.type).startle(command.stimulus);
        return;
      case 'light':
        requireWorld(command.type).setLight(command.level);
        return;
      case 'waveMaker':
        requireWorld(command.type).setWaveMaker(command.settings);
        return;
      case 'lure':
        requireWorld(command.type).setLure(command.position);
        return;
      case 'decor':
        requireWorld(command.type).setDecor(command.colliders);
        return;
      case 'anchors':
        requireWorld(command.type).setAnchors(command.anchors);
        return;
      case 'toys':
        requireWorld(command.type).setToys(command.toys);
        return;
      case 'brood':
        requireWorld(command.type).setBrood(command.brood);
        return;
      case 'stage':
        requireWorld(command.type).setStage(command.id, command.stage);
        return;
      case 'personality':
        requireWorld(command.type).setPersonality(command.id, command.personality);
        return;
      case 'visitor':
        requireWorld(command.type).setVisitor(command.visitor);
        return;
      case 'food': {
        const w = requireWorld(command.type);
        const { buffer } = command;
        if (
          !(buffer instanceof ArrayBuffer) ||
          buffer.byteLength % Float32Array.BYTES_PER_ELEMENT
        ) {
          throw new TypeError('sim: "food" needs an ArrayBuffer of float32 records');
        }
        w.setFood(new Float32Array(buffer));
        return;
      }
      case 'algae':
        requireWorld(command.type).setAlgae(command.cover);
        return;
      case 'addFish': {
        const w = requireWorld(command.type);
        const { spawn, at } = command;
        changeLayout(w, command.request, { kind: 'add', id: spawn.id }, () => {
          if (at === undefined) w.addFish(spawn);
          else w.addFish(spawn, at);
        });
        return;
      }
      case 'removeFish': {
        const w = requireWorld(command.type);
        const { id } = command;
        changeLayout(w, command.request, { kind: 'remove', id }, () => w.removeFish(id));
        return;
      }
      case 'canGrazeAt': {
        const { request, species, position } = command;
        const [x, y, z] = position;
        const reachable = requireWorld(command.type).canGrazeAt(species, x, y, z);
        send({ type: 'grazeReach', request, reachable });
        return;
      }
      case 'nestSite': {
        const position = requireWorld(command.type).nestSite(command.parents);
        send({ type: 'nestSite', request: command.request, position });
        return;
      }
    }
  };

  const listener = (event: MessageEvent): void => {
    try {
      messageType(event.data, COMMAND_TYPES);
      handle(event.data as SimCommand);
    } catch (error) {
      sendError(error, requestOf(event.data));
    }
  };
  port.addEventListener('message', listener);
  port.start?.();

  return {
    dispose(): void {
      stop();
      world = null;
      port.removeEventListener('message', listener);
    },
  };
}

/**
 * Main-thread side of the bridge. Every request (`init`, `addFish`, `removeFish`, `canGrazeAt`,
 * `nestSite`)
 * returns a promise that settles with the worker's answer or rejects with its error; such an
 * error goes to that caller alone. `onError` listeners get the errors no request is waiting for,
 * and a worker failure (`error` or `messageerror` on the port), which also rejects every request
 * still pending, since its answer may never come.
 */
export class SimClient {
  private readonly port: SimClientPort;
  private readonly snapshotListeners = new Set<(snapshot: Snapshot) => void>();
  private readonly errorListeners = new Set<(message: string) => void>();
  private readonly ateListeners = new Set<(events: readonly AteEvent[], ate: SimAte) => void>();
  private readonly nudgeListeners = new Set<(nudge: ToyNudge) => void>();
  private readonly crewListeners = new Set<(tally: readonly CrewTally[], crew: SimCrew) => void>();
  private readonly polypListeners = new Set<(extension: number, polyps: SimPolyps) => void>();
  /** The fish order of the newest layout, and the latest positions in it, x, y, z per fish. */
  private fishIds: readonly string[] = [];
  private fishEpoch = -1;
  private positions = new Float32Array(0);
  private positionsEpoch = -1;
  private pendingInit: {
    request: number;
    resolve: (ready: SimReady) => void;
    reject: (error: Error) => void;
  } | null = null;
  private readonly pendingLayouts = new Map<
    number,
    { resolve: (layout: SimLayout) => void; reject: (error: Error) => void }
  >();
  private readonly pendingQueries = new Map<
    number,
    { resolve: (reachable: boolean) => void; reject: (error: Error) => void }
  >();
  private readonly pendingNests = new Map<
    number,
    { resolve: (position: Point3 | null) => void; reject: (error: Error) => void }
  >();
  private nextRequest = 1;
  /**
   * Requests a worker failure rejected. The worker may well have survived it, so their replies can
   * still arrive; they are dropped, except that a ready or a layout still moves the epoch.
   */
  private readonly abandoned = new Set<number>();
  private readonly listener = (event: MessageEvent): void => this.receive(event.data);
  private readonly failure = (event: Event): void => this.fail(failureText(event));
  private epoch = 0;

  constructor(port: SimClientPort) {
    this.port = port;
    port.addEventListener('message', this.listener);
    port.addEventListener('error', this.failure);
    port.addEventListener('messageerror', this.failure);
    port.start?.();
  }

  init(config: AnyWorldConfig): Promise<SimReady> {
    if (this.pendingInit !== null) {
      return Promise.reject(new Error('sim: init already in flight'));
    }
    const request = this.nextRequest++;
    return new Promise((resolve, reject) => {
      this.pendingInit = { request, resolve, reject };
      this.send({ type: 'init', request, config });
    });
  }

  /**
   * Adds a fish to the running world, at `at` (moved clear of glass, sand and rock) or, without
   * it, wherever a fish would spawn at init. Resolves with the new layout; see `SimLayout`.
   */
  addFish(spawn: FishSpawn, at?: FishPlacement): Promise<SimLayout> {
    return this.requestLayout((request) =>
      at === undefined
        ? { type: 'addFish', request, spawn }
        : { type: 'addFish', request, spawn, at },
    );
  }

  /** Takes fish `id` out of the running world; rejects if there is no such fish. */
  removeFish(id: string): Promise<SimLayout> {
    return this.requestLayout((request) => ({ type: 'removeFish', request, id }));
  }

  /**
   * Whether a fish of `species` could feed on an item fixed at `position` (world frame) in the
   * world as it stands when the worker reaches this request; see `World.canGrazeAt`. Rejects
   * before `init`, or for an unknown species or a non-finite position.
   */
  canGrazeAt(species: string, position: Point3): Promise<boolean> {
    const request = this.nextRequest++;
    return new Promise((resolve, reject) => {
      this.pendingQueries.set(request, { resolve, reject });
      this.send({
        type: 'canGrazeAt',
        request,
        species,
        position: [position[0], position[1], position[2]],
      });
    });
  }

  /**
   * Where the fish `parents` would lay their eggs (world frame), or null when nowhere near their
   * home has room; see `World.nestSite`. Rejects for an unknown fish.
   */
  nestSite(parents: readonly string[]): Promise<Point3 | null> {
    const request = this.nextRequest++;
    return new Promise((resolve, reject) => {
      this.pendingNests.set(request, { resolve, reject });
      this.send({ type: 'nestSite', request, parents: [...parents] });
    });
  }

  start(): void {
    this.send({ type: 'start' });
  }

  stop(): void {
    this.send({ type: 'stop' });
  }

  step(steps: number): void {
    this.send({ type: 'step', steps });
  }

  /** A glass tap or a fast pointer at `stimulus.position` (world frame); nearby fish may C-start. */
  startle(stimulus: Stimulus): void {
    this.send({ type: 'startle', stimulus });
  }

  /** 0 = lights off (night rest), 1 = full day. */
  setLight(level: number): void {
    this.send({ type: 'light', level });
  }

  /** Installs, changes or (with null) removes the wave maker; see `waveMakerForTier`. */
  setWaveMaker(settings: WaveMakerSettings | null): void {
    this.send({ type: 'waveMaker', settings });
  }

  /** Where the lure is (world frame), or null when it is switched off or lifted from the glass. */
  setLure(position: Point3 | null): void {
    this.send({ type: 'lure', position });
  }

  /** Replaces the decor colliders; only moved, added or removed ones are rebuilt in the field. */
  setDecor(colliders: readonly Collider[]): void {
    this.send({ type: 'decor', colliders });
  }

  setAnchors(anchors: readonly Anchor[]): void {
    this.send({ type: 'anchors', anchors });
  }

  /** Every toy in the tank (world frame), `[]` for none; see `World.setToys`. */
  setToys(toys: readonly SimToy[]): void {
    this.send({ type: 'toys', toys });
  }

  /** Every clutch being tended and every pregnancy, `{ clutches: [], gravid: [] }` for none. */
  setBrood(brood: SimBrood): void {
    this.send({ type: 'brood', brood });
  }

  /** Fish `id` grew into `stage`; see `World.setStage`. */
  setStage(id: string, stage: FishStage): void {
    this.send({ type: 'stage', id, stage });
  }

  /** Fish `id`'s boldness, greed and sociability, each 0 to 1; see `World.setPersonality`. */
  setPersonality(id: string, personality: Personality): void {
    this.send({ type: 'personality', id, personality });
  }

  /** The owner at the front glass (world frame), or null once they leave; see `World.setVisitor`. */
  setVisitor(visitor: Visitor | null): void {
    this.send({ type: 'visitor', visitor });
  }

  /**
   * Where fish `id` (a sim fish id) was in the latest snapshot, world frame, or null when no
   * snapshot of the current layout has it. A step behind the interpolated pose a renderer shows.
   */
  fishPoint(id: string): [number, number, number] | null {
    if (this.positionsEpoch !== this.fishEpoch) return null;
    const i = this.fishIds.indexOf(id);
    if (i < 0 || i * 3 + 2 >= this.positions.length) return null;
    return [
      this.positions[i * 3] ?? 0,
      this.positions[i * 3 + 1] ?? 0,
      this.positions[i * 3 + 2] ?? 0,
    ];
  }

  /**
   * Sends this tick's food particles, `FOOD_STRIDE` floats each: id, x, y, z in the world's frame, and
   * the index of the food type in `foodTypeSchema`. The array is copied, so the caller keeps it.
   */
  setFood(food: Float32Array): void {
    if (food.length % FOOD_STRIDE !== 0) {
      throw new RangeError(`food: length ${food.length} is not a multiple of ${FOOD_STRIDE}`);
    }
    const buffer = food.slice().buffer;
    this.port.postMessage({ type: 'food', buffer } satisfies SimCommand, [buffer]);
  }

  /** The lifecycle's algae cover, 0 to 1; resend after `init` and whenever the lifecycle moves it. */
  setAlgae(cover: number): void {
    if (!(Number.isFinite(cover) && cover >= 0 && cover <= 1)) {
      throw new RangeError(`algae: cover must be within 0 to 1, got ${cover}`);
    }
    this.send({ type: 'algae', cover });
  }

  /** Hands a snapshot's buffer back to the worker; the snapshot must not be read afterwards. */
  recycle(snapshot: Snapshot): void {
    const buffer = snapshot.data.buffer;
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength === 0) return;
    this.port.postMessage({ type: 'recycle', buffer } satisfies SimCommand, [buffer]);
  }

  onSnapshot(listener: (snapshot: Snapshot) => void): () => void {
    this.snapshotListeners.add(listener);
    return () => this.snapshotListeners.delete(listener);
  }

  /** What fish ate; gameplay removes eaten particles and reports the portions to the lifecycle. */
  onAte(listener: (events: readonly AteEvent[], ate: SimAte) => void): () => void {
    this.ateListeners.add(listener);
    return () => this.ateListeners.delete(listener);
  }

  /** Each bump a fish gave a ball in the current world, in order; gameplay applies it to the ball. */
  onToyNudge(listener: (nudge: ToyNudge) => void): () => void {
    this.nudgeListeners.add(listener);
    return () => this.nudgeListeners.delete(listener);
  }

  /** Algae grazed and settled food scavenged in the current world, for the lifecycle's crew. */
  onCrew(listener: (tally: readonly CrewTally[], crew: SimCrew) => void): () => void {
    this.crewListeners.add(listener);
    return () => this.crewListeners.delete(listener);
  }

  /**
   * How far coral polyps are out in the current world, 0 to 1, from the tank's darkness: once
   * right after `init` and then as it moves. Purely a render signal; nothing in the sim reads it.
   */
  onPolyps(listener: (extension: number, polyps: SimPolyps) => void): () => void {
    this.polypListeners.add(listener);
    return () => this.polypListeners.delete(listener);
  }

  onError(listener: (message: string) => void): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  dispose(): void {
    this.port.removeEventListener('message', this.listener);
    this.port.removeEventListener('error', this.failure);
    this.port.removeEventListener('messageerror', this.failure);
    this.snapshotListeners.clear();
    this.errorListeners.clear();
    this.ateListeners.clear();
    this.nudgeListeners.clear();
    this.crewListeners.clear();
    this.polypListeners.clear();
    this.abandoned.clear();
    this.rejectPending('sim: client disposed');
  }

  private rejectPending(message: string): void {
    const pending = [
      ...(this.pendingInit === null ? [] : [this.pendingInit]),
      ...this.pendingLayouts.values(),
      ...this.pendingQueries.values(),
      ...this.pendingNests.values(),
    ];
    this.pendingInit = null;
    this.pendingLayouts.clear();
    this.pendingQueries.clear();
    this.pendingNests.clear();
    for (const p of pending) p.reject(new Error(message));
  }

  private fail(message: string): void {
    if (this.pendingInit !== null) this.abandoned.add(this.pendingInit.request);
    for (const request of this.pendingLayouts.keys()) this.abandoned.add(request);
    for (const request of this.pendingQueries.keys()) this.abandoned.add(request);
    for (const request of this.pendingNests.keys()) this.abandoned.add(request);
    this.rejectPending(message);
    for (const l of this.errorListeners) l(message);
  }

  private send(command: SimCommand): void {
    this.port.postMessage(command, []);
  }

  private requestLayout(command: (request: number) => SimCommand): Promise<SimLayout> {
    const request = this.nextRequest++;
    return new Promise((resolve, reject) => {
      this.pendingLayouts.set(request, { resolve, reject });
      this.send(command(request));
    });
  }

  /** Copied before listeners run, since a listener may hand the buffer back with `recycle`. */
  private keepPositions(snapshot: Snapshot): void {
    const n = this.fishIds.length;
    if (snapshot.data.length !== n * SNAPSHOT_STRIDE) {
      throw new Error(
        `sim: snapshot of epoch ${snapshot.epoch} holds ${snapshot.data.length} floats, its layout of ${n} fish needs ${n * SNAPSHOT_STRIDE}`,
      );
    }
    if (this.positions.length !== n * 3) this.positions = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      this.positions[i * 3] = snapshot.data[i * SNAPSHOT_STRIDE] ?? 0;
      this.positions[i * 3 + 1] = snapshot.data[i * SNAPSHOT_STRIDE + 1] ?? 0;
      this.positions[i * 3 + 2] = snapshot.data[i * SNAPSHOT_STRIDE + 2] ?? 0;
    }
    this.positionsEpoch = snapshot.epoch;
  }

  private receive(data: unknown): void {
    messageType(data, EVENT_TYPES);
    const event = data as SimEvent;
    switch (event.type) {
      case 'ready': {
        const pending = this.pendingInit?.request === event.request ? this.pendingInit : null;
        if (pending === null && !this.abandoned.delete(event.request)) {
          throw new Error(`sim: ready for unknown request ${event.request}`);
        }
        this.epoch = event.epoch;
        this.fishIds = event.fishIds;
        this.fishEpoch = event.epoch;
        if (pending !== null) {
          this.pendingInit = null;
          pending.resolve(event);
        }
        return;
      }
      case 'snapshot': {
        const snapshot: Snapshot = {
          epoch: event.epoch,
          tick: event.tick,
          time: event.time,
          data: new Float32Array(event.buffer),
        };
        if (event.epoch === this.fishEpoch) this.keepPositions(snapshot);
        for (const l of this.snapshotListeners) l(snapshot);
        return;
      }
      case 'ate':
        // A world being replaced by `init` may still report bites on food the caller has
        // already reset; only the current world's are passed on.
        if (this.pendingInit !== null || event.epoch !== this.epoch) return;
        for (const l of this.ateListeners) l(event.events, event);
        return;
      case 'toyNudge':
        if (this.pendingInit !== null || event.epoch !== this.epoch) return;
        for (const nudge of event.nudges) for (const l of this.nudgeListeners) l(nudge);
        return;
      case 'crew':
        if (this.pendingInit !== null || event.epoch !== this.epoch) return;
        for (const l of this.crewListeners) l(event.tally, event);
        return;
      case 'polyps':
        if (this.pendingInit !== null || event.epoch !== this.epoch) return;
        for (const l of this.polypListeners) l(event.extension, event);
        return;
      case 'layout': {
        const pending = this.pendingLayouts.get(event.request);
        if (pending === undefined && !this.abandoned.delete(event.request)) {
          throw new Error(`sim: layout for unknown request ${event.request}`);
        }
        this.pendingLayouts.delete(event.request);
        this.epoch = event.epoch;
        this.fishIds = event.fishIds;
        this.fishEpoch = event.epoch;
        pending?.resolve(event);
        return;
      }
      case 'grazeReach': {
        const pending = this.pendingQueries.get(event.request);
        if (pending === undefined) {
          if (this.abandoned.delete(event.request)) return;
          throw new Error(`sim: grazeReach for unknown request ${event.request}`);
        }
        this.pendingQueries.delete(event.request);
        pending.resolve(event.reachable);
        return;
      }
      case 'nestSite': {
        const pending = this.pendingNests.get(event.request);
        if (pending === undefined) {
          if (this.abandoned.delete(event.request)) return;
          throw new Error(`sim: nestSite for unknown request ${event.request}`);
        }
        this.pendingNests.delete(event.request);
        pending.resolve(event.position);
        return;
      }
      case 'error': {
        // An error naming a request belongs to that request alone; one without a request (the
        // step loop failing, say) goes to the listeners.
        const { request } = event;
        if (request !== undefined && this.abandoned.delete(request)) return;
        let pending: { reject: (error: Error) => void } | null = null;
        if (request !== undefined) {
          if (this.pendingInit?.request === request) {
            pending = this.pendingInit;
            this.pendingInit = null;
          } else {
            pending =
              this.pendingLayouts.get(request) ??
              this.pendingQueries.get(request) ??
              this.pendingNests.get(request) ??
              null;
            this.pendingLayouts.delete(request);
            this.pendingQueries.delete(request);
            this.pendingNests.delete(request);
          }
        }
        if (pending !== null) {
          pending.reject(new Error(event.message));
          return;
        }
        if (this.errorListeners.size === 0) {
          throw new Error(`sim worker error with no listener: ${event.message}`);
        }
        for (const l of this.errorListeners) l(event.message);
        return;
      }
    }
  }
}
