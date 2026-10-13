import type { CareAction, Fish, FoodType, Water } from '@aquarium/shared';
import type { CameraMode } from './camera';

/** A pinch, not a pile: leftovers poison the tank, so hand-feeding stays small. */
export const HAND_FEED_PORTION = 0.5;

export type PlayTool = 'tap' | 'feed' | 'laser' | 'wand' | 'net';

/** Typed bus between the React overlay and the camera/input layer. */
export interface InteractionEvents {
  'camera:request-mode': { mode: CameraMode };
  'camera:mode-changed': { mode: CameraMode };
  'play:request-tool': { tool: PlayTool };
  'play:tool-changed': { tool: PlayTool };
  /** The food chosen in the UI; hand-feed drops this one. */
  'feed:select': { food: FoodType };
  /** The tank scene is built and the play tools work. */
  'play:ready': Record<string, never>;
  'feed:request': { food: FoodType; portion: number };
  /** Food went into the water; the persistence layer posts the feed action. */
  'feed:dropped': { food: FoodType; portion: number; particles: number };
  'feed:rejected': { reason: 'rate-limited' | 'tank-full'; retryAfterMs: number };
  /** Fish ate food; the persistence layer batches these into ate reports. */
  'food:ate': { eaten: readonly { fishId: string; portion: number }[] };
  /** Uneaten food dissolved on the substrate. */
  'food:expired': { count: number };

  /**
   * The saved tank became the active one. The fish system builds its fish from `fish`, putting
   * dead ones at the surface, and keeps the demo tank's fish out while this one is active.
   */
  'tank:loaded': { tankId: string; biome: 'freshwater' | 'reef'; fish: readonly Fish[] };
  /** The active saved tank went away (switch or sign-out); drop its fish. */
  'tank:unloaded': { tankId: string };
  /** A fish joined. `acclimate` means it starts in a floating bag until `tank:fish-released`. */
  'tank:fish-added': { tankId: string; fish: Fish; acclimate: boolean };
  'tank:fish-released': { tankId: string; fishId: string };
  /** The fish died: erratic swim, then belly-up at the surface. */
  'tank:fish-died': { tankId: string; fish: Fish };
  /** Netted, or removed on another device. */
  'tank:fish-removed': { tankId: string; fishId: string; reason: 'netted' | 'gone' };
  'tank:water': { tankId: string; water: Water };
  /** A care action succeeded on the server; scenes can play the matching visual. */
  'tank:care': { tankId: string; action: CareAction['type'] };
  /** Emitted by the fish system when the net tool taps a dead fish. */
  'net:tap': { fishId: string };
}
