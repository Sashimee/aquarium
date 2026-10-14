import {
  CompressedTexture,
  DataTexture,
  HalfFloatType,
  LinearFilter,
  LinearSRGBColorSpace,
  RGBAFormat,
  RGB_BPTC_UNSIGNED_Format,
} from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import assetIndex from '../../public/assets/index.json';
import { DEFAULT_HDRI_URL, uploadableHdri } from './environment';
import environmentSource from './environment.ts?raw';

const ORIGIN = 'https://devfish.bas.lu';

describe('room HDRI', () => {
  it('is fetched from the page origin, never a third party', () => {
    expect(new URL(DEFAULT_HDRI_URL, `${ORIGIN}/`).origin).toBe(ORIGIN);
    expect(DEFAULT_HDRI_URL).not.toMatch(/^[a-z][a-z0-9+.-]*:|^\/\//i);
  });

  it('points at a file listed in assets/index.json', () => {
    const files = assetIndex.assets
      .filter((asset) => asset.kind === 'hdri')
      .flatMap((asset) => asset.files.map((f) => f.file));
    const relative = DEFAULT_HDRI_URL.slice(DEFAULT_HDRI_URL.indexOf('assets/') + 'assets/'.length);
    expect(files).toContain(relative);
  });

  it('keeps no third-party URL in the module source', () => {
    expect(environmentSource).not.toMatch(/https?:\/\//);
  });
});

describe('uploadableHdri', () => {
  const pixels = new Uint16Array(4 * 4 * 4).fill(0x3c00);

  it('rewraps raw half-float data, which WebGPU cannot upload as a compressed texture', () => {
    const transcoded = new CompressedTexture(
      [{ data: pixels, width: 4, height: 4 }],
      4,
      4,
      // three's types reject RGBAFormat here, but KTX2Loader really returns this texture
      RGBAFormat as never,
      HalfFloatType,
    );
    transcoded.colorSpace = LinearSRGBColorSpace;
    const texture = uploadableHdri(transcoded);
    expect(texture).toBeInstanceOf(DataTexture);
    expect(texture.format).toBe(RGBAFormat);
    expect(texture.type).toBe(HalfFloatType);
    expect(texture.image).toMatchObject({ width: 4, height: 4 });
    expect((texture.image as { data: Uint16Array }).data).toBe(pixels);
    expect(texture.colorSpace).toBe(LinearSRGBColorSpace);
    expect(texture.minFilter).toBe(LinearFilter);
    expect(texture.magFilter).toBe(LinearFilter);
    expect(texture.flipY).toBe(false);
    expect(texture.generateMipmaps).toBe(false);
  });

  it('keeps BC6H compressed', () => {
    const bc6h = new CompressedTexture(
      [{ data: new Uint8Array(16), width: 4, height: 4 }],
      4,
      4,
      RGB_BPTC_UNSIGNED_Format,
      HalfFloatType,
    );
    expect(uploadableHdri(bc6h)).toBe(bc6h);
  });

  it('refuses raw data that is not half-float', () => {
    const wrong = new CompressedTexture(
      [{ data: new Uint8Array(64), width: 4, height: 4 }],
      4,
      4,
      // three's types reject RGBAFormat here, but KTX2Loader really returns this texture
      RGBAFormat as never,
    );
    expect(() => uploadableHdri(wrong)).toThrow('half-float');
  });
});
