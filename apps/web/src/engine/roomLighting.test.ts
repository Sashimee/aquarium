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
  const drewStudio: PMREMGenerator[] = [];
  vi.spyOn(PMREMGenerator.prototype, 'fromScene').mockImplementation(function (
    this: PMREMGenerator,
  ) {
    drewStudio.push(this);
    return new RenderTarget(ROOM_CUBE_SIZE, ROOM_CUBE_SIZE);
  });
  const drewHdri: PMREMGenerator[] = [];
  const fromEquirectangular = vi.spyOn(PMREMGenerator.prototype, 'fromEquirectangular');
  fromEquirectangular.mockImplementation(function (this: PMREMGenerator, _hdri, target) {
    drewHdri.push(this);
    return target ?? new RenderTarget();
  });
  const disposed: PMREMGenerator[] = [];
  vi.spyOn(PMREMGenerator.prototype, 'dispose').mockImplementation(function (this: PMREMGenerator) {
    disposed.push(this);
  });
  return { fromEquirectangular, drewStudio, drewHdri, disposed };
}

describe('installRoomLighting', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('draws every HDRI with the studio generator and frees it only with the room', async () => {
    const { drewStudio, drewHdri, disposed } = spyGenerators();
    const hdri = bc6hHdri(4 * ROOM_CUBE_SIZE);
    const hdriDisposed = vi.fn();
    hdri.addEventListener('dispose', hdriDisposed);
    const onError = vi.fn();

    const lighting = installRoomLighting(renderer, ktx2Serving(hdri), new Scene(), 'hdri', onError);
    await vi.waitFor(() => expect(hdriDisposed).toHaveBeenCalledOnce());
    await lighting.bake('other', 0);

    expect(drewStudio).toHaveLength(1);
    expect(drewHdri).toHaveLength(2);
    expect(drewHdri.every((generator) => generator === drewStudio[0])).toBe(true);
    expect(disposed).toHaveLength(0);
    expect(onError).not.toHaveBeenCalled();
    lighting.dispose();
    expect(disposed).toEqual(drewStudio);
  });

  it('keeps the generator and the studio when drawing the HDRI throws', async () => {
    const { fromEquirectangular, drewStudio, disposed } = spyGenerators();
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
    expect(disposed).toHaveLength(0);
    expect(scene.environment).toBe(lighting.texture);
    lighting.dispose();
    expect(disposed).toEqual(drewStudio);
  });
});
