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
  traits: z.array(z.string().min(1)).default([]),
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
    bodyLengthM: positive,
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

export const lifecycleSchema = z.strictObject({
  hungerPerHour: rate,
  healthLossPerHourStarving: rate,
  healthRecoveryPerHour: rate,
  starvationHungerThreshold: unitSchema.default(0.75),
  ammoniaTolerance: rate,
  birthSizeM: positive,
  maxSizeM: positive,
  growthPerDay: rate,
  lifespanDays: positive,
  diet: z.array(foodTypeSchema).min(1),
  bioload: positive,
  ammoniaPerBioloadPerHour: rate,
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

export const presetLayoutSchema = z.strictObject({
  id: slugSchema,
  name: z.string().min(1),
  biome: biomeSchema,
  decor: decorLayoutSchema,
});
export type PresetLayout = z.infer<typeof presetLayoutSchema>;
