import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { addFishRequestSchema } from './tank.js';
import {
  DEFAULT_PURCHASE_STAGE,
  economySchema,
  ledgerEntrySchema,
  purchaseRequestSchema,
} from './economy.js';

const content = join(import.meta.dirname, '../../../content');
const readJson = (path: string): unknown => JSON.parse(readFileSync(join(content, path), 'utf8'));
const economyJson = () => structuredClone(readJson('economy.json')) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe('content/economy.json', () => {
  const economy = economySchema.parse(readJson('economy.json'));

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
      expect(p.adult / p.juvenile, id).toBeGreaterThan(2);
      expect(p.adult / p.juvenile, id).toBeLessThan(3.5);
    }
  });

  it('sells packs with more Pearls per euro as they grow', () => {
    const perEuro = economy.packs.map((p) => p.pearls / p.priceCents);
    expect(perEuro).toEqual([...perEuro].sort((a, b) => a - b));
    expect(new Set(perEuro).size).toBe(perEuro.length);
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
    const bad = economyJson();
    bad.species['neon-tetra'] = { juvenile: 40, adult: 40 };
    expect(economySchema.safeParse(bad).success).toBe(false);
  });

  it.each([0, -5])('rejects a price of %i', (price) => {
    const bad = economyJson();
    bad.items.consumables.testKit = price;
    expect(economySchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a non-positive cap', () => {
    const bad = economyJson();
    bad.earn.dailyCare.dailyCap = 0;
    expect(economySchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a pack that is worse value than a smaller one', () => {
    const bad = economyJson();
    bad.packs[2].pearls = 900;
    expect(economySchema.safeParse(bad).success).toBe(false);
  });

  it('rejects an unknown item key', () => {
    const bad = economyJson();
    bad.items.consumables.waterChange = 5;
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

  it('keeps add-fish backward compatible and takes a stage', () => {
    const base = { species: 'neon-tetra', name: 'Blip' };
    expect(addFishRequestSchema.parse(base).stage).toBeUndefined();
    expect(DEFAULT_PURCHASE_STAGE).toBe('adult');
    expect(addFishRequestSchema.parse({ ...base, stage: 'juvenile' }).stage).toBe('juvenile');
    expect(addFishRequestSchema.safeParse({ ...base, stage: 'fry' }).success).toBe(false);
  });
});
