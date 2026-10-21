import { z } from 'zod';
import {
  authIdSchema,
  idSchema,
  PROCEDURAL_EUPHYLLIA_ID,
  slugSchema,
  timestampSchema,
} from './common.js';
import { diseaseKindSchema } from './fishState.js';
import { tankSizeSchema } from './tankSize.js';

// Tables and routes live in apps/api (T70, PLAN 9.2).
//   wallet(user_id PK -> user ON DELETE CASCADE, balance integer): cache of the ledger sum, kept
//     apart from Better Auth's user table.
//   ledger(id, user_id -> user ON DELETE SET NULL, delta, reason, source, item_ref, idempotency_key,
//     created_at): append-only. Real-money rows (source stripe|apple) lose their user ref on account
//     deletion and stay 10 years; play rows (source game) are deleted with the account, so user_id
//     is never null on them.
//   Two partial unique indexes, exactly:
//     payment keys: UNIQUE (source, idempotency_key) WHERE source <> 'game'
//     play keys:    UNIQUE (user_id, idempotency_key) WHERE source = 'game'
//   A single UNIQUE (source, idempotency_key) would make one user's purchase key, or a server key
//   like daily-care-2026-10-19, collide with every other user's.
//   Replaying a key with the same itemRef returns the stored entry with replayed: true and charges
//   nothing. Replaying it with a different itemRef returns 409.
//   Every paid route charges through one spend(): UPDATE wallet SET balance = balance - n
//     WHERE user_id = u AND balance >= n RETURNING balance.
//   The amount always comes from content/economy.json by itemRef; a request never carries one.
// The balance may go negative after a chargeback; basic care is never blocked by it.
//
// Ledger reasons:
//   purchase      game spend, delta < 0
//   earn          game reward, delta > 0
//   grant         starting and migration grants, source game
//   pack          a Pearl pack bought, source stripe|apple
//   subscription  the daily Pearls of the subscription, source stripe|apple, itemRef sub:<id>
//   refund        a game purchase given back, source game, delta > 0
//   clawback      Pearls removed after a refunded payment or a lost dispute, source stripe|apple,
//                 delta < 0, itemRef names the original pack or subscription row
//   restore       Pearls returned after a won dispute, source stripe|apple, delta > 0
//
// A fish is bought through add-fish only; purchase rejects species:* refs.
//
// Plants and decor are priced by the ids of DECOR_ASSET_IDS (the ids a layout holds), not by
// manifest ids. The procedural euphyllia-<hammer|torch>-<n> pieces share items.euphyllia; see
// decorPrice(), which ignores the biome: T70 must check the biome before charging. The vacation-feeder is free: it is survival care, and basic care is never priced.

export const pearlsSchema = z.int();
export const priceSchema = z
  .int()
  .positive()
  .describe('price in Pearls, 1 Pearl is about 1 euro cent');

export const walletSchema = z.strictObject({ balance: pearlsSchema });
export type Wallet = z.infer<typeof walletSchema>;

export const ledgerReasonSchema = z.enum([
  'purchase',
  'earn',
  'grant',
  'pack',
  'subscription',
  'refund',
  'clawback',
  'restore',
]);
export type LedgerReason = z.infer<typeof ledgerReasonSchema>;

export const ledgerSourceSchema = z.enum(['stripe', 'apple', 'game']);
export type LedgerSource = z.infer<typeof ledgerSourceSchema>;

export const idempotencyKeySchema = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);

// What the ledger stores: a client key, or a server reward key with a ':' no client key may hold.
export const ledgerKeySchema = z
  .string()
  .min(8)
  .max(160)
  .regex(/^[A-Za-z0-9_:-]+$/);

export const itemRefSchema = z
  .string()
  .min(1)
  .max(120)
  .describe(
    'what was bought or earned, e.g. plant:java-fern or pack:pearls-550; purchase rejects species:* refs',
  );

export const ledgerEntrySchema = z.strictObject({
  id: idSchema,
  userId: authIdSchema
    .nullable()
    .describe('null once the row is pseudonymised on account deletion'),
  delta: pearlsSchema.refine((n) => n !== 0, 'a ledger entry moves Pearls'),
  reason: ledgerReasonSchema,
  source: ledgerSourceSchema,
  itemRef: itemRefSchema.nullable(),
  idempotencyKey: ledgerKeySchema,
  createdAt: timestampSchema,
});
export type LedgerEntry = z.infer<typeof ledgerEntrySchema>;

export const ONE_TIME_REF = /^(plant|decor|background):/;

export const walletResponseSchema = z.strictObject({
  wallet: walletSchema,
  ledger: z.array(ledgerEntrySchema),
  owned: z
    .array(itemRefSchema)
    .describe(
      'every one-time item ref (plant:, decor:, background:) whose latest purchase or refund entry is a purchase, over the whole ledger and not just the returned page; fish, tanks, consumables and equipment tiers are never listed',
    ),
});
export type WalletResponse = z.infer<typeof walletResponseSchema>;

export const purchaseRequestSchema = z.strictObject({
  idempotencyKey: idempotencyKeySchema,
  itemRef: itemRefSchema,
  tankId: idSchema.optional(),
});
export type PurchaseRequest = z.infer<typeof purchaseRequestSchema>;

export const purchaseResponseSchema = z.strictObject({
  wallet: walletSchema,
  entry: ledgerEntrySchema,
  replayed: z
    .boolean()
    .describe('true when the idempotency key was already used and nothing was charged again'),
});
export type PurchaseResponse = z.infer<typeof purchaseResponseSchema>;

export const purchasableStageSchema = z.enum(['juvenile', 'adult']);
export type PurchasableStage = z.infer<typeof purchasableStageSchema>;

// What add-fish did before the shop had stages: the fish.stage column default.

const range = z
  .strictObject({ min: priceSchema, max: priceSchema })
  .refine((r) => r.max >= r.min, 'max must not be below min');

const tierPrices = z
  .array(priceSchema)
  .min(1)
  .max(3)
  .refine((p) => p.every((v, i) => i === 0 || v > (p[i - 1] ?? 0)), 'a higher tier costs more')
  .describe('price of tier 1, 2, 3 in order');

const pricedRange = (keys: z.ZodType<string>) =>
  z
    .strictObject({
      min: priceSchema,
      max: priceSchema,
      prices: z.record(keys, priceSchema).describe('the price of each item, within min and max'),
    })
    .refine((r) => r.max >= r.min, 'max must not be below min')
    .refine(
      (r) => Object.values(r.prices).every((v) => v >= r.min && v <= r.max),
      'every price lies within min and max',
    );

const speciesPriceSchema = z
  .strictObject({ juvenile: priceSchema, adult: priceSchema })
  .refine((p) => p.adult > p.juvenile, 'an adult costs more than a juvenile');

const dailyCap = z.int().positive();

export const packSchema = z.strictObject({
  id: slugSchema,
  priceCents: z.int().positive().describe('euro cents, VAT included'),
  pearls: z.int().positive(),
  webAvailable: z
    .boolean()
    .describe('false when Stripe fees make the pack unprofitable on the web'),
});
export type Pack = z.infer<typeof packSchema>;

export const economySchema = z
  .strictObject({
    pearlValueCents: z.number().positive(),
    species: z.record(slugSchema, speciesPriceSchema),
    items: z.strictObject({
      plant: pricedRange(z.string().min(1)).describe('prices keyed by DECOR_ASSET_IDS id'),
      decor: pricedRange(z.string().min(1)).describe('prices keyed by DECOR_ASSET_IDS id'),
      euphyllia: priceSchema.describe('every procedural euphyllia piece, within the decor range'),
      background: z.strictObject({
        price: priceSchema,
        freePerBiome: z.int().positive(),
      }),
      equipment: z.strictObject({
        heater: tierPrices,
        filter: tierPrices,
        light: tierPrices,
        co2: tierPrices,
        waveMaker: tierPrices,
      }),
      consumables: z.strictObject({
        premiumFood: priceSchema,
        premiumMedicine: pricedRange(diseaseKindSchema).describe('prices keyed by disease kind'),
        bottledBacteria: priceSchema,
        testKit: priceSchema,
      }),
      tankSlots: z.array(priceSchema).length(5).describe('extra tanks 2 to 6, in order'),
      tankSizes: z
        .partialRecord(tankSizeSchema, priceSchema)
        .describe('paid upgrades; standard is the free default size and is not listed'),
    }),
    earn: z.strictObject({
      dailyCare: z.strictObject({ reward: range, dailyCap }),
      healthyTankStreak: z.strictObject({
        perDay: priceSchema,
        dailyCap: dailyCap.describe('per account per day, across all tanks'),
      }),
      achievement: z.strictObject({ reward: range, dailyCap }),
      frySale: z.strictObject({
        percentOfJuvenilePrice: z.int().min(1).max(100),
        dailyCap,
      }),
    }),
    grants: z.strictObject({
      starting: priceSchema,
      migration: priceSchema,
    }),
    packs: z.array(packSchema).min(1),
    subscription: z.strictObject({
      id: slugSchema,
      priceCents: z.int().positive(),
      interval: z.literal('month'),
      pearlsPerDay: priceSchema,
    }),
  })
  .superRefine((e, ctx) => {
    if (e.items.euphyllia < e.items.decor.min || e.items.euphyllia > e.items.decor.max) {
      ctx.addIssue({
        code: 'custom',
        path: ['items', 'euphyllia'],
        message: 'the euphyllia price lies within the decor range',
      });
    }
    let previous = 0;
    e.packs.forEach((pack, i) => {
      const perEuro = pack.pearls / pack.priceCents;
      if (perEuro <= previous) {
        ctx.addIssue({
          code: 'custom',
          path: ['packs', i],
          message: 'a bigger pack must give more Pearls per euro',
        });
      }
      previous = perEuro;
    });
  });
export type Economy = z.infer<typeof economySchema>;

export function decorPrice(economy: Economy, assetId: string): number | undefined {
  if (PROCEDURAL_EUPHYLLIA_ID.test(assetId)) return economy.items.euphyllia;
  const { plant, decor } = economy.items;
  if (Object.hasOwn(plant.prices, assetId)) return plant.prices[assetId];
  if (Object.hasOwn(decor.prices, assetId)) return decor.prices[assetId];
  return undefined;
}
