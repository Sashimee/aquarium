import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { addFishRequestSchema } from './tank.js';
import { VACATION_FEEDER_ASSET_ID } from '../../sim/lifecycle/params.js';
import { DECOR_ASSET_IDS } from './decorRules.js';
import { diseaseKindSchema } from './fishState.js';
import {
  DEFAULT_PURCHASE_STAGE,
  decorPrice,
  economySchema,
  idempotencyKeySchema,
  type Economy,
  ledgerEntrySchema,
  purchaseRequestSchema,
} from './economy.js';

const content = join(import.meta.dirname, '../../../content');
const readJson = (path: string): unknown => JSON.parse(readFileSync(join(content, path), 'utf8'));
const placeableIds = [...new Set(Object.values(DECOR_ASSET_IDS).flatMap((ids) => [...ids]))];

describe('content/economy.json', () => {
  const economy = economySchema.parse(readJson('economy.json'));
  const fixture = (): Economy => structuredClone(economy);

  it('prices every species juvenile and adult, adult above juvenile', () => {
    const files = readdirSync(join(content, 'species')).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const id = (readJson(`species/${file}`) as { id: string }).id;
      const price = economy.species[id];
      expect(price, `${id} has no price`).toBeDefined();
      expect(price?.adult ?? 0).toBeGreaterThan(price?.juvenile ?? Infinity);
    }
  });

  it('keeps adults at about 2.5x the juvenile price', () => {
    for (const [id, p] of Object.entries(economy.species)) {
      expect(p.adult / p.juvenile, id).toBeGreaterThan(2.2);
      expect(p.adult / p.juvenile, id).toBeLessThan(2.8);
    }
  });

  it('sells packs with more Pearls per euro as they grow', () => {
    const perEuro = economy.packs.map((p) => p.pearls / p.priceCents);
    expect(perEuro).toEqual([...perEuro].sort((a, b) => a - b));
    expect(new Set(perEuro).size).toBe(perEuro.length);
  });

  it('pins the pack table', () => {
    expect(economy.packs.map((p) => [p.priceCents, p.pearls, p.webAvailable])).toEqual([
      [99, 100, false],
      [499, 550, true],
      [999, 1200, true],
      [1999, 2500, true],
      [4999, 6500, true],
      [9999, 14000, true],
    ]);
  });

  it('pins the subscription', () => {
    expect(economy.subscription).toEqual({
      id: 'aquarist-club',
      priceCents: 499,
      interval: 'month',
      pearlsPerDay: 20,
    });
  });

  it('resolves a price for every placeable id and every premium medicine', () => {
    for (const id of placeableIds) {
      expect(decorPrice(economy, id), id).toBeGreaterThan(0);
    }
    for (const id of ['euphyllia-hammer-0', 'euphyllia-torch-123456789']) {
      expect(decorPrice(economy, id), id).toBe(economy.items.euphyllia);
    }
    for (const kind of diseaseKindSchema.options) {
      expect(economy.items.consumables.premiumMedicine.prices[kind], kind).toBeGreaterThan(0);
    }
  });

  it('prices no id that cannot be placed and no id twice', () => {
    const plants = Object.keys(economy.items.plant.prices);
    const decor = Object.keys(economy.items.decor.prices);
    expect(new Set([...plants, ...decor]).size).toBe(plants.length + decor.length);
    expect([...plants, ...decor].sort()).toEqual([...placeableIds].sort());
  });

  it.each(['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__'])(
    'prices no inherited property name such as %s',
    (id) => {
      expect(decorPrice(economy, id)).toBeUndefined();
    },
  );

  it('leaves the vacation feeder free', () => {
    expect(decorPrice(economy, VACATION_FEEDER_ASSET_ID)).toBeUndefined();
  });

  it('rejects a euphyllia price outside the decor range', () => {
    const bad = fixture();
    bad.items.euphyllia = bad.items.decor.max + 1;
    expect(economySchema.safeParse(bad).success).toBe(false);
  });

  it('keeps the healthy-tank streak at 15 Pearls a day or less', () => {
    expect(economy.earn.healthyTankStreak.dailyCap).toBeLessThanOrEqual(15);
  });

  it('leaves the default tank size free', () => {
    expect(economy.items.tankSizes).not.toHaveProperty('standard');
  });

  it('raises equipment prices with every tier', () => {
    for (const [kind, tiers] of Object.entries(economy.items.equipment)) {
      expect(tiers, kind).toEqual([...tiers].sort((a, b) => a - b));
      expect(new Set(tiers).size, kind).toBe(tiers.length);
    }
  });

  it('starts the web shop at the 4.99 euro pack', () => {
    const web = economy.packs.filter((p) => p.webAvailable).map((p) => p.priceCents);
    expect(Math.min(...web)).toBe(499);
  });

  it('prices no basic care', () => {
    const text = JSON.stringify(economy).toLowerCase();
    for (const free of ['standardfood', 'waterchange', 'vacuum', 'scrape', 'standardtreatment']) {
      expect(text).not.toContain(free);
    }
    expect(Object.keys(economy.items.consumables).sort()).toEqual([
      'bottledBacteria',
      'premiumFood',
      'premiumMedicine',
      'testKit',
    ]);
  });

  it('rejects a species whose adult is not above its juvenile', () => {
    const bad = fixture();
    bad.species['neon-tetra'] = { juvenile: 40, adult: 40 };
    expect(economySchema.safeParse(bad).success).toBe(false);
  });

  it.each([0, -5])('rejects a price of %i', (price) => {
    const bad = fixture();
    bad.items.consumables.testKit = price;
    expect(economySchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a non-positive cap', () => {
    const bad = fixture();
    bad.earn.dailyCare.dailyCap = 0;
    expect(economySchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a pack that is worse value than a smaller one', () => {
    const bad = fixture();
    const pack = bad.packs[2];
    if (!pack) throw new Error('fixture has no third pack');
    pack.pearls = 900;
    expect(economySchema.safeParse(bad).success).toBe(false);
  });

  it('rejects an item price outside its range', () => {
    const bad = fixture();
    bad.items.plant.prices['sketchfab-b34ed521'] = bad.items.plant.max + 1;
    expect(economySchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a higher equipment tier that costs less', () => {
    const bad = fixture();
    bad.items.equipment.heater = [150, 50, 400];
    expect(economySchema.safeParse(bad).success).toBe(false);
  });

  it('rejects an unknown item key', () => {
    const bad: unknown = {
      ...economy,
      items: {
        ...economy.items,
        consumables: { ...economy.items.consumables, waterChange: 5 },
      },
    };
    expect(economySchema.safeParse(bad).success).toBe(false);
  });
});

describe('economy contract', () => {
  const entry = {
    id: '0b0e3c0e-6a43-4c6e-8f0e-2a3f6d1f4a11',
    userId: null,
    delta: 550,
    reason: 'pack',
    source: 'stripe',
    itemRef: 'pack:pearls-550',
    idempotencyKey: 'evt_1Abc23Def456',
    createdAt: '2026-10-19T10:00:00.000Z',
  };

  it('accepts a pseudonymised ledger row and rejects a zero delta', () => {
    expect(ledgerEntrySchema.safeParse(entry).success).toBe(true);
    expect(ledgerEntrySchema.safeParse({ ...entry, delta: 0 }).success).toBe(false);
    expect(ledgerEntrySchema.safeParse({ ...entry, reason: 'loot' }).success).toBe(false);
  });

  it('requires an idempotency key on a purchase', () => {
    expect(purchaseRequestSchema.safeParse({ itemRef: 'plant:java-fern' }).success).toBe(false);
    expect(
      purchaseRequestSchema.safeParse({ itemRef: 'plant:java-fern', idempotencyKey: 'abcdefgh1' })
        .success,
    ).toBe(true);
  });

  it('requires userId on a ledger row even when it is null', () => {
    const withoutUser: Record<string, unknown> = { ...entry };
    delete withoutUser.userId;
    expect(ledgerEntrySchema.safeParse(withoutUser).success).toBe(false);
  });

  it.each(['subscription', 'clawback', 'restore', 'refund'])('accepts the %s reason', (reason) => {
    expect(ledgerEntrySchema.safeParse({ ...entry, reason }).success).toBe(true);
  });

  it.each(['amount', 'price', 'delta'])('rejects a purchase request carrying %s', (field) => {
    const request = { itemRef: 'plant:java-fern', idempotencyKey: 'abcdefgh1', [field]: 0 };
    expect(purchaseRequestSchema.safeParse(request).success).toBe(false);
  });

  it.each([
    ['abcdefg', false],
    ['abcdefgh', true],
    ['a'.repeat(128), true],
    ['a'.repeat(129), false],
    ['abcd:efgh', false],
    ['abcd efgh', false],
    ['abcd_ef-GH12', true],
  ])('idempotency key %j valid: %s', (key, valid) => {
    expect(idempotencyKeySchema.safeParse(key).success).toBe(valid);
  });

  it('keeps add-fish backward compatible and takes a stage', () => {
    const base = { species: 'neon-tetra', name: 'Blip' };
    expect(addFishRequestSchema.parse(base).stage).toBeUndefined();
    expect(DEFAULT_PURCHASE_STAGE).toBe('adult');
    expect(addFishRequestSchema.parse({ ...base, stage: 'juvenile' }).stage).toBe('juvenile');
    expect(addFishRequestSchema.safeParse({ ...base, stage: 'fry' }).success).toBe(false);
  });
});
