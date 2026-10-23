import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Plugin } from 'vite';

const PLACEHOLDER = '__BUILD_ID__';
// Parses as an array so an unstamped worker is still valid JS.
const EMITTED_PLACEHOLDER = "['__EMITTED_ASSETS__']";

/** Paths the worker precaches, read from its own SHELL list so the two cannot drift apart. */
export function shellPaths(source: string): string[] {
  const list = /const SHELL = \[([^\]]*)\]/.exec(source)?.[1];
  const paths = [...(list ?? '').matchAll(/'(\/[^']+)'/g)].map((match) => match[1] as string);
  if (!paths.length) {
    throw new Error('sw.js has no SHELL list of absolute paths, so its precache cannot be hashed.');
  }
  return paths;
}

/** Hashes names and contents, so editing any file the worker caches rolls the caches over. */
export function buildId(files: Readonly<Record<string, string | Uint8Array>>): string {
  const hash = createHash('sha256');
  for (const name of Object.keys(files).sort()) {
    hash
      .update(`${name}\0`)
      .update(files[name] as string | Uint8Array)
      .update('\0');
  }
  return hash.digest('hex').slice(0, 12);
}

export function buildIdForOutput(
  outDir: string,
  bundleNames: readonly string[],
  workerSource: string,
): string {
  const files: Record<string, string | Uint8Array> = { 'sw.js': workerSource };
  for (const name of bundleNames) files[`bundle:${name}`] = '';
  for (const path of shellPaths(workerSource)) files[path] = readFileSync(join(outDir, path));
  return buildId(files);
}

/** Request paths of the content-hashed files Vite emitted, as the worker's cache-first set. */
export function emittedPaths(bundleNames: readonly string[]): string[] {
  return bundleNames.filter((name) => name.startsWith('assets/')).map((name) => `/${name}`);
}

export function stampWorker(source: string, id: string, emitted: readonly string[]): string {
  for (const placeholder of [PLACEHOLDER, EMITTED_PLACEHOLDER]) {
    if (!source.includes(placeholder)) {
      throw new Error(`sw.js has no ${placeholder} placeholder to stamp; fix sw.js.`);
    }
  }
  return source
    .replaceAll(PLACEHOLDER, id)
    .replaceAll(EMITTED_PLACEHOLDER, () => JSON.stringify([...emitted].sort()));
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
      const source = readFileSync(file, 'utf8');
      const names = Object.keys(bundle);
      writeFileSync(
        file,
        stampWorker(source, buildIdForOutput(outDir, names, source), emittedPaths(names)),
      );
    },
  };
}
