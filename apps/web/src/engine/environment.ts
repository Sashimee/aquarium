import {
  DataTexture,
  EquirectangularReflectionMapping,
  HalfFloatType,
  LinearFilter,
  LinearSRGBColorSpace,
  PMREMGenerator,
  RGBAFormat,
  type Scene,
  type CompressedTexture,
  type Texture,
  type WebGPURenderer,
} from 'three/webgpu';
import type { Ktx2Textures } from './ktx2';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { ASSET_BASE } from '../scene/assets';

/** Manifest entry `polyhaven-studio_small_09` (CC0, Sergej Majboroda), served from our own origin. */
export const DEFAULT_HDRI_URL = `${ASSET_BASE}hdri/studio-small-09/studio_small_09_1k.ktx2`;

/**
 * Without a compressed HDR format KTX2Loader transcodes to RGBA half-float but still returns a
 * CompressedTexture, which the WebGPU backend uploads as rgba8unorm and then throws on. Raw
 * half-float data goes in a DataTexture; BC6H stays compressed.
 */
export function uploadableHdri(texture: CompressedTexture): Texture {
  // KTX2Loader passes RGBAFormat here although the type only admits compressed formats.
  if ((texture.format as number) !== RGBAFormat) return texture;
  const level = texture.mipmaps?.[0];
  if (!level?.data) throw new Error('The transcoded HDRI has no pixel data');
  if (texture.type !== HalfFloatType) {
    throw new Error(`The transcoded HDRI is raw data of type ${texture.type}, expected half-float`);
  }
  const raw = new DataTexture(
    level.data as Uint16Array,
    level.width,
    level.height,
    RGBAFormat,
    HalfFloatType,
  );
  raw.colorSpace = texture.colorSpace === '' ? LinearSRGBColorSpace : texture.colorSpace;
  raw.minFilter = LinearFilter;
  raw.magFilter = LinearFilter;
  raw.generateMipmaps = false;
  raw.flipY = false;
  raw.needsUpdate = true;
  texture.dispose();
  return raw;
}

/** Edge of each cube face in the room's PMREM: what three picks for a 1k equirectangular map. */
export const ROOM_CUBE_SIZE = 256;

/** The cube face edge three's PMREMGenerator picks for an equirectangular map `width` texels wide. */
export function pmremCubeSize(width: number): number {
  return 2 ** Math.floor(Math.log2(width / 4));
}

export interface RoomLighting {
  /**
   * The room's PMREM. The procedural studio is drawn into it at once and the HDRI over it once
   * that has loaded, so it is the same texture for the life of the scene.
   */
  readonly texture: Texture;
  dispose(): void;
}

/**
 * Lights the room with a procedural studio at once, then draws the HDRI into the same PMREM when
 * it has loaded. A failed download keeps the procedural studio and reports through `onError`.
 *
 * The HDRI must not get a texture of its own: three rebinds textures only for materials whose
 * own properties changed, so materials lit through `scene.environmentNode` would go on sampling
 * the studio's texture. Once that was freed, WebGL bound a deleted texture and the sampler unit
 * kept whatever was bound before it, such as a shadow map.
 */
export function installRoomLighting(
  renderer: WebGPURenderer,
  ktx2: Ktx2Textures,
  scene: Scene,
  hdriUrl: string,
  onError: (message: string, cause: unknown) => void,
): RoomLighting {
  const studio = new RoomEnvironment();
  const studioGenerator = new PMREMGenerator(renderer);
  const room = studioGenerator.fromScene(studio, 0.04, undefined, undefined, {
    size: ROOM_CUBE_SIZE,
  });
  studio.dispose();
  studioGenerator.dispose();

  scene.environment = room.texture;
  scene.background = room.texture;
  scene.backgroundBlurriness = 0.35;
  scene.backgroundIntensity = 0.45;

  let disposed = false;

  ktx2
    .loadAsync(hdriUrl)
    .then((loaded) => {
      if (disposed) {
        loaded.dispose();
        return;
      }
      const hdri = uploadableHdri(loaded);
      try {
        const { width } = hdri.image as { width: number };
        if (pmremCubeSize(width) !== ROOM_CUBE_SIZE) {
          throw new Error(
            `The HDRI is ${width} texels wide; the room needs a 1k map (${4 * ROOM_CUBE_SIZE} wide)`,
          );
        }
        hdri.mapping = EquirectangularReflectionMapping;
        const generator = new PMREMGenerator(renderer);
        generator.fromEquirectangular(hdri, room);
        generator.dispose();
      } finally {
        hdri.dispose();
      }
    })
    .catch((cause: unknown) => {
      if (!disposed) onError(`Could not load the room HDRI from ${hdriUrl}`, cause);
    });

  return {
    texture: room.texture,
    dispose() {
      disposed = true;
      room.dispose();
    },
  };
}
