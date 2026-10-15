import { describe, expect, it } from 'vitest';
import { tankPreloadPlugin } from '../../build/tank-preload-plugin.ts';

interface Chunk {
  type: 'chunk';
  fileName: string;
  imports: string[];
  isDynamicEntry: boolean;
  facadeModuleId: string | null;
}

interface Tag {
  tag: string;
  attrs: Record<string, string | boolean>;
  injectTo: string;
}

interface Hooks {
  apply: string;
  configResolved: (config: { base: string }) => void;
  transformIndexHtml: {
    order: string;
    handler: (
      html: string,
      ctx: { bundle?: object | undefined; chunk?: Chunk | undefined },
    ) => Tag[];
  };
}

function chunk(fileName: string, imports: string[] = [], facadeModuleId: string | null = null) {
  return {
    type: 'chunk',
    fileName,
    imports,
    isDynamicEntry: facadeModuleId !== null,
    facadeModuleId,
  } satisfies Chunk;
}

function bundleOf(...chunks: Chunk[]): Record<string, Chunk | { type: 'asset' }> {
  return Object.fromEntries(chunks.map((c) => [c.fileName, c]));
}

function run(bundle: object | undefined, entry: Chunk | undefined, base = '/'): Tag[] {
  const hooks = tankPreloadPlugin() as unknown as Hooks;
  hooks.configResolved({ base });
  return hooks.transformIndexHtml.handler('<html></html>', { bundle, chunk: entry });
}

const entry = chunk('assets/index-a.js', ['assets/src-a.js', 'assets/helper-a.js']);
const tank = chunk(
  'assets/tank-a.js',
  ['assets/three.tsl-a.js', 'assets/helper-a.js', 'assets/substrate-a.js'],
  '/repo/apps/web/src/tank.ts',
);

describe('tankPreloadPlugin', () => {
  it('runs on build only, after the HTML has its own tags', () => {
    const hooks = tankPreloadPlugin() as unknown as Hooks;
    expect(hooks.apply).toBe('build');
    expect(hooks.transformIndexHtml.order).toBe('post');
  });

  it('preloads the tank chunk and its static imports that the entry does not already load', () => {
    const bundle = bundleOf(
      entry,
      chunk('assets/src-a.js'),
      chunk('assets/helper-a.js'),
      tank,
      chunk('assets/three.tsl-a.js'),
      chunk('assets/substrate-a.js', ['assets/plants-a.js']),
      chunk('assets/plants-a.js'),
      chunk('assets/FishSystem-a.js', [], '/repo/apps/web/src/fish/FishSystem.ts'),
    );
    const tags = run(bundle, entry);
    expect(tags.map((t) => t.attrs['href'])).toEqual([
      '/assets/tank-a.js',
      '/assets/three.tsl-a.js',
      '/assets/substrate-a.js',
      '/assets/plants-a.js',
    ]);
    for (const tag of tags) {
      expect(tag).toEqual({
        tag: 'link',
        attrs: {
          rel: 'preload',
          as: 'script',
          crossorigin: true,
          fetchpriority: 'low',
          href: tag.attrs['href'],
        },
        injectTo: 'head',
      });
    }
  });

  it('prefixes the configured base', () => {
    const lone = chunk('assets/tank-a.js', [], '/repo/apps/web/src/tank.ts');
    expect(run(bundleOf(entry, lone), entry, '/fish/').map((t) => t.attrs['href'])).toEqual([
      '/fish/assets/tank-a.js',
    ]);
  });

  it('terminates on import cycles and lists each file once', () => {
    const a = chunk('assets/tank-a.js', ['assets/b.js'], '/repo/apps/web/src/tank.ts');
    const b = chunk('assets/b.js', ['assets/tank-a.js', 'assets/b.js']);
    expect(run(bundleOf(entry, a, b), entry).map((t) => t.attrs['href'])).toEqual([
      '/assets/tank-a.js',
      '/assets/b.js',
    ]);
  });

  it('fails the build when src/tank.ts is no longer a lazy chunk', () => {
    const eager = { ...tank, isDynamicEntry: false };
    expect(() => run(bundleOf(entry, eager), entry)).toThrow(/no lazy chunk for src\/tank\.ts/);
    expect(() => run(bundleOf(entry), entry)).toThrow(/no lazy chunk for src\/tank\.ts/);
  });

  it('adds nothing when there is no bundle, as in dev', () => {
    expect(run(undefined, undefined)).toEqual([]);
  });
});
