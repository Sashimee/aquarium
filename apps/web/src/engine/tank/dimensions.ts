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

/** A standard 120 x 50 x 50 cm (300 l) rimless tank with 10 mm glass. */
export const DEFAULT_TANK: Readonly<TankDimensions> = {
  length: 1.2,
  depth: 0.5,
  height: 0.5,
  glass: 0.01,
  freeboard: 0.03,
  substrateFront: 0.04,
  substrateBack: 0.1,
};

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

export function waterBounds(d: TankDimensions): Box3 {
  validateTank(d);
  const halfL = d.length / 2 - d.glass - WATER_INSET;
  const halfD = d.depth / 2 - d.glass - WATER_INSET;
  return new Box3(
    new Vector3(-halfL, d.glass + WATER_INSET, -halfD),
    new Vector3(halfL, d.height - d.freeboard, halfD),
  );
}
