import { TANK_SIZES, type TankSize } from './tankSize.js';
import { createTankSpace, type TankSpace } from './tankSpace.js';

export interface SandBed {
  /** Sand depth above the bottom glass at the front glass, in metres. */
  readonly front: number;
  /** Sand depth above the bottom glass at the back glass, in metres. */
  readonly back: number;
}

/** Sand depth at the front and back glass per size; the nano's bed is shallower. */
export const SAND_BED: Readonly<Record<TankSize, SandBed>> = {
  nano30: { front: 0.02, back: 0.05 },
  standard: { front: 0.04, back: 0.1 },
  std200: { front: 0.04, back: 0.09 },
  long300: { front: 0.035, back: 0.09 },
};

const WATER_INSET = 0.001;

/**
 * Height of the sand top at (x, z): a slope rising towards the back (-z), the usual aquascaping
 * layout, with low dunes. The scene draws this surface and the sim walks on it.
 */
export function sandHeight(
  tank: { readonly depth: number; readonly glass: number },
  front: number,
  back: number,
  x: number,
  z: number,
): number {
  const innerDepth = tank.depth - 2 * tank.glass;
  const rise = Math.min(1, Math.max(0, (innerDepth / 2 - z) / innerDepth));
  const eased = rise * rise * (3 - 2 * rise);
  const dunes =
    0.004 * Math.sin(x * 21 + z * 6) +
    0.003 * Math.sin(-x * 9.5 + z * 29) +
    0.0015 * Math.sin(x * 47 - z * 13);
  return tank.glass + front + (back - front) * eased + dunes;
}

/** The tank space the scene builds for a size: the same sand slope and dunes, so the sim accepts the same fish. */
export function tankSpaceOfSize(size: TankSize): TankSpace {
  const dimensions = TANK_SIZES[size].dimensions;
  const { length, depth, height, glass, freeboard } = dimensions;
  const { front, back } = SAND_BED[size];
  return createTankSpace(
    { width: length, depth, height, glass, freeboard, inset: WATER_INSET },
    (x, z) => sandHeight(dimensions, front, back, x, z),
  );
}
