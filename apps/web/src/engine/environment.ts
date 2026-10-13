import {
  EquirectangularReflectionMapping,
  LoadingManager,
  PMREMGenerator,
  type Scene,
  type Texture,
  type WebGPURenderer,
} from 'three/webgpu';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

/**
 * Manifest entry `polyhaven-studio_small_09` (CC0, Sergej Majboroda), loaded from Poly Haven
 * until the asset pipeline (T08) serves its own copy.
 */
export const DEFAULT_HDRI_URL =
  'https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/1k/studio_small_09_1k.hdr';

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
  scene.backgroundIntensity = 0.6;

  let hdri: Texture | null = null;
  let room: typeof roomTarget | null = roomTarget;
  let disposed = false;
  const manager = new LoadingManager();

  new HDRLoader(manager)
    .loadAsync(hdriUrl)
    .then((texture) => {
      if (disposed) {
        texture.dispose();
        return;
      }
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
    });

  return {
    initial: roomTarget.texture,
    dispose() {
      disposed = true;
      manager.abort();
      hdri?.dispose();
      room?.dispose();
      room = null;
    },
  };
}
