import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ktx2WorkerPlugin } from '../../build/ktx2-worker-plugin.ts';

interface Hooks {
  config: () => { define: Record<string, string> };
  generateBundle: (
    this: {
      emitFile: (file: { fileName: string; source: string }) => void;
      error: (m: string) => never;
    },
    options: object,
    bundle: Record<string, unknown>,
  ) => void;
}

function run(bundle: Record<string, unknown>) {
  const hooks = ktx2WorkerPlugin() as unknown as Hooks;
  const emitted: { fileName: string; source: string }[] = [];
  const error = vi.fn((message: string): never => {
    throw new Error(message);
  });
  const generate = () => {
    hooks.generateBundle.call({ emitFile: (f) => emitted.push(f), error }, {}, bundle);
  };
  return { hooks, emitted, generate };
}

describe('ktx2WorkerPlugin', () => {
  it('strips the unused transcoder glue, keeps the wasm, and emits the worker', () => {
    const bundle = {
      'assets/basis_transcoder-o4Hde_L7.js': {},
      'assets/basis_transcoder-VXdx5NbI.wasm': {},
      'assets/index-abc.js': {},
    };
    const { emitted, generate } = run(bundle);
    generate();
    expect(Object.keys(bundle).sort()).toEqual([
      'assets/basis_transcoder-VXdx5NbI.wasm',
      'assets/index-abc.js',
    ]);
    expect(emitted.map((f) => f.fileName)).toEqual(['ktx2-worker.js']);
  });

  it('fails the build when there is no glue to strip', () => {
    const { generate } = run({ 'assets/index-abc.js': {} });
    expect(generate).toThrow(/no basis_transcoder-\*\.js asset to strip/);
  });

  it('defines a content hash of the emitted worker source', () => {
    const { hooks, emitted, generate } = run({ 'assets/basis_transcoder-x1.js': {} });
    generate();
    const defined = JSON.parse(hooks.config().define['__KTX2_WORKER_HASH__'] ?? 'null') as string;
    const expected = createHash('sha256')
      .update(emitted[0]?.source ?? '')
      .digest('hex')
      .slice(0, 12);
    expect(defined).toBe(expected);
  });
});
