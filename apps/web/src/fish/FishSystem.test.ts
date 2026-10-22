import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BoxGeometry,
  CompressedTexture,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  Quaternion,
  Scene,
  Vector3,
  type Node,
} from 'three/webgpu';
import {
  CARCASS,
  FishState,
  SNAPSHOT_STRIDE,
  SnapshotField,
  WALK,
  type SimToy,
} from '@aquarium/sim';
import type { Collider } from '@aquarium/shared';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import type { Engine } from '../engine/Engine';
import { DAYLIGHT_INTERVAL_MS, DAYLIGHT_UNSEEN_GAP_MS, DaylightFeed } from '../engine/daylight';
import { TIER_SETTINGS, type TierSettings } from '../engine/quality/tiers';
import { EventBus, type EngineEvents } from '../engine/events';
import { DEFAULT_TANK, TANK_DIMENSIONS, waterBounds } from '../engine/tank/dimensions';
import type { InteractionEvents } from '../interaction/events';
import { FISH_1, FISH_2, TANK_A, fishFixture } from '../sync/fixtures';
import type { FishAssetEntry, ImpostorAtlasInfo } from './assetIndex';
import { FishAssetLoader, type FishModel, type ShellRig } from './assets';
import { ImpostorInstanceData } from './impostor';
import { FishInstanceData, InstanceSlot, type InstanceValues } from './instances';
import { FishMaterial } from './material';
import { batchLocomotion, FishSystem, walkerLift } from './FishSystem';
import { renderProfile, swimModeFor } from './profiles';
import type { BallNudge, PickRay } from './start';
import { PECK_JAB_BODY_LENGTHS, SWIM_MODES } from './swim';
import { CRAB_GAIT, SHRIMP_GAIT, SNAIL_GAIT, type TailRig } from './walk';
import { SimInitTimeout } from './simWorld';

class FakeWorker {
  static last: FakeWorker | null = null;
  readonly sent: { type: string }[] = [];
  private readonly listeners = new Map<string, Set<(event: Event) => void>>();
  constructor() {
    FakeWorker.last = this;
  }
  addEventListener(type: string, listener: (event: Event) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }
  removeEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.get(type)?.delete(listener);
  }
  inits(): { request: number; config: { fish: { id: string; species: string }[] } }[] {
    return this.sent.filter((m) => m.type === 'init') as unknown as ReturnType<FakeWorker['inits']>;
  }
  postMessage(message: { type: string }): void {
    this.sent.push(message);
  }
  terminate(): void {}
  emit(data: unknown): void {
    for (const l of [...(this.listeners.get('message') ?? [])]) {
      l(new MessageEvent('message', { data }));
    }
  }
}

type FrameListener = (deltaS: number, nowMs: number) => void;

function fakeEngine(): {
  engine: Engine;
  errors: string[];
  frames: FrameListener[];
  photo: { simPaused: boolean };
} {
  const events = new EventBus<EngineEvents>();
  const errors: string[] = [];
  const frames: FrameListener[] = [];
  events.on('engine:error', ({ message }) => errors.push(message));
  const photo = { simPaused: false };
  const engine = {
    scene: new Scene(),
    ktx2: new KTX2Loader(),
    events,
    daylight: 1,
    disposed: false,
    quality: { tier: 'medium', register: () => () => undefined },
    onFrame: (listener: FrameListener) => {
      frames.push(listener);
      return () => undefined;
    },
    camera: { position: new Vector3(0, 0.25, 1.5) },
    viewPosition: new Vector3(0, 0.25, 1.5),
    photo,
    sceneRevision: 0,
    caustics: { lightDirection: new Vector3(0, -1, 0), hoodLight: () => null },
  };
  return { engine: engine as unknown as Engine, errors, frames, photo };
}

async function initPosted(): Promise<FakeWorker> {
  await vi.waitFor(() => {
    if (!FakeWorker.last?.sent.some((m) => m.type === 'init')) throw new Error('no init yet');
  });
  const worker = FakeWorker.last;
  if (worker === null) throw new Error('no worker');
  return worker;
}

describe('FishSystem.create', () => {
  beforeEach(() => {
    FakeWorker.last = null;
    vi.stubGlobal('Worker', FakeWorker);
    vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function create(engine: Engine, signal = new AbortController().signal): Promise<FishSystem> {
    return FishSystem.create(engine, {
      tank: DEFAULT_TANK,
      assetRoot: '/assets/',
      biome: 'reef',
      interaction: new EventBus<InteractionEvents>(),
      seed: 7,
      signal,
    });
  }

  it('reports a sim error held before a start that timed out', async () => {
    const { engine, errors } = fakeEngine();
    const start = create(engine);
    const settled = start.catch((cause: unknown) => cause);
    const worker = await initPosted();
    worker.emit({ type: 'error', message: 'bad collider' });

    await vi.advanceTimersByTimeAsync(15_000);

    expect(await settled).toBeInstanceOf(SimInitTimeout);
    expect(errors).toContain('Fish sim: bad collider');
  });

  it('stays quiet about held sim errors when the start is aborted', async () => {
    const { engine, errors } = fakeEngine();
    const controller = new AbortController();
    const start = create(engine, controller.signal);
    const settled = start.catch((cause: unknown) => cause);
    const worker = await initPosted();
    worker.emit({ type: 'error', message: 'bad collider' });
    const gone = new Error('page torn down');

    controller.abort(gone);

    expect(await settled).toBe(gone);
    expect(errors.filter((m) => m.startsWith('Fish sim:'))).toEqual([]);
  });

  it('keeps the demo stock out between a switch unload and the next tank', async () => {
    const { engine } = fakeEngine();
    const start = create(engine);
    const worker = await initPosted();
    let answered = 0;
    const answer = (): void => {
      for (const { request, config } of worker.inits().slice(answered)) {
        worker.emit({
          type: 'ready',
          request,
          epoch: request,
          fishIds: config.fish.map((f) => f.id),
          stride: 8,
          stepHz: 30,
        });
      }
      answered = worker.inits().length;
    };
    answer();
    const fish = await start;
    const demo = worker.inits()[0]?.config.fish.map((f) => f.species);
    expect(demo?.length).toBeGreaterThan(0);
    const lastSpecies = async (count: number): Promise<string[] | undefined> => {
      await vi.waitFor(() => {
        if (worker.inits().length < count) throw new Error('no new world yet');
      });
      answer();
      await fish.synced();
      return worker.inits()[count - 1]?.config.fish.map((f) => f.species);
    };

    fish.handle({
      type: 'tank:loaded',
      payload: {
        backgroundId: 'bg-fw-planted-stream',
        tankId: TANK_A,
        biome: 'freshwater',
        size: 'standard',
        decorLayout: [],
        decorEdited: false,
        fish: [fishFixture(FISH_1)],
      },
    });
    expect(await lastSpecies(2)).toEqual(['neon-tetra']);

    fish.handle({ type: 'tank:unloaded', payload: { tankId: TANK_A, reason: 'switch' } });
    await fish.synced();
    expect(worker.inits()).toHaveLength(2);
    expect(worker.sent.at(-1)?.type).toBe('stop');

    fish.handle({ type: 'tank:none', payload: {} });
    expect(await lastSpecies(3)).toEqual(demo);
    fish.dispose();
  });

  function answerInits(worker: FakeWorker, from = 0): void {
    for (const { request, config } of worker.inits().slice(from)) {
      worker.emit({
        type: 'ready',
        request,
        epoch: request,
        fishIds: config.fish.map((f) => f.id),
        stride: 8,
        stepHz: 30,
      });
    }
  }

  it("hands the frame loop's hood light to the sim, settled only when nobody saw it change", async () => {
    const { engine } = fakeEngine();
    const start = create(engine);
    const worker = await initPosted();
    answerInits(worker);
    const fish = await start;
    const levels = { now: 1 };
    const daylight = new DaylightFeed(() => levels.now, engine.events);
    const page = { hidden: false, listener: (): void => undefined };
    daylight.watch({
      get hidden() {
        return page.hidden;
      },
      addEventListener: (_type, listener) => (page.listener = listener),
      removeEventListener: () => undefined,
    });
    const startLights = worker.sent.filter((m) => m.type === 'light').length;
    const lights = (): unknown[] =>
      worker.sent.filter((m) => m.type === 'light').slice(startLights);
    let nowMs = 0;
    const frame = (gapMs: number): void => {
      nowMs += gapMs;
      daylight.frame(nowMs, gapMs);
    };

    frame(0);
    levels.now = 0;
    frame(DAYLIGHT_INTERVAL_MS);
    levels.now = 1;
    frame(DAYLIGHT_UNSEEN_GAP_MS + 1);
    levels.now = 0.5;
    page.hidden = true;
    page.listener();
    frame(DAYLIGHT_INTERVAL_MS);
    page.hidden = false;
    page.listener();
    levels.now = 0;
    frame(DAYLIGHT_INTERVAL_MS);
    levels.now = 1;
    frame(DAYLIGHT_INTERVAL_MS);

    expect(lights()).toEqual([
      { type: 'light', level: 1, settle: true },
      { type: 'light', level: 0, settle: false },
      { type: 'light', level: 1, settle: true },
      { type: 'light', level: 0.5, settle: true },
      { type: 'light', level: 0, settle: true },
      { type: 'light', level: 1, settle: false },
    ]);
    fish.dispose();
  });

  it("tells sim client listeners the current client, then a stuck worker's replacement", async () => {
    const { engine } = fakeEngine();
    const start = create(engine);
    const worker = await initPosted();
    answerInits(worker);
    const fish = await start;
    const clients: unknown[] = [];
    const extensions: number[] = [];
    const off = fish.onSimClient((client) => {
      clients.push(client);
      client.onPolyps((extension) => extensions.push(extension));
    });
    expect(clients).toHaveLength(1);
    worker.emit({ type: 'polyps', epoch: 1, tick: 3, extension: 0.25 });
    expect(extensions).toEqual([0.25]);

    fish.handle({ type: 'tank:none', payload: {} });
    fish.handle({
      type: 'tank:loaded',
      payload: {
        backgroundId: 'bg-fw-planted-stream',
        tankId: TANK_A,
        biome: 'freshwater',
        size: 'standard',
        decorLayout: [],
        decorEdited: false,
        fish: [fishFixture(FISH_1)],
      },
    });
    await vi.waitFor(() => {
      if (worker.inits().length < 2) throw new Error('no second init yet');
    });
    await vi.advanceTimersByTimeAsync(15_000);
    await vi.waitFor(() => {
      if (clients.length < 2) throw new Error('worker not replaced yet');
    });
    const replacement = FakeWorker.last;
    expect(replacement).not.toBe(worker);
    expect(clients[1]).not.toBe(clients[0]);
    if (replacement === null) throw new Error('no replacement worker');
    await vi.waitFor(() => {
      if (replacement.inits().length === 0) throw new Error('no init on the replacement yet');
    });
    answerInits(replacement);
    const epoch = replacement.inits()[0]?.request;
    replacement.emit({ type: 'polyps', epoch, tick: 0, extension: 0.75 });
    expect(extensions).toEqual([0.25, 0.75]);

    off();
    fish.dispose();
    expect(clients).toHaveLength(2);
  });

  it('tells world listeners the running world, that it stopped, and the next one', async () => {
    const { engine } = fakeEngine();
    const start = create(engine);
    const worker = await initPosted();
    answerInits(worker);
    const fish = await start;
    const worlds: (number | null)[] = [];
    fish.onWorld((epoch) => worlds.push(epoch));
    expect(worlds).toEqual([worker.inits()[0]?.request]);

    fish.handle({
      type: 'tank:loaded',
      payload: {
        backgroundId: 'bg-fw-planted-stream',
        tankId: TANK_A,
        biome: 'freshwater',
        size: 'standard',
        decorLayout: [],
        decorEdited: false,
        fish: [fishFixture(FISH_1)],
      },
    });
    expect(worlds.at(-1)).toBeNull();
    await vi.waitFor(() => {
      if (worker.inits().length < 2) throw new Error('no second init yet');
    });
    answerInits(worker, 1);
    await fish.synced();
    expect(worlds.at(-1)).toBe(worker.inits()[1]?.request);
    expect(worlds.at(-1)).not.toBe(worlds[0]);

    fish.handle({ type: 'tank:unloaded', payload: { tankId: TANK_A, reason: 'switch' } });
    expect(worlds.at(-1)).toBeNull();

    fish.dispose();
    const after = worlds.length;
    fish.handle({ type: 'tank:none', payload: {} });
    expect(worlds).toHaveLength(after);
  });
});

describe('batchLocomotion', () => {
  const shrimp = { hinge: { y: 0, z: 0.002 }, telsonZ: -0.016, legPairs: 5 };
  const tail = { hinge: shrimp.hinge, tip: { y: -0.003, z: -0.016, share: 1 }, bodyLength: 0.03 };
  const shell: ShellRig = { centre: [0, 0.004, -0.002], drop: 0.001 };
  const finned = { swimmingMode: 'subcarangiform' } as const;
  const pleopod = { swimmingMode: 'pleopod', walking: { legPairs: 5 } } as const;
  const crawler = (legPairs: number) => ({ swimmingMode: 'none', walking: { legPairs } }) as const;
  function model(
    kind: FishAssetEntry['kind'],
    {
      rig = kind === 'fish' || kind === 'snail' ? null : shrimp,
      tailRig = rig === null ? null : tail,
      shellRig = kind === 'crab' || kind === 'snail' ? shell : null,
      standoff = kind === 'fish' ? null : 0.0045,
    }: {
      rig?: FishAssetEntry['shrimp'];
      tailRig?: TailRig | null;
      shellRig?: ShellRig | null;
      standoff?: number | null;
    } = {},
  ): Pick<FishModel, 'entry' | 'tail' | 'shell'> {
    return {
      entry: {
        id: 'model',
        kind,
        species: 'species',
        min: [-0.01, -0.005, -0.016],
        max: [0.01, 0.004, 0.02],
        standardLengthM: 0.03,
        standoff,
        lodFiles: ['lod0.glb'],
        sharperTextures: new Map(),
        shrimp: rig,
        impostor: null,
      },
      tail: tailRig,
      shell: shellRig,
    };
  }

  it("swims a finned species in its own mode, shaped by the species' profile", () => {
    const profile = renderProfile('neon-tetra');
    expect(batchLocomotion(model('fish'), finned, profile)).toEqual({
      kind: 'swim',
      mode: swimModeFor(SWIM_MODES.subcarangiform, profile),
    });
  });

  it('walks a pleopod species on its shrimp rig and tail, two cheliped pairs and no shell', () => {
    const profile = renderProfile('cherry-shrimp');
    expect(batchLocomotion(model('shrimp'), pleopod, profile)).toEqual({
      kind: 'walk',
      shrimp,
      tail,
      chelipedPairs: 2,
      shell: null,
      gait: SHRIMP_GAIT,
      lift: 0.0045 - WALK.standoffBodyLengths * 0.03,
    });
  });

  it('walks a legged species that never swims on a crab rig with one cheliped pair and its shell', () => {
    const profile = renderProfile('hermit-crab');
    expect(batchLocomotion(model('crab'), crawler(2), profile)).toEqual({
      kind: 'walk',
      shrimp,
      tail,
      chelipedPairs: 1,
      shell,
      gait: CRAB_GAIT,
      lift: 0.0045 - WALK.standoffBodyLengths * 0.03,
    });
  });

  it('glides a legless species on a snail model, lifted to the sole the sim holds off the glass', () => {
    const profile = renderProfile('nerite-snail');
    expect(batchLocomotion(model('snail', { standoff: 0 }), crawler(0), profile)).toEqual({
      kind: 'glide',
      shell,
      gait: SNAIL_GAIT,
      lift: -WALK.standoffBodyLengths * 0.03,
    });
  });

  it('refuses a walker model without a tail rig', () => {
    const profile = renderProfile('cherry-shrimp');
    expect(() => batchLocomotion(model('shrimp', { tailRig: null }), pleopod, profile)).toThrow(
      /needs a shrimp model/,
    );
  });

  it('refuses a pleopod species on a fish or crab model', () => {
    const profile = renderProfile('cherry-shrimp');
    expect(() => batchLocomotion(model('fish'), pleopod, profile)).toThrow(/needs a shrimp model/);
    expect(() => batchLocomotion(model('crab'), pleopod, profile)).toThrow(/needs a shrimp model/);
  });

  it('refuses a legless walker on a legged model, and a legged one on a snail', () => {
    const profile = renderProfile('hermit-crab');
    expect(() => batchLocomotion(model('crab'), crawler(0), profile)).toThrow(
      /needs a snail model/,
    );
    expect(() => batchLocomotion(model('snail'), crawler(2), profile)).toThrow(
      /needs a crab model/,
    );
    expect(() => batchLocomotion(model('shrimp'), crawler(2), profile)).toThrow(
      /needs a crab model/,
    );
  });

  it('refuses a crab or snail model without its shell rig', () => {
    const profile = renderProfile('hermit-crab');
    expect(() => batchLocomotion(model('crab', { shellRig: null }), crawler(2), profile)).toThrow(
      /needs a crab model/,
    );
    expect(() => batchLocomotion(model('snail', { shellRig: null }), crawler(0), profile)).toThrow(
      /needs a snail model/,
    );
  });

  it("refuses more walking pairs than fit behind the crab's chelipeds", () => {
    const profile = renderProfile('hermit-crab');
    expect(batchLocomotion(model('crab'), crawler(4), profile).kind).toBe('walk');
    expect(() => batchLocomotion(model('crab'), crawler(5), profile)).toThrow(
      /5 walking leg pairs .* do not fit the model's 5 leg slots/,
    );
  });
});

describe('walkerLift', () => {
  it("is zero where the model's feet sit where the sim holds the body", () => {
    expect(
      walkerLift({ standoff: WALK.standoffBodyLengths * 0.02, standardLengthM: 0.02 }),
    ).toBeCloseTo(0, 12);
  });

  it('raises a model whose feet reach further below its origin than the sim standoff', () => {
    expect(walkerLift({ standoff: 0.008, standardLengthM: 0.03 })).toBeCloseTo(
      0.008 - WALK.standoffBodyLengths * 0.03,
      12,
    );
  });

  it('lowers a snail whose origin is already on its sole, and a fish has no standoff', () => {
    expect(walkerLift({ standoff: 0, standardLengthM: 0.02 })).toBeLessThan(0);
    expect(walkerLift({ standoff: null, standardLengthM: 0.02 })).toBeLessThan(0);
  });
});

/** A shrimp drawn as one box: posed and pickable like the real model. */
function shrimpModel(assetId: string): FishModel {
  return {
    entry: {
      id: assetId,
      kind: 'shrimp',
      species: 'cherry-shrimp',
      min: [-0.004, -0.004, -0.0125],
      max: [0.004, 0.004, 0.0125],
      standardLengthM: 0.025,
      standoff: WALK.standoffBodyLengths * 0.025,
      lodFiles: [],
      sharperTextures: new Map(),
      shrimp: { hinge: { y: 0, z: 0 }, telsonZ: -0.0125, legPairs: 5 },
      impostor: null,
    },
    tail: { hinge: { y: 0, z: 0 }, tip: { y: -0.004, z: -0.0125, share: 1 }, bodyLength: 0.025 },
    shell: null,
    textureSize: 1024,
    lods: [
      [
        {
          geometry: new BoxGeometry(0.008, 0.008, 0.025),
          source: new MeshStandardMaterial(),
          legPivots: [],
          mouth: false,
        },
      ],
    ],
  };
}

describe('FishSystem dead shrimp', () => {
  const SHRIMP = fishFixture(FISH_1, { species: 'cherry-shrimp', size: 0.025 });
  const STEP_S = 1 / 30;

  beforeEach(() => {
    FakeWorker.last = null;
    vi.stubGlobal('Worker', FakeWorker);
    vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')));
    vi.spyOn(FishAssetLoader.prototype, 'load').mockImplementation((assetId) =>
      assetId.includes('shrimp')
        ? Promise.resolve(shrimpModel(assetId))
        : Promise.reject(new Error('offline')),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  interface ShrimpTank {
    readonly fish: FishSystem;
    readonly scene: Scene;
    readonly worker: FakeWorker;
    readonly photo: { simPaused: boolean };
    advance(seconds: number): void;
  }

  /**
   * A saved freshwater tank holding one cherry shrimp, drawn for half a second: in its bag, or
   * out in the tank where the sim holds it at `climbing` (position, then quaternion).
   */
  async function shrimpTank(climbing: readonly number[] | null = null): Promise<ShrimpTank> {
    const { engine, frames, photo } = fakeEngine();
    const start = FishSystem.create(engine, {
      tank: DEFAULT_TANK,
      assetRoot: '/assets/',
      biome: 'freshwater',
      interaction: new EventBus<InteractionEvents>(),
      seed: 7,
      signal: new AbortController().signal,
    });
    const worker = await initPosted();
    let answered = 0;
    const answer = (): void => {
      for (const { request, config } of worker.inits().slice(answered)) {
        worker.emit({
          type: 'ready',
          request,
          epoch: request,
          fishIds: config.fish.map((f) => f.id),
          stride: SNAPSHOT_STRIDE,
          stepHz: 30,
        });
      }
      answered = worker.inits().length;
    };
    answer();
    const fish = await start;
    fish.handle({
      type: 'tank:loaded',
      payload: {
        backgroundId: 'bg-fw-planted-stream',
        tankId: TANK_A,
        biome: 'freshwater',
        size: 'standard',
        decorLayout: [],
        decorEdited: false,
        fish: climbing === null ? [] : [SHRIMP],
      },
    });
    if (climbing === null) {
      fish.handle({
        type: 'tank:fish-added',
        payload: { tankId: TANK_A, fish: SHRIMP, acclimate: true },
      });
    } else {
      await vi.waitFor(() => {
        if (worker.inits().length < 2) throw new Error('no world for the shrimp yet');
      });
      answer();
    }
    await fish.synced();
    let tick = 0;
    const advance = (seconds: number): void => {
      for (let t = 0; t < seconds; t += STEP_S) {
        if (climbing !== null) {
          const data = new Float32Array(SNAPSHOT_STRIDE);
          data.set(climbing);
          tick++;
          worker.emit({
            type: 'snapshot',
            epoch: answered,
            tick,
            time: tick * STEP_S,
            buffer: data.buffer,
          });
        }
        for (const frame of frames) frame(STEP_S, performance.now());
      }
    };
    advance(0.5);
    return { fish, scene: engine.scene, worker, photo, advance };
  }

  /** How the shrimp is drawn: the first instance of its LOD 0 mesh. */
  function drawnQuaternion(scene: Scene): Quaternion {
    let mesh: InstancedMesh | null = null;
    scene.traverse((o) => {
      if (o instanceof InstancedMesh && o.name.endsWith(':lod0')) mesh = o;
    });
    if (mesh === null) throw new Error('no shrimp mesh in the scene');
    const matrix = new Matrix4();
    (mesh as InstancedMesh).getMatrixAt(0, matrix);
    const q = new Quaternion();
    matrix.decompose(new Vector3(), q, new Vector3());
    return q;
  }

  /** Where the shrimp is drawn: the first instance of its LOD 0 mesh. */
  function drawnPosition(scene: Scene): Vector3 {
    let mesh: InstancedMesh | null = null;
    scene.traverse((o) => {
      if (o instanceof InstancedMesh && o.name.endsWith(':lod0')) mesh = o;
    });
    if (mesh === null) throw new Error('no shrimp mesh in the scene');
    const matrix = new Matrix4();
    (mesh as InstancedMesh).getMatrixAt(0, matrix);
    return new Vector3().setFromMatrixPosition(matrix);
  }

  function die(fish: FishSystem): void {
    fish.handle({
      type: 'tank:fish-died',
      payload: {
        tankId: TANK_A,
        fish: { ...SHRIMP, status: 'dead', diedAt: '2026-10-15T00:00:00.000Z' },
      },
    });
  }

  function picked(fish: FishSystem, origin: PickRay['origin'], dir: PickRay['dir']): boolean {
    return fish.pickDead({ origin, dir }) === SHRIMP.id;
  }

  /** Where the dead shrimp is, from which horizontal rays across the tank pick it. */
  function locate(fish: FishSystem): { x: number; y: number; z: number } {
    const along = (axis: 'x' | 'z', y: number, across: number): boolean =>
      axis === 'x'
        ? picked(fish, { x: -1, y, z: across }, { x: 1, y: 0, z: 0 })
        : picked(fish, { x: across, y, z: -1 }, { x: 0, y: 0, z: 1 });
    const ys: number[] = [];
    const zs: number[] = [];
    for (let y = 0; y <= DEFAULT_TANK.height; y += 0.002) {
      for (let z = -0.25; z <= 0.25; z += 0.002) {
        if (along('x', y, z)) {
          ys.push(y);
          zs.push(z);
        }
      }
    }
    if (ys.length === 0) throw new Error('no ray picks the dead shrimp');
    const mid = (v: number[]): number => (Math.min(...v) + Math.max(...v)) / 2;
    const y = mid(ys);
    const xs: number[] = [];
    for (let x = -0.6; x <= 0.6; x += 0.002) if (along('z', y, x)) xs.push(x);
    return { x: mid(xs), y, z: mid(zs) };
  }

  it('picks a sinking shrimp where it is drawn, all the way down to the floor', async () => {
    const { fish, advance } = await shrimpTank();
    const down = { x: 0, y: -1, z: 0 };
    die(fish);
    advance(STEP_S);
    const start = locate(fish);
    expect(picked(fish, { ...start, y: 1 }, down)).toBe(true);

    let last = start;
    for (let i = 0; i < 12; i++) {
      advance(2);
      const at = locate(fish);
      expect(at.y).toBeLessThanOrEqual(last.y + 0.002);
      expect(at.x).toBeCloseTo(start.x, 2);
      expect(at.z).toBeCloseTo(start.z, 2);
      last = at;
    }
    expect(last.y).toBeLessThan(start.y - 0.2);
    advance(5);
    expect(locate(fish).y).toBe(last.y);
    expect(picked(fish, { x: -1, y: last.y, z: last.z }, { x: 1, y: 0, z: 0 })).toBe(true);
    expect(picked(fish, { x: -1, y: start.y, z: start.z }, { x: 1, y: 0, z: 0 })).toBe(false);
    fish.dispose();
  });

  it('brings a dead shrimp into the smaller glass when the tank shrinks, and back out again', async () => {
    const { fish, scene, advance } = await shrimpTank();
    die(fish);
    advance(30);
    const nano = waterBounds(TANK_DIMENSIONS.nano30);
    const inNano = (p: Vector3): boolean =>
      p.x >= nano.min.x &&
      p.x <= nano.max.x &&
      p.z >= nano.min.z &&
      p.z <= nano.max.z &&
      p.y >= nano.min.y &&
      p.y <= nano.max.y;
    expect(inNano(drawnPosition(scene))).toBe(false);

    fish.setTank(TANK_DIMENSIONS.nano30);
    advance(STEP_S);
    expect(inNano(drawnPosition(scene))).toBe(true);
    fish.setTank(TANK_DIMENSIONS.nano30);
    advance(STEP_S);
    expect(inNano(drawnPosition(scene))).toBe(true);

    fish.setTank(DEFAULT_TANK);
    advance(30);
    const standard = waterBounds(DEFAULT_TANK);
    const back = drawnPosition(scene);
    expect(back.x).toBeGreaterThanOrEqual(standard.min.x);
    expect(back.x).toBeLessThanOrEqual(standard.max.x);
    expect(back.z).toBeGreaterThanOrEqual(standard.min.z);
    expect(back.z).toBeLessThanOrEqual(standard.max.z);
    fish.dispose();
  });

  it('comes to rest on top of a rock placed under it, and sinks off it once it goes', async () => {
    const { fish, advance } = await shrimpTank();
    die(fish);
    advance(1);
    const { x, z } = locate(fish);
    const rock: Collider = {
      id: 'rock',
      kind: 'box',
      hard: true,
      center: [x, 0.1, z],
      halfExtents: [0.05, 0.05, 0.05],
      rotationY: 0,
      rounding: 0,
    };
    fish.setColliders([rock]);
    advance(20);
    const rest = locate(fish);
    expect(rest.y).toBeGreaterThan(0.15);
    expect(rest.y).toBeLessThan(0.15 + 0.12 * SHRIMP.size + 0.003);

    fish.setColliders([]);
    advance(STEP_S);
    const falling = locate(fish).y;
    expect(falling).toBeGreaterThan(rest.y - 0.003);
    advance(0.3);
    const lower = locate(fish).y;
    expect(lower).toBeLessThan(falling - 0.002);
    expect(lower).toBeGreaterThan(0.14);
    advance(5);
    expect(locate(fish).y).toBeLessThan(0.14);
    fish.dispose();
  });

  it('keeps its sinking speed when a rock is placed under it mid-fall', async () => {
    const { fish, scene, advance } = await shrimpTank();
    die(fish);
    advance(3);
    const before = drawnPosition(scene);
    advance(0.2);
    const at = drawnPosition(scene);
    fish.setColliders([
      {
        id: 'rock',
        kind: 'box',
        hard: true,
        center: [at.x, at.y - 0.08, at.z],
        halfExtents: [0.03, 0.02, 0.03],
        rotationY: 0,
        rounding: 0,
      },
    ]);
    advance(0.2);
    const after = drawnPosition(scene);
    const sinkingBefore = before.y - at.y;
    expect(sinkingBefore).toBeGreaterThan(0.001);
    expect(at.y - after.y).toBeGreaterThan(0.95 * sinkingBefore);
    advance(20);
    const rest = drawnPosition(scene).y;
    expect(rest).toBeGreaterThan(at.y - 0.06);
    expect(rest).toBeLessThan(at.y - 0.06 + 0.12 * SHRIMP.size + 0.003);
    fish.dispose();
  });

  it('keeps sinking, not jumping up, when a rock appears above it mid-fall', async () => {
    const { fish, scene, advance } = await shrimpTank();
    die(fish);
    advance(3);
    const before = drawnPosition(scene);
    advance(0.2);
    const at = drawnPosition(scene);
    fish.setColliders([
      {
        id: 'ledge',
        kind: 'box',
        hard: true,
        center: [at.x, at.y + 0.02, at.z],
        halfExtents: [0.03, 0.01, 0.03],
        rotationY: 0,
        rounding: 0,
      },
    ]);
    advance(STEP_S);
    expect(drawnPosition(scene).y).toBeLessThan(at.y);
    advance(0.2 - STEP_S);
    const after = drawnPosition(scene);
    expect(at.y - after.y).toBeGreaterThan(0.95 * (before.y - at.y));
    fish.dispose();
  });

  it('eases out of a climbing pose and lies along the glass, not into it', async () => {
    const onGlass = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -Math.PI / 2);
    const forward = new Vector3(0, 0, 1).applyQuaternion(onGlass);
    expect(forward.y).toBeCloseTo(1, 6);
    const back = waterBounds(DEFAULT_TANK).max.z - 0.004;
    const { fish, scene, advance } = await shrimpTank([
      0.1,
      0.25,
      back,
      onGlass.x,
      onGlass.y,
      onGlass.z,
      onGlass.w,
    ]);
    expect(drawnQuaternion(scene).angleTo(onGlass)).toBeLessThan(1e-3);

    die(fish);
    advance(STEP_S);
    expect(drawnQuaternion(scene).angleTo(onGlass)).toBeLessThan(0.05);
    advance(0.5);
    const easing = drawnQuaternion(scene).angleTo(onGlass);
    expect(easing).toBeGreaterThan(0.05);
    expect(easing).toBeLessThan(Math.PI / 2);

    advance(20);
    const lying = new Vector3(0, 0, 1).applyQuaternion(drawnQuaternion(scene));
    expect(Math.abs(lying.y)).toBeLessThan(1e-3);
    expect(Math.abs(lying.z)).toBeLessThan(1e-3);
    expect(locate(fish).z).toBeCloseTo(back, 2);
    fish.dispose();
  });

  it('holds still while photo mode pauses the sim, and goes on after', async () => {
    const { fish, scene, worker, photo, advance } = await shrimpTank([0.1, 0.25, 0, 0, 0, 0, 1]);
    photo.simPaused = true;
    advance(STEP_S);
    expect(worker.sent.at(-1)?.type).toBe('stop');

    die(fish);
    advance(STEP_S);
    const held = drawnPosition(scene);
    advance(2);
    expect(drawnPosition(scene).distanceTo(held)).toBe(0);

    photo.simPaused = false;
    advance(STEP_S);
    expect(worker.sent.at(-1)?.type).toBe('start');
    advance(2);
    expect(drawnPosition(scene).distanceTo(held)).toBeGreaterThan(0.01);
    fish.dispose();
  });
});

/** A betta drawn as one box, enough to place and draw it. */
function bettaModel(impostor: ImpostorAtlasInfo | null = null): FishModel {
  return {
    entry: {
      id: 'betta',
      kind: 'fish',
      species: 'betta',
      min: [-0.006, -0.015, -0.0365],
      max: [0.006, 0.011, 0.0365],
      standardLengthM: 0.073,
      standoff: null,
      lodFiles: [],
      sharperTextures: new Map(),
      shrimp: null,
      impostor,
    },
    tail: null,
    shell: null,
    textureSize: 1024,
    lods: [
      [
        {
          geometry: new BoxGeometry(0.012, 0.026, 0.073),
          source: new MeshStandardMaterial(),
          legPivots: [],
          mouth: false,
        },
      ],
    ],
  };
}

describe('FishSystem toys and display', () => {
  const BETTA = fishFixture(FISH_1, { species: 'betta', size: 0.06 });
  const STEP_S = 1 / 30;
  const MIRROR: SimToy = { kind: 'mirror', position: [0, 0.25, -0.2], normal: [0, 0, 1] };
  const AT = [0.1, 0.22, -0.12] as const;

  beforeEach(() => {
    FakeWorker.last = null;
    vi.stubGlobal('Worker', FakeWorker);
    vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')));
    vi.spyOn(FishAssetLoader.prototype, 'load').mockImplementation((assetId) =>
      assetId === 'betta' || assetId === 'royal-gramma'
        ? Promise.resolve(bettaModel())
        : Promise.reject(new Error('offline')),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  /** A saved tank with one betta, its world up; `snapshot` sends one sim step and draws it. */
  async function bettaTank(
    shown = BETTA,
    biome: 'freshwater' | 'reef' = 'freshwater',
    tier: Partial<TierSettings> | null = null,
  ) {
    const { engine, frames } = fakeEngine();
    if (tier !== null) {
      engine.quality.register = (name, apply) => {
        if (name === 'fish-lod') apply({ ...TIER_SETTINGS.low, ...tier }, 'low');
        return () => undefined;
      };
    }
    const interaction = new EventBus<InteractionEvents>();
    const start = FishSystem.create(engine, {
      tank: DEFAULT_TANK,
      assetRoot: '/assets/',
      biome: 'freshwater',
      interaction,
      seed: 7,
      signal: new AbortController().signal,
    });
    const worker = await initPosted();
    let answered = 0;
    let epoch = 0;
    const answer = (): void => {
      for (const { request, config } of worker.inits().slice(answered)) {
        epoch = request;
        worker.emit({
          type: 'ready',
          request,
          epoch: request,
          fishIds: config.fish.map((f) => f.id),
          stride: SNAPSHOT_STRIDE,
          stepHz: 30,
        });
      }
      answered = worker.inits().length;
    };
    answer();
    const fish = await start;
    const load = (): void =>
      fish.handle({
        type: 'tank:loaded',
        payload: {
          backgroundId: 'bg-fw-planted-stream',
          tankId: TANK_A,
          size: 'standard',
          biome,
          decorLayout: [],
          decorEdited: false,
          fish: [shown],
        },
      });
    const nextWorld = async (): Promise<void> => {
      const count = answered + 1;
      await vi.waitFor(() => {
        if (worker.inits().length < count) throw new Error('no new world yet');
      });
      answer();
      await fish.synced();
    };
    let tick = 0;
    const snapshot = (
      display: number,
      gillFlare: number,
      count = 1,
      state: FishState = FishState.Cruise,
    ): void => {
      const data = new Float32Array(SNAPSHOT_STRIDE * count);
      for (let i = 0; i < count; i++) {
        const o = i * SNAPSHOT_STRIDE;
        data.set([...AT, 0, 0, 0, 1], o);
        data[o + SnapshotField.State] = state;
        data[o + SnapshotField.Display] = display;
        data[o + SnapshotField.GillFlare] = gillFlare;
      }
      tick++;
      worker.emit({
        type: 'snapshot',
        epoch,
        tick,
        time: tick * STEP_S,
        buffer: data.buffer,
      });
      for (const frame of frames) frame(STEP_S, performance.now());
    };
    return {
      fish,
      engine,
      worker,
      load,
      nextWorld,
      snapshot,
      interaction,
      frames,
      epoch: () => epoch,
    };
  }

  it('sends the toys to the running world and again to every new one', async () => {
    const { fish, worker, load, nextWorld } = await bettaTank();
    fish.setToys([MIRROR]);
    expect(worker.sent.at(-1)).toEqual({ type: 'toys', toys: [MIRROR] });

    load();
    await nextWorld();
    const types = worker.sent.map((m) => m.type);
    const init = types.lastIndexOf('init');
    const resent = types.lastIndexOf('toys');
    expect(resent).toBeGreaterThan(init);
    expect(resent).toBeLessThan(types.lastIndexOf('start'));
    expect(worker.sent[resent]).toEqual({ type: 'toys', toys: [MIRROR] });

    fish.setToys([]);
    expect(worker.sent.at(-1)).toEqual({ type: 'toys', toys: [] });
    fish.handle({ type: 'tank:unloaded', payload: { tankId: TANK_A, reason: 'switch' } });
    fish.handle({ type: 'tank:none', payload: {} });
    await nextWorld();
    const after = worker.sent.map((m) => m.type);
    expect(after.lastIndexOf('toys')).toBeLessThan(after.lastIndexOf('init'));
    fish.dispose();
  });

  it('takes the sim clock from snapshots of the running world only', async () => {
    const { fish, worker, load, nextWorld, epoch, snapshot } = await bettaTank();
    load();
    await nextWorld();
    snapshot(0, 0);
    snapshot(0, 0);
    const running = fish.simTimeS;
    expect(running).toBeGreaterThan(0);
    worker.emit({
      type: 'snapshot',
      epoch: epoch() + 7,
      tick: 1,
      time: 0.01,
      buffer: new Float32Array(SNAPSHOT_STRIDE).buffer,
    });
    expect(fish.simTimeS).toBe(running);
    fish.dispose();
  });

  it('passes ball nudges of the current world on as velocity changes', async () => {
    const { fish, worker, epoch } = await bettaTank();
    const seen: BallNudge[] = [];
    const off = fish.onToyNudge((nudge) => seen.push(nudge));
    const nudge = { fishId: 'sim-1', toyId: 'ball', toy: 0, ix: 0.03, iz: -0.02 };
    worker.emit({ type: 'toyNudge', epoch: epoch(), tick: 1, nudges: [nudge] });
    worker.emit({ type: 'toyNudge', epoch: epoch() + 7, tick: 2, nudges: [nudge] });
    off();
    worker.emit({ type: 'toyNudge', epoch: epoch(), tick: 3, nudges: [nudge] });
    expect(seen).toEqual([{ toyId: 'ball', ix: 0.03, iz: -0.02 }]);
    fish.dispose();
  });

  it('tells where a shown swimming fish is by its server id', async () => {
    const { fish, load, nextWorld, snapshot } = await bettaTank();
    expect(fish.fishPoint(BETTA.id)).toBeNull();
    load();
    await nextWorld();
    snapshot(0, 0);
    snapshot(0, 0);
    const at = fish.fishPoint(BETTA.id);
    expect(at?.x).toBeCloseTo(AT[0], 6);
    expect(at?.y).toBeCloseTo(AT[1], 6);
    expect(at?.z).toBeCloseTo(AT[2], 6);
    expect(fish.fishPoint('nobody')).toBeNull();
    fish.dispose();
    expect(fish.fishPoint(BETTA.id)).toBeNull();
  });

  it("draws the sim's fin spread and gill flare, and lets them go when the fish dies", async () => {
    const written: InstanceValues[] = [];
    const write = FishInstanceData.prototype.write;
    vi.spyOn(FishInstanceData.prototype, 'write').mockImplementation(function (
      this: FishInstanceData,
      index,
      values,
    ) {
      written.push({ ...values });
      write.call(this, index, values);
    });
    const { fish, load, nextWorld, snapshot } = await bettaTank();
    load();
    await nextWorld();
    snapshot(0, 0);
    snapshot(0, 0);
    expect(written.at(-1)).toMatchObject({ display: 0, gillFlare: 0 });
    snapshot(0.8, 0.6);
    snapshot(0.8, 0.6);
    snapshot(0.8, 0.6);
    expect(written.at(-1)?.display).toBeCloseTo(0.8, 6);
    expect(written.at(-1)?.gillFlare).toBeCloseTo(0.6, 6);

    fish.handle({
      type: 'tank:fish-died',
      payload: {
        tankId: TANK_A,
        fish: { ...BETTA, status: 'dead', diedAt: '2026-10-16T00:00:00.000Z' },
      },
    });
    const closing: number[] = [];
    for (let i = 0; i < Math.ceil(CARCASS.limpS / STEP_S) + 2; i++) {
      snapshot(0.8, 0.6);
      closing.push(written.at(-1)?.display ?? NaN);
    }
    expect(closing[0]).toBeGreaterThan(0.5);
    for (let i = 1; i < closing.length; i++) {
      expect(closing[i]).toBeLessThanOrEqual(closing[i - 1] ?? NaN);
    }
    expect(written.at(-1)).toMatchObject({ display: 0, gillFlare: 0 });
    fish.dispose();
  });

  it("follows the sim's own easing as a living fish closes its fins in the same world", async () => {
    const written: InstanceValues[] = [];
    const write = FishInstanceData.prototype.write;
    vi.spyOn(FishInstanceData.prototype, 'write').mockImplementation(function (
      this: FishInstanceData,
      index,
      values,
    ) {
      written.push({ ...values });
      write.call(this, index, values);
    });
    const { fish, load, nextWorld, snapshot } = await bettaTank();
    load();
    await nextWorld();
    for (let i = 0; i < 3; i++) snapshot(1, 1);
    snapshot(0.3, 0.2);
    snapshot(0.3, 0.2);
    expect(written.at(-1)?.display).toBeCloseTo(0.3, 6);
    expect(written.at(-1)?.gillFlare).toBeCloseTo(0.2, 6);
    fish.dispose();
  });

  it('closes the fins over a moment when a rebuilt world restarts them at 0', async () => {
    const written: { data: FishInstanceData; values: InstanceValues }[] = [];
    const write = FishInstanceData.prototype.write;
    vi.spyOn(FishInstanceData.prototype, 'write').mockImplementation(function (
      this: FishInstanceData,
      index,
      values,
    ) {
      written.push({ data: this, values: { ...values } });
      write.call(this, index, values);
    });
    const { fish, worker, load, nextWorld, snapshot } = await bettaTank();
    load();
    await nextWorld();
    for (let i = 0; i < 3; i++) snapshot(1, 1);
    const betta = written.at(-1)?.data;
    const bettaDisplay = (): number =>
      written.filter((w) => w.data === betta).at(-1)?.values.display ?? NaN;
    const gramma = fishFixture(FISH_2, { species: 'royal-gramma', size: 0.06 });
    fish.handle({
      type: 'tank:fish-added',
      payload: { tankId: TANK_A, fish: gramma, acclimate: false },
    });
    const request = await vi.waitFor(() => {
      const add = worker.sent.find((m) => m.type === 'addFish');
      if (add === undefined || !('request' in add)) throw new Error('no addFish yet');
      return add.request;
    });
    worker.emit({ type: 'error', request, message: 'no room' });
    await nextWorld();
    snapshot(0, 0, 2);
    snapshot(0, 0, 2);
    expect(bettaDisplay()).toBeGreaterThan(0.8);
    expect(bettaDisplay()).toBeLessThan(1);
    for (let i = 0; i < Math.ceil(CARCASS.limpS / STEP_S) + 2; i++) snapshot(0, 0, 2);
    expect(bettaDisplay()).toBe(0);
    snapshot(0.4, 0.4, 2);
    snapshot(0.4, 0.4, 2);
    snapshot(0.2, 0.2, 2);
    snapshot(0.2, 0.2, 2);
    expect(bettaDisplay()).toBeCloseTo(0.2, 6);
    fish.dispose();
  });

  it('keeps a fish held mid-peck where it was rather than creeping along the jab', async () => {
    const { fish, engine, worker, load, nextWorld, snapshot, frames } = await bettaTank();
    load();
    await nextWorld();
    const drawnZ = (): number => {
      let mesh: InstancedMesh | null = null;
      engine.scene.traverse((o) => {
        if (mesh === null && o instanceof InstancedMesh && o.name.endsWith(':lod0')) mesh = o;
      });
      if (mesh === null) throw new Error('no betta mesh in the scene');
      const matrix = new Matrix4();
      (mesh as InstancedMesh).getMatrixAt(0, matrix);
      return new Vector3().setFromMatrixPosition(matrix).z;
    };
    let jab = 0;
    for (let i = 0; i < 30 && jab < 1e-4; i++) {
      snapshot(0, 0, 1, FishState.Clean);
      jab = drawnZ() - AT[2];
    }
    expect(jab).toBeGreaterThan(1e-4);

    const inits = worker.inits().length;
    fish.handle({
      type: 'tank:fish-added',
      payload: {
        tankId: TANK_A,
        fish: fishFixture(FISH_2, { species: 'royal-gramma', size: 0.06 }),
        acclimate: false,
      },
    });
    const request = await vi.waitFor(() => {
      const add = worker.sent.find((m) => m.type === 'addFish');
      if (add === undefined || !('request' in add)) throw new Error('no addFish yet');
      return add.request;
    });
    worker.emit({ type: 'error', request, message: 'no room' });
    await vi.waitFor(() => {
      if (worker.inits().length === inits) throw new Error('the world was not rebuilt yet');
    });
    const held: number[] = [];
    for (let i = 0; i < 144; i++) {
      for (const frame of frames) frame(1 / 144, performance.now());
      held.push(drawnZ() - AT[2]);
    }
    expect(Math.max(...held)).toBeLessThanOrEqual(PECK_JAB_BODY_LENGTHS * 0.06 + 1e-6);
    expect(held.at(-1)).toBeCloseTo(0, 6);
    fish.dispose();
  });

  it.each([
    ['betta', BETTA, 'freshwater', false],
    [
      'royal gramma, whose territorial display the sim reports but no mesh shows',
      fishFixture(FISH_1, { species: 'royal-gramma', size: 0.06 }),
      'reef',
      true,
    ],
  ] as const)(
    'draws a distant %s in display as an impostor only without the flare trait',
    async (_, shown, biome, far) => {
      const atlas: ImpostorAtlasInfo = {
        grid: 8,
        frameSize: 64,
        pivot: [0, 0, 0],
        radius: 0.04,
        albedoFile: 'atlas-albedo.ktx2',
        normalFile: 'atlas-normal.ktx2',
      };
      vi.mocked(FishAssetLoader.prototype.load).mockResolvedValue(bettaModel(atlas));
      vi.spyOn(KTX2Loader.prototype, 'loadAsync').mockImplementation(() =>
        Promise.resolve(new CompressedTexture([], 1, 1)),
      );
      const impostorWrites = vi.spyOn(ImpostorInstanceData.prototype, 'write');
      const meshWrites = vi.spyOn(FishInstanceData.prototype, 'write');
      const tier = {
        fishLod: { midDistance: 0.01, impostorDistance: 0.02 },
        fishImpostors: { fullMeshes: 0 },
      };
      const { fish, load, nextWorld, snapshot } = await bettaTank(shown, biome, tier);
      load();
      await nextWorld();
      snapshot(0, 0);
      await vi.waitFor(() => {
        snapshot(0, 0);
        if (impostorWrites.mock.calls.length === 0) throw new Error('no impostor drawn yet');
      });
      for (let i = 0; i < 3; i++) snapshot(0.8, 0.6);
      impostorWrites.mockClear();
      meshWrites.mockClear();
      snapshot(0.8, 0.6);
      expect(impostorWrites.mock.calls.length > 0).toBe(far);
      expect(meshWrites.mock.calls.length > 0).toBe(!far);
      fish.dispose();
    },
  );

  it.each([
    ['betta', BETTA, 'freshwater', true],
    [
      'royal gramma, territorial without the flare trait',
      fishFixture(FISH_1, { species: 'royal-gramma', size: 0.06 }),
      'reef',
      false,
    ],
  ] as const)('builds the display deformation for the %s: %s', async (_, shown, biome, flares) => {
    const { fish, engine, load, nextWorld, snapshot } = await bettaTank(shown, biome);
    load();
    await nextWorld();
    snapshot(0, 0);
    const materials: FishMaterial[] = [];
    engine.scene.traverse((object) => {
      if (object instanceof InstancedMesh && object.material instanceof FishMaterial) {
        materials.push(object.material);
      }
    });
    expect(materials.length).toBeGreaterThan(0);
    for (const material of materials) {
      let readsDisplay = false;
      material.deformed.position.traverse((n) => {
        const split = n as Node & { isSplitNode?: boolean; components?: string; node?: Node };
        const buffer = split.node as (Node & { bufferOffset?: number }) | undefined;
        if (
          split.isSplitNode === true &&
          split.components === 'xyzw'[InstanceSlot.Display % 4] &&
          buffer?.bufferOffset === InstanceSlot.Display - (InstanceSlot.Display % 4)
        ) {
          readsDisplay = true;
        }
      });
      expect(readsDisplay).toBe(flares);
    }
    fish.dispose();
  });

  describe('replay fast-forward', () => {
    const steps = (worker: FakeWorker): number[] =>
      worker.sent
        .filter((m) => m.type === 'step')
        .map((m) => (m as unknown as { steps: number }).steps);

    it('asks the worker for the extra steps the time scale owes, one request at a time', async () => {
      const { fish, worker, load, nextWorld, snapshot, interaction, frames } = await bettaTank();
      load();
      await nextWorld();
      snapshot(0, 0);
      interaction.emit('replay:time-scale', { scale: 20 });
      for (const frame of frames) frame(0.05, performance.now());
      expect(steps(worker)).toEqual([28]);

      for (const frame of frames) frame(0.05, performance.now());
      expect(steps(worker)).toEqual([28]);

      snapshot(0, 0);
      expect(steps(worker)).toHaveLength(2);
      fish.dispose();
    });

    it('sends nothing at normal speed', async () => {
      const { fish, worker, load, nextWorld, snapshot, interaction, frames } = await bettaTank();
      load();
      await nextWorld();
      snapshot(0, 0);
      interaction.emit('replay:time-scale', { scale: 1 });
      for (const frame of frames) frame(0.05, performance.now());
      expect(steps(worker)).toEqual([]);
      fish.dispose();
    });

    it('caps the owed steps after a long frame so a slow worker cannot build a backlog', async () => {
      const { fish, worker, load, nextWorld, snapshot, interaction, frames } = await bettaTank();
      load();
      await nextWorld();
      snapshot(0, 0);
      interaction.emit('replay:time-scale', { scale: 20 });
      for (const frame of frames) frame(0.05, performance.now());
      for (let i = 0; i < 20; i++) for (const frame of frames) frame(1, performance.now());
      const before = steps(worker).length;
      snapshot(0, 0);
      const sent = steps(worker).slice(before);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toBeLessThanOrEqual(60);
      fish.dispose();
    });

    it('treats a non-finite scale as normal speed instead of throwing in the worker', async () => {
      const { fish, worker, load, nextWorld, snapshot, interaction, frames } = await bettaTank();
      load();
      await nextWorld();
      snapshot(0, 0);
      interaction.emit('replay:time-scale', { scale: Number.NaN });
      for (const frame of frames) frame(0.05, performance.now());
      expect(steps(worker)).toEqual([]);
      fish.dispose();
    });
  });
});
