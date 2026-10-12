import type { FoodType } from '@aquarium/shared';
import type { CameraMode } from './camera';

export type PlayTool = 'tap' | 'feed' | 'laser' | 'wand';

/** Typed bus between the React overlay and the camera/input layer. */
export interface InteractionEvents {
  'camera:request-mode': { mode: CameraMode };
  'camera:mode-changed': { mode: CameraMode };
  'play:request-tool': { tool: PlayTool };
  'play:tool-changed': { tool: PlayTool };
  'feed:request': { food: FoodType; portion: number };
  /** Food went into the water; the persistence layer posts the feed action. */
  'feed:dropped': { food: FoodType; portion: number; particles: number };
  'feed:rejected': { reason: 'rate-limited' | 'tank-full'; retryAfterMs: number };
  /** Fish ate food; the persistence layer batches these into ate reports. */
  'food:ate': { eaten: readonly { fishId: string; portion: number }[] };
  /** Uneaten food dissolved on the substrate. */
  'food:expired': { count: number };
}
