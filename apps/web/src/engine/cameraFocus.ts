import type { CameraMode } from '../interaction/camera';
import type { Engine } from './Engine';

/** Depth of field follows the focus camera; tiers without it leave the call a no-op. */
export function depthOfFieldFollowsCamera(
  engine: Pick<Engine, 'setFocusMode'>,
): (mode: CameraMode) => void {
  return (mode) => engine.setFocusMode(mode === 'focus');
}
