import { z } from 'zod';
import {
  biomeSchema,
  decorLayoutSchema,
  idSchema,
  slugSchema,
  timestampSchema,
  unitSchema,
} from './common.js';

export const waterSchema = z.strictObject({
  ammonia: z.number().nonnegative(),
  nitrate: z.number().nonnegative(),
  algae: unitSchema,
});
export type Water = z.infer<typeof waterSchema>;

export const fishStatusSchema = z.enum(['alive', 'dead']);
export const causeOfDeathSchema = z.enum(['starvation', 'ammonia', 'old_age', 'unknown']);

export const fishSchema = z.strictObject({
  id: idSchema,
  tankId: idSchema,
  species: slugSchema,
  name: z.string().trim().min(1).max(40),
  bornAt: timestampSchema,
  size: z.number().positive(),
  hunger: unitSchema,
  health: unitSchema,
  status: fishStatusSchema,
  diedAt: timestampSchema.nullable(),
  cause: causeOfDeathSchema.nullable(),
});
export type Fish = z.infer<typeof fishSchema>;

export const memorialSchema = z.strictObject({
  id: idSchema,
  tankId: idSchema,
  fishName: z.string(),
  species: slugSchema,
  bornAt: timestampSchema,
  diedAt: timestampSchema,
  cause: causeOfDeathSchema,
});
export type Memorial = z.infer<typeof memorialSchema>;

export const tankSchema = z.strictObject({
  id: idSchema,
  name: z.string().trim().min(1).max(60),
  biome: biomeSchema,
  decorLayout: decorLayoutSchema,
  water: waterSchema,
  lastTickAt: timestampSchema,
  fish: z.array(fishSchema),
  memorials: z.array(memorialSchema),
});
export type Tank = z.infer<typeof tankSchema>;

export const createTankRequestSchema = z.strictObject({
  name: z.string().trim().min(1).max(60),
  biome: biomeSchema,
});
export type CreateTankRequest = z.infer<typeof createTankRequestSchema>;

export const updateTankRequestSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(60).optional(),
    decorLayout: decorLayoutSchema.optional(),
  })
  .refine((v) => v.name !== undefined || v.decorLayout !== undefined, 'nothing to update');
export type UpdateTankRequest = z.infer<typeof updateTankRequestSchema>;

export const addFishRequestSchema = z.strictObject({
  species: slugSchema,
  name: z.string().trim().min(1).max(40),
});
export type AddFishRequest = z.infer<typeof addFishRequestSchema>;
