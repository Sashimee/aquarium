import { FileLoader, LoadingManager, REVISION, type WebGPURenderer } from 'three/webgpu';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import basisTranscoderWasm from 'three/addons/libs/basis/basis_transcoder.wasm?url';

/**
 * Emitted at build time by ktx2WorkerPlugin (vite.config.ts). A same-origin worker takes the CSP
 * of its own response, so the API can allow 'unsafe-eval' for this file alone: the basis
 * transcoder's embind glue calls new Function, which a blob: worker would need the page to allow.
 */
export const KTX2_WORKER_URL = `/ktx2-worker.js?v=${REVISION}`;

/** Points the transcoder binary at the bundled copy. */
export function bundledTranscoderUrl(url: string): string {
  if (url.endsWith('basis_transcoder.wasm')) return basisTranscoderWasm;
  return url;
}

/**
 * What users of the shared loader may do with it: load textures. The narrowing is type-level;
 * it keeps callers from disposing the engine's loader by accident, not by force.
 */
export type Ktx2Textures = Pick<KTX2Loader, 'load' | 'loadAsync'>;

export interface SharedKtx2 {
  readonly loader: KTX2Loader;
  dispose(): void;
}

function disposedError(what: string): Error {
  return new Error(`KTX2: cannot load ${what}, the shared loader was disposed`);
}

function refuse(what: string, onError: ((err: unknown) => void) | undefined): void {
  if (!onError) throw disposedError(what);
  onError(disposedError(what));
}

/**
 * three's dispose() revokes the transcoder's blob URL and empties the worker pool without
 * settling what was queued in it, so every load still in the pipeline would hang, and a
 * transcode posted after dispose would start a worker nobody terminates. This loader refuses
 * new work, rejects pending work, and leaves the pool unable to create workers.
 */
class DisposableKtx2Loader extends KTX2Loader {
  private disposed = false;
  private initialized: Promise<void> | null = null;
  private readonly pending = new Set<(error: Error) => void>();

  override load(...args: Parameters<KTX2Loader['load']>): void {
    if (this.disposed) refuse(args[0], args[3]);
    else super.load(...args);
  }

  override parse(...[buffer, onLoad, onError]: Parameters<KTX2Loader['parse']>): void {
    if (this.disposed) {
      refuse('a downloaded texture', onError);
      return;
    }
    // After 'loaded', three still routes an exception thrown by onLoad to onError; keep that.
    let state: 'pending' | 'loaded' | 'failed' = 'pending';
    const fail = (error: unknown): void => {
      if (state === 'failed') return;
      state = 'failed';
      this.pending.delete(fail);
      onError?.(error);
    };
    this.pending.add(fail);
    try {
      super.parse(
        buffer,
        (texture) => {
          if (state !== 'pending') return;
          state = 'loaded';
          this.pending.delete(fail);
          onLoad?.(texture);
        },
        fail,
      );
    } catch (error) {
      this.pending.delete(fail);
      throw error;
    }
  }

  /**
   * Replaces three's init(), which also fetches the glue script to build a blob worker: the worker
   * file already carries the glue, so only the binary is fetched. A transcoder that arrives after
   * dispose would otherwise install a fresh worker creator.
   */
  override init(): Promise<void> {
    this.initialized ??= this.loadTranscoder();
    return this.initialized;
  }

  private async loadTranscoder(): Promise<void> {
    const binaryLoader = new FileLoader(this.manager)
      .setPath(this.transcoderPath)
      .setWithCredentials(this.withCredentials)
      .setResponseType('arraybuffer');
    const binary = await binaryLoader.loadAsync('basis_transcoder.wasm');
    if (this.disposed) throw disposedError('a texture');
    if (typeof binary === 'string') throw new Error('KTX2: the transcoder binary loaded as text');
    this.transcoderBinary = binary;
    this.workerPool.setWorkerCreator(() => {
      const worker = new Worker(KTX2_WORKER_URL);
      const transcoderBinary = binary.slice(0);
      worker.postMessage({ type: 'init', config: this.workerConfig, transcoderBinary }, [
        transcoderBinary,
      ]);
      return worker;
    });
  }

  override dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.workerPool.setWorkerCreator(() => {
      throw disposedError('a texture');
    });
    // Not super.dispose(): it decrements three's count of active loaders, which only three's own
    // init() increments, so the count would go negative and hide its duplicate-loader warning.
    // The rest of it is this, since workerSourceURL stays '' without three's init().
    this.workerPool.dispose();
    const thrown: unknown[] = [];
    for (const fail of [...this.pending]) {
      try {
        fail(disposedError('a texture'));
      } catch (error) {
        thrown.push(error);
      }
    }
    if (thrown.length > 0) {
      throw new AggregateError(thrown, `KTX2: ${thrown.length} error callback(s) threw on dispose`);
    }
  }
}

/**
 * The renderer's one KTX2 transcoder and worker pool. Every texture load goes through it: each
 * further KTX2Loader would fetch and compile the transcoder again and start its own workers.
 */
export function createSharedKtx2(renderer: WebGPURenderer): SharedKtx2 {
  const manager = new LoadingManager();
  manager.setURLModifier(bundledTranscoderUrl);
  const loader = new DisposableKtx2Loader(manager)
    .setTranscoderPath('basis/')
    .detectSupport(renderer);
  return {
    loader,
    dispose() {
      manager.abort();
      loader.dispose();
    },
  };
}

/**
 * `loader` with `rewrite` applied to every URL loaded through the view, and to nothing else.
 * State and workers stay on `loader`, so one caller can pick texture variants without a second
 * transcoder and without affecting other callers' loads. The view is a whole KTX2Loader so that
 * GLTFLoader accepts it, but its dispose() throws: only the owner of `loader` may dispose it.
 */
export function rewritingKtx2Loader(
  loader: Ktx2Textures,
  rewrite: (url: string) => string,
): KTX2Loader {
  if (!(loader instanceof KTX2Loader)) {
    throw new TypeError('rewritingKtx2Loader: expected the shared KTX2Loader (engine.ktx2)');
  }
  const load: KTX2Loader['load'] = (url, onLoad, onProgress, onError) => {
    loader.load(rewrite(url), onLoad, onProgress, onError);
  };
  const dispose = (): never => {
    throw new Error('KTX2: a view cannot dispose the shared loader; the engine owns it');
  };
  return new Proxy(loader, {
    get: (target, key, receiver) => {
      if (key === 'load') return load;
      if (key === 'dispose') return dispose;
      return Reflect.get(target, key, receiver);
    },
  });
}

/**
 * The shared loader in the shape GLTFLoader.setKTX2Loader takes, unable to dispose it, for loads
 * of the textures a glTF references as they are. ModelLibrary and FishAssetLoader use
 * rewritingKtx2Loader to swap textures to 2k on request without touching anyone else's loads.
 */
export function gltfKtx2Loader(loader: Ktx2Textures): KTX2Loader {
  return rewritingKtx2Loader(loader, (url) => url);
}
