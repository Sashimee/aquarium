import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Plugin } from 'vite';

const PLACEHOLDER = '__BUILD_ID__';

/** Bundle file names are content-hashed, so the id changes exactly when the shipped code does. */
export function buildId(fileNames: readonly string[]): string {
  return createHash('sha256')
    .update([...fileNames].sort().join('\n'))
    .digest('hex')
    .slice(0, 12);
}

export function stampWorker(source: string, id: string): string {
  if (!source.includes(PLACEHOLDER)) {
    throw new Error(
      `sw.js has no ${PLACEHOLDER} placeholder to stamp, so its caches would never roll over.`,
    );
  }
  return source.replaceAll(PLACEHOLDER, id);
}

export function swBuildIdPlugin(): Plugin {
  let outDir = '';
  return {
    name: 'aquarium:sw-build-id',
    apply: 'build',
    configResolved(config) {
      outDir = join(config.root, config.build.outDir);
    },
    writeBundle(_options, bundle) {
      const file = join(outDir, 'sw.js');
      writeFileSync(file, stampWorker(readFileSync(file, 'utf8'), buildId(Object.keys(bundle))));
    },
  };
}
