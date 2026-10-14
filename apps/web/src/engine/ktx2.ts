import { LoadingManager, type WebGPURenderer } from 'three/webgpu';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import basisTranscoderJs from 'three/addons/libs/basis/basis_transcoder.js?url';
import basisTranscoderWasm from 'three/addons/libs/basis/basis_transcoder.wasm?url';

/** Points the transcoder at the bundled copy. */
export function bundledTranscoderUrl(url: string): string {
  if (url.endsWith('basis_transcoder.js')) return basisTranscoderJs;
  if (url.endsWith('basis_transcoder.wasm')) return basisTranscoderWasm;
  return url;
}

/** What users of the shared loader may do with it: load textures, never dispose it. */
export type Ktx2Textures = Pick<KTX2Loader, 'load' | 'loadAsync'>;

export interface SharedKtx2 {
  readonly loader: KTX2Loader;
  dispose(): void;
}

function refuse(what: string, onError: ((err: unknown) => void) | undefined): void {
  const error = new Error(`KTX2: cannot load ${what}, the shared loader was disposed`);
  if (!onError) throw error;
  onError(error);
}

/**
 * dispose() revokes the transcoder's blob URL and terminates the worker pool, so a later load
 * would start a worker that never answers. Both paths into the pool refuse instead.
 */
class DisposableKtx2Loader extends KTX2Loader {
  private disposed = false;

  override load(...args: Parameters<KTX2Loader['load']>): void {
    if (this.disposed) refuse(args[0], args[3]);
    else super.load(...args);
  }

  override parse(...args: Parameters<KTX2Loader['parse']>): void {
    if (this.disposed) refuse('a downloaded texture', args[2]);
    else super.parse(...args);
  }

  override dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    super.dispose();
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

/** The shared loader in the shape GLTFLoader.setKTX2Loader takes, unable to dispose it. */
export function gltfKtx2Loader(loader: Ktx2Textures): KTX2Loader {
  return rewritingKtx2Loader(loader, (url) => url);
}
