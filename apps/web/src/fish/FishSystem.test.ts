import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Scene } from 'three/webgpu';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import type { Engine } from '../engine/Engine';
import { EventBus, type EngineEvents } from '../engine/events';
import { DEFAULT_TANK } from '../engine/tank/dimensions';
import type { InteractionEvents } from '../interaction/events';
import { FishSystem } from './FishSystem';
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
});
