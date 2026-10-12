import type { CameraMode } from './camera';

/** Typed bus between the React overlay and the camera/input layer. */
export interface InteractionEvents {
  'camera:request-mode': { mode: CameraMode };
  'camera:mode-changed': { mode: CameraMode };
}
