import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BoxGeometry,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  Quaternion,
  Scene,
  Vector3,
} from 'three/webgpu';
import { SNAPSHOT_STRIDE } from '@aquarium/sim';
import type { Collider } from '@aquarium/shared';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import type { Engine } from '../engine/Engine';
import { EventBus, type EngineEvents } from '../engine/events';
import { DEFAULT_TANK, waterBounds } from '../engine/tank/dimensions';
import type { InteractionEvents } from '../interaction/events';
import { FISH_1, TANK_A, fishFixture } from '../sync/fixtures';
import type { FishAssetEntry } from './assetIndex';
import { FishAssetLoader, type FishModel } from './assets';
import { batchLocomotion, FishSystem } from './FishSystem';
import { renderProfile, swimModeFor } from './profiles';
import type { PickRay } from './start';
import { SWIM_MODES } from './swim';
import type { TailRig } from './walk';
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

function fakeEngine(): { engine: Engine; errors: string[]; frames: FrameListener[] } {
  const events = new EventBus<EngineEvents>();
  const errors: string[] = [];
  const frames: FrameListener[] = [];
  events.on('engine:error', ({ message }) => errors.push(message));
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
    sceneRevision: 0,
    caustics: { lightDirection: new Vector3(0, -1, 0), hoodLight: () => null },
  };
  return { engine: engine as unknown as Engine, errors, frames };
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
        tankId: TANK_A,
        biome: 'freshwater',
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
});

describe('batchLocomotion', () => {
  const shrimp = { hinge: { y: 0, z: 0.002 }, telsonZ: -0.016, legPairs: 5 };
  const tail = { hinge: shrimp.hinge, tip: { y: -0.003, z: -0.016, share: 1 }, bodyLength: 0.03 };
  function model(
    rig: FishAssetEntry['shrimp'],
    tailRig: TailRig | null = rig === null ? null : tail,
  ): Pick<FishModel, 'entry' | 'tail'> {
    return {
      entry: {
        id: 'model',
        kind: rig === null ? 'fish' : 'shrimp',
        species: 'species',
        min: [-0.01, -0.005, -0.016],
        max: [0.01, 0.004, 0.02],
        standardLengthM: 0.03,
        lodFiles: ['lod0.glb'],
        sharperTextures: new Map(),
        shrimp: rig,
      },
      tail: tailRig,
    };
  }

  it("swims a finned species in its own mode, shaped by the species' profile", () => {
    const profile = renderProfile('neon-tetra');
    expect(batchLocomotion(model(null), 'subcarangiform', profile)).toEqual({
      kind: 'swim',
      mode: swimModeFor(SWIM_MODES.subcarangiform, profile),
    });
  });

  it('walks a pleopod species on its shrimp rig and tail', () => {
    const profile = renderProfile('cherry-shrimp');
    expect(batchLocomotion(model(shrimp), 'pleopod', profile)).toEqual({
      kind: 'walk',
      shrimp,
      tail,
    });
  });

  it('refuses a walker model without a tail rig', () => {
    const profile = renderProfile('cherry-shrimp');
    expect(() => batchLocomotion(model(shrimp, null), 'pleopod', profile)).toThrow(
      /needs a shrimp model/,
    );
  });

  it('refuses a walking species whose model has no shrimp rig', () => {
    const profile = renderProfile('cherry-shrimp');
    expect(() => batchLocomotion(model(null), 'pleopod', profile)).toThrow(/needs a shrimp model/);
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
      lodFiles: [],
      sharperTextures: new Map(),
      shrimp: { hinge: { y: 0, z: 0 }, telsonZ: -0.0125, legPairs: 5 },
    },
    tail: { hinge: { y: 0, z: 0 }, tip: { y: -0.004, z: -0.0125, share: 1 }, bodyLength: 0.025 },
    textureSize: 1024,
    lods: [
      [
        {
          geometry: new BoxGeometry(0.008, 0.008, 0.025),
          source: new MeshStandardMaterial(),
          legPivots: [],
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
    advance(seconds: number): void;
  }

  /**
   * A saved freshwater tank holding one cherry shrimp, drawn for half a second: in its bag, or
   * out in the tank where the sim holds it at `climbing` (position, then quaternion).
   */
  async function shrimpTank(climbing: readonly number[] | null = null): Promise<ShrimpTank> {
    const { engine, frames } = fakeEngine();
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
        tankId: TANK_A,
        biome: 'freshwater',
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
    return { fish, scene: engine.scene, advance };
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
});
