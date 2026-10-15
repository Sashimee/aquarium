import {
  CompressedTexture,
  PMREMGenerator,
  RenderTarget,
  RGB_BPTC_UNSIGNED_Format,
  Scene,
  type WebGPURenderer,
} from 'three/webgpu';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installRoomLighting, ROOM_CUBE_SIZE } from './environment';
import type { Ktx2Textures } from './ktx2';

const renderer = {} as unknown as WebGPURenderer;

function bc6hHdri(width: number): CompressedTexture {
  return new CompressedTexture([], width, width / 2, RGB_BPTC_UNSIGNED_Format);
}

function ktx2Serving(hdri: CompressedTexture): Ktx2Textures {
  return { load: vi.fn(), loadAsync: () => Promise.resolve(hdri) };
}

function spyGenerators() {
  vi.spyOn(PMREMGenerator.prototype, 'fromScene').mockImplementation(
    () => new RenderTarget(ROOM_CUBE_SIZE, ROOM_CUBE_SIZE),
  );
  const fromEquirectangular = vi.spyOn(PMREMGenerator.prototype, 'fromEquirectangular');
  const disposed: PMREMGenerator[] = [];
  vi.spyOn(PMREMGenerator.prototype, 'dispose').mockImplementation(function (this: PMREMGenerator) {
    disposed.push(this);
  });
  return { fromEquirectangular, disposed };
}

describe('installRoomLighting', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('draws the HDRI into the room PMREM and frees its generator and texture', async () => {
    const { fromEquirectangular, disposed } = spyGenerators();
    fromEquirectangular.mockImplementation((_hdri, target) => target ?? new RenderTarget());
    const hdri = bc6hHdri(4 * ROOM_CUBE_SIZE);
    const hdriDisposed = vi.fn();
    hdri.addEventListener('dispose', hdriDisposed);
    const onError = vi.fn();

    const lighting = installRoomLighting(renderer, ktx2Serving(hdri), new Scene(), 'hdri', onError);
    await vi.waitFor(() => expect(hdriDisposed).toHaveBeenCalledOnce());

    expect(fromEquirectangular).toHaveBeenCalledOnce();
    expect(disposed).toHaveLength(2);
    expect(onError).not.toHaveBeenCalled();
    lighting.dispose();
  });

  it('frees the HDRI generator when drawing the HDRI throws, and keeps the studio', async () => {
    const { fromEquirectangular, disposed } = spyGenerators();
    const failure = new Error('pipeline failed');
    fromEquirectangular.mockImplementation(() => {
      throw failure;
    });
    const scene = new Scene();
    const onError = vi.fn();

    const lighting = installRoomLighting(
      renderer,
      ktx2Serving(bc6hHdri(4 * ROOM_CUBE_SIZE)),
      scene,
      'hdri',
      onError,
    );
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());

    expect(onError).toHaveBeenCalledWith('Could not load the room HDRI from hdri', failure);
    expect(disposed).toHaveLength(2);
    expect(new Set(disposed).size).toBe(2);
    expect(scene.environment).toBe(lighting.texture);
    lighting.dispose();
  });
});
