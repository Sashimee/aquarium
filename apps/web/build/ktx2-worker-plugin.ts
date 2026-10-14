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
  return {
    name: 'aquarium:ktx2-worker',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: FILE_NAME, source: workerSource() });
    },
    configureServer(server) {
      server.middlewares.use(`/${FILE_NAME}`, (_req, res) => {
        res.setHeader('content-type', 'text/javascript');
        res.end(workerSource());
      });
    },
  };
}
