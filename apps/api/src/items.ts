import { decorPrice, PROCEDURAL_EUPHYLLIA_ID, type Economy } from '@aquarium/shared';

export const EUPHYLLIA_LICENSE_REF = 'decor:euphyllia';
// Refs bought once and owned for good; mirrors ONE_TIME_REF in the web session.
export const ONE_TIME_REF = /^(plant|decor|background):/;
export const backgroundRef = (id: string) => `background:${id}`;

export interface License {
  ref: string;
  price: number;
}

// A layout piece is licensed by what it is, not by the procedural variant: every euphyllia piece
// shares one licence.
export function licenseFor(economy: Economy, assetId: string): License {
  const price = decorPrice(economy, assetId);
  if (price === undefined) {
    throw new Error(`decor asset "${assetId}" has no price in content/economy.json`);
  }
  if (PROCEDURAL_EUPHYLLIA_ID.test(assetId)) return { ref: EUPHYLLIA_LICENSE_REF, price };
  const kind = Object.hasOwn(economy.items.plant.prices, assetId) ? 'plant' : 'decor';
  return { ref: `${kind}:${assetId}`, price };
}

export function licenseForRef(economy: Economy, ref: string): License | null {
  if (ref === EUPHYLLIA_LICENSE_REF) return { ref, price: economy.items.euphyllia };
  const match = /^(plant|decor):(.+)$/.exec(ref);
  const id = match?.[2];
  if (id === undefined || PROCEDURAL_EUPHYLLIA_ID.test(id)) return null;
  if (decorPrice(economy, id) === undefined) return null;
  const license = licenseFor(economy, id);
  return license.ref === ref ? license : null;
}
