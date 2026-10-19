import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BUDGET_BYTES, checkAssets, loadCheckInput, type CheckInput } from './check.ts';
import { packGlb, sha256 } from './glb.ts';
import {
  FIN_ID_ATTRIBUTE,
  FIN_MASK_ATTRIBUTE,
  MOUTH_ATTRIBUTE,
  LEG_ATTRIBUTE,
  type AssetIndex,
  type OutputAsset,
} from './index-schema.ts';
import {
  aggregateSha256,
  derivedModifications,
  modificationProblems,
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
      ['wm-firefish-hobgood', 'firefish', 'Nick Hobgood (Nhobgood)', 'CC-BY-SA-3.0'],
      ['wm-rasbora-dabrowski', 'harlequin-rasbora', 'Mariusz Dabrowski', 'CC-BY-SA-3.0'],
      ['wm-sixline-delso-63', 'six-line-wrasse', 'Diego Delso', 'CC-BY-SA-4.0'],
      ['wm-ancistrus-reis', 'bristlenose-pleco', 'Júlio Reis', 'CC-BY-SA-4.0'],
      ['wm-ancistrus-l144-adolfoi', 'bristlenose-pleco', 'Corydoras-adolfoi', 'CC-BY-SA-4.0'],
    ])('accepts the roster photo %s', (id, species, author, licence) => {
      const photo = manifestAsset({ id, kind: 'reference-photo', species, author, licence });
      expect(validateManifest(manifestOf(photo), `\`${id}\` ${author}`)).toEqual([]);
      const wrongAuthor = { ...photo, author: 'Jane Doe' };
      expect(validateManifest(manifestOf(wrongAuthor), `\`${id}\` Jane Doe`).join('\n')).toContain(
        'only allowed for the approved reference-photo ids',
      );
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
    writeFileSync(join(root, 'tools', 'asset-pipeline', 'debug', 'prawn.png'), 'png');
    writeFileSync(join(root, 'tools', 'asset-pipeline', 'debug', 'prawn-parts.png'), 'png');
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

  function glb(
    attributes: string[],
    imageUris: string[] = [],
    mouth: number[] = [0, 0.4, 1],
  ): Uint8Array {
    const attrs = Object.fromEntries(attributes.map((name, i) => [name, i]));
    const data = new Uint8Array(Float32Array.from(mouth).buffer);
    const accessors = attributes.map(() => ({
      bufferView: 0,
      componentType: 5126,
      count: mouth.length,
      type: 'SCALAR',
    }));
    return packGlb(
      {
        asset: { version: '2.0' },
        buffers: [{ byteLength: data.byteLength }],
        bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: data.byteLength }],
        accessors,
        meshes: [{ primitives: [{ attributes: attrs }] }],
        ...(imageUris.length > 0 ? { images: imageUris.map((uri) => ({ uri })) } : {}),
      },
      data,
    );
  }

  function ktx2(width: number, colorModel: number, transfer: number, extra = 0): Uint8Array {
    const out = new Uint8Array(104 + 32 + 16 + extra);
    out.set([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]);
    const view = new DataView(out.buffer);
    view.setUint32(20, width, true);
    view.setUint32(24, width, true);
    view.setUint32(40, 1, true);
    view.setUint32(48, 104, true);
    view.setUint32(52, 32, true);
    view.setBigUint64(80, 136n, true);
    view.setBigUint64(88, BigInt(16 + extra), true);
    out[104 + 12] = colorModel;
    out[104 + 14] = transfer;
    return out;
  }

  function impostorOf(
    options: { size?: number; albedoModel?: number; normalModel?: number; extra?: number } = {},
  ): { impostor: NonNullable<OutputAsset['impostor']>; files: OutputAsset['files'] } {
    const size = options.size ?? 64;
    const albedo = put(
      'fish/tetra/impostor_albedo.ktx2',
      ktx2(size, options.albedoModel ?? 163, 2),
    );
    const normalDepth = put(
      'fish/tetra/impostor_normal.ktx2',
      ktx2(size, options.normalModel ?? 166, 1, options.extra ?? 0),
    );
    return {
      impostor: {
        sourceLod: 1,
        layout: 'octahedral',
        pose: 'rest',
        grid: 4,
        frameSize: 16,
        atlasSize: 64,
        pivot: [0, 0, 0],
        radius: 0.02,
        albedo: { ...albedo, codec: 'etc1s' },
        normalDepth: { ...normalDepth, codec: 'uastc' },
      },
      files: [albedo, normalDepth],
    };
  }

  const FISH_ATTRIBUTES = [
    'POSITION',
    'TEXCOORD_0',
    FIN_MASK_ATTRIBUTE,
    FIN_ID_ATTRIBUTE,
    MOUTH_ATTRIBUTE,
  ];

  function fishAsset(
    options: {
      attributes?: string[];
      triangles?: number[];
      lodCount?: number;
      impostor?: Parameters<typeof impostorOf>[0] | false;
      mouth?: number[];
    } = {},
  ): OutputAsset {
    const atlas = options.impostor === false ? null : impostorOf(options.impostor);
    const attributes = options.attributes ?? FISH_ATTRIBUTES;
    const triangles = options.triangles ?? [300, 150, 50];
    const lodCount = options.lodCount ?? 3;
    const lods = Array.from({ length: lodCount }, (_, i) => ({
      ...put(`fish/tetra/lod${i}.glb`, glb(attributes, [], options.mouth)),
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
      files: [
        ...lods.map(({ file, bytes, sha256: digest }) => ({ file, bytes, sha256: digest })),
        ...(atlas?.files ?? []),
      ],
      ...(atlas ? { impostor: atlas.impostor } : {}),
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
        mouthMask: { attribute: MOUTH_ATTRIBUTE },
        debugRender: 'debug/tetra.png',
      },
    };
  }

  function shrimpAsset(attributes?: string[]): OutputAsset {
    const attrs = attributes ?? ['POSITION', FIN_MASK_ATTRIBUTE, FIN_ID_ATTRIBUTE, LEG_ATTRIBUTE];
    const lods = [300, 150, 50].map((triangles, i) => ({
      ...put(`shrimp/prawn/lod${i}.glb`, glb(attrs)),
      triangles,
      vertices: triangles * 2,
    }));
    return {
      id: 'prawn',
      kind: 'shrimp',
      origin: 'procedural',
      sources: [],
      licence: 'CC0-1.0',
      modifications: [],
      lods,
      textures: [],
      files: lods.map(({ file, bytes, sha256: digest }) => ({ file, bytes, sha256: digest })),
      shrimp: {
        standardLengthM: 0.03,
        lengthSource: 'recipe',
        axes: { forward: '+z', up: '+y' },
        origin: 'centre-of-mass',
        standoffM: 0.004,
        attributes: { partId: FIN_ID_ATTRIBUTE, weight: FIN_MASK_ATTRIBUTE, limb: LEG_ATTRIBUTE },
        partIds: { body: 0, leg: 6, antenna: 7, pleopod: 8, abdomen: 9 },
        legPairs: 5,
        pleopodPairs: 5,
        abdomenHinge: { y: 0, z: 0.003 },
        telsonZ: -0.015,
        debugRender: 'debug/prawn.png',
        debugPartsRender: 'debug/prawn-parts.png',
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

  it('passes a complete shrimp and fails one without its limb attribute, shrimp block or renders', () => {
    expect(checkAssets(inputFor([shrimpAsset()]))).toEqual([]);
    const noLeg = shrimpAsset(['POSITION', FIN_MASK_ATTRIBUTE, FIN_ID_ATTRIBUTE]);
    expect(checkAssets(inputFor([noLeg])).join('\n')).toContain(
      `lacks vertex attribute ${LEG_ATTRIBUTE}`,
    );
    const bare = { ...shrimpAsset(), shrimp: undefined };
    expect(checkAssets(inputFor([bare])).join('\n')).toContain('has no shrimp block');
    rmSync(join(root, 'tools', 'asset-pipeline', 'debug', 'prawn-parts.png'));
    expect(checkAssets(inputFor([shrimpAsset()])).join('\n')).toContain(
      'debug render debug/prawn-parts.png is missing',
    );
  });

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

  it('fails a CC-BY source whose manifest modifications omit what the pipeline did', () => {
    const asset = { ...fishAsset(), licence: 'CC-BY-4.0', modifications: ['merged meshes'] };
    const by = manifestOf(
      manifestAsset({ id: 'src-a', licence: 'CC-BY-4.0', author: 'Ann', modifications: [] }),
    );
    const credits = '- src-a Ann';
    expect(checkAssets(inputFor([asset], by, credits)).join('\n')).toContain(
      'modifications do not list',
    );
    const synced = manifestOf(
      manifestAsset({
        id: 'src-a',
        licence: 'CC-BY-4.0',
        author: 'Ann',
        modifications: ['merged meshes'],
      }),
    );
    expect(checkAssets(inputFor([asset], synced, credits)).join('\n')).not.toContain(
      'modifications do not list',
    );
  });

  it('prefixes notes with the asset id when a source feeds several assets, and clears unused sources', () => {
    const derivedOf = (modifications: string[], extra: ManifestAsset[] = []): Manifest =>
      manifestOf(
        manifestAsset({ id: 'src-a', licence: 'CC-BY-4.0', author: 'Ann', modifications }),
        ...extra,
      );
    const one = { ...fishAsset(), licence: 'CC-BY-4.0', modifications: ['scaled'] };
    const two = { ...one, id: 'other' };
    const index = { ...inputFor([one, two]).index };
    expect(derivedModifications(index, derivedOf([])).get('src-a')).toEqual([
      'tetra: scaled',
      'other: scaled',
    ]);
    const unused = derivedOf(['stale note']);
    const none = { ...index, assets: [] };
    expect(derivedModifications(none, unused).get('src-a')).toEqual([]);
    expect(modificationProblems(none, unused)).toHaveLength(1);
  });

  it('derives modifications for a reference photo that feeds a built asset, and none for an unused one', () => {
    const photo = (modifications: string[]) =>
      manifestAsset({
        id: 'src-a',
        kind: 'reference-photo',
        licence: 'CC-BY-4.0',
        author: 'Ann',
        modifications,
      });
    const loft = { ...fishAsset(), licence: 'CC-BY-4.0', modifications: ['projected'] };
    const used = inputFor([loft]).index;
    expect(derivedModifications(used, manifestOf(photo([]))).get('src-a')).toEqual(['projected']);
    expect(modificationProblems(used, manifestOf(photo([]))).join('\n')).toContain(
      'modifications do not list',
    );
    expect(modificationProblems(used, manifestOf(photo(['projected'])))).toEqual([]);
    const unused = { ...used, assets: [] };
    expect(derivedModifications(unused, manifestOf(photo(['stale']))).get('src-a')).toEqual([]);
    expect(modificationProblems(unused, manifestOf(photo(['stale']))).length).toBe(1);
  });

  it('derives modifications for a CC0 reference photo that feeds a built asset', () => {
    const photo = manifestAsset({
      id: 'src-a',
      kind: 'reference-photo',
      licence: 'CC0-1.0',
      modifications: [],
    });
    const loft = { ...fishAsset(), modifications: ['projected'] };
    const index = inputFor([loft]).index;
    expect(derivedModifications(index, manifestOf(photo)).get('src-a')).toEqual(['projected']);
    expect(modificationProblems(index, manifestOf(photo)).join('\n')).toContain(
      'modifications do not list',
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

  it('fails a GLB that references a texture the asset does not list', () => {
    const asset = fishAsset();
    const lod0 = asset.lods[0];
    if (!lod0) throw new Error('fixture has no LOD');
    const stray = put('fish/tetra/lod0.glb', glb(FISH_ATTRIBUTES, ['textures/ghost_1k.ktx2']));
    const problems = checkAssets(
      inputFor([
        {
          ...asset,
          lods: [{ ...lod0, ...stray }, ...asset.lods.slice(1)],
          files: [stray, ...asset.files.slice(1)],
        },
      ]),
    );
    expect(problems.join('\n')).toContain('references textures/ghost_1k.ktx2');
  });

  it('accepts a GLB whose texture uris are all listed', () => {
    const asset = fishAsset();
    const lod0 = asset.lods[0];
    if (!lod0) throw new Error('fixture has no LOD');
    const attributes = FISH_ATTRIBUTES;
    const texture = put('fish/tetra/textures/skin_1k.ktx2', 'ktx');
    const withImage = put('fish/tetra/lod0.glb', glb(attributes, ['textures/skin_1k.ktx2']));
    const input = inputFor([
      {
        ...asset,
        lods: [{ ...lod0, ...withImage }, ...asset.lods.slice(1)],
        files: [withImage, ...asset.files.slice(1), texture],
      },
    ]);
    expect(checkAssets(input)).toEqual([]);
  });

  it('matches percent-encoded texture uris against the listed files', () => {
    const asset = fishAsset();
    const lod0 = asset.lods[0];
    if (!lod0) throw new Error('fixture has no LOD');
    const attributes = FISH_ATTRIBUTES;
    const texture = put('fish/tetra/textures/my skin_1k.ktx2', 'ktx');
    const withImage = put('fish/tetra/lod0.glb', glb(attributes, ['textures/my%20skin_1k.ktx2']));
    const input = inputFor([
      {
        ...asset,
        lods: [{ ...lod0, ...withImage }, ...asset.lods.slice(1)],
        files: [withImage, ...asset.files.slice(1), texture],
      },
    ]);
    expect(checkAssets(input)).toEqual([]);
  });

  it('fails a shipped file that is neither GLB nor KTX2', () => {
    const asset = fishAsset();
    const raw = put('fish/tetra/env.hdr', 'RADIANCE');
    const problems = checkAssets(inputFor([{ ...asset, files: [...asset.files, raw] }]));
    expect(problems.join('\n')).toContain('env.hdr is not a .glb or .ktx2 file');
  });

  it('fails a fish without a fin mask attribute', () => {
    const asset = fishAsset({ attributes: ['POSITION', FIN_ID_ATTRIBUTE] });
    expect(checkAssets(inputFor([asset])).join('\n')).toContain(
      `lacks vertex attribute ${FIN_MASK_ATTRIBUTE}`,
    );
  });

  it('fails a fish primitive without TEXCOORD_0', () => {
    const asset = fishAsset({
      attributes: ['POSITION', FIN_MASK_ATTRIBUTE, FIN_ID_ATTRIBUTE, MOUTH_ATTRIBUTE],
    });
    expect(checkAssets(inputFor([asset])).join('\n')).toContain(
      'lacks vertex attribute TEXCOORD_0',
    );
  });

  it('fails a fish without a mouth mask attribute', () => {
    const asset = fishAsset({ attributes: ['POSITION', FIN_MASK_ATTRIBUTE, FIN_ID_ATTRIBUTE] });
    expect(checkAssets(inputFor([asset])).join('\n')).toContain(
      `lacks vertex attribute ${MOUTH_ATTRIBUTE}`,
    );
  });

  it('fails a mouth mask outside 0..1', () => {
    const above = fishAsset({ mouth: [0, 0.5, 1.25] });
    expect(checkAssets(inputFor([above])).join('\n')).toContain('range 0..1.25 is outside 0..1');
    const below = fishAsset({ mouth: [-0.5, 0.5, 1] });
    expect(checkAssets(inputFor([below])).join('\n')).toContain('range -0.5..1 is outside 0..1');
  });

  it('fails a mouth mask that is zero everywhere', () => {
    const asset = fishAsset({ mouth: [0, 0, 0] });
    expect(checkAssets(inputFor([asset])).join('\n')).toContain('is 0 on every vertex');
  });

  it('fails loudly on a mouth accessor that is not float32', () => {
    const asset = fishAsset();
    const lod0 = asset.lods[0];
    if (!lod0) throw new Error('fixture has no LOD');
    const quantised = put(
      'fish/tetra/lod0.glb',
      packGlb(
        {
          asset: { version: '2.0' },
          buffers: [{ byteLength: 3 }],
          bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 3 }],
          accessors: FISH_ATTRIBUTES.map(() => ({
            bufferView: 0,
            componentType: 5121,
            normalized: true,
            count: 3,
            type: 'SCALAR',
          })),
          meshes: [
            {
              primitives: [
                { attributes: Object.fromEntries(FISH_ATTRIBUTES.map((n, i) => [n, i])) },
              ],
            },
          ],
        },
        new Uint8Array(3),
      ),
    );
    const problems = checkAssets(
      inputFor([
        {
          ...asset,
          lods: [{ ...lod0, ...quantised }, ...asset.lods.slice(1)],
          files: [quantised, ...asset.files.slice(1)],
        },
      ]),
    );
    expect(problems.join('\n')).toContain('must be non-normalised float32 SCALAR');
  });

  it('fails a fish with missing LODs', () => {
    const problems = checkAssets(inputFor([fishAsset({ lodCount: 2 })])).join('\n');
    expect(problems).toContain('needs 3 LODs');
  });

  it('fails a fish whose LODs do not get lighter', () => {
    const problems = checkAssets(inputFor([fishAsset({ triangles: [300, 300, 50] })])).join('\n');
    expect(problems).toContain('is not lighter than LOD 0');
  });

  describe('impostor atlas', () => {
    const problemsOf = (asset: OutputAsset): string => checkAssets(inputFor([asset])).join('\n');

    it('fails a fish with no impostor', () => {
      expect(problemsOf(fishAsset({ impostor: false }))).toContain('has no impostor atlas');
    });

    it('fails an atlas whose pixel size differs from the index', () => {
      expect(problemsOf(fishAsset({ impostor: { size: 32 } }))).toContain('is 32x32');
    });

    it('fails when the codec split is swapped', () => {
      const problems = problemsOf(fishAsset({ impostor: { albedoModel: 166, normalModel: 163 } }));
      expect(problems).toContain('impostor_albedo.ktx2 must be ETC1S');
      expect(problems).toContain('impostor_normal.ktx2 must be UASTC');
    });

    it('fails atlases over the per-species budget', () => {
      expect(problemsOf(fishAsset({ impostor: { extra: 1_000_000 } }))).toContain(
        'per-species budget',
      );
    });

    it('fails a radius that cannot hold the model bounds', () => {
      const asset = {
        ...fishAsset(),
        bounds: {
          min: [-0.1, -0.1, -0.1] as [number, number, number],
          max: [0.1, 0.1, 0.1] as [number, number, number],
        },
      };
      expect(problemsOf(asset)).toContain('impostor radius');
    });
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

  describe('species length', () => {
    const SPECIES_LENGTH = 0.04;

    function speciesFile(bodyLengthM: number | null): void {
      const template = JSON.parse(
        readFileSync(resolve(REPO_ROOT, 'content', 'species', 'guppy.json'), 'utf8'),
      ) as { locomotion?: Record<string, unknown> };
      if (bodyLengthM === null) delete template.locomotion;
      else template.locomotion = { ...template.locomotion, bodyLengthM };
      mkdirSync(join(root, 'content', 'species'), { recursive: true });
      writeFileSync(join(root, 'content', 'species', 'guppy.json'), JSON.stringify(template));
    }

    function guppy(fish: Partial<NonNullable<OutputAsset['fish']>>, id = 'tetra'): OutputAsset {
      const base = fishAsset();
      if (!base.fish) throw new Error('fishAsset has no fish block');
      return { ...base, id, species: 'guppy', fish: { ...base.fish, ...fish } };
    }

    function problemsFor(asset: OutputAsset): string {
      return checkAssets(inputFor([asset])).join('\n');
    }

    it('fails a fish built from the recipe length once the species file has bodyLengthM', () => {
      speciesFile(SPECIES_LENGTH);
      const asset = guppy({ lengthSource: 'recipe', standardLengthM: SPECIES_LENGTH });
      expect(problemsFor(asset)).toContain('lengthSource recipe');
    });

    it('fails a fish whose standardLengthM differs from the species file', () => {
      speciesFile(SPECIES_LENGTH);
      const asset = guppy({ lengthSource: 'species-json', standardLengthM: 0.05 });
      expect(problemsFor(asset)).toContain('differs from content/species');
    });

    it('accepts a fish built at the species length', () => {
      speciesFile(SPECIES_LENGTH);
      const asset = guppy({ lengthSource: 'species-json', standardLengthM: SPECIES_LENGTH });
      expect(problemsFor(asset)).not.toContain('bodyLengthM');
    });

    it('applies the recipe lengthFactor (guppy-male is 0.625 of the species length)', () => {
      speciesFile(SPECIES_LENGTH);
      const scaled = SPECIES_LENGTH * 0.625;
      const good = guppy({ lengthSource: 'species-json', standardLengthM: scaled }, 'guppy-male');
      expect(problemsFor(good)).not.toContain('bodyLengthM');
      const unscaled = guppy(
        { lengthSource: 'species-json', standardLengthM: SPECIES_LENGTH },
        'guppy-male',
      );
      expect(problemsFor(unscaled)).toContain('differs from content/species');
    });

    it('fails a species-json fish whose species file lost bodyLengthM', () => {
      speciesFile(null);
      const asset = guppy({ lengthSource: 'species-json', standardLengthM: SPECIES_LENGTH });
      expect(problemsFor(asset)).toContain('has no bodyLengthM');
    });
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
