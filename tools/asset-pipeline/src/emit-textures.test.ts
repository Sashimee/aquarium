import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeTextureEntries } from './emit.ts';

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
