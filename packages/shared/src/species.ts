import { z } from 'zod';
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
  schooling: z.strictObject({
    minGroup: z.int().min(1),
    topologicalNeighbours: z.int().min(1).max(12),
    tightenWhenStartled: z.boolean(),
  }),
  territorial: z.boolean(),
  preferredZone: zoneSchema,
  depthBand: z
    .tuple([unitSchema, unitSchema])
    .refine(([lo, hi]) => lo <= hi, 'depthBand must be [low, high]'),
  perceptionRange: positive,
  perceptionFovDeg: z.number().min(1).max(360),
  curiosity: unitSchema,
  boldness: unitSchema,
  traits: z.array(z.string().min(1)).default([]),
});

export const locomotionSchema = z.strictObject({
  swimmingMode: swimmingModeSchema,
  gait: gaitSchema,
  maxSpeed: positive,
  cruiseSpeed: positive,
  mass: positive,
  maxTurnRateDegPerS: positive,
  maxPitchDeg: z.number().min(0).max(90),
  strouhal: z.number().min(0.2).max(0.4).default(0.3),
  bodyLength: positive,
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
  maxSize: positive,
  growthPerDay: rate,
  bioload: positive,
  ammoniaPerBioloadPerHour: rate,
  foodDecayMinutes: positive,
  filterRemovalPerHour: rate,
  nitratePerHour: rate,
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
