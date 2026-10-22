import { territoryWarning } from './cichlid';
import type {
  Economy,
  Pack,
  PurchasableStage,
  SpeciesSummary,
  Tank,
  TankSize,
} from '@aquarium/shared';

export function euroText(pearls: number, economy: Economy): string {
  const cents = Math.round(pearls * economy.pearlValueCents);
  return `€${(cents / 100).toFixed(2)}`;
}

export function pearlText(pearls: number): string {
  return `${pearls.toLocaleString('en')} Pearls`;
}

/** The euro value always sits next to the Pearl price. */
export function priceText(pearls: number, economy: Economy): string {
  return `${pearlText(pearls)} (about ${euroText(pearls, economy)})`;
}

export function speciesPrice(
  economy: Economy,
  speciesId: string,
  stage: PurchasableStage,
): number | undefined {
  return Object.hasOwn(economy.species, speciesId)
    ? economy.species[speciesId]?.[stage]
    : undefined;
}

/** The server's rule: the first display tank is free, then a slot price plus a size upgrade price. */
export function tankPrice(
  economy: Economy,
  tanks: readonly Pick<Tank, 'quarantine'>[],
  size: TankSize,
): number {
  const display = tanks.filter((t) => !t.quarantine).length;
  const slot = display === 0 ? 0 : (economy.items.tankSlots[display - 1] ?? 0);
  return slot + (economy.items.tankSizes[size] ?? 0);
}

export function priceOrFree(pearls: number, economy: Economy): string {
  return pearls === 0 ? 'Free' : priceText(pearls, economy);
}

export function spendQuestion(label: string, price: number, balance: number | null): string {
  const base = `Buy ${label} for ${pearlText(price)}?`;
  return balance === null ? base : `${base} You will have ${pearlText(balance - price)} left.`;
}

export function earnedText(amount: number): string {
  return `You earned ${pearlText(amount)}.`;
}

export interface PackOffer {
  pack: Pack;
  shortfall: number;
  leftover: number;
}

/** The smallest pack that covers the shortfall on its own, never a bigger one to be safe. */
export function smallestCoveringPack(economy: Economy, shortfall: number): PackOffer | null {
  if (shortfall <= 0) return null;
  const covering = economy.packs
    .filter((p) => p.webAvailable && p.pearls >= shortfall)
    .sort((a, b) => a.pearls - b.pearls)[0];
  return covering ? { pack: covering, shortfall, leftover: covering.pearls - shortfall } : null;
}

export interface Shortfall {
  kind: 'short';
  price: number;
  balance: number;
  shortfall: number;
  offer: PackOffer | null;
}

export type Affordability = { kind: 'ok' } | Shortfall;

/**
 * An unknown balance is let through: the server decides, and a refusal comes back as a message.
 * A negative balance (after a chargeback) counts in full, so the shortfall is the whole gap.
 */
export function assessPurchase(
  balance: number | null,
  price: number,
  economy: Economy,
): Affordability {
  if (balance === null || balance >= price) return { kind: 'ok' };
  const shortfall = price - balance;
  return {
    kind: 'short',
    price,
    balance,
    shortfall,
    offer: smallestCoveringPack(economy, shortfall),
  };
}

export function packText(pack: Pack): string {
  return `${pearlText(pack.pearls)} for €${(pack.priceCents / 100).toFixed(2)}`;
}

export function shortfallSentence(result: Shortfall): string {
  const have = Math.max(result.balance, 0);
  const need = `This costs ${pearlText(result.price)} and you have ${pearlText(have)}, so you are ${pearlText(result.shortfall)} short.`;
  if (!result.offer) {
    return `${need} That is more than the biggest pack holds, so it would take more than one.`;
  }
  const { pack, leftover } = result.offer;
  return `${need} The smallest pack that covers it is ${packText(pack)}, which leaves you ${pearlText(leftover)} afterwards.`;
}

export function heaterWarning(
  tank: Pick<Tank, 'equipment'>,
  species: Pick<SpeciesSummary, 'warmWater' | 'commonName'>,
  roomC: number,
): string | null {
  if (!species.warmWater || tank.equipment.heater.tier > 0) return null;
  return `This tank has no heater, so the water cools to room temperature, about ${roomC} °C. ${species.commonName} likes warmer water and can get stressed and sick. You can still add it, or buy a heater first.`;
}

export function purchaseWarning(
  tank: Tank,
  candidate: SpeciesSummary,
  all: readonly SpeciesSummary[],
  roomC: number,
): string | null {
  const warnings = [
    heaterWarning(tank, candidate, roomC),
    territoryWarning(tank, candidate, all),
  ].filter((w) => w !== null);
  return warnings.length === 0 ? null : warnings.join(' ');
}
