import { z } from 'zod';

export const FIN_MASK_ATTRIBUTE = '_FIN_MASK';
export const SWAY_ATTRIBUTE = '_SWAY';
export const FIN_ID_ATTRIBUTE = '_FIN_ID';
export const FIN_IDS = { caudal: 1, dorsal: 2, anal: 3, pectoral: 4, pelvic: 5 } as const;
export type FinName = keyof typeof FIN_IDS;
export const LOD_COUNT = 3;

const vec3 = z.tuple([z.number(), z.number(), z.number()]);

const fileEntry = z.strictObject({
  file: z.string().min(1),
  bytes: z.int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

export const lodSchema = fileEntry.extend({
  triangles: z.int().positive(),
  vertices: z.int().positive(),
});

export const textureVariantSchema = fileEntry.extend({
  size: z.int().positive(),
  codec: z.enum(['etc1s', 'uastc']),
});

export const textureSchema = z.strictObject({
  name: z.string().min(1),
  role: z.enum(['baseColor', 'normal', 'metallicRoughness', 'occlusionRoughnessMetal', 'emissive']),
  colorSpace: z.enum(['srgb', 'linear']),
  variants: z.strictObject({
    '1k': textureVariantSchema,
    '2k': textureVariantSchema,
  }),
});

export const fishInfoSchema = z.strictObject({
  standardLengthM: z.number().positive(),
  lengthSource: z.enum(['species-json', 'recipe']),
  axes: z.strictObject({ forward: z.literal('+z'), up: z.literal('+y') }),
  origin: z.literal('centre-of-mass'),
  finMask: z.strictObject({
    maskAttribute: z.literal(FIN_MASK_ATTRIBUTE),
    idAttribute: z.literal(FIN_ID_ATTRIBUTE),
    ids: z.strictObject({
      caudal: z.literal(1),
      dorsal: z.literal(2),
      anal: z.literal(3),
      pectoral: z.literal(4),
      pelvic: z.literal(5),
    }),
  }),
  debugRender: z.string().min(1),
});

export const assetKindSchema = z.enum([
  'fish',
  'anemone',
  'plant',
  'coral',
  'driftwood',
  'rock',
  'decor',
  'substrate',
  'hdri',
]);
export type AssetKind = z.infer<typeof assetKindSchema>;

export const outputAssetSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  kind: assetKindSchema,
  species: z.string().min(1).optional(),
  origin: z.enum(['model', 'procedural-loft', 'procedural', 'texture-set', 'passthrough']),
  sources: z.array(z.string().min(1)),
  licence: z.string().min(1),
  modifications: z.array(z.string().min(1)),
  bounds: z.strictObject({ min: vec3, max: vec3 }).optional(),
  lods: z.array(lodSchema),
  textures: z.array(textureSchema),
  files: z.array(fileEntry),
  fish: fishInfoSchema.optional(),
});
export type OutputAsset = z.infer<typeof outputAssetSchema>;

export const assetIndexSchema = z.strictObject({
  version: z.literal(1),
  textureVariants: z.string(),
  customAttributes: z.string(),
  totalBytes: z.int().nonnegative(),
  assets: z.array(outputAssetSchema),
});
export type AssetIndex = z.infer<typeof assetIndexSchema>;

export const TEXTURE_VARIANTS_NOTE =
  'GLBs reference the 1k KTX2 files by relative uri. Quality tiers that want 2k rewrite "_1k.ktx2" to "_2k.ktx2" in a LoadingManager URL modifier; every texture has both files.';
export const CUSTOM_ATTRIBUTES_NOTE =
  'three.js GLTFLoader lower-cases custom attributes: _FIN_MASK is geometry attribute "_fin_mask" (0 rigid body, 1 fin tip) and _FIN_ID is "_fin_id" (0 body, 1 caudal, 2 dorsal, 3 anal, 4 pectoral, 5 pelvic). Anemone tentacle sway is "_sway" (0 base, 1 tip).';
