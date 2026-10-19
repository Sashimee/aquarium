import { z } from 'zod';

export const FIN_MASK_ATTRIBUTE = '_FIN_MASK';
export const SWAY_ATTRIBUTE = '_SWAY';
export const FIN_ID_ATTRIBUTE = '_FIN_ID';
export const MOUTH_ATTRIBUTE = '_MOUTH';
export const LEG_ATTRIBUTE = '_LEG';
export const FIN_IDS = { caudal: 1, dorsal: 2, anal: 3, pectoral: 4, pelvic: 5 } as const;
export type FinName = keyof typeof FIN_IDS;
export const SHRIMP_PART_IDS = { body: 0, leg: 6, antenna: 7, pleopod: 8, abdomen: 9 } as const;
export type ShrimpPartName = keyof typeof SHRIMP_PART_IDS;
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
  mouthMask: z.strictObject({ attribute: z.literal(MOUTH_ATTRIBUTE) }),
  debugRender: z.string().min(1),
});

export const shrimpInfoSchema = z.strictObject({
  standardLengthM: z.number().positive(),
  lengthSource: z.enum(['species-json', 'recipe']),
  axes: z.strictObject({ forward: z.literal('+z'), up: z.literal('+y') }),
  origin: z.literal('centre-of-mass'),
  standoffM: z.number().positive(),
  attributes: z.strictObject({
    partId: z.literal(FIN_ID_ATTRIBUTE),
    weight: z.literal(FIN_MASK_ATTRIBUTE),
    limb: z.literal(LEG_ATTRIBUTE),
  }),
  partIds: z.strictObject({
    body: z.literal(0),
    leg: z.literal(6),
    antenna: z.literal(7),
    pleopod: z.literal(8),
    abdomen: z.literal(9),
  }),
  legPairs: z.literal(5),
  pleopodPairs: z.literal(5),
  abdomenHinge: z.strictObject({ y: z.number(), z: z.number() }),
  telsonZ: z.number(),
  debugRender: z.string().min(1),
  debugPartsRender: z.string().min(1),
});

export const IMPOSTOR_MAX_BYTES = 1_000_000;
export const IMPOSTOR_FILES = {
  albedo: 'impostor_albedo.ktx2',
  normalDepth: 'impostor_normal.ktx2',
} as const;

export const impostorSchema = z.strictObject({
  sourceLod: z.literal(1),
  layout: z.literal('octahedral'),
  pose: z.literal('rest'),
  grid: z.int().min(2),
  frameSize: z.int().positive(),
  atlasSize: z.int().positive(),
  pivot: vec3,
  radius: z.number().positive(),
  albedo: fileEntry.extend({ codec: z.literal('etc1s') }),
  normalDepth: fileEntry.extend({ codec: z.literal('uastc') }),
});

export const AUDIO_MAX_TOTAL_BYTES = 5_000_000;
export const AUDIO_MAX_FILE_BYTES = 1_000_000;

export const audioInfoSchema = z.strictObject({
  role: z.string().min(1),
  loop: z.boolean(),
  durationS: z.number().positive(),
  sampleRate: z.int().positive(),
  channels: z.int().positive(),
  bitrateKbps: z.int().positive(),
  loudnessLufs: z.number(),
  file: z.string().min(1),
});

export const assetKindSchema = z.enum([
  'fish',
  'shrimp',
  'anemone',
  'plant',
  'coral',
  'driftwood',
  'rock',
  'decor',
  'substrate',
  'hdri',
  'audio',
]);
export type AssetKind = z.infer<typeof assetKindSchema>;

export const outputAssetSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  kind: assetKindSchema,
  species: z.string().min(1).optional(),
  origin: z.enum([
    'model',
    'procedural-loft',
    'procedural',
    'texture-set',
    'passthrough',
    'recording',
  ]),
  sources: z.array(z.string().min(1)),
  licence: z.string().min(1),
  modifications: z.array(z.string().min(1)),
  bounds: z.strictObject({ min: vec3, max: vec3 }).optional(),
  lods: z.array(lodSchema),
  textures: z.array(textureSchema),
  files: z.array(fileEntry),
  fish: fishInfoSchema.optional(),
  impostor: impostorSchema.optional(),
  shrimp: shrimpInfoSchema.optional(),
  audio: audioInfoSchema.optional(),
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
  'three.js GLTFLoader lower-cases custom attributes: _FIN_MASK is geometry attribute "_fin_mask" (0 rigid body, 1 fin tip) and _FIN_ID is "_fin_id" (0 body, 1 caudal, 2 dorsal, 3 anal, 4 pectoral, 5 pelvic). Every fish LOD also carries _MOUTH, geometry attribute "_mouth", a float in [0, 1] for buccal motion: 1 at the jaw or lower-lip tip (every LOD is renormalised so its highest value is exactly 1), easing to 0 behind the gill line and above the mouth slit; fins, eyes and attachments are 0. Anemone tentacle sway is "_sway" (0 base, 1 tip). Shrimp reuse _fin_id (0 body, carapace and eyes; 6 walking leg; 7 antenna; 8 pleopod; 9 abdomen, telson and tail fan) and add "_leg" (limb index: pair * 2 + side, side 0 = -x; antennules 0/1, long antennae 2/3; tail-fan leaves k * 2 + side). Shrimp _fin_mask means: id 0 is 0 (eye stalks included, ignore it); ids 6 and 7 are the weight along the limb, 0 root to 1 tip; id 8 is the pleopod beat weight, 0 root to 1 tip; id 9 is the tail-curl weight clamp((hingeZ - z) / (hingeZ - telsonZ), 0, 1) of the rest position. Tail curl rotates ids 8 and 9 about +x through the shrimp.abdomenHinge {y, z} by flex * clamp((hingeZ - z) / (hingeZ - telsonZ), 0, 1), computed from the rest position, never from _fin_mask, so the pleopods follow the segment they hang from. Pleopods (id 8) exist only in LOD0 and LOD1 and are removed from LOD2; legs are simplified, so do not assume every _leg index exists at every LOD. The cherry material is alphaMode BLEND with base colour alpha 0.86: three.js GLTFLoader turns depthWrite off for BLEND, so set depthWrite true on the cherry material and expect some sorting artefacts from the self-overlapping legs and antennae.';
