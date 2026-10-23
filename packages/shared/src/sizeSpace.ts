import { TANK_SIZES, type TankSize } from './tankSize.js';
import { createTankSpace, type TankSpace } from './tankSpace.js';

/** Sand depth at the front and back glass per size; the nano's bed is shallower. */
const SUBSTRATE: Readonly<Record<TankSize, { front: number; back: number }>> = {
  nano30: { front: 0.02, back: 0.05 },
  standard: { front: 0.04, back: 0.1 },
  std200: { front: 0.04, back: 0.09 },
  long300: { front: 0.035, back: 0.09 },
};

const WATER_INSET = 0.001;

/** The tank space the scene builds for a size: the same sand slope and dunes, so the sim accepts the same fish. */
export function tankSpaceOfSize(size: TankSize): TankSpace {
  const { length, depth, height, glass, freeboard } = TANK_SIZES[size].dimensions;
  const { front, back } = SUBSTRATE[size];
  const innerDepth = depth - 2 * glass;
  return createTankSpace(
    { width: length, depth, height, glass, freeboard, inset: WATER_INSET },
    (x, z) => {
      const rise = Math.min(1, Math.max(0, (innerDepth / 2 - z) / innerDepth));
      const eased = rise * rise * (3 - 2 * rise);
      const dunes =
        0.004 * Math.sin(x * 21 + z * 6) +
        0.003 * Math.sin(-x * 9.5 + z * 29) +
        0.0015 * Math.sin(x * 47 - z * 13);
      return glass + front + (back - front) * eased + dunes;
    },
  );
}
