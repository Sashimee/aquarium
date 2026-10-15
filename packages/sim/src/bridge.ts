import type { Collider } from '@aquarium/shared';
import type { Anchor, Stimulus } from './behaviour.ts';
import type { Point3 } from './decor.ts';
import { FOOD_STRIDE, type AteEvent } from './food.ts';
import { SNAPSHOT_STRIDE, type Snapshot } from './snapshot.ts';
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
 * `addFish` and `removeFish` change the running world in place and are answered by a `layout`
 * event carrying the same `request` number, or by an `error` event carrying it. `canGrazeAt`
 * changes nothing and is answered by a `grazeReach` event, or an `error` event, with its `request`.
 */
export type SimCommand =
  | { readonly type: 'init'; readonly config: AnyWorldConfig }
  | { readonly type: 'start' }
  | { readonly type: 'stop' }
  | { readonly type: 'step'; readonly steps: number }
  | { readonly type: 'recycle'; readonly buffer: ArrayBuffer }
  | { readonly type: 'startle'; readonly stimulus: Stimulus }
  | { readonly type: 'light'; readonly level: number }
  /** A laser dot or fingertip on the glass, or null once it is gone; see `World.setLure`. */
  | { readonly type: 'lure'; readonly position: Point3 | null }
  /** The full collider set in the shared format; hard ones block fish, soft ones (plants) push them aside. */
  | { readonly type: 'decor'; readonly colliders: readonly Collider[] }
  | { readonly type: 'anchors'; readonly anchors: readonly Anchor[] }
  /** Float32 records of `[id, x, y, z, typeIndex]`; see `World.setFood`. */
  | { readonly type: 'food'; readonly buffer: ArrayBuffer }
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
    };

export interface SimReady {
  readonly type: 'ready';
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
  | SimLayout
  | SimGrazeReach
  /** `request` is set when the failed command was an `addFish`, `removeFish` or `canGrazeAt`. */
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

/** Bites taken in the steps leading up to the snapshot at `tick`, which follows it. */
export interface SimAte {
  readonly type: 'ate';
  readonly epoch: number;
  readonly tick: number;
  readonly events: readonly AteEvent[];
}

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
  'lure',
  'decor',
  'anchors',
  'food',
  'addFish',
  'removeFish',
  'canGrazeAt',
]);
const EVENT_TYPES = new Set(['ready', 'snapshot', 'ate', 'layout', 'grazeReach', 'error']);

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
  return typeof request === 'number' ? request : undefined;
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

  const send = (event: SimEvent, transfer: ArrayBuffer[] = []): void => {
    port.postMessage(event, transfer);
  };

  const emitSnapshot = (w: World): void => {
    const events = w.takeAteEvents();
    if (events.length > 0) send({ type: 'ate', epoch, tick: w.tick, events });
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
    // Bites taken so far belong to the old layout's epoch, so they go out before it changes.
    const events = w.takeAteEvents();
    if (events.length > 0) send({ type: 'ate', epoch, tick: w.tick, events });
    apply();
    epoch++;
    send({ type: 'layout', epoch, request, fishIds: w.fishIds, stride: SNAPSHOT_STRIDE, change });
    emitSnapshot(w);
  };

  const handle = (command: SimCommand): void => {
    switch (command.type) {
      case 'init': {
        stop();
        world = new World(command.config);
        pool.length = 0;
        epoch++;
        send({
          type: 'ready',
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
      case 'lure':
        requireWorld(command.type).setLure(command.position);
        return;
      case 'decor':
        requireWorld(command.type).setDecor(command.colliders);
        return;
      case 'anchors':
        requireWorld(command.type).setAnchors(command.anchors);
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
 * Main-thread side of the bridge. Every request (`init`, `addFish`, `removeFish`, `canGrazeAt`)
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
  private pendingInit: {
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
  private nextRequest = 1;
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
    return new Promise((resolve, reject) => {
      this.pendingInit = { resolve, reject };
      this.send({ type: 'init', config });
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
    this.rejectPending('sim: client disposed');
  }

  private rejectPending(message: string): void {
    const pending = [
      ...(this.pendingInit === null ? [] : [this.pendingInit]),
      ...this.pendingLayouts.values(),
      ...this.pendingQueries.values(),
    ];
    this.pendingInit = null;
    this.pendingLayouts.clear();
    this.pendingQueries.clear();
    for (const p of pending) p.reject(new Error(message));
  }

  private fail(message: string): void {
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

  private receive(data: unknown): void {
    messageType(data, EVENT_TYPES);
    const event = data as SimEvent;
    switch (event.type) {
      case 'ready':
        this.epoch = event.epoch;
        this.pendingInit?.resolve(event);
        this.pendingInit = null;
        return;
      case 'snapshot': {
        const snapshot: Snapshot = {
          epoch: event.epoch,
          tick: event.tick,
          time: event.time,
          data: new Float32Array(event.buffer),
        };
        for (const l of this.snapshotListeners) l(snapshot);
        return;
      }
      case 'ate':
        // A world being replaced by `init` may still report bites on food the caller has
        // already reset; only the current world's are passed on.
        if (this.pendingInit !== null || event.epoch !== this.epoch) return;
        for (const l of this.ateListeners) l(event.events, event);
        return;
      case 'layout': {
        const pending = this.pendingLayouts.get(event.request);
        if (pending === undefined) {
          throw new Error(`sim: layout for unknown request ${event.request}`);
        }
        this.pendingLayouts.delete(event.request);
        this.epoch = event.epoch;
        pending.resolve(event);
        return;
      }
      case 'grazeReach': {
        const pending = this.pendingQueries.get(event.request);
        if (pending === undefined) {
          throw new Error(`sim: grazeReach for unknown request ${event.request}`);
        }
        this.pendingQueries.delete(event.request);
        pending.resolve(event.reachable);
        return;
      }
      case 'error': {
        // An error naming a request belongs to that add, remove or query alone, never to an init;
        // one without a request goes to a pending init, and to the listeners only if none is.
        const pending =
          event.request === undefined
            ? this.pendingInit
            : (this.pendingLayouts.get(event.request) ??
              this.pendingQueries.get(event.request) ??
              null);
        if (event.request === undefined) this.pendingInit = null;
        else {
          this.pendingLayouts.delete(event.request);
          this.pendingQueries.delete(event.request);
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
