import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { Plugin } from 'vite';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';

// three's types omit these statics; the loader reads the same ones to build its blob worker.
const Loader = KTX2Loader as unknown as {
  BasisWorker: () => void;
  EngineFormat: unknown;
  EngineType: unknown;
  TranscoderFormat: unknown;
  BasisFormat: unknown;
};

const FILE_NAME = 'ktx2-worker.js';
const UNUSED_TRANSCODER_GLUE = /^assets\/basis_transcoder-[\w-]+\.js$/;

function workerSource(): string {
  const require = createRequire(import.meta.url);
  const transcoder = readFileSync(
    require.resolve('three/addons/libs/basis/basis_transcoder.js'),
    'utf8',
  );
  const worker = Loader.BasisWorker.toString();
  // Same layout KTX2Loader.init() builds for its blob worker.
  return [
    `let _EngineFormat = ${JSON.stringify(Loader.EngineFormat)}`,
    `let _EngineType = ${JSON.stringify(Loader.EngineType)}`,
    `let _TranscoderFormat = ${JSON.stringify(Loader.TranscoderFormat)}`,
    `let _BasisFormat = ${JSON.stringify(Loader.BasisFormat)}`,
    transcoder,
    worker.substring(worker.indexOf('{') + 1, worker.lastIndexOf('}')),
  ].join('\n');
}

export function ktx2WorkerPlugin(): Plugin {
  const source = workerSource();
  // three's REVISION does not change across patch releases, so only the content can version the URL.
  const hash = createHash('sha256').update(source).digest('hex').slice(0, 12);
  return {
    name: 'aquarium:ktx2-worker',
    config() {
      return { define: { __KTX2_WORKER_HASH__: JSON.stringify(hash) } };
    },
    enforce: 'post',
    generateBundle(_options, bundle) {
      // KTX2Loader's module-level new URL() makes the bundler emit the glue script, but the shared
      // loader never fetches it: bundledTranscoderUrl serves the worker file instead.
      const glue = Object.keys(bundle).filter((name) => UNUSED_TRANSCODER_GLUE.test(name));
      if (glue.length === 0) {
        this.error(
          'ktx2-worker: no basis_transcoder-*.js asset to strip; three renamed it, update UNUSED_TRANSCODER_GLUE',
        );
      }
      for (const name of glue) Reflect.deleteProperty(bundle, name);
      this.emitFile({ type: 'asset', fileName: FILE_NAME, source });
    },
    configureServer(server) {
      server.middlewares.use(`/${FILE_NAME}`, (_req, res) => {
        res.setHeader('content-type', 'text/javascript');
        res.end(source);
      });
    },
  };
}
