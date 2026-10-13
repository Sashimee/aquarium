import type { DecorItem } from '@aquarium/shared';
import catalog from '../../../public/assets/index.json';
import type { CatalogEntry } from '../../scene/assets';
import type { TankLimits } from './rules';
import { specsFromCatalog, type DecorSpec } from './spec';

export const LIMITS: TankLimits = { halfLength: 0.589, halfDepth: 0.239 };
export const FLAT_GROUND = 0.06;
export const flat = (): number => FLAT_GROUND;

export const SPECS: ReadonlyMap<string, DecorSpec> = specsFromCatalog(
  catalog.assets as unknown as CatalogEntry[],
);

export function spec(assetId: string): DecorSpec {
  const found = SPECS.get(assetId);
  if (!found) throw new Error(`fixture asset ${assetId} is not in the catalog`);
  return found;
}

export const item = (
  assetId: string,
  x: number,
  z: number,
  extra: Partial<Omit<DecorItem, 'assetId' | 'position'>> = {},
  y = FLAT_GROUND,
): DecorItem => ({ assetId, position: [x, y, z], rotationY: 0, scale: 1, ...extra });

export function must<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error('expected a value in this test');
  return value;
}
