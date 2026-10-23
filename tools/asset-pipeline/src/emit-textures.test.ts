import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildDocument, writeTextureEntries } from './emit.ts';
import type { MaterialDef, Part } from './parts.ts';

function image(size: number) {
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) data.set([(i * 7) % 256, (i * 13) % 256, 90, 255], i * 4);
  return { width: size, height: size, data };
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

describe('writeTextureEntries', () => {
  it('writes one file and points 2k at it when the source has no more detail', async () => {
    const root = mkdtempSync(join(tmpdir(), 'emit-tex-'));
    roots.push(root);
    const { files, textures } = await writeTextureEntries(root, 'decor/x', [
      {
        name: 'x_basecolor',
        source: { role: 'baseColor', codec: 'etc1s', image: image(64) },
        colorSpace: 'srgb',
      },
    ]);
    const variants = textures[0]?.variants;
    expect(variants?.['2k'].file).toBe(variants?.['1k'].file);
    expect(files).toHaveLength(1);
    expect(readdirSync(join(root, 'decor/x/textures'))).toEqual(['x_basecolor_1k.ktx2']);
  });

  it('writes a separate 2k file when it is larger', async () => {
    const root = mkdtempSync(join(tmpdir(), 'emit-tex-'));
    roots.push(root);
    const { files, textures } = await writeTextureEntries(root, 'decor/x', [
      {
        name: 'x_basecolor',
        source: { role: 'baseColor', codec: 'etc1s', image: image(2048) },
        colorSpace: 'srgb',
      },
    ]);
    const variants = textures[0]?.variants;
    expect(variants?.['2k'].file).not.toBe(variants?.['1k'].file);
    expect(variants?.['2k'].size).toBe(2048);
    expect(files).toHaveLength(2);
  }, 60_000);
});

describe('buildDocument texture reuse', () => {
  const part = (material: string): Part => ({
    material,
    positions: new Float32Array(9),
    normals: new Float32Array(9),
    uvs: new Float32Array(6),
    indices: new Uint32Array([0, 1, 2]),
    extra: {},
  });
  const def = (name: string, shade: number): MaterialDef => ({
    name,
    baseColorFactor: [1, 1, 1, 1],
    baseColor: { role: 'baseColor', codec: 'etc1s', image: image(shade === 0 ? 8 : 16) },
    roughness: 1,
    metallic: 0,
    alphaMode: 'OPAQUE',
    doubleSided: false,
    normalScale: 1,
  });
  const parts = [part('a'), part('b')];

  it('binds materials with identical maps to one texture', () => {
    const { doc, textures } = buildDocument('x', parts, [def('a', 0), def('b', 0)], new Map());
    expect(textures.map((t) => t.name)).toEqual(['x_a_basecolor']);
    const [a, b] = doc.getRoot().listMaterials();
    expect(a?.getBaseColorTexture()).toBe(b?.getBaseColorTexture());
  });

  it('shares only the maps that match and keeps the others per material', () => {
    const withNormal = (name: string, normalSize: number): MaterialDef => ({
      ...def(name, 0),
      normal: { role: 'normal', codec: 'uastc', image: image(normalSize) },
    });
    const { doc, textures } = buildDocument(
      'x',
      parts,
      [withNormal('a', 8), withNormal('b', 16)],
      new Map(),
    );
    expect(textures.map((t) => t.name)).toEqual(['x_a_basecolor', 'x_a_normal', 'x_b_normal']);
    const [a, b] = doc.getRoot().listMaterials();
    expect(a?.getBaseColorTexture()).toBe(b?.getBaseColorTexture());
    expect(a?.getNormalTexture()).not.toBe(b?.getNormalTexture());
  });

  it('never merges a texture owned by another asset with one this asset writes', () => {
    const shared = new Map([['b', { assetDir: 'decor/owner', prefix: 'owner_b' }]]);
    const { doc, textures } = buildDocument('x', parts, [def('a', 0), def('b', 0)], shared);
    expect(textures.map((t) => t.name)).toEqual(['x_a_basecolor', 'owner_b_basecolor']);
    expect(textures[1]?.shared?.assetDir).toBe('decor/owner');
    const [a, b] = doc.getRoot().listMaterials();
    expect(a?.getBaseColorTexture()).not.toBe(b?.getBaseColorTexture());
  });

  it('keeps maps that differ apart', () => {
    const { textures } = buildDocument('x', parts, [def('a', 0), def('b', 1)], new Map());
    expect(textures).toHaveLength(2);
  });
});
