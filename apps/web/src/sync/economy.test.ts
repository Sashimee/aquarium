import type { Economy } from '@aquarium/shared';
import { describe, expect, it } from 'vitest';
import { BUNDLED_ECONOMY } from './bundledEconomy';
import {
  assessPurchase,
  euroText,
  heaterWarning,
  priceText,
  shortfallSentence,
  smallestCoveringPack,
  speciesPrice,
} from './economy';
import { speciesFixture, tankFixture } from './fixtures';

const economy = BUNDLED_ECONOMY;

describe('prices', () => {
  it('puts the euro value next to every Pearl price', () => {
    expect(euroText(40, economy)).toBe('€0.40');
    expect(priceText(1200, economy)).toBe('1,200 Pearls (about €12.00)');
  });

  it('prices a species by stage and refuses unknown species', () => {
    expect(speciesPrice(economy, 'neon-tetra', 'juvenile')).toBe(15);
    expect(speciesPrice(economy, 'neon-tetra', 'adult')).toBe(40);
    expect(speciesPrice(economy, 'not-a-fish', 'adult')).toBeUndefined();
    expect(speciesPrice(economy, 'constructor', 'adult')).toBeUndefined();
  });
});

describe('smallest covering pack', () => {
  it('offers the smallest pack that covers the shortfall and shows the leftover', () => {
    const offer = smallestCoveringPack(economy, 120);
    expect(offer?.pack.pearls).toBe(550);
    expect(offer?.leftover).toBe(430);
  });

  it('takes the smallest web pack for a tiny shortfall, skipping the one not sold on the web', () => {
    const offer = smallestCoveringPack(economy, 1);
    expect(offer?.pack.pearls).toBe(550);
    expect(offer?.leftover).toBe(549);
  });

  it('accepts a pack that covers exactly, with nothing left over', () => {
    const offer = smallestCoveringPack(economy, 550);
    expect(offer?.pack.pearls).toBe(550);
    expect(offer?.leftover).toBe(0);
    expect(smallestCoveringPack(economy, 551)?.pack.pearls).toBe(1200);
  });

  it('has no offer when one pack cannot cover it, or when nothing is short', () => {
    expect(smallestCoveringPack(economy, 14_001)).toBeNull();
    expect(smallestCoveringPack(economy, 0)).toBeNull();
    expect(smallestCoveringPack(economy, -5)).toBeNull();
  });

  it('skips packs that are not on sale on the web', () => {
    const hidden: Economy = {
      ...economy,
      packs: economy.packs.map((p) => (p.pearls === 550 ? { ...p, webAvailable: false } : p)),
    };
    expect(smallestCoveringPack(hidden, 50)?.pack.pearls).toBe(1200);
  });
});

describe('assessPurchase', () => {
  it('lets an affordable purchase through, to the pearl', () => {
    expect(assessPurchase(40, 40, economy)).toEqual({ kind: 'ok' });
    expect(assessPurchase(500, 40, economy)).toEqual({ kind: 'ok' });
  });

  it('lets an unknown balance through, because the server decides', () => {
    expect(assessPurchase(null, 800, economy)).toEqual({ kind: 'ok' });
  });

  it('reports the shortfall and the smallest pack for an overdraft', () => {
    const verdict = assessPurchase(30, 150, economy);
    expect(verdict).toMatchObject({ kind: 'short', shortfall: 120, price: 150, balance: 30 });
    if (verdict.kind !== 'short') throw new Error('expected a shortfall');
    expect(verdict.offer?.pack.pearls).toBe(550);
    expect(verdict.offer?.leftover).toBe(430);
  });

  it('counts a negative balance after a chargeback in full', () => {
    const verdict = assessPurchase(-100, 40, economy);
    expect(verdict).toMatchObject({ kind: 'short', shortfall: 140 });
    expect(shortfallSentence(verdict as Extract<typeof verdict, { kind: 'short' }>)).toContain(
      'you have 0 Pearls',
    );
  });

  it('says so plainly when no single pack covers it', () => {
    const verdict = assessPurchase(0, 20_000, economy);
    if (verdict.kind !== 'short') throw new Error('expected a shortfall');
    expect(verdict.offer).toBeNull();
    expect(shortfallSentence(verdict)).toContain('more than one');
  });

  it('writes the offer with its price and leftover and no pressure', () => {
    const verdict = assessPurchase(30, 150, economy);
    if (verdict.kind !== 'short') throw new Error('expected a shortfall');
    const text = shortfallSentence(verdict);
    expect(text).toContain('550 Pearls for €4.99');
    expect(text).toContain('leaves you 430 Pearls');
    expect(text).not.toMatch(/hurry|now or|limited|last chance|expires/i);
  });
});

describe('heater warning', () => {
  const warm = speciesFixture({ id: 'betta', commonName: 'Betta', warmWater: true });
  const cool = speciesFixture({ warmWater: false });
  const heated = tankFixture();
  const cold = tankFixture({
    equipment: { ...heated.equipment, heater: { tier: 0 } },
  });

  it('warns before a warm-water species goes into a tank with no heater', () => {
    const warning = heaterWarning(cold, warm, 21);
    expect(warning).toContain('no heater');
    expect(warning).toContain('21');
    expect(warning).toContain('Betta');
  });

  it('stays quiet with a working heater, at any tier', () => {
    expect(heaterWarning(heated, warm, 21)).toBeNull();
    const strong = tankFixture({ equipment: { ...heated.equipment, heater: { tier: 3 } } });
    expect(heaterWarning(strong, warm, 21)).toBeNull();
  });

  it('stays quiet for a species that does not need warmth, heater or not', () => {
    expect(heaterWarning(cold, cool, 21)).toBeNull();
  });
});
