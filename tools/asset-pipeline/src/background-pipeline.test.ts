import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BACKGROUND_MAX_BYTES, BACKGROUND_TIERS } from '@aquarium/shared';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  QUALITY_LADDER,
  backgroundContentProblems,
  backgroundFile,
  backgroundFileProblems,
  cropProblems,
  deriveTierImages,
  encodeWithinBudget,
  ktx2KeyValueKeys,
  missingBackgroundProblems,
} from './backgrounds.ts';
import { assetIndexSchema, type OutputAsset } from './index-schema.ts';
import { manifestSchema } from './manifest.ts';
import { applyDepthOfField, blurSigma, distanceFromDepthByte } from './misty-lake.ts';
import { encodeKtx2 } from './textures.ts';

const root = join(import.meta.dirname, '../../..');
const readJson = (path: string): unknown => JSON.parse(readFileSync(join(root, path), 'utf8'));

describe('cropProblems', () => {
  const source = { width: 4000, height: 3000 };

  it('accepts a 2:1 box inside the source that is wide enough', () => {
    expect(cropProblems({ left: 0, top: 500, width: 4000, height: 2000 }, source)).toEqual([]);
  });

  it('rejects a box that is not 2:1', () => {
    expect(cropProblems({ left: 0, top: 0, width: 4000, height: 2001 }, source)).toEqual([
      'crop 4000x2001 is not 2:1',
    ]);
  });

  it('rejects a box under the high-tier width', () => {
    const problems = cropProblems({ left: 0, top: 0, width: 2046, height: 1023 }, source);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('under the 2048 px');
  });

  it('rejects a box that leaves the source on either axis', () => {
    expect(cropProblems({ left: 1, top: 0, width: 4000, height: 2000 }, source)).toHaveLength(1);
    expect(cropProblems({ left: 0, top: 1001, width: 4000, height: 2000 }, source)).toHaveLength(1);
  });

  it('rejects fractional and negative values before anything else', () => {
    expect(cropProblems({ left: 0.5, top: 0, width: 4000, height: 2000 }, source)).toEqual([
      'crop.left must be an integer >= 0',
    ]);
    expect(cropProblems({ left: 0, top: -1, width: 4000, height: 2000 }, source)).toEqual([
      'crop.top must be an integer >= 0',
    ]);
  });
});

describe('encodeWithinBudget', () => {
  const sizes = (bySize: Record<number, number>) => async (q: number) =>
    new Uint8Array(bySize[q] ?? 0);

  it('returns the highest quality that fits', async () => {
    const result = await encodeWithinBudget(sizes({ 192: 700, 160: 600, 128: 500 }), 600);
    expect(result.qualityLevel).toBe(160);
    expect(result.bytes.byteLength).toBe(600);
  });

  it('stops at the first fit instead of encoding the whole ladder', async () => {
    const tried: number[] = [];
    await encodeWithinBudget(async (q) => {
      tried.push(q);
      return new Uint8Array(10);
    }, 600);
    expect(tried).toEqual([QUALITY_LADDER[0]]);
  });

  it('throws naming the smallest size when nothing fits', async () => {
    await expect(
      encodeWithinBudget(async (q) => new Uint8Array(1000 + q), 600, [200, 100]),
    ).rejects.toThrow(/quality 100 is 1100 bytes, over the 600 byte budget/);
  });
});

describe('deriveTierImages', () => {
  async function source(orientation?: number): Promise<Buffer> {
    const red = await sharp({
      create: { width: 400, height: 300, channels: 3, background: { r: 255, g: 0, b: 0 } },
    })
      .png()
      .toBuffer();
    const base = sharp({
      create: { width: 2400, height: 1400, channels: 3, background: { r: 0, g: 0, b: 255 } },
    }).composite([{ input: red, left: 100, top: 50 }]);
    const upright = await base.png().toBuffer();
    if (orientation === undefined) {
      return sharp(upright)
        .withExif({ IFD0: { Copyright: 'tester-secret-1234', Artist: 'tester-secret-5678' } })
        .jpeg({ quality: 100, chromaSubsampling: '4:4:4' })
        .toBuffer();
    }
    return sharp(upright)
      .rotate(270)
      .withMetadata({ orientation })
      .jpeg({ quality: 100, chromaSubsampling: '4:4:4' })
      .toBuffer();
  }

  const pixel = (image: { width: number; data: Uint8Array }, x: number, y: number) => {
    const at = (y * image.width + x) * 4;
    return [image.data[at], image.data[at + 1], image.data[at + 2]] as const;
  };

  it('crops to the box, then resizes to every tier', async () => {
    const { tiers, crop } = await deriveTierImages(await source(), {
      left: 100,
      top: 50,
      width: 2200,
      height: 1100,
    });
    expect(crop).toEqual({ left: 100, top: 50, width: 2200, height: 1100 });
    for (const [tier, [width, height]] of Object.entries(BACKGROUND_TIERS)) {
      const image = tiers[tier as keyof typeof tiers];
      expect([image.width, image.height]).toEqual([width, height]);
      expect(image.data.byteLength).toBe(width * height * 4);
    }
    const low = tiers.low;
    const [r, , b] = pixel(low, 4, 4);
    expect(r).toBeGreaterThan(240);
    expect(b).toBeLessThan(15);
    const [r2, , b2] = pixel(low, low.width - 5, low.height - 5);
    expect(r2).toBeLessThan(15);
    expect(b2).toBeGreaterThan(240);
  });

  it('applies the EXIF orientation before the crop box is read', async () => {
    const oriented = await source(6);
    expect((await sharp(oriented).metadata()).width).toBe(1400);
    const { tiers } = await deriveTierImages(oriented, {
      left: 100,
      top: 50,
      width: 2200,
      height: 1100,
    });
    const [r, , b] = pixel(tiers.low, 4, 4);
    expect(r).toBeGreaterThan(240);
    expect(b).toBeLessThan(15);
  });

  it('refuses a crop that does not fit and says why', async () => {
    await expect(
      deriveTierImages(await source(), { left: 500, top: 0, width: 2200, height: 1100 }),
    ).rejects.toThrow(/does not fit the 2400x1400 source/);
  });

  it('takes the whole image when the manifest gives no crop', async () => {
    const wide = await sharp({
      create: { width: 4096, height: 2048, channels: 3, background: '#336699' },
    })
      .png()
      .toBuffer();
    const { crop } = await deriveTierImages(wide, null);
    expect(crop).toEqual({ left: 0, top: 0, width: 4096, height: 2048 });
  });

  it('writes a KTX2 with no EXIF text and no key/value entry beyond the writer', async () => {
    const { tiers } = await deriveTierImages(await source(), {
      left: 100,
      top: 50,
      width: 2200,
      height: 1100,
    });
    const ktx2 = await encodeKtx2(tiers.low, {
      codec: 'etc1s',
      colorSpace: 'srgb',
      role: 'baseColor',
    });
    const text = Buffer.from(ktx2).toString('latin1');
    expect(text).not.toContain('tester-secret');
    expect(text).not.toContain('Exif');
    expect(ktx2KeyValueKeys(ktx2).filter((k) => k !== 'KTXwriter')).toEqual([]);
  }, 60_000);
});

describe('blur and depth of field', () => {
  const params = { near: 1.5, far: 14, focus: 3.6 };

  it('leaves the focus plane sharp and softens farther objects more', () => {
    expect(blurSigma(3.6, 3.6)).toBe(0);
    expect(blurSigma(6, 3.6)).toBeGreaterThan(blurSigma(4, 3.6));
    expect(blurSigma(60, 3.6)).toBeLessThanOrEqual(11);
  });

  it('blurs the foreground less than the same distance behind the focus', () => {
    expect(blurSigma(1.6, 3.6)).toBeLessThan(blurSigma(5.6, 3.6));
  });

  it('decodes the depth byte linearly between near and far', () => {
    expect(distanceFromDepthByte(0, params)).toBe(1.5);
    expect(distanceFromDepthByte(255, params)).toBe(14);
  });

  it('takes sharp pixels at the focus plane and the blurriest level far away', () => {
    const levels = [0, 50, 100, 150, 200].map((v) => new Uint8Array([v, v, v, v, v, v]));
    const focusByte = Math.round(((3.6 - 1.5) / (14 - 1.5)) * 255);
    const out = applyDepthOfField(levels, new Uint8Array([focusByte, 255]), params, 2, 3);
    expect(out[0]).toBeLessThan(10);
    expect(out[3]).toBe(200);
  });

  it('refuses a wrong number of blur levels', () => {
    expect(() => applyDepthOfField([new Uint8Array(3)], new Uint8Array(1), params, 1, 3)).toThrow(
      /blur levels/,
    );
  });
});

function fakeBackground(bytes: number): OutputAsset {
  const tier = (name: 'high' | 'mid' | 'low') => ({
    file: backgroundFile('bg-x', name),
    bytes,
    sha256: 'a'.repeat(64),
    width: BACKGROUND_TIERS[name][0],
    height: BACKGROUND_TIERS[name][1],
    qualityLevel: 128,
  });
  return {
    id: 'bg-x',
    kind: 'background',
    origin: 'photo',
    sources: ['bg-x'],
    licence: 'CC0-1.0',
    modifications: ['cropped'],
    lods: [],
    textures: [],
    files: [],
    background: { crop: null, tiers: { high: tier('high'), mid: tier('mid'), low: tier('low') } },
  };
}

describe('background checks', () => {
  it('passes an asset inside the size budget', () => {
    expect(backgroundFileProblems(fakeBackground(BACKGROUND_MAX_BYTES), () => null)).toEqual([]);
  });

  it('fails a tier one byte over the budget', () => {
    const problems = backgroundFileProblems(fakeBackground(BACKGROUND_MAX_BYTES + 1), () => null);
    expect(problems).toHaveLength(3);
    expect(problems[0]).toContain(`over the ${BACKGROUND_MAX_BYTES} byte background budget`);
  });

  it('fails a tier file that is not a complete KTX2', () => {
    const problems = backgroundFileProblems(fakeBackground(100), () => new Uint8Array(10));
    expect(problems).toHaveLength(3);
    expect(problems[0]).toContain('is unreadable');
  });

  it('fails an index entry with no background block', () => {
    const bare = fakeBackground(100);
    delete bare.background;
    expect(backgroundFileProblems(bare, () => null)).toEqual([
      'background bg-x: index entry has no background block (crop, tiers)',
    ]);
  });

  it('wants each content entry pointing at the high tier of a built asset', () => {
    const built = new Map([['bg-x', fakeBackground(100)]]);
    const ok = { id: 'bg-x', asset: 'bg-x', file: 'background/bg-x/high.ktx2' };
    expect(backgroundContentProblems([ok], built)).toEqual([]);
    expect(backgroundContentProblems([{ ...ok, file: null }], built)[0]).toContain('file is null');
    expect(backgroundContentProblems([{ ...ok, asset: 'bg-y' }], built)[0]).toContain(
      'not built into index.json',
    );
    expect(backgroundContentProblems([{ id: 'bg-z', asset: null, file: null }], built)).toEqual([]);
  });

  it('flags a downloaded manifest background that was never built', () => {
    const manifest = manifestSchema.parse(readJson('assets/manifest.json'));
    const entry = manifest.assets.find((a) => a.kind === 'background');
    if (!entry) throw new Error('manifest has no background');
    expect(missingBackgroundProblems(manifest.assets, new Map())).toHaveLength(
      manifest.assets.filter((a) => a.kind === 'background' && a.status === 'downloaded').length,
    );
    expect(
      missingBackgroundProblems(manifest.assets, new Map([[entry.id, fakeBackground(1)]])),
    ).toHaveLength(
      manifest.assets.filter((a) => a.kind === 'background' && a.status === 'downloaded').length -
        1,
    );
  });
});

describe('committed backgrounds', () => {
  const manifest = manifestSchema.parse(readJson('assets/manifest.json'));
  const index = assetIndexSchema.parse(readJson('apps/web/public/assets/index.json'));
  const backgrounds = manifest.assets.filter((a) => a.kind === 'background');

  it('builds every manifest background, each tier within the size budget', () => {
    expect(backgrounds).toHaveLength(10);
    for (const entry of backgrounds) {
      const built = index.assets.find((a) => a.kind === 'background' && a.id === entry.id);
      expect(built, `${entry.id} is not in index.json`).toBeDefined();
      for (const tier of Object.values(built?.background?.tiers ?? {})) {
        expect(tier.bytes, `${tier.file}`).toBeLessThanOrEqual(BACKGROUND_MAX_BYTES);
      }
    }
  });

  it('records the processing in the manifest modifications', () => {
    for (const entry of backgrounds) {
      expect(entry.modifications.join(' '), entry.id).toMatch(/KTX2/);
      expect(entry.modifications.join(' '), entry.id).toMatch(/metadata removed/);
    }
  });

  it('keeps every manifest crop 2:1 and inside its recorded source size', () => {
    for (const entry of backgrounds) {
      const crop = entry['crop'] as
        { left: number; top: number; width: number; height: number } | undefined;
      if (entry['source'] === 'render') {
        expect(crop, entry.id).toBeUndefined();
        continue;
      }
      const size = /^photo (\d+)x(\d+)$/.exec(String(entry['textures']));
      expect(size, `${entry.id}: textures must read "photo WxH"`).not.toBeNull();
      if (!crop) throw new Error(`${entry.id} has no crop`);
      expect(
        cropProblems(crop, { width: Number(size?.[1]), height: Number(size?.[2]) }),
        entry.id,
      ).toEqual([]);
    }
  });
});
