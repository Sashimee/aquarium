import type {
  BackgroundId,
  Biome,
  CareAction,
  Collider,
  DecorLayout,
  Fish,
  FoodType,
  Plant,
  TankSize,
  Water,
} from '@aquarium/shared';
import type { PhotoFilter } from '../engine/photo/grade';
import type { PhotoState } from '../engine/photo/PhotoMode';
import type { PlantPick } from '../scene/plantGrowth';
import type { CameraMode } from './camera';
import type { GameView } from './play/game';

/** A pinch, not a pile: leftovers poison the tank, so hand-feeding stays small. */
export const HAND_FEED_PORTION = 0.5;

export type PlayTool =
  'tap' | 'feed' | 'laser' | 'wand' | 'net' | 'trim' | 'mirror' | 'ball' | 'game';

export type Toy = 'mirror' | 'ball';

export interface GameFishRef {
  id: string;
  name: string;
  species: string;
  /** The fish's own boldness, 0 to 1; the species figure alone is used without it. */
  boldness?: number;
}

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

/** What a save status report came from; the decor notice only clears for a layout save. */
export type SaveSource = 'layout' | 'background';

export type SaveStatus = 'idle' | 'saving' | 'retrying' | 'saved' | 'error';

export type PhotoMove = 'left' | 'right' | 'up' | 'down' | 'forward' | 'back';

export type PhotoCommand =
  | { type: 'enter' }
  | { type: 'exit' }
  | { type: 'filter'; filter: PhotoFilter }
  | { type: 'dof'; enabled?: boolean; focusDistance?: number; fStop?: number }
  | { type: 'fov'; degrees: number }
  | { type: 'freeze'; paused: boolean }
  | { type: 'hide-ui'; hidden: boolean }
  /** Starts or stops moving the eye, for an on-screen pad; the keyboard does the same. */
  | { type: 'hold'; move: PhotoMove; down: boolean }
  | { type: 'capture' };

export type PhotoCaptureFailure = 'timeout' | 'concurrent' | 'exited' | 'failed';

export type PhotoCaptureOutcome =
  | { status: 'done'; blob: Blob }
  | { status: 'failed'; reason: PhotoCaptureFailure; message: string };

export interface PhotoView {
  state: PhotoState;
  /** A capture is waiting for the render effects or drawing. */
  capturing: boolean;
}

/** Typed bus between the React overlay and the camera/input layer. */
export interface InteractionEvents {
  'camera:request-mode': { mode: CameraMode };
  'camera:mode-changed': { mode: CameraMode };
  /** Follow was requested but there is no fish to follow. */
  'camera:follow-unavailable': Record<string, never>;
  /** Focus the camera on the middle of these fish (server ids); the ones not on screen are skipped. */
  'camera:focus-fish': { fishIds: readonly string[] };
  'play:request-tool': { tool: PlayTool };
  'play:tool-changed': { tool: PlayTool };
  /** A tank the player may not feed locally (the shared tank): taps never drop food while locked. */
  'play:feed-lock': { locked: boolean };
  /** Which toys are in the tank; the play panel offers to remove them. */
  'toys:changed': { mirror: boolean; ball: boolean };
  'toys:remove': { toy: Toy };
  /** The feeding game's round, for the play panel. */
  'game:state': { view: GameView };
  /** `start` takes the live fish of the active tank; the game picks the shy one. */
  'game:request': { action: 'start'; fish: readonly GameFishRef[] } | { action: 'stop' };
  /** The food chosen in the UI; hand-feed drops this one. */
  'feed:select': { food: FoodType };
  /** The tank scene is built and the play tools work. */
  'play:ready': Record<string, never>;
  /** `keepSelection` drops food for someone else's feed without changing the food the player picked. */
  'feed:request': { food: FoodType; portion: number; keepSelection?: boolean };
  /** Food went into the water; the persistence layer posts the feed action. */
  'feed:dropped': { food: FoodType; portion: number; particles: number };
  'feed:rejected': { reason: 'rate-limited' | 'tank-full' | 'unreachable'; retryAfterMs: number };
  /** Fish ate food; the persistence layer batches these into ate reports. */
  'food:ate': { eaten: readonly { fishId: string; portion: number; foodId?: number }[] };
  /** Uneaten food dissolved on the substrate. */
  'food:expired': { count: number };

  /**
   * The saved tank became the active one. The fish system builds its fish from `fish`, putting
   * dead ones at the surface, and keeps the demo tank's fish out while this one is active.
   */
  'tank:loaded': {
    tankId: string;
    biome: Biome;
    size: TankSize;
    fish: readonly Fish[];
    decorLayout: DecorLayout;
    /** False: the player never saved a layout, so `decorLayout` is empty and the preset shows. */
    decorEdited: boolean;
    backgroundId: BackgroundId;
    /**
     * Distinct days of the last `VISIT_WINDOW_DAYS` the owner opened the tank. The fish know the
     * owner from it and come to the glass. Left out for tanks the viewer does not own.
     */
    recentVisitDays?: number;
  };
  /** The server's background for the tank changed outside this tab's own choice (another device). */
  'tank:background': { tankId: string; backgroundId: BackgroundId };
  /** The player picked a background in the decorate panel; ignored if it is not for the shown biome. */
  'background:choose': { backgroundId: BackgroundId };
  /** The background on show, never null; `tankId` is null for the demo tank, which has nowhere to save. */
  'background:state': { tankId: string | null; biome: Biome; backgroundId: BackgroundId | null };
  /** The player chose a background for a saved tank; the persistence layer saves it. */
  'background:save': { tankId: string; backgroundId: BackgroundId };
  /** The server's layout changed outside this tab's own edits (another device). */
  'tank:decor': { tankId: string; layout: DecorLayout; edited: boolean };
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
  'demo:request-biome': { biome: Biome };
  /** The demo tank's biome, sent after each `demo:request-biome` that changed it. */
  'demo:biome-changed': { biome: Biome };
  /** A fish joined. `acclimate` means it starts in a floating bag until `tank:fish-released`. */
  'tank:fish-added': { tankId: string; fish: Fish; acclimate: boolean };
  'tank:fish-released': { tankId: string; fishId: string };
  /** The fish died: erratic swim, then belly-up at the surface. */
  'tank:fish-died': { tankId: string; fish: Fish };
  /** Living fish whose hunger or health changed on the server. */
  'tank:fish-updated': { tankId: string; fish: Fish[] };
  /** Netted, or removed on another device. */
  'tank:fish-removed': { tankId: string; fishId: string; reason: 'netted' | 'gone' };
  'tank:water': { tankId: string; water: Water };
  /** The growing plants of the tank, sent after each load and whenever they change. */
  'tank:plants': { tankId: string; plants: readonly Plant[] };
  /** The tank's wave maker tier, sent after each load and whenever a purchase changes it; 0 is none. */
  'tank:wave-maker': { tankId: string; tier: number };
  /**
   * The tank's lamp hours in UTC and strength (0..1), sent after each load and whenever either
   * changes.
   */
  'tank:lamp': { tankId: string; intensity: number; onHour: number; offHour: number };
  /** The loading screen: from app start, and from each tank switch, until the tank has drawn. */
  'load:state': LoadState;
  /** The failure card was closed; the loading screen stays away until the next load begins. */
  'load:dismiss': Record<string, never>;
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
  'decor:colliders': { colliders: readonly Collider[] };
  /** The player settled an edit; the persistence layer saves it. */
  'decor:layout': { tankId: string; layout: DecorLayout };
  'decor:save-state': {
    status: SaveStatus;
    message: string | null;
    source?: SaveSource;
    reported?: { source: SaveSource; status: SaveStatus };
  };
  /** The player tapped the tank glass; `intensity` is 0.5 for a tap and 1 for knocking. */
  'photo:request': PhotoCommand;
  'photo:view': PhotoView;
  'photo:capture': PhotoCaptureOutcome;
  'glass:tapped': { intensity: number };
  /**
   * The away replay asks the fish sim to run faster than real time. 1 is normal speed; above 1 the
   * fish system steps the running sim the extra steps itself. Always sent back to 1 when the replay ends.
   */
  'replay:time-scale': { scale: number };
  /** Emitted by the fish system when the net tool taps a dead fish. */
  'net:tap': { fishId: string };
  /** The trim tool tapped; `pick` is the plant under the ray, or null when none is. */
  'plant:picked': { pick: PlantPick | null };
}

export interface LoadState {
  active: boolean;
  reason: 'boot' | 'switch';
  /** 0..1, never goes back while a load runs. */
  progress: number;
  stage: string;
  /** Set when the load failed; the screen then offers a retry. */
  error: string | null;
}

/** State the overlay reads when a lazily loaded view mounts after the event already fired. */
export const STICKY_INTERACTION_EVENTS: readonly (keyof InteractionEvents)[] = [
  'camera:mode-changed',
  'play:tool-changed',
  'play:ready',
  'toys:changed',
  'game:state',
  'demo:biome-changed',
  'decor:state',
  'background:state',
  'decor:save-state',
  'decor:load-failed',
  'load:state',
  'photo:view',
];
