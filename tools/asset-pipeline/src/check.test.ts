import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BUDGET_BYTES, checkAssets, loadCheckInput, type CheckInput } from './check.ts';
import { packGlb, sha256 } from './glb.ts';
import {
  FIN_ID_ATTRIBUTE,
  FIN_MASK_ATTRIBUTE,
  type AssetIndex,
  type OutputAsset,
} from './index-schema.ts';
import {
  aggregateSha256,
  validateManifest,
  type Manifest,
  type ManifestAsset,
} from './manifest.ts';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const DIGEST = 'a'.repeat(64);

function manifestAsset(overrides: Partial<ManifestAsset> = {}): ManifestAsset {
  return {
    id: 'src-a',
    kind: 'model',
    title: 'A',
    author: 'Jane Doe',
    author_url: 'https://example.com/jane',
    source_url: 'https://example.com/a',
    licence: 'CC0-1.0',
    licence_url: 'https://example.com/cc0',
    sha256: DIGEST,
    modifications: [],
    status: 'downloaded',
    ...overrides,
  };
}

function manifestOf(...assets: ManifestAsset[]): Manifest {
  return {
    version: 1,
    status_values: ['downloaded', 'selected-pending-download'],
    rules: [],
    assets,
  };
}

describe('validateManifest', () => {
  it('accepts CC0, CC-BY with credit and pending entries with a null hash', () => {
    const manifest = manifestOf(
      manifestAsset(),
      manifestAsset({ id: 'src-b', licence: 'CC-BY-4.0' }),
      manifestAsset({ id: 'src-c', status: 'selected-pending-download', sha256: null }),
    );
    expect(validateManifest(manifest, '`src-b` by Jane Doe')).toEqual([]);
  });

  it('rejects a licence outside the allowlist', () => {
    const problems = validateManifest(manifestOf(manifestAsset({ licence: 'CC-BY-NC-4.0' })), '');
    expect(problems.join('\n')).toContain('CC-BY-NC-4.0');
  });

  it('rejects CC-BY without a credit line or author', () => {
    const ccBy = manifestAsset({ licence: 'CC-BY-4.0' });
    expect(validateManifest(manifestOf(ccBy), '').join('\n')).toContain(
      'not credited in CREDITS.md',
    );
    expect(validateManifest(manifestOf(ccBy), '`src-a` by someone else').join('\n')).toContain(
      'does not name author',
    );
    expect(validateManifest(manifestOf({ ...ccBy, author: ' ' }), '`src-a`').join('\n')).toContain(
      'empty author',
    );
  });

  describe('CC-BY-SA allowlist', () => {
    const approved = {
      id: 'wm-gramma-loreto-llez',
      kind: 'reference-photo',
      species: 'royal-gramma',
      author: 'H. Zell (Llez)',
      licence: 'CC-BY-SA-3.0',
    };
    const credits = '`wm-gramma-loreto-llez` H. Zell (Llez) `src-a` Jane Doe';

    it('accepts exactly the approved reference photos', () => {
      expect(validateManifest(manifestOf(manifestAsset(approved)), credits)).toEqual([]);
    });

    it.each([
      ['another id by the same author', { id: 'src-a' }],
      ['another species', { species: 'betta' }],
      ['a model instead of a photo', { kind: 'model' }],
      ['an author that only contains the approved name', { author: 'H. Zell (Llez) and friends' }],
      ['a different author', { author: 'Jane Doe' }],
    ])('rejects %s', (_label, override) => {
      const problems = validateManifest(
        manifestOf(manifestAsset({ ...approved, ...override })),
        credits,
      );
      expect(problems.join('\n')).toContain('only allowed for the approved reference-photo ids');
    });
  });

  it('enforces status values, hash nullability and the aggregate recipe', () => {
    expect(
      validateManifest(manifestOf(manifestAsset({ status: 'weird' })), '').join('\n'),
    ).toContain('status "weird"');
    expect(
      validateManifest(manifestOf(manifestAsset({ status: 'selected-pending-download' })), '').join(
        '\n',
      ),
    ).toContain('pending asset must have sha256 null');
    expect(validateManifest(manifestOf(manifestAsset({ sha256: null })), '').join('\n')).toContain(
      'sha256 is null',
    );

    const files = [
      { path: 'b.bin', sha256: 'b'.repeat(64), bytes: 1 },
      { path: 'a.bin', sha256: 'c'.repeat(64), bytes: 1 },
    ];
    const good = manifestAsset({ files, sha256: aggregateSha256(files) });
    expect(validateManifest(manifestOf(good), '')).toEqual([]);
    expect(validateManifest(manifestOf({ ...good, sha256: DIGEST }), '').join('\n')).toContain(
      'not the aggregate',
    );
  });

  it('flags duplicate ids', () => {
    expect(validateManifest(manifestOf(manifestAsset(), manifestAsset()), '').join('\n')).toContain(
      'duplicate id',
    );
  });
});

describe('aggregateSha256', () => {
  it('is independent of file order', () => {
    const a = { path: 'a', sha256: '1'.repeat(64) };
    const b = { path: 'b', sha256: '2'.repeat(64) };
    expect(aggregateSha256([a, b])).toBe(aggregateSha256([b, a]));
  });
});

describe('checkAssets', () => {
  let root: string;
  let assetsDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'asset-check-'));
    assetsDir = join(root, 'apps', 'web', 'public', 'assets');
    mkdirSync(assetsDir, { recursive: true });
    mkdirSync(join(root, 'tools', 'asset-pipeline', 'debug'), { recursive: true });
    writeFileSync(join(root, 'tools', 'asset-pipeline', 'debug', 'tetra.png'), 'png');
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function put(
    relative: string,
    data: Uint8Array | string,
  ): { file: string; bytes: number; sha256: string } {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    const path = join(assetsDir, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
    return { file: relative, bytes: bytes.byteLength, sha256: sha256(bytes) };
  }

  function glb(attributes: string[]): Uint8Array {
    const attrs = Object.fromEntries(attributes.map((name, i) => [name, i]));
    return packGlb(
      { asset: { version: '2.0' }, meshes: [{ primitives: [{ attributes: attrs }] }] },
      new Uint8Array(4),
    );
  }

  function fishAsset(
    options: { attributes?: string[]; triangles?: number[]; lodCount?: number } = {},
  ): OutputAsset {
    const attributes = options.attributes ?? ['POSITION', FIN_MASK_ATTRIBUTE, FIN_ID_ATTRIBUTE];
    const triangles = options.triangles ?? [300, 150, 50];
    const lodCount = options.lodCount ?? 3;
    const lods = Array.from({ length: lodCount }, (_, i) => ({
      ...put(`fish/tetra/lod${i}.glb`, glb(attributes)),
      triangles: triangles[i] ?? 0,
      vertices: (triangles[i] ?? 0) * 2,
    }));
    return {
      id: 'tetra',
      kind: 'fish',
      origin: 'model',
      sources: ['src-a'],
      licence: 'CC0-1.0',
      modifications: [],
      lods,
      textures: [],
      files: lods.map(({ file, bytes, sha256: digest }) => ({ file, bytes, sha256: digest })),
      fish: {
        standardLengthM: 0.03,
        lengthSource: 'recipe',
        axes: { forward: '+z', up: '+y' },
        origin: 'centre-of-mass',
        finMask: {
          maskAttribute: FIN_MASK_ATTRIBUTE,
          idAttribute: FIN_ID_ATTRIBUTE,
          ids: { caudal: 1, dorsal: 2, anal: 3, pectoral: 4, pelvic: 5 },
        },
        debugRender: 'debug/tetra.png',
      },
    };
  }

  function inputFor(
    assets: OutputAsset[],
    manifest = manifestOf(manifestAsset()),
    credits = '',
  ): CheckInput {
    const index: AssetIndex = {
      version: 1,
      textureVariants: '',
      customAttributes: '',
      totalBytes: assets.flatMap((a) => a.files).reduce((sum, f) => sum + f.bytes, 0),
      assets,
    };
    return { manifest, credits, index, assetsDir, repoRoot: root };
  }

  it('passes a complete fish', () => {
    expect(checkAssets(inputFor([fishAsset()]))).toEqual([]);
  });

  it('fails an asset whose source is not in the manifest', () => {
    const asset = { ...fishAsset(), sources: ['ghost'] };
    expect(checkAssets(inputFor([asset])).join('\n')).toContain(
      '"ghost" is not in assets/manifest.json',
    );
  });

  it('fails an asset derived from a source with a disallowed licence', () => {
    const manifest = manifestOf(manifestAsset({ licence: 'CC-BY-NC-4.0' }));
    expect(checkAssets(inputFor([fishAsset()], manifest)).join('\n')).toContain(
      'disallowed licence',
    );
  });

  it('fails a CC-BY source that has no credit', () => {
    const manifest = manifestOf(manifestAsset({ licence: 'CC-BY-4.0' }));
    const asset = { ...fishAsset(), licence: 'CC-BY-4.0' };
    expect(checkAssets(inputFor([asset], manifest, '')).join('\n')).toContain(
      'not credited in CREDITS.md',
    );
    expect(checkAssets(inputFor([asset], manifest, '`src-a` Jane Doe'))).toEqual([]);
  });

  it('fails an asset derived from a CC-BY-SA source that is not approved', () => {
    const manifest = manifestOf(
      manifestAsset({ licence: 'CC-BY-SA-4.0', author: 'H. Zell', kind: 'model' }),
    );
    const asset = { ...fishAsset(), licence: 'CC-BY-SA-4.0' };
    expect(checkAssets(inputFor([asset], manifest, '`src-a` H. Zell')).join('\n')).toContain(
      'disallowed licence',
    );
  });

  it('fails an output whose licence is weaker than its sources', () => {
    const manifest = manifestOf(manifestAsset({ licence: 'CC-BY-4.0' }));
    const asset = { ...fishAsset(), licence: 'CC0-1.0' };
    expect(checkAssets(inputFor([asset], manifest, '`src-a` Jane Doe')).join('\n')).toContain(
      'weaker than its sources require',
    );
  });

  it('takes the strictest licence across several sources', () => {
    const manifest = manifestOf(
      manifestAsset(),
      manifestAsset({ id: 'src-b', licence: 'CC-BY-4.0' }),
    );
    const credits = '`src-b` Jane Doe';
    const base = { ...fishAsset(), sources: ['src-a', 'src-b'] };
    expect(
      checkAssets(inputFor([{ ...base, licence: 'CC0-1.0' }], manifest, credits)).join('\n'),
    ).toContain('weaker than its sources require');
    expect(checkAssets(inputFor([{ ...base, licence: 'CC-BY-4.0' }], manifest, credits))).toEqual(
      [],
    );
  });

  it('rejects a non-commercial source', () => {
    const manifest = manifestOf(manifestAsset({ licence: 'CC-BY-NC-4.0' }));
    const asset = { ...fishAsset(), licence: 'CC-BY-NC-4.0' };
    expect(checkAssets(inputFor([asset], manifest)).join('\n')).toContain('disallowed licence');
  });

  it('requires a procedural asset without sources to be CC0', () => {
    const asset: OutputAsset = {
      ...fishAsset(),
      sources: [],
      origin: 'procedural',
      licence: 'CC-BY-4.0',
    };
    expect(checkAssets(inputFor([asset])).join('\n')).toContain('must be CC0-1.0');
  });

  it('requires a procedural origin for assets without sources', () => {
    const asset = { ...fishAsset(), sources: [] };
    expect(checkAssets(inputFor([asset])).join('\n')).toContain('no manifest sources');
    expect(checkAssets(inputFor([{ ...asset, origin: 'procedural-loft' }]))).toEqual([]);
  });

  it('fails files on disk that the index does not list', () => {
    const input = inputFor([fishAsset()]);
    put('fish/tetra/extra.bin', 'x');
    expect(checkAssets(input).join('\n')).toContain(
      'assets/fish/tetra/extra.bin is not part of any asset',
    );
  });

  it('fails a file that changed after the index was written', () => {
    const input = inputFor([fishAsset()]);
    put('fish/tetra/lod0.glb', 'tampered');
    expect(checkAssets(input).join('\n')).toContain('differs from index.json');
  });

  it('fails a total over the budget', () => {
    const input = inputFor([fishAsset()]);
    const [asset] = input.index.assets;
    if (!asset) throw new Error('fixture has no asset');
    const filler = { file: 'fish/tetra/filler.bin', bytes: BUDGET_BYTES, sha256: DIGEST };
    writeFileSync(join(assetsDir, filler.file), new Uint8Array(BUDGET_BYTES));
    const problems = checkAssets({
      ...input,
      index: { ...input.index, assets: [{ ...asset, files: [...asset.files, filler] }] },
    });
    expect(problems.join('\n')).toContain('exceeds the 150 MB budget');
  });

  it('fails a fish without a fin mask attribute', () => {
    const asset = fishAsset({ attributes: ['POSITION', FIN_ID_ATTRIBUTE] });
    expect(checkAssets(inputFor([asset])).join('\n')).toContain(
      `lacks vertex attribute ${FIN_MASK_ATTRIBUTE}`,
    );
  });

  it('fails a fish with missing LODs', () => {
    const problems = checkAssets(inputFor([fishAsset({ lodCount: 2 })])).join('\n');
    expect(problems).toContain('needs 3 LODs');
  });

  it('fails a fish whose LODs do not get lighter', () => {
    const problems = checkAssets(inputFor([fishAsset({ triangles: [300, 300, 50] })])).join('\n');
    expect(problems).toContain('is not lighter than LOD 0');
  });

  it('fails a fish without its debug render or fish block', () => {
    rmSync(join(root, 'tools', 'asset-pipeline', 'debug', 'tetra.png'));
    expect(checkAssets(inputFor([fishAsset()])).join('\n')).toContain(
      'debug render debug/tetra.png is missing',
    );
    const bare: OutputAsset = { ...fishAsset() };
    delete bare.fish;
    expect(checkAssets(inputFor([bare])).join('\n')).toContain('no fish block');
  });

  it('fails an index whose totalBytes disagrees with the disk', () => {
    const input = inputFor([fishAsset()]);
    const problems = checkAssets({ ...input, index: { ...input.index, totalBytes: 1 } });
    expect(problems.join('\n')).toContain('totalBytes');
  });
});

describe('the committed assets', () => {
  it('pass assets:check', () => {
    expect(checkAssets(loadCheckInput(REPO_ROOT))).toEqual([]);
  });
});
