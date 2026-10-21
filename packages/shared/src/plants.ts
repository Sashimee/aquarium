import { z } from 'zod';
import { MAX_EQUIPMENT_TIER } from './equipment.js';
import { idempotencyKeySchema } from './economy.js';

const rate = z.number().nonnegative();

export const plantFormSchema = z.enum(['stem', 'rosette', 'carpet', 'runner', 'epiphyte']);
export type PlantForm = z.infer<typeof plantFormSchema>;

export const plantSpreadSchema = z.strictObject({
  intervalDays: z
    .number()
    .positive()
    .describe('days of full-rate growth (light and nutrients) it takes to put out one offset'),
  cap: z.int().positive().describe('offsets one plant may have'),
  radiusM: z.number().positive().describe('how far from the parent an offset may root, in metres'),
  minParentSize: z.number().positive().describe('size multiplier the parent must have reached'),
});

// content/plants.json, one entry per freshwater plant asset id of DECOR_ASSET_IDS.
export const plantSpeciesSchema = z
  .strictObject({
    id: z.string().min(1).max(64).describe('the decor asset id'),
    form: plantFormSchema,
    growthPerDay: rate.describe('logistic growth rate per day at full light and nutrients'),
    minSize: z.number().positive().describe('smallest size multiplier a trim may leave'),
    maxSize: z.number().positive().describe('the cap growth approaches'),
    lightDemand: z
      .number()
      .positive()
      .describe('light tier x intensity at which the plant grows at full rate'),
    co2Response: z.number().min(0).max(1).describe('share of the CO2 growth bonus it takes up'),
    nitratePerSize: rate.describe('nitrate removed from a 300 L tank per +1.0 of size'),
    nitrateHalfSaturation: z
      .number()
      .positive()
      .describe('nitrate level at which uptake runs at half speed'),
    coverage: rate.describe('weight per unit of size in the competition with algae'),
    spread: plantSpreadSchema.nullable(),
  })
  .refine((p) => p.minSize < 1 && p.maxSize > 1, {
    message: 'a plant starts at size 1, so minSize must be below 1 and maxSize above it',
    path: ['maxSize'],
  })
  .refine((p) => (p.form === 'runner' || p.form === 'carpet') === (p.spread !== null), {
    message: 'only runner and carpet plants spread, and they must say how',
    path: ['spread'],
  });
export type PlantSpecies = z.infer<typeof plantSpeciesSchema>;

export const plantParametersSchema = z.strictObject({
  co2GrowthPerTier: z
    .array(rate)
    .length(MAX_EQUIPMENT_TIER + 1)
    .describe('growth multiplier for a plant with co2Response 1, index = CO2 tier'),
  algaeSuppressionPerHour: rate.describe(
    'share of the algae a fully active, fully covering planting removes per hour',
  ),
  offsetStartSize: z.number().positive().describe('size multiplier of a new offset'),
  maxOffsetsPerTank: z.int().positive(),
  offsetSpacingM: z.number().nonnegative().describe('offsets try to root this far from any plant'),
  edgeMarginM: z.number().nonnegative().describe('offsets root this far inside the substrate'),
  sources: z.record(z.string(), z.array(z.string().min(1)).min(1)),
});
export type PlantParameters = z.infer<typeof plantParametersSchema>;

export const hardscapeFootprintSchema = z.strictObject({
  id: z.string().min(1).max(64).describe('the decor asset id'),
  halfX: z.number().positive().describe('half the model width at scale 1, in metres'),
  halfZ: z.number().positive().describe('half the model depth at scale 1, in metres'),
});
export type HardscapeFootprint = z.infer<typeof hardscapeFootprintSchema>;

export const plantContentSchema = z
  .strictObject({
    params: plantParametersSchema,
    plants: z.array(plantSpeciesSchema).min(1),
    hardscape: z
      .array(hardscapeFootprintSchema)
      .describe('rocks and wood an offset must not root inside, from the asset bounds'),
  })
  .refine((c) => new Set(c.plants.map((p) => p.id)).size === c.plants.length, {
    message: 'duplicate plant id',
    path: ['plants'],
  })
  .refine((c) => new Set(c.hardscape.map((h) => h.id)).size === c.hardscape.length, {
    message: 'duplicate hardscape id',
    path: ['hardscape'],
  })
  .refine((c) => c.plants.every((p) => c.params.offsetStartSize >= p.minSize), {
    message:
      'offsetStartSize must be at least every plant minSize, or a new offset starts below what can be trimmed to',
    path: ['params', 'offsetStartSize'],
  });
export type PlantContent = z.infer<typeof plantContentSchema>;

export const plantKeySchema = z.string().min(1).max(40);

// The persisted growth state of one plant, tanks.plants.
export const storedPlantSchema = z.strictObject({
  key: plantKeySchema,
  assetId: z.string().min(1).max(64),
  parentKey: plantKeySchema.nullable(),
  position: z.tuple([z.number(), z.number()]).nullable(),
  size: z.number().positive(),
  spreadProgress: z.number().min(0).max(1),
  spawned: z.int().nonnegative(),
});
export type StoredPlant = z.infer<typeof storedPlantSchema>;
export const storedPlantsSchema = z.array(storedPlantSchema).max(400);

export const plantSchema = z.object({
  key: plantKeySchema.describe(
    'stable id. A plant in the decor layout has key `s<tintSeed>` (`-2`, `-3` for the second, third ... piece with the same seed); an offset has its parent key + `.<n>`',
  ),
  assetId: z.string(),
  tintSeed: z
    .number()
    .int()
    .nullable()
    .describe('the layout piece this plant is, matched on DecorItem.tintSeed; null for an offset'),
  parentKey: plantKeySchema.nullable(),
  position: z
    .tuple([z.number(), z.number()])
    .nullable()
    .describe(
      'offset only: x and z in tank space, metres. y is the substrate surface at that spot. null for a layout plant, which sits where the layout puts it',
    ),
  size: z.number().positive().describe('multiplier on the layout scale; 1 is as bought'),
  minSize: z.number().positive(),
  maxSize: z.number().positive(),
});
export type Plant = z.infer<typeof plantSchema>;

// POST /api/tanks/:tankId/plants/trim cuts one plant back to `size` (a multiplier on its layout
// scale) and answers with the tank. The cut mass leaves the tank, so nitrate and every other level
// stay as they are. The tank is caught up first, so the plant is trimmed at its size now, not the
// size the client last saw.
// Refusals: 404 unknown tank (or another user's) or plant; 400 size below the species' minSize;
// 409 reason plant_not_grown when the plant is already at or below `size`; 409 reason key_reused
// when the idempotency key was used for another plant or size. A retry with the same key replays:
// it returns the current tank and trims nothing again. The server remembers the last 16 keys per tank.
export const trimPlantRequestSchema = z.strictObject({
  plantKey: plantKeySchema,
  size: z.number().positive().max(100),
  idempotencyKey: idempotencyKeySchema,
});
export type TrimPlantRequest = z.infer<typeof trimPlantRequestSchema>;

export const PLANT_TRIM_KEYS_REMEMBERED = 16;
export const trimKeysSchema = z
  .array(z.strictObject({ key: z.string(), plantKey: plantKeySchema, size: z.number() }))
  .max(PLANT_TRIM_KEYS_REMEMBERED);
