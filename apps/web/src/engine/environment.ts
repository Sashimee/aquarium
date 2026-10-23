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
import { abortError, raceAbort } from '../scene/abortable';

/** Manifest entry `polyhaven-studio_small_09` (CC0, Sergej Majboroda), served from our own origin. */
export const DEFAULT_HDRI_URL = `${ASSET_BASE}hdri/studio-small-09/studio_small_09_1k.ktx2`;

/**
 * Without a compressed HDR format KTX2Loader transcodes to RGBA half-float but still returns a
 * CompressedTexture, which the WebGPU backend uploads as rgba8unorm and then throws on. Raw
 * half-float data goes in a DataTexture; BC6H stays compressed.
 */
export function uploadableHdri(texture: CompressedTexture): CompressedTexture | DataTexture {
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
   * The room's PMREM. The procedural studio is drawn into it at once and each HDRI over it once
   * that has loaded, so it is the same texture for the life of the scene.
   */
  readonly texture: Texture;
  /**
   * Draws the HDRI at `hdriUrl`, or the default studio for null, into the PMREM and turns the
   * environment and background `yaw` radians about +Y. Rejects with an AbortError when `signal`
   * aborts or a later bake overtakes this one; the PMREM then keeps what it had.
   */
  bake(hdriUrl: string | null, yaw: number, signal?: AbortSignal): Promise<void>;
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

  const baker = hdriBaker({
    ktx2,
    scene,
    defaultUrl: hdriUrl,
    draw: (hdri) => {
      const generator = new PMREMGenerator(renderer);
      try {
        generator.fromEquirectangular(hdri, room);
      } finally {
        generator.dispose();
      }
    },
  });

  baker.bake(null, 0).catch((cause: unknown) => {
    if (!baker.disposed && !isAbort(cause)) {
      onError(`Could not load the room HDRI from ${hdriUrl}`, cause);
    }
  });

  return {
    texture: room.texture,
    bake: baker.bake,
    dispose() {
      baker.dispose();
      room.dispose();
    },
  };
}

export interface HdriBakerOptions {
  readonly ktx2: Pick<Ktx2Textures, 'loadAsync'>;
  readonly scene: Pick<Scene, 'environmentRotation' | 'backgroundRotation'>;
  /** What a bake of null draws. */
  readonly defaultUrl: string;
  /** Draws a loaded 1k equirectangular HDRI into the room's PMREM. */
  draw(hdri: Texture): void;
}

export interface HdriBaker {
  readonly disposed: boolean;
  bake: RoomLighting['bake'];
  dispose(): void;
}

/**
 * Loads HDRIs and hands each to `draw`, the last asked for winning: one a later bake overtook
 * is freed undrawn. The environment and background turn to a bake's yaw as it is drawn, so the
 * picture and its rotation change together.
 */
export function hdriBaker(options: HdriBakerOptions): HdriBaker {
  const { ktx2, scene } = options;
  let disposed = false;
  let latest = 0;

  const overtaken = () => new DOMException('A newer room HDRI replaced this one', 'AbortError');

  const bake = async (url: string | null, yaw: number, signal?: AbortSignal): Promise<void> => {
    const generation = ++latest;
    const source = url ?? options.defaultUrl;
    const download = ktx2.loadAsync(source);
    let loaded: CompressedTexture;
    try {
      loaded = await (signal ? raceAbort(download, signal) : download);
    } catch (cause) {
      download.then(
        (late) => late.dispose(),
        () => undefined,
      );
      throw cause;
    }
    if (disposed || generation !== latest || signal?.aborted) {
      loaded.dispose();
      if (signal?.aborted) throw abortError(signal);
      throw overtaken();
    }
    const hdri = uploadableHdri(loaded);
    try {
      const { width } = hdri.image;
      if (pmremCubeSize(width) !== ROOM_CUBE_SIZE) {
        throw new Error(
          `The HDRI ${source} is ${width} texels wide; the room needs a 1k map (${4 * ROOM_CUBE_SIZE} wide)`,
        );
      }
      hdri.mapping = EquirectangularReflectionMapping;
      options.draw(hdri);
    } finally {
      hdri.dispose();
    }
    scene.environmentRotation.set(0, yaw, 0);
    scene.backgroundRotation.set(0, yaw, 0);
  };

  return {
    get disposed() {
      return disposed;
    },
    bake,
    dispose() {
      disposed = true;
      latest++;
    },
  };
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
