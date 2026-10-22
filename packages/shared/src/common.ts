import { z } from 'zod';

export const idSchema = z.uuid();
export const authIdSchema = z.string().min(1).max(64);
export const timestampSchema = z.iso.datetime();
export const unitSchema = z.number().min(0).max(1);
export const biomeSchema = z.enum(['freshwater', 'reef', 'cichlid', 'blackwater', 'mangrove']);
export type Biome = z.infer<typeof biomeSchema>;

// Biomes a player can start a tank in. A biome joins when its preset, species and backgrounds ship.
export const playableBiomeSchema = z.enum([
  'freshwater',
  'reef',
  'cichlid',
  'blackwater',
  'mangrove',
]);
export type PlayableBiome = z.infer<typeof playableBiomeSchema>;

// Biomes a new tank can be created in. A biome joins when its species content ships.
export const creatableBiomeSchema = z.enum([
  'freshwater',
  'reef',
  'cichlid',
  'blackwater',
  'mangrove',
]);
export type CreatableBiome = z.infer<typeof creatableBiomeSchema>;

export const isPlayableBiome = (biome: Biome): biome is PlayableBiome =>
  playableBiomeSchema.safeParse(biome).success;

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
  tintSeed: z.number().int().min(0).max(0xffffffff).optional().describe('stable colour seed'),
});
export type DecorItem = z.infer<typeof decorItemSchema>;

export const decorItemResponseSchema = z.object(decorItemSchema.shape);

// FNV-1a over the placement, matching the web's former coral placement key, so rows saved before
// tintSeed existed keep the colour they already show.
export function legacyTintSeed(item: Pick<DecorItem, 'position' | 'rotationY'>): number {
  let h = 2166136261;
  for (const v of [...item.position, item.rotationY]) {
    h = Math.imul(h ^ Math.round(v * 1000), 16777619) >>> 0;
  }
  return h;
}

export const decorLayoutSchema = z.array(decorItemSchema).max(200);
export const decorLayoutResponseSchema = z.array(decorItemResponseSchema).max(200);
export type DecorLayout = z.infer<typeof decorLayoutSchema>;

export const PROCEDURAL_EUPHYLLIA_ID = /^euphyllia-(hammer|torch)-(0|[1-9]\d{0,8})$/;
