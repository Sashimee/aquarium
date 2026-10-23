import { z } from 'zod';
import { PROCEDURAL_EUPHYLLIA_ID } from './common.js';
import { idempotencyKeySchema } from './economy.js';
import { MAX_EQUIPMENT_TIER } from './equipment.js';

const rate = z.number().nonnegative();
const range = z
  .tuple([z.number(), z.number()])
  .refine(([lo, hi]) => lo < hi, { message: 'a range runs from low to high' });

export const coralFormSchema = z.enum(['sps', 'lps', 'other']);
export type CoralForm = z.infer<typeof coralFormSchema>;

/** The species a decor asset id belongs to: the procedural euphyllia ids share one entry per kind. */
export function coralSpeciesId(assetId: string): string {
  const kind = PROCEDURAL_EUPHYLLIA_ID.exec(assetId)?.[1];
  return kind ? `euphyllia-${kind}` : assetId;
}

// content/corals.json, one entry per reef coral decor asset (the euphyllia ids by kind).
export const coralSpeciesSchema = z
  .strictObject({
    id: z.string().min(1).max(64).describe('the decor asset id, or euphyllia-hammer / -torch'),
    form: coralFormSchema,
    growthPerDay: rate.describe('logistic growth rate per day at full light, flow and health'),
    minSize: z
      .number()
      .positive()
      .describe(
        'the floor for fragging: a cut never leaves a colony below it, and no fragment starts below it',
      ),
    maxSize: z.number().positive().describe('the cap growth approaches'),
    fragMinSize: z
      .number()
      .positive()
      .describe('size a colony must reach before a fragment can be cut'),
    lightDemand: z
      .number()
      .positive()
      .describe('light tier x intensity at which the coral grows at full rate'),
    lightMax: z
      .number()
      .positive()
      .describe('light tier x intensity above which the coral starts to bleach'),
    lightMaxSpan: z
      .number()
      .positive()
      .describe('light above lightMax at which the stress is complete'),
    flowDemand: z
      .number()
      .positive()
      .max(1)
      .describe('flow (0..1, from the wave maker tier) at which the coral grows at full rate'),
    temperatureC: range.describe('water temperature the coral is comfortable in'),
    temperatureSpanC: z.number().positive().describe('degrees outside the range at full stress'),
    salinity: range,
    salinitySpan: z.number().positive(),
    kh: range.describe('carbonate hardness in dKH'),
    khSpan: z.number().positive(),
    ph: range,
    phSpan: z.number().positive(),
  })
  .refine((c) => c.minSize < 1 && c.maxSize > 1, {
    message: 'a coral starts at size 1, so minSize must be below 1 and maxSize above it',
    path: ['maxSize'],
  })
  .refine((c) => c.fragMinSize <= c.maxSize, {
    message: 'fragMinSize must be reachable, so at most maxSize',
    path: ['fragMinSize'],
  })
  .refine((c) => c.lightMax >= c.lightDemand, {
    message: 'a coral must not bleach in the light it needs to grow',
    path: ['lightMax'],
  });
export type CoralSpecies = z.infer<typeof coralSpeciesSchema>;

export const coralParametersSchema = z.strictObject({
  flowPerWaveMakerTier: z
    .array(z.number().min(0).max(1))
    .length(MAX_EQUIPMENT_TIER + 1)
    .describe(
      'water movement 0..1 at each wave maker tier; a reef without one still has the filter',
    ),
  bleachPerHour: rate.describe('share of the gap to full stress a coral bleaches per hour'),
  recoverPerHour: rate.describe('share of the bleaching a coral loses per hour in good water'),
  fragStartSize: z
    .number()
    .positive()
    .describe('size of a new fragment, and what the colony loses'),
  fragMaxBleach: z
    .number()
    .min(0)
    .max(1)
    .describe('a colony bleached beyond this cannot be fragged'),
  fragRadiusM: z.number().positive().describe('how far from the colony a fragment may be placed'),
  fragSpacingM: z.number().nonnegative().describe('fragments try to sit this far from any coral'),
  edgeMarginM: z.number().nonnegative().describe('fragments sit this far inside the substrate'),
  maxFragsPerTank: z.int().positive(),
  sources: z.record(z.string(), z.array(z.string().min(1)).min(1)),
});
export type CoralParameters = z.infer<typeof coralParametersSchema>;

export const coralContentSchema = z
  .strictObject({
    params: coralParametersSchema,
    corals: z.array(coralSpeciesSchema).min(1),
  })
  .refine((c) => new Set(c.corals.map((s) => s.id)).size === c.corals.length, {
    message: 'duplicate coral id',
    path: ['corals'],
  })
  .refine((c) => c.corals.every((s) => s.fragMinSize - c.params.fragStartSize >= s.minSize), {
    message: 'a colony at fragMinSize must stay at or above minSize after losing fragStartSize',
    path: ['corals'],
  })
  .refine((c) => c.corals.every((s) => c.params.fragStartSize >= s.minSize), {
    message: 'fragStartSize must be at least every coral minSize',
    path: ['params', 'fragStartSize'],
  });
export type CoralContent = z.infer<typeof coralContentSchema>;

export const coralKeySchema = z.string().min(1).max(40);

// The persisted state of one coral colony, tanks.corals.
export const storedCoralSchema = z.strictObject({
  key: coralKeySchema,
  assetId: z.string().min(1).max(64),
  parentKey: coralKeySchema.nullable(),
  position: z.tuple([z.number(), z.number()]).nullable(),
  size: z.number().positive(),
  bleach: z.number().min(0).max(1),
  spawned: z.int().nonnegative(),
});
export type StoredCoral = z.infer<typeof storedCoralSchema>;
export const storedCoralsSchema = z.array(storedCoralSchema).max(400);

export const coralSchema = z.object({
  key: coralKeySchema.describe(
    'stable id. A coral in the decor layout has key `s<tintSeed>` (`-2`, `-3` for the second, third ... piece with the same seed); a fragment has its parent key + `.<n>`',
  ),
  assetId: z.string(),
  tintSeed: z
    .number()
    .int()
    .nullable()
    .describe('the layout piece this coral is, matched on DecorItem.tintSeed; null for a fragment'),
  parentKey: coralKeySchema.nullable(),
  position: z
    .tuple([z.number(), z.number()])
    .nullable()
    .describe(
      'fragment only: x and z in tank space, metres. y is the substrate surface at that spot. null for a layout coral, which sits where the layout puts it',
    ),
  size: z.number().positive().describe('multiplier on the layout scale; 1 is as bought'),
  minSize: z.number().positive(),
  maxSize: z.number().positive(),
  fragMinSize: z.number().positive().describe('the colony can be fragged from this size'),
  bleach: z
    .number()
    .min(0)
    .max(1)
    .describe(
      '0 healthy colour, 1 fully bleached white; it recovers slowly once the water is right',
    ),
});
export type Coral = z.infer<typeof coralSchema>;

// POST /api/tanks/:tankId/corals/frag cuts a fragment off one coral and answers with the tank. The
// colony loses the fragment's size; the fragment is a new coral in `corals` (parentKey = coralKey,
// size = the server's fragStartSize, bleach 0) that grows on its own. The tank is caught up first,
// so the colony is judged at its size and bleaching now, not what the client last saw.
// Refusals: 404 unknown tank (or another user's) or coral; 409 reason coral_not_grown when the
// colony is below its fragMinSize; 409 reason coral_bleached when it is too bleached to cut;
// 409 reason coral_limit when the tank holds the most fragments it may; 409 reason coral_no_room
// when no spot within reach of the colony is clear of rock and wood; 409 reason key_reused when
// the idempotency key was used for another coral. A retry with the same key replays: it returns the
// current tank and cuts nothing again. The server remembers the last 16 keys per tank.
export const fragCoralRequestSchema = z.strictObject({
  coralKey: coralKeySchema,
  idempotencyKey: idempotencyKeySchema,
});
export type FragCoralRequest = z.infer<typeof fragCoralRequestSchema>;

export const CORAL_FRAG_KEYS_REMEMBERED = 16;
export const fragKeysSchema = z
  .array(z.strictObject({ key: z.string(), coralKey: coralKeySchema }))
  .max(CORAL_FRAG_KEYS_REMEMBERED);
