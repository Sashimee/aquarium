import { SAND_BED, TANK_SIZES, type TankSize, WATER_INSET } from '@aquarium/shared';
import { Box3, Vector3 } from 'three/webgpu';

/** All lengths in metres. The tank sits centred on x/z with its bottom glass at y = 0. */
export interface TankDimensions {
  length: number;
  depth: number;
  height: number;
  glass: number;
  /** Gap between the water surface and the top edge of the glass. */
  freeboard: number;
  substrateFront: number;
  substrateBack: number;
}

function sized(size: TankSize): Readonly<TankDimensions> {
  const { front, back } = SAND_BED[size];
  return { ...TANK_SIZES[size].dimensions, substrateFront: front, substrateBack: back };
}

export const TANK_DIMENSIONS: Readonly<Record<TankSize, Readonly<TankDimensions>>> = {
  nano30: sized('nano30'),
  standard: sized('standard'),
  std200: sized('std200'),
  long300: sized('long300'),
};

/** A standard 120 x 50 x 50 cm (300 l) rimless tank with 10 mm glass. */
export const DEFAULT_TANK: Readonly<TankDimensions> = TANK_DIMENSIONS.standard;

/** The cabinet under the tank; the room's floor is at its foot, y = -STAND_HEIGHT. */
export const STAND_HEIGHT = 0.75;

export { WATER_INSET };

export function validateTank(d: TankDimensions): void {
  const positive: (keyof TankDimensions)[] = ['length', 'depth', 'height', 'glass'];
  for (const key of positive) {
    if (!(d[key] > 0)) throw new RangeError(`Tank: ${key} must be > 0, got ${d[key]}`);
  }
  if (d.freeboard < 0) throw new RangeError('Tank: freeboard must be >= 0');
  if (2 * d.glass >= Math.min(d.length, d.depth)) {
    throw new RangeError('Tank: glass is thicker than the tank allows');
  }
  if (d.substrateFront < 0 || d.substrateBack < 0) {
    throw new RangeError('Tank: substrate heights must be >= 0');
  }
  const waterTop = d.height - d.freeboard;
  if (waterTop <= d.glass + Math.max(d.substrateFront, d.substrateBack)) {
    throw new RangeError('Tank: substrate reaches above the water surface');
  }
}

export function sameTank(a: Readonly<TankDimensions>, b: Readonly<TankDimensions>): boolean {
  return (Object.keys(a) as (keyof TankDimensions)[]).every((key) => a[key] === b[key]);
}

export function waterBounds(d: TankDimensions, target = new Box3()): Box3 {
  validateTank(d);
  const halfL = d.length / 2 - d.glass - WATER_INSET;
  const halfD = d.depth / 2 - d.glass - WATER_INSET;
  target.min.set(-halfL, d.glass + WATER_INSET, -halfD);
  target.max.set(halfL, d.height - d.freeboard, halfD);
  return target;
}

/** Litres of the water box, from the bottom glass to the waterline; the sand is not taken out. */
export function waterLitres(d: TankDimensions): number {
  const size = waterBounds(d).getSize(new Vector3());
  return size.x * size.y * size.z * 1000;
}

/**
 * How far the camera stands back from this tank relative to the standard one, so that neither its
 * length nor its height fills more of the view than the standard tank's does.
 */
export function framingScale(d: TankDimensions): number {
  return Math.max(d.length / DEFAULT_TANK.length, d.height / DEFAULT_TANK.height);
}

/** The front view of the standard tank: 1.6 m out, a little above the middle of the water. */
const STANDARD_VIEW_DISTANCE = 1.6;
const STANDARD_VIEW_RISE = 0.1;

/** The engine's front view of this tank, scaled from the standard tank's by `framingScale`. */
export function defaultView(d: TankDimensions): { eye: Vector3; target: Vector3 } {
  const scale = framingScale(d);
  const middle = d.height / 2;
  return {
    eye: new Vector3(0, middle + STANDARD_VIEW_RISE * scale, STANDARD_VIEW_DISTANCE * scale),
    target: new Vector3(0, middle, 0),
  };
}
