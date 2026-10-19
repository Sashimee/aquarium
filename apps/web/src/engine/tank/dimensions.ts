import { TANK_SIZES, type TankSize } from '@aquarium/shared';
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

/** Waterline and sand bed per size: a shallower bed and a lower freeboard in the 30 cm nano. */
const FILL: Readonly<
  Record<TankSize, Pick<TankDimensions, 'freeboard' | 'substrateFront' | 'substrateBack'>>
> = {
  nano30: { freeboard: 0.02, substrateFront: 0.02, substrateBack: 0.05 },
  standard: { freeboard: 0.03, substrateFront: 0.04, substrateBack: 0.1 },
  std200: { freeboard: 0.03, substrateFront: 0.04, substrateBack: 0.09 },
  long300: { freeboard: 0.03, substrateFront: 0.035, substrateBack: 0.09 },
};

export const TANK_DIMENSIONS: Readonly<Record<TankSize, Readonly<TankDimensions>>> = {
  nano30: { ...TANK_SIZES.nano30.dimensions, ...FILL.nano30 },
  standard: { ...TANK_SIZES.standard.dimensions, ...FILL.standard },
  std200: { ...TANK_SIZES.std200.dimensions, ...FILL.std200 },
  long300: { ...TANK_SIZES.long300.dimensions, ...FILL.long300 },
};

/** A standard 120 x 50 x 50 cm (300 l) rimless tank with 10 mm glass. */
export const DEFAULT_TANK: Readonly<TankDimensions> = TANK_DIMENSIONS.standard;

/** Keeps the water box off the inner glass faces so they never z-fight or self-attenuate. */
export const WATER_INSET = 0.001;

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
