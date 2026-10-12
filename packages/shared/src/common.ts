import { z } from 'zod';

export const idSchema = z.uuid();
export const authIdSchema = z.string().min(1).max(64);
export const timestampSchema = z.iso.datetime();
export const unitSchema = z.number().min(0).max(1);
export const biomeSchema = z.enum(['freshwater', 'reef']);
export type Biome = z.infer<typeof biomeSchema>;

export const slugSchema = z.string().regex(/^[a-z][a-z0-9-]*$/);

const coordinate = z.number().min(-5).max(5);

export const decorItemSchema = z.strictObject({
  assetId: z.string().min(1).max(64),
  position: z.tuple([coordinate, coordinate, coordinate]).describe('metres, tank space'),
  rotationY: z
    .number()
    .min(-Math.PI * 2)
    .max(Math.PI * 2)
    .default(0),
  scale: z.number().min(0.01).max(10).default(1),
});
export type DecorItem = z.infer<typeof decorItemSchema>;

export const decorLayoutSchema = z.array(decorItemSchema).max(200);
export type DecorLayout = z.infer<typeof decorLayoutSchema>;
