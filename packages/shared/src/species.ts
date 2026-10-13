import { z } from 'zod';
import { foodTypeSchema } from './events.js';
import { biomeSchema, decorLayoutSchema, slugSchema, unitSchema } from './common.js';

const positive = z.number().positive();
const rate = z.number().nonnegative();

export const swimmingModeSchema = z.enum([
  'carangiform',
  'subcarangiform',
  'labriform',
  'anguilliform',
]);
export const gaitSchema = z.enum(['burst-and-coast', 'cruise', 'hover', 'forage']);
export const zoneSchema = z.enum(['surface', 'mid', 'bottom']);

export const traitSchema = z.enum([
  'shoal',
  'air-gulp',
  'glass-grazer',
  'rock-grazer',
  'anemone-host',
  'cave-dweller',
  'flare-display',
]);
export type Trait = z.infer<typeof traitSchema>;

export const behaviourSchema = z.strictObject({
  schooling: z
    .strictObject({
      minGroup: z.int().min(1),
      topologicalNeighbours: z.int().min(1).max(12),
      tightenWhenStartled: z.boolean(),
    })
    .optional(),
  territorial: z.boolean(),
  preferredZone: zoneSchema,
  depthBand: z
    .tuple([unitSchema, unitSchema])
    .refine(([lo, hi]) => lo <= hi, 'depthBand must be [low, high]'),
  perceptionRangeM: positive,
  perceptionFovDeg: z.number().min(1).max(360),
  curiosity: unitSchema,
  boldness: unitSchema,
  traits: z.array(traitSchema).default([]),
  airGulp: z.strictObject({ perHour: z.number().positive().max(120) }).optional(),
  grazing: z
    .strictObject({
      meanIntervalS: z.number().positive().max(3600),
      minS: z.number().positive().max(60).optional(),
      maxS: z.number().positive().max(60).optional(),
    })
    .refine((g) => g.minS === undefined || g.maxS === undefined || g.minS <= g.maxS, {
      message: 'minS must not exceed maxS',
      path: ['minS'],
    })
    .optional(),
  flare: z
    .strictObject({
      minS: z.number().positive().max(60),
      maxS: z.number().positive().max(60),
    })
    .refine((f) => f.minS <= f.maxS, { message: 'minS must not exceed maxS', path: ['minS'] })
    .optional(),
  station: z
    .strictObject({
      radiusBodyLengths: z.number().positive().max(20).describe('in standard lengths'),
      restationMinS: z.number().positive().max(600).optional(),
      restationMaxS: z.number().positive().max(600).optional(),
    })
    .refine(
      (s) =>
        s.restationMinS === undefined ||
        s.restationMaxS === undefined ||
        s.restationMinS <= s.restationMaxS,
      { message: 'restationMinS must not exceed restationMaxS', path: ['restationMinS'] },
    )
    .optional(),
  refuge: z.strictObject({ afterStartleS: z.number().positive().max(600) }).optional(),
  excursion: z
    .strictObject({
      meanIntervalS: z.number().positive().max(600),
      leashBodyLengths: z.number().positive().max(20).optional().describe('in standard lengths'),
    })
    .optional(),
});

export const locomotionSchema = z
  .strictObject({
    swimmingMode: swimmingModeSchema,
    gait: gaitSchema,
    maxSpeedMps: positive,
    cruiseSpeedMps: positive,
    massKg: positive,
    maxTurnRateDegPerS: positive,
    maxPitchDeg: z.number().min(0).max(90),
    strouhal: z.number().min(0.2).max(0.4).default(0.3),
    bodyLengthM: positive.describe(
      'standard length (snout to caudal peduncle, fin excluded) in metres of the fish the speeds and mass describe; the renderer scales the model so its standard length matches',
    ),
  })
  .refine((l) => l.cruiseSpeedMps <= l.maxSpeedMps, {
    message: 'cruiseSpeedMps must not exceed maxSpeedMps',
    path: ['cruiseSpeedMps'],
  });

export const renderSchema = z.strictObject({
  modelId: z.string().min(1),
  lods: z.array(z.string().min(1)).min(1),
  scale: positive,
  tintVariation: unitSchema,
  finMask: z.boolean(),
});

export const lifecycleSchema = z
  .strictObject({
    hungerPerHour: rate,
    healthLossPerHourStarving: rate,
    healthRecoveryPerHour: rate,
    starvationHungerThreshold: unitSchema.default(0.75),
    ammoniaTolerance: rate,
    birthSizeM: positive.describe('standard length in metres when bought or born'),
    maxSizeM: positive.describe(
      'adult maximum standard length in metres; the drawn total length is this times the model total/standard length ratio',
    ),
    growthPerDay: rate.describe('standard length gained per day, in metres'),
    lifespanDays: positive,
    diet: z.array(foodTypeSchema).min(1),
    bioload: positive,
    ammoniaPerBioloadPerHour: rate,
  })
  .refine((l) => l.birthSizeM <= l.maxSizeM, {
    message: 'birthSizeM must not exceed maxSizeM',
    path: ['birthSizeM'],
  });
export type SpeciesLifecycle = z.infer<typeof lifecycleSchema>;

export const speciesSchema = z.strictObject({
  id: slugSchema,
  commonName: z.string().min(1),
  scientificName: z.string().min(1),
  biome: biomeSchema,
  behaviour: behaviourSchema,
  locomotion: locomotionSchema,
  render: renderSchema,
  lifecycle: lifecycleSchema,
});
export type Species = z.infer<typeof speciesSchema>;

export const speciesSummarySchema = z.strictObject({
  id: slugSchema,
  commonName: z.string().min(1),
  scientificName: z.string().min(1),
  biome: biomeSchema,
  lifecycle: lifecycleSchema,
});
export type SpeciesSummary = z.infer<typeof speciesSummarySchema>;

export const speciesListSchema = z.array(speciesSummarySchema);

const metres = z.number().min(-5).max(5);

export const presetSubstrateSchema = z.strictObject({
  assetId: slugSchema,
  accentAssetId: slugSchema.optional(),
  tint: z.tuple([unitSchema, unitSchema, unitSchema]).default([1, 1, 1]),
  tileMeters: z.number().min(0.05).max(5),
});
export type PresetSubstrate = z.infer<typeof presetSubstrateSchema>;

export const plantPatchSchema = z.strictObject({
  id: slugSchema,
  assetId: slugSchema,
  center: z.tuple([metres, metres]).describe('x, z in metres, tank space'),
  radius: z.number().positive().max(5),
  count: z.int().min(1).max(500).describe('instances at the highest quality tier'),
  scale: z.tuple([z.number().min(0.05).max(10), z.number().min(0.05).max(10)]),
  seed: z.int().min(0).max(0xffffffff),
});
export type PlantPatch = z.infer<typeof plantPatchSchema>;

export const presetCurrentSchema = z.strictObject({
  direction: z
    .tuple([z.number().min(-1).max(1), z.number().min(-1).max(1)])
    .refine(([x, z]) => x !== 0 || z !== 0, 'direction must not be zero')
    .describe('horizontal flow direction (x, z), normalised on load'),
  speed: z.number().min(0).max(1).describe('mean filter flow in m/s'),
  gustPeriodS: z.number().min(1).max(120),
  gustDepth: unitSchema,
});
export type PresetCurrent = z.infer<typeof presetCurrentSchema>;

export const presetLayoutSchema = z.strictObject({
  id: slugSchema,
  name: z.string().min(1),
  biome: biomeSchema,
  decor: decorLayoutSchema,
  substrate: presetSubstrateSchema.optional(),
  plantPatches: z.array(plantPatchSchema).max(64).default([]),
  current: presetCurrentSchema.optional(),
});
export type PresetLayout = z.infer<typeof presetLayoutSchema>;
