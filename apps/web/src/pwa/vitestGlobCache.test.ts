import { describe, expect, it } from 'vitest';
import { bypassGlobModuleCache } from '../../build/vitest-glob-cache-plugin.ts';

describe('bypassGlobModuleCache', () => {
  it.each([
    "import.meta.glob('./a/*.json')",
    "import.meta.glob<unknown>('./a/*.json', { eager: true })",
    "import.meta.glob(['./a/*.json'])",
    'import.meta.glob\n<unknown>(x)',
  ])('bypasses %j', (source) => {
    expect(bypassGlobModuleCache(source)).toBe(true);
  });

  it('leaves modules without a glob cacheable', () => {
    expect(bypassGlobModuleCache("import { x } from './x.ts'; const glob = 1;")).toBe(false);
  });
});
