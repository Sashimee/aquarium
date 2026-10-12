import type { Tier, TierChangeReason } from './quality/tiers';

export type BackendKind = 'webgpu' | 'webgl2';

export interface EngineStats {
  fps: number;
  frameMs: number;
  gpuMs: number | null;
  drawCalls: number;
  triangles: number;
  tier: Tier;
}

export interface EngineEvents {
  'engine:ready': { backend: BackendKind; tier: Tier; gpuTiming: boolean };
  'engine:error': { message: string; cause?: unknown };
  'engine:stats': EngineStats;
  'quality:tier-changed': { from: Tier | null; to: Tier; reason: TierChangeReason };
}

type Handler<T> = (payload: T) => void;

export class EventBus<Events extends object> {
  private readonly handlers = new Map<keyof Events, Set<Handler<never>>>();

  on<K extends keyof Events>(type: K, handler: Handler<Events[K]>): () => void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(handler);
    return () => this.off(type, handler);
  }

  once<K extends keyof Events>(type: K, handler: Handler<Events[K]>): () => void {
    const off = this.on(type, (payload) => {
      off();
      handler(payload);
    });
    return off;
  }

  off<K extends keyof Events>(type: K, handler: Handler<Events[K]>): void {
    const set = this.handlers.get(type);
    if (!set) return;
    set.delete(handler);
    if (set.size === 0) this.handlers.delete(type);
  }

  emit<K extends keyof Events>(type: K, payload: Events[K]): void {
    const set = this.handlers.get(type);
    if (!set) return;
    for (const handler of [...set] as Handler<Events[K]>[]) handler(payload);
  }

  listenerCount(type: keyof Events): number {
    return this.handlers.get(type)?.size ?? 0;
  }

  clear(): void {
    this.handlers.clear();
  }
}

export type EngineEventBus = EventBus<EngineEvents>;
