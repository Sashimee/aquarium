import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface Pack {
  id: string;
  pearls: number;
  priceCents: number;
  webAvailable: boolean;
}

interface Economy {
  pearlValueCents: number;
  grants: { starting: number };
  species: Record<string, { juvenile: number; adult: number }>;
  items: {
    plant: { prices: Record<string, number> };
    background: { price: number };
    equipment: Record<string, number[]>;
    tankSlots: number[];
    tankSizes: Record<string, number>;
  };
  rooms: Record<string, number>;
  packs: Pack[];
  subscription: { id: string; priceCents: number; pearlsPerDay: number };
}

export const economy = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../../content/economy.json'), 'utf8'),
) as Economy;

/** What the server charges for the next display tank, given how many display tanks exist. */
export function tankCost(displayTanks: number, size: string): number {
  const slot = displayTanks === 0 ? 0 : (economy.items.tankSlots[displayTanks - 1] ?? 0);
  return slot + (economy.items.tankSizes[size] ?? 0);
}

export const webPack = (id: string): Economy['packs'][number] => {
  const pack = economy.packs.find((p) => p.id === id);
  if (!pack?.webAvailable) throw new Error(`pack ${id} is not sold on the web`);
  return pack;
};
