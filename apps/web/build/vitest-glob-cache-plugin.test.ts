import type { Plugin } from 'vite';
import { describe, expect, it } from 'vitest';
import viteConfig from '../vite.config.ts';
import { bypassGlobModuleCache } from './vitest-glob-cache-plugin.ts';

type CacheKeyGenerator = (context: { sourceCode: string }) => string | false | undefined;

function registeredGenerator(plugin: Plugin): CacheKeyGenerator {
  const run = plugin.configureVitest;
  if (!run) throw new Error('plugin has no configureVitest hook');
  let registered: CacheKeyGenerator | undefined;
  const stub = {
    defineCacheKeyGenerator: (generator: CacheKeyGenerator) => {
      registered = generator;
    },
  };
  (run as unknown as (context: typeof stub) => void).call({} as never, stub);
  if (!registered) throw new Error('configureVitest never called defineCacheKeyGenerator');
  return registered;
}

function configuredPlugin(): Plugin {
  const plugins = (viteConfig as { plugins?: unknown[] }).plugins ?? [];
  const found = plugins.find(
    (plugin): plugin is Plugin =>
      typeof plugin === 'object' &&
      plugin !== null &&
      (plugin as Plugin).name === 'aquarium:vitest-glob-cache',
  );
  if (!found) throw new Error('vitestGlobCachePlugin is not registered in vite.config.ts');
  return found;
}

describe('vitest glob cache plugin', () => {
  const generator = registeredGenerator(configuredPlugin());

  it.each([
    "import.meta.glob('./a/*.json')",
    "import.meta.glob<unknown>('./a/*.json', { eager: true })",
    "import.meta.glob(['./a/*.json'])",
    'import.meta.glob\n<unknown>(x)',
  ])('disables the module cache for %j', (sourceCode) => {
    expect(bypassGlobModuleCache(sourceCode)).toBe(true);
    expect(generator({ sourceCode })).toBe(false);
  });

  it('leaves modules without a glob cacheable', () => {
    const sourceCode = "import { x } from './x.ts'; const glob = 1;";
    expect(bypassGlobModuleCache(sourceCode)).toBe(false);
    expect(generator({ sourceCode })).not.toBe(false);
  });
});
