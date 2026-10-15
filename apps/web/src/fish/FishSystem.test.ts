import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Scene } from 'three/webgpu';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import type { Engine } from '../engine/Engine';
import { EventBus, type EngineEvents } from '../engine/events';
import { DEFAULT_TANK } from '../engine/tank/dimensions';
import type { InteractionEvents } from '../interaction/events';
import { FISH_1, TANK_A, fishFixture } from '../sync/fixtures';
import type { FishAssetEntry } from './assetIndex';
import { batchLocomotion, FishSystem } from './FishSystem';
import { renderProfile, swimModeFor } from './profiles';
import { SWIM_MODES } from './swim';
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

function fakeEngine(): { engine: Engine; errors: string[] } {
  const events = new EventBus<EngineEvents>();
  const errors: string[] = [];
  events.on('engine:error', ({ message }) => errors.push(message));
  const engine = {
    scene: new Scene(),
    ktx2: new KTX2Loader(),
    events,
    daylight: 1,
    disposed: false,
    quality: { tier: 'medium', register: () => () => undefined },
    onFrame: () => () => undefined,
  };
  return { engine: engine as unknown as Engine, errors };
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
  function entry(rig: FishAssetEntry['shrimp']): FishAssetEntry {
    return {
      id: 'model',
      kind: rig === null ? 'fish' : 'shrimp',
      species: 'species',
      min: [-0.01, -0.005, -0.016],
      max: [0.01, 0.004, 0.02],
      standardLengthM: 0.03,
      lodFiles: ['lod0.glb'],
      sharperTextures: new Map(),
      shrimp: rig,
    };
  }

  it("swims a finned species in its own mode, shaped by the species' profile", () => {
    const profile = renderProfile('neon-tetra');
    expect(batchLocomotion(entry(null), 'subcarangiform', profile)).toEqual({
      kind: 'swim',
      mode: swimModeFor(SWIM_MODES.subcarangiform, profile),
    });
  });

  it('walks a pleopod species on its shrimp rig', () => {
    const profile = renderProfile('cherry-shrimp');
    expect(batchLocomotion(entry(shrimp), 'pleopod', profile)).toEqual({ kind: 'walk', shrimp });
  });

  it('refuses a walking species whose model has no shrimp rig', () => {
    const profile = renderProfile('cherry-shrimp');
    expect(() => batchLocomotion(entry(null), 'pleopod', profile)).toThrow(/needs a shrimp model/);
  });
});
