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

export interface SharedKtx2 {
  readonly loader: KTX2Loader;
  dispose(): void;
}

/**
 * The renderer's one KTX2 transcoder and worker pool. Every texture load goes through it: each
 * further KTX2Loader would fetch and compile the transcoder again and start its own workers.
 */
export function createSharedKtx2(renderer: WebGPURenderer): SharedKtx2 {
  const manager = new LoadingManager();
  manager.setURLModifier(bundledTranscoderUrl);
  const loader = new KTX2Loader(manager).setTranscoderPath('basis/').detectSupport(renderer);
  let disposed = false;
  return {
    loader,
    dispose() {
      if (disposed) return;
      disposed = true;
      manager.abort();
      loader.dispose();
    },
  };
}

/**
 * `loader` with `rewrite` applied to every URL loaded through the view, and to nothing else.
 * State and workers stay on `loader`, so one caller can pick texture variants without a second
 * transcoder and without affecting other callers' loads.
 */
export function rewritingKtx2Loader(
  loader: KTX2Loader,
  rewrite: (url: string) => string,
): KTX2Loader {
  const load: KTX2Loader['load'] = (url, onLoad, onProgress, onError) => {
    loader.load(rewrite(url), onLoad, onProgress, onError);
  };
  return new Proxy(loader, {
    get: (target, key, receiver) => (key === 'load' ? load : Reflect.get(target, key, receiver)),
  });
}
