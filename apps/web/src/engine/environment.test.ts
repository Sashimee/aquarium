import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CompressedTexture,
  DataTexture,
  HalfFloatType,
  LinearFilter,
  LinearSRGBColorSpace,
  RGBAFormat,
  RGB_BPTC_UNSIGNED_Format,
  Scene,
  type Texture,
} from 'three/webgpu';
import { describe, expect, it, vi } from 'vitest';
import assetIndex from '../../public/assets/index.json';
import {
  DEFAULT_HDRI_URL,
  hdriBaker,
  pmremCubeSize,
  ROOM_CUBE_SIZE,
  uploadableHdri,
} from './environment';
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

  it('fits the PMREM the studio is drawn into, so the HDRI can be drawn over it', () => {
    const relative = DEFAULT_HDRI_URL.slice(DEFAULT_HDRI_URL.indexOf('assets/') + 'assets/'.length);
    const ktx2 = readFileSync(join(__dirname, '../../public/assets', relative));
    const pixelWidth = new DataView(ktx2.buffer, ktx2.byteOffset).getUint32(20, true);
    expect(pmremCubeSize(pixelWidth)).toBe(ROOM_CUBE_SIZE);
  });
});

describe('pmremCubeSize', () => {
  it("matches three's power-of-two cube face for an equirectangular width", () => {
    expect(pmremCubeSize(1024)).toBe(256);
    expect(pmremCubeSize(2048)).toBe(512);
    expect(pmremCubeSize(1000)).toBe(128);
    expect(pmremCubeSize(1023)).toBe(128);
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

describe('hdriBaker', () => {
  const hdri = (width = 1024) =>
    new CompressedTexture(
      [{ data: new Uint8Array(width * (width / 2)), width, height: width / 2 }],
      width,
      width / 2,
      RGB_BPTC_UNSIGNED_Format,
      HalfFloatType,
    );

  function setup() {
    const pending = new Map<string, (texture: CompressedTexture) => void>();
    const failures = new Map<string, (cause: Error) => void>();
    const ktx2 = {
      loadAsync: vi.fn(
        (url: string) =>
          new Promise<CompressedTexture>((resolve, reject) => {
            pending.set(url, resolve);
            failures.set(url, reject);
          }),
      ),
    };
    const scene = new Scene();
    const drawn: Texture[] = [];
    const baker = hdriBaker({
      ktx2,
      scene,
      defaultUrl: 'studio.ktx2',
      draw: (texture) => drawn.push(texture),
    });
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
    return { ktx2, scene, drawn, baker, pending, failures, settle };
  }

  it('draws the HDRI, then turns the environment and background to its yaw', async () => {
    const { baker, pending, scene, drawn, settle } = setup();
    const baked = baker.bake('hall.ktx2', 0.145);
    await settle();
    expect(scene.environmentRotation.y).toBe(0);
    const texture = hdri();
    const freed = vi.spyOn(texture, 'dispose');
    pending.get('hall.ktx2')?.(texture);
    await baked;
    expect(drawn).toEqual([texture]);
    expect(freed).toHaveBeenCalled();
    expect(scene.environmentRotation.y).toBe(0.145);
    expect(scene.backgroundRotation.y).toBe(0.145);
  });

  it('loads the default studio for null and puts the yaw back', async () => {
    const { baker, pending, ktx2, scene, settle } = setup();
    scene.environmentRotation.y = 0.145;
    scene.backgroundRotation.y = 0.145;
    const baked = baker.bake(null, 0);
    await settle();
    expect(ktx2.loadAsync).toHaveBeenCalledWith('studio.ktx2');
    pending.get('studio.ktx2')?.(hdri());
    await baked;
    expect(scene.environmentRotation.y).toBe(0);
    expect(scene.backgroundRotation.y).toBe(0);
  });

  it('frees an HDRI a later bake overtook without drawing it', async () => {
    const { baker, pending, drawn, scene, settle } = setup();
    const first = baker.bake('cabin.ktx2', 0.3);
    const second = baker.bake('hall.ktx2', 0.145);
    await settle();
    const stale = hdri();
    const freed = vi.spyOn(stale, 'dispose');
    const fresh = hdri();
    pending.get('hall.ktx2')?.(fresh);
    await second;
    pending.get('cabin.ktx2')?.(stale);
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    expect(freed).toHaveBeenCalled();
    expect(drawn).toEqual([fresh]);
    expect(scene.environmentRotation.y).toBe(0.145);
  });

  it('rejects at once on abort and frees the HDRI when it arrives', async () => {
    const { baker, pending, drawn, settle } = setup();
    const controller = new AbortController();
    const baked = baker.bake('hall.ktx2', 0.145, controller.signal);
    controller.abort();
    await expect(baked).rejects.toMatchObject({ name: 'AbortError' });
    const late = hdri();
    const freed = vi.spyOn(late, 'dispose');
    pending.get('hall.ktx2')?.(late);
    await settle();
    expect(freed).toHaveBeenCalled();
    expect(drawn).toEqual([]);
  });

  it('keeps the PMREM and yaw when the download fails or the HDRI is the wrong size', async () => {
    const { baker, pending, failures, drawn, scene, settle } = setup();
    const missing = baker.bake('gone.ktx2', 0.5);
    await settle();
    failures.get('gone.ktx2')?.(new Error('HTTP 404'));
    await expect(missing).rejects.toThrow('HTTP 404');
    const wide = baker.bake('2k.ktx2', 0.5);
    await settle();
    const big = hdri(2048);
    const freed = vi.spyOn(big, 'dispose');
    pending.get('2k.ktx2')?.(big);
    await expect(wide).rejects.toThrow('1k map');
    expect(freed).toHaveBeenCalled();
    expect(drawn).toEqual([]);
    expect(scene.environmentRotation.y).toBe(0);
  });

  it('draws nothing once disposed', async () => {
    const { baker, pending, drawn, settle } = setup();
    const baked = baker.bake('hall.ktx2', 0.145);
    await settle();
    baker.dispose();
    pending.get('hall.ktx2')?.(hdri());
    await expect(baked).rejects.toMatchObject({ name: 'AbortError' });
    expect(baker.disposed).toBe(true);
    expect(drawn).toEqual([]);
  });
});

describe('room HDRIs', () => {
  it('are each a 1k map that fits the PMREM the studio is drawn into', () => {
    const files = assetIndex.assets
      .filter((asset) => asset.kind === 'hdri')
      .flatMap((asset) => asset.files.map((f) => f.file));
    expect(files.length).toBeGreaterThan(1);
    for (const file of files) {
      const ktx2 = readFileSync(join(__dirname, '../../public/assets', file));
      const pixelWidth = new DataView(ktx2.buffer, ktx2.byteOffset).getUint32(20, true);
      expect(pmremCubeSize(pixelWidth), file).toBe(ROOM_CUBE_SIZE);
    }
  });
});
