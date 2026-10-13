import {
  DataTexture,
  EquirectangularReflectionMapping,
  HalfFloatType,
  LinearFilter,
  LinearSRGBColorSpace,
  LoadingManager,
  PMREMGenerator,
  RGBAFormat,
  type Scene,
  type CompressedTexture,
  type Texture,
  type WebGPURenderer,
} from 'three/webgpu';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { ASSET_BASE, rewriteAssetUrl } from '../scene/assets';

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

export interface RoomLighting {
  /** The procedural studio installed at once; `onChange` reports the swap to the HDRI. */
  readonly initial: Texture;
  dispose(): void;
}

/**
 * Lights the room with a procedural studio at once, then swaps in the HDRI when it has
 * loaded. A failed download keeps the procedural studio and reports through `onError`.
 */
export function installRoomLighting(
  renderer: WebGPURenderer,
  scene: Scene,
  hdriUrl: string,
  onError: (message: string, cause: unknown) => void,
  onChange: (environment: Texture) => void,
): RoomLighting {
  const pmrem = new PMREMGenerator(renderer);
  const studio = new RoomEnvironment();
  const roomTarget = pmrem.fromScene(studio, 0.04);
  studio.dispose();
  pmrem.dispose();

  scene.environment = roomTarget.texture;
  scene.background = roomTarget.texture;
  scene.backgroundBlurriness = 0.35;
  scene.backgroundIntensity = 0.45;

  let hdri: Texture | null = null;
  let room: typeof roomTarget | null = roomTarget;
  let disposed = false;
  const manager = new LoadingManager();
  manager.setURLModifier((url) => rewriteAssetUrl(url, 1024));
  const loader = new KTX2Loader(manager).setTranscoderPath('basis/').detectSupport(renderer);
  let loaderDisposed = false;
  const releaseLoader = (): void => {
    if (loaderDisposed) return;
    loaderDisposed = true;
    loader.dispose();
  };

  loader
    .loadAsync(hdriUrl)
    .then((loaded) => {
      if (disposed) {
        loaded.dispose();
        return;
      }
      const texture = uploadableHdri(loaded);
      texture.mapping = EquirectangularReflectionMapping;
      hdri = texture;
      scene.environment = texture;
      scene.background = texture;
      onChange(texture);
      room?.dispose();
      room = null;
    })
    .catch((cause: unknown) => {
      if (!disposed) onError(`Could not load the room HDRI from ${hdriUrl}`, cause);
    })
    .finally(releaseLoader);

  return {
    initial: roomTarget.texture,
    dispose() {
      disposed = true;
      manager.abort();
      releaseLoader();
      hdri?.dispose();
      room?.dispose();
      room = null;
    },
  };
}
