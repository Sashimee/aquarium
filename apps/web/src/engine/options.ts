import { DEFAULT_TANK_SIZE, tankSizeSchema, type TankSize } from '@aquarium/shared';
import { parseClock } from './daylight';
import { isTier, TIERS, type Tier } from './quality/tiers';

export type BackendPreference = 'auto' | 'webgpu' | 'webgl';

export interface EngineOptions {
  backend: BackendPreference;
  /** Pins the quality tier and disables the probe and adaptation. */
  tier: Tier | null;
  adaptive: boolean;
  /** Pins the tank clock to these minutes after midnight; null follows the local time. */
  clock: number | null;
  /** Shows the on-device performance readout. */
  stats: boolean;
  /** The tank size drawn until a saved tank brings its own: the demo tank's. */
  tankSize: TankSize;
}

const BACKENDS: readonly BackendPreference[] = ['auto', 'webgpu', 'webgl'];

function isBackend(value: string): value is BackendPreference {
  return (BACKENDS as readonly string[]).includes(value);
}

/**
 * Reads `?backend=`, `?tier=`, `?adaptive=`, `?clock=`, `?stats=` and `?size=` from a URL query
 * string.
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

  const tier = tierParam ?? null;
  return {
    backend,
    tier,
    adaptive: tier === null && adaptiveParam !== '0',
    clock,
    stats: statsParam === '1',
    tankSize: size?.data ?? DEFAULT_TANK_SIZE,
  };
}
