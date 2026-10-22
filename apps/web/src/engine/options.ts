import { DEFAULT_TANK_SIZE, tankSizeSchema, type TankSize } from '@aquarium/shared';
import { parseClock } from './daylight';
import {
  FRAME_RATE_CHOICES,
  isFrameRateChoice,
  isPixelRatioChoice,
  PIXEL_RATIO_CHOICES,
  type FrameRateChoice,
  type PixelRatioChoice,
} from './displayPreference';
import { isTier, TIERS, type Tier } from './quality/tiers';

export type BackendPreference = 'auto' | 'webgpu' | 'webgl';

export interface EngineOptions {
  backend: BackendPreference;
  /** Pins the quality tier and disables the probe and adaptation. */
  tier: Tier | null;
  adaptive: boolean;
  /**
   * Pins the clock to these minutes after midnight: the hood's lamp schedule reads them as UTC and
   * the room's daylight as local time. Outside UTC the two disagree with an unpinned page, e.g. at
   * UTC+2 `?clock=13:00` shows the room's 13:00 local sun but the hood's 13:00 UTC lamp state,
   * which unpinned would show at 15:00 local. The window's weather holds still while pinned. Null
   * follows the real time.
   */
  clock: number | null;
  /** Shows the on-device performance readout. */
  stats: boolean;
  /** The tank size drawn until a saved tank brings its own: the demo tank's. */
  tankSize: TankSize;
  /** Overrides the saved frame rate choice for this page; null follows it. */
  frameRate: FrameRateChoice | null;
  /** Overrides the saved pixel ratio choice for this page; null follows it. */
  pixelRatio: PixelRatioChoice | null;
}

const BACKENDS: readonly BackendPreference[] = ['auto', 'webgpu', 'webgl'];

function isBackend(value: string): value is BackendPreference {
  return (BACKENDS as readonly string[]).includes(value);
}

/**
 * Reads `?backend=`, `?tier=`, `?adaptive=`, `?clock=`, `?stats=`, `?size=`, `?fps=` and `?dpr=`
 * from a URL query string.
 */
export function parseEngineOptions(search: string): EngineOptions {
  const params = new URLSearchParams(search);

  const backend = params.get('backend') ?? 'auto';
  if (!isBackend(backend)) {
    throw new Error(`Unknown ?backend=${backend}; use one of ${BACKENDS.join(', ')}`);
  }

  const tierParam = params.get('tier');
  if (tierParam !== null && !isTier(tierParam)) {
    throw new Error(`Unknown ?tier=${tierParam}; use one of ${TIERS.join(', ')}`);
  }

  const adaptiveParam = params.get('adaptive');
  if (adaptiveParam !== null && adaptiveParam !== '0' && adaptiveParam !== '1') {
    throw new Error(`Unknown ?adaptive=${adaptiveParam}; use 0 or 1`);
  }

  const clockParam = params.get('clock');
  const clock = clockParam === null ? null : parseClock(clockParam);

  const statsParam = params.get('stats');
  if (statsParam !== null && statsParam !== '0' && statsParam !== '1') {
    throw new Error(`Unknown ?stats=${statsParam}; use 0 or 1`);
  }

  const sizeParam = params.get('size');
  const size = sizeParam === null ? null : tankSizeSchema.safeParse(sizeParam);
  if (size?.success === false) {
    throw new Error(`Unknown ?size=${sizeParam}; use one of ${tankSizeSchema.options.join(', ')}`);
  }

  const frameRate = params.get('fps');
  if (frameRate !== null && !isFrameRateChoice(frameRate)) {
    throw new Error(`Unknown ?fps=${frameRate}; use one of ${FRAME_RATE_CHOICES.join(', ')}`);
  }

  const pixelRatio = params.get('dpr');
  if (pixelRatio !== null && !isPixelRatioChoice(pixelRatio)) {
    throw new Error(`Unknown ?dpr=${pixelRatio}; use one of ${PIXEL_RATIO_CHOICES.join(', ')}`);
  }

  const tier = tierParam ?? null;
  return {
    backend,
    tier,
    adaptive: tier === null && adaptiveParam !== '0',
    clock,
    stats: statsParam === '1',
    tankSize: size?.data ?? DEFAULT_TANK_SIZE,
    frameRate,
    pixelRatio,
  };
}
