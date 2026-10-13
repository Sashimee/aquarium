import type { Collider } from '@aquarium/shared';
import type { Anchor, Stimulus } from './behaviour.ts';
import { FOOD_STRIDE, type AteEvent } from './food.ts';
import { SNAPSHOT_STRIDE, type Snapshot } from './snapshot.ts';
import { STEP_HZ, World, type AnyWorldConfig } from './world.ts';

/**
 * Every position crossing the bridge (startle stimuli, food, decor colliders, anchors, and the
 * fish in snapshots) is in the world's frame, which `init` fixes: tank space when the config has
 * `space`, so scene coordinates pass through unchanged; the legacy flat-floor box when it has
 * `tank`. Never map positions by subtracting the local sand height: food would sink under the
 * fish's floor where the sand is low and startles would land in the wrong place.
 */
export type SimCommand =
  | { readonly type: 'init'; readonly config: AnyWorldConfig }
  | { readonly type: 'start' }
  | { readonly type: 'stop' }
  | { readonly type: 'step'; readonly steps: number }
  | { readonly type: 'recycle'; readonly buffer: ArrayBuffer }
  | { readonly type: 'startle'; readonly stimulus: Stimulus }
  | { readonly type: 'light'; readonly level: number }
  /** The full collider set in the shared format; hard ones block fish, soft ones (plants) push them aside. */
  | { readonly type: 'decor'; readonly colliders: readonly Collider[] }
  | { readonly type: 'anchors'; readonly anchors: readonly Anchor[] }
  /** Float32 records of `[id, x, y, z, typeIndex]`; see `World.setFood`. */
  | { readonly type: 'food'; readonly buffer: ArrayBuffer };

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
  | { readonly type: 'error'; readonly message: string };

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

const COMMAND_TYPES = new Set([
  'init',
  'start',
  'stop',
  'step',
  'recycle',
  'startle',
  'light',
  'decor',
  'anchors',
  'food',
]);
const EVENT_TYPES = new Set(['ready', 'snapshot', 'ate', 'error']);

function messageType(data: unknown, allowed: ReadonlySet<string>): string {
  if (typeof data === 'object' && data !== null && 'type' in data) {
    const type = (data as { type: unknown }).type;
    if (typeof type === 'string' && allowed.has(type)) return type;
  }
  const text = JSON.stringify(data) ?? String(data);
  const shown = text.length > 200 ? `${text.slice(0, 200)}…` : text;
  throw new TypeError(`unexpected sim bridge message: ${shown}`);
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

  const sendError = (error: unknown): void => {
    send({ type: 'error', message: error instanceof Error ? error.message : String(error) });
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
    }
  };

  const listener = (event: MessageEvent): void => {
    try {
      messageType(event.data, COMMAND_TYPES);
      handle(event.data as SimCommand);
    } catch (error) {
      sendError(error);
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

/** Main-thread side of the bridge. */
export class SimClient {
  private readonly port: MessagePortLike;
  private readonly snapshotListeners = new Set<(snapshot: Snapshot) => void>();
  private readonly errorListeners = new Set<(message: string) => void>();
  private readonly ateListeners = new Set<(events: readonly AteEvent[], ate: SimAte) => void>();
  private pendingInit: {
    resolve: (ready: SimReady) => void;
    reject: (error: Error) => void;
  } | null = null;
  private readonly listener = (event: MessageEvent): void => this.receive(event.data);
  private epoch = 0;

  constructor(port: MessagePortLike) {
    this.port = port;
    port.addEventListener('message', this.listener);
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
    this.snapshotListeners.clear();
    this.errorListeners.clear();
    this.ateListeners.clear();
    this.pendingInit?.reject(new Error('sim: client disposed'));
    this.pendingInit = null;
  }

  private send(command: SimCommand): void {
    this.port.postMessage(command, []);
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
      case 'error': {
        const pending = this.pendingInit;
        this.pendingInit = null;
        pending?.reject(new Error(event.message));
        if (pending === null && this.errorListeners.size === 0) {
          throw new Error(`sim worker error with no listener: ${event.message}`);
        }
        for (const l of this.errorListeners) l(event.message);
        return;
      }
    }
  }
}
