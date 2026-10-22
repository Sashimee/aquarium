export const DISPLAY_STORAGE_KEY = 'aquarium.display';

export const FRAME_RATE_CHOICES = ['capped', 'display'] as const;
export const PIXEL_RATIO_CHOICES = ['capped', 'device'] as const;

/** `capped` holds the device class's frame cap; `display` draws every frame the display shows. */
export type FrameRateChoice = (typeof FRAME_RATE_CHOICES)[number];
/** `capped` holds the device class's pixel ratio ceiling; `device` lets each tier use its own cap. */
export type PixelRatioChoice = (typeof PIXEL_RATIO_CHOICES)[number];

export interface DisplayChoice {
  readonly frameRate: FrameRateChoice;
  readonly pixelRatio: PixelRatioChoice;
}

export const DEFAULT_DISPLAY_CHOICE: DisplayChoice = { frameRate: 'capped', pixelRatio: 'capped' };

export function isFrameRateChoice(value: unknown): value is FrameRateChoice {
  return typeof value === 'string' && (FRAME_RATE_CHOICES as readonly string[]).includes(value);
}

export function isPixelRatioChoice(value: unknown): value is PixelRatioChoice {
  return typeof value === 'string' && (PIXEL_RATIO_CHOICES as readonly string[]).includes(value);
}

export type DisplayStorage = Pick<Storage, 'getItem' | 'setItem'>;

/** Reads a stored choice; whatever is missing or unknown in it falls back to the default. */
export function parseDisplayChoice(stored: string | null | undefined): DisplayChoice {
  if (stored === null || stored === undefined) return DEFAULT_DISPLAY_CHOICE;
  let value: unknown;
  try {
    value = JSON.parse(stored);
  } catch {
    return DEFAULT_DISPLAY_CHOICE;
  }
  if (typeof value !== 'object' || value === null) return DEFAULT_DISPLAY_CHOICE;
  const { frameRate, pixelRatio } = value as Record<string, unknown>;
  return {
    frameRate: isFrameRateChoice(frameRate) ? frameRate : DEFAULT_DISPLAY_CHOICE.frameRate,
    pixelRatio: isPixelRatioChoice(pixelRatio) ? pixelRatio : DEFAULT_DISPLAY_CHOICE.pixelRatio,
  };
}

/**
 * The player's frame rate and resolution opt-ins, kept in local storage. `subscribe` and
 * `snapshot` have the shape React's `useSyncExternalStore` takes, so a settings screen can bind to
 * them directly; the engine follows changes as they are made.
 */
export class DisplayPreference {
  private current: DisplayChoice;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly storage: DisplayStorage | null) {
    this.current = this.read();
  }

  readonly snapshot = (): DisplayChoice => this.current;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  set(change: Partial<DisplayChoice>): void {
    if (change.frameRate !== undefined && !isFrameRateChoice(change.frameRate)) {
      throw new RangeError(`Unknown frame rate choice "${String(change.frameRate)}"`);
    }
    if (change.pixelRatio !== undefined && !isPixelRatioChoice(change.pixelRatio)) {
      throw new RangeError(`Unknown pixel ratio choice "${String(change.pixelRatio)}"`);
    }
    const next = { ...this.current, ...change };
    if (next.frameRate === this.current.frameRate && next.pixelRatio === this.current.pixelRatio) {
      return;
    }
    this.current = next;
    try {
      this.storage?.setItem(DISPLAY_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Storage can be full or blocked; the choice then lasts for this session only.
    }
    for (const listener of [...this.listeners]) listener();
  }

  private read(): DisplayChoice {
    try {
      return parseDisplayChoice(this.storage?.getItem(DISPLAY_STORAGE_KEY));
    } catch {
      return DEFAULT_DISPLAY_CHOICE;
    }
  }
}

function browserDisplayStorage(): DisplayStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export interface DisplayLimits {
  /** Null draws every display frame. */
  frameCapFps: number | null;
  pixelRatioCeiling: number;
}

/** What `choice` makes of a device class's frame cap and pixel ratio ceiling. */
export function displayLimits(defaults: DisplayLimits, choice: DisplayChoice): DisplayLimits {
  return {
    frameCapFps: choice.frameRate === 'display' ? null : defaults.frameCapFps,
    pixelRatioCeiling:
      choice.pixelRatio === 'device' ? Number.POSITIVE_INFINITY : defaults.pixelRatioCeiling,
  };
}

/** One choice for the whole page: a settings screen writes it, the engine reads it. */
export const displayPreference = new DisplayPreference(browserDisplayStorage());
