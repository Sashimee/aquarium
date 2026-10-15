import type { DecorCollider } from '@aquarium/sim';
import type { CareAction, DecorLayout, Fish, FoodType, Water } from '@aquarium/shared';
import type { CameraMode } from './camera';

/** A pinch, not a pile: leftovers poison the tank, so hand-feeding stays small. */
export const HAND_FEED_PORTION = 0.5;

export type PlayTool = 'tap' | 'feed' | 'laser' | 'wand' | 'net';

export type DecorCommand =
  | { type: 'add'; assetId: string }
  | { type: 'select'; id: string | null }
  | { type: 'rotate'; id: string; radians: number }
  | { type: 'nudge'; id: string; dx: number; dz: number }
  | { type: 'remove'; id: string }
  | { type: 'retry-save' };

export interface DecorPaletteEntry {
  assetId: string;
  label: string;
  kind: string;
}

export interface DecorPieceView {
  id: string;
  label: string;
}

export interface DecorViewState {
  active: boolean;
  /** False for the demo tank, which has nowhere to save to. */
  persisted: boolean;
  palette: readonly DecorPaletteEntry[];
  pieces: readonly DecorPieceView[];
  selectedId: string | null;
  hasFeeder: boolean;
  /** Why the last change was refused, or null. */
  problem: string | null;
}

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

/** Typed bus between the React overlay and the camera/input layer. */
export interface InteractionEvents {
  'camera:request-mode': { mode: CameraMode };
  'camera:mode-changed': { mode: CameraMode };
  /** Follow was requested but there is no fish to follow. */
  'camera:follow-unavailable': Record<string, never>;
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
  'tank:loaded': {
    tankId: string;
    biome: 'freshwater' | 'reef';
    fish: readonly Fish[];
    decorLayout: DecorLayout;
  };
  /** The server's layout changed outside this tab's own edits (another device). */
  'tank:decor': { tankId: string; layout: DecorLayout };
  /**
   * The active saved tank went away; drop its fish. `switch` means another saved tank is on its
   * way (a switch, a new tank or a reload); `reset` means signed out or unverified.
   */
  'tank:unloaded': { tankId: string; reason: 'switch' | 'reset' };
  /**
   * No saved tank is coming: signed out, unverified, or the tank list failed to load. Sent even
   * when nothing was loaded, since a switch may already have unloaded the last tank.
   */
  'tank:none': Record<string, never>;
  /** The UI asks to show the other biome's demo tank (anonymous visitors, or no saved tank). */
  'demo:request-biome': { biome: 'freshwater' | 'reef' };
  /** The demo tank's biome, sent after each `demo:request-biome` that changed it. */
  'demo:biome-changed': { biome: 'freshwater' | 'reef' };
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
  'decor:request-mode': { active: boolean };
  'decor:mode-changed': { active: boolean };
  /** The decor code failed to load (message), or loaded after a failure (null). */
  'decor:load-failed': { message: string | null };
  'decor:command': DecorCommand;
  'decor:state': DecorViewState;
  /**
   * Collision proxies of every movable piece, in tank space (y = 0 under the bottom glass),
   * ids prefixed `decor:`. Sent on load and after each edit; the sim consumer replaces its
   * `decor:` colliders with this list and leaves its own (plants) alone.
   */
  'decor:colliders': { colliders: readonly DecorCollider[] };
  /** The player settled an edit; the persistence layer saves it. */
  'decor:layout': { tankId: string; layout: DecorLayout };
  'decor:save-state': { status: SaveStatus; message: string | null };
  /** Emitted by the fish system when the net tool taps a dead fish. */
  'net:tap': { fishId: string };
}

/** State the overlay reads when a lazily loaded view mounts after the event already fired. */
export const STICKY_INTERACTION_EVENTS: readonly (keyof InteractionEvents)[] = [
  'camera:mode-changed',
  'play:tool-changed',
  'play:ready',
  'demo:biome-changed',
  'decor:state',
  'decor:save-state',
  'decor:load-failed',
];
