/// <reference types="vitest/config" />
import type { Plugin } from 'vite';

const GLOB_CALL = /\bimport\.meta\.glob\b/;

/**
 * Vitest's own bail-out only matches the literal `import.meta.glob(`, so `import.meta.glob<T>(`
 * is cached by source text alone and keeps serving the file list from when it was first cached.
 */
export function bypassGlobModuleCache(sourceCode: string): boolean {
  return GLOB_CALL.test(sourceCode);
}

export function vitestGlobCachePlugin(): Plugin {
  return {
    name: 'aquarium:vitest-glob-cache',
    configureVitest({ defineCacheKeyGenerator }) {
      defineCacheKeyGenerator(({ sourceCode }) =>
        bypassGlobModuleCache(sourceCode) ? false : undefined,
      );
    },
  };
}
