import { z } from 'zod';

export const idSchema = z.uuid();
export const timestampSchema = z.iso.datetime();
export const unitSchema = z.number().min(0).max(1);
export const biomeSchema = z.enum(['freshwater', 'reef']);
export type Biome = z.infer<typeof biomeSchema>;

export const slugSchema = z.string().regex(/^[a-z][a-z0-9-]*$/);

export const decorItemSchema = z.strictObject({
  assetId: z.string().min(1),
  position: z.tuple([z.number(), z.number(), z.number()]),
  rotationY: z.number().default(0),
  scale: z.number().positive().default(1),
});
export type DecorItem = z.infer<typeof decorItemSchema>;

export const decorLayoutSchema = z.array(decorItemSchema).max(200);
export type DecorLayout = z.infer<typeof decorLayoutSchema>;
