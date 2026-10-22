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
  'pleopod',
  'none',
]);
/** Swimming modes of the walking invertebrates, which `locomotion.walking` moves. */
export const WALKER_SWIMMING_MODES: readonly z.infer<typeof swimmingModeSchema>[] = [
  'pleopod',
  'none',
];
export const gaitSchema = z.enum(['burst-and-coast', 'cruise', 'hover', 'forage']);
export const zoneSchema = z.enum(['surface', 'mid', 'bottom']);

// `cleaner` on a swimmer keeps a cleaning station; on a walker it is accepted but drives nothing yet.
// `amphibious`: an air-breather that hauls out onto an emergent bank (mudskippers).
export const traitSchema = z.enum([
  'shoal',
  'air-gulp',
  'amphibious',
  'glass-grazer',
  'rock-grazer',
  'anemone-host',
  'cave-dweller',
  'flare-display',
  'biofilm-grazer',
  'cleaner',
]);
export type Trait = z.infer<typeof traitSchema>;

/** When a species is awake: by lamp light, in the dark, or at dawn and dusk. */
export const activitySchema = z.enum(['diurnal', 'nocturnal', 'crepuscular']);
export type Activity = z.infer<typeof activitySchema>;

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
    .refine(([lo, hi]) => lo <= hi, 'depthBand must be [low, high]')
    .describe(
      'fractions of the local water column measured up from the substrate: 0 = sand, 1 = surface',
    ),
  perceptionRangeM: positive,
  perceptionFovDeg: z.number().min(1).max(360),
  curiosity: unitSchema,
  boldness: unitSchema,
  traits: z.array(traitSchema).default([]),
  activity: activitySchema.optional().describe('when the species is awake; diurnal when left out'),
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

const FLIP_PEAK_OVER_MEAN = Math.PI / 2;

export const walkSurfaceSchema = z.enum(['substrate', 'decor', 'glass']);

export const walkingSchema = z.strictObject({
  walkSpeedMps: positive.describe('typical stepping speed on a surface'),
  strideBodyLengths: z
    .number()
    .min(0.05)
    .max(1)
    .describe('body lengths per full leg cycle; drives the leg phase'),
  legPairs: z
    .int()
    .min(0)
    .max(5)
    .describe('pereiopods that walk, 0 for a snail gliding on its foot; render only'),
  surfaces: z
    .array(walkSurfaceSchema)
    .min(1)
    .describe(
      'extra surfaces a walker may climb; any surface within 45 degrees of horizontal counts as ground whatever is listed',
    ),
  tailFlip: z
    .strictObject({
      speedMps: positive.describe('mean escape speed'),
      durationS: z.number().positive().max(0.5),
      refractoryS: z.number().positive().max(10),
    })
    .optional()
    .describe('the escape of a walker that swims (swimmingMode "pleopod")'),
  withdraw: z
    .strictObject({
      minS: z.number().positive().max(600),
      maxS: z.number().positive().max(600),
    })
    .refine((w) => w.minS <= w.maxS, { message: 'minS must not exceed maxS', path: ['minS'] })
    .optional()
    .describe(
      'the escape of a walker that never swims (swimmingMode "none"): it pulls into its shell where it stands and stays there for minS to maxS seconds',
    ),
});
export type Walking = z.infer<typeof walkingSchema>;

export const locomotionSchema = z
  .strictObject({
    swimmingMode: swimmingModeSchema,
    gait: gaitSchema,
    maxSpeedMps: positive,
    cruiseSpeedMps: positive,
    massKg: positive,
    maxTurnRateDegPerS: positive,
    maxPitchDeg: z.number().min(0).max(90),
    strouhal: z.number().min(0.2).max(0.4).default(0.3).describe('ignored by walkers'),
    walking: walkingSchema.optional(),
    bodyLengthM: positive.describe(
      'standard length (snout to caudal peduncle, fin excluded) in metres of the fish the speeds and mass describe; the renderer scales the model so its standard length matches',
    ),
  })
  .refine((l) => l.cruiseSpeedMps <= l.maxSpeedMps, {
    message: 'cruiseSpeedMps must not exceed maxSpeedMps',
    path: ['cruiseSpeedMps'],
  })
  .refine((l) => WALKER_SWIMMING_MODES.includes(l.swimmingMode) === (l.walking !== undefined), {
    message: 'walking is required for, and only valid with, swimmingMode "pleopod" or "none"',
    path: ['walking'],
  })
  .refine(
    (l) =>
      l.walking === undefined ||
      !WALKER_SWIMMING_MODES.includes(l.swimmingMode) ||
      (l.swimmingMode === 'pleopod') === (l.walking.tailFlip !== undefined),
    {
      message: 'walking.tailFlip is required for, and only valid with, swimmingMode "pleopod"',
      path: ['walking', 'tailFlip'],
    },
  )
  .refine(
    (l) =>
      l.walking === undefined ||
      !WALKER_SWIMMING_MODES.includes(l.swimmingMode) ||
      (l.swimmingMode === 'none') === (l.walking.withdraw !== undefined),
    {
      message: 'walking.withdraw is required for, and only valid with, swimmingMode "none"',
      path: ['walking', 'withdraw'],
    },
  )
  .refine((l) => l.walking === undefined || l.walking.walkSpeedMps <= l.cruiseSpeedMps, {
    message: 'walking.walkSpeedMps must not exceed cruiseSpeedMps',
    path: ['walking', 'walkSpeedMps'],
  })
  .refine(
    (l) =>
      l.walking?.tailFlip === undefined ||
      l.walking.tailFlip.speedMps * FLIP_PEAK_OVER_MEAN <= l.maxSpeedMps * (1 + 1e-6),
    {
      message:
        'walking.tailFlip.speedMps is the mean of a half-sine burst; its peak, pi/2 times the mean, must not exceed maxSpeedMps',
      path: ['walking', 'tailFlip', 'speedMps'],
    },
  );

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

export const breedingModeSchema = z.enum([
  'livebearer',
  'egg-scatterer',
  'substrate-spawner',
  'mouthbrooder',
  'none',
]);
export type BreedingMode = z.infer<typeof breedingModeSchema>;

const countRange = z
  .tuple([z.int().positive(), z.int().positive()])
  .refine(([lo, hi]) => lo <= hi, 'range must be [low, high]');

export const breedingSchema = z
  .strictObject({
    mode: breedingModeSchema.default('none'),
    minAgeDays: positive.optional().describe('age before a fish can breed'),
    minHealth: unitSchema.optional(),
    maxHunger: unitSchema.optional(),
    temperatureC: z
      .tuple([z.number().min(0).max(45), z.number().min(0).max(45)])
      .refine(([lo, hi]) => lo <= hi, 'temperatureC must be [low, high]')
      .optional()
      .describe('water temperature band that triggers breeding'),
    needsPair: z.boolean().default(true).describe('needs a living male and female'),
    needsCave: z.boolean().default(false),
    intervalDays: positive.optional().describe('minimum days between broods'),
    broodSize: countRange.optional().describe('fry per brood, [min, max]'),
    fryGrowth: z
      .strictObject({
        juvenileAfterDays: positive,
        adultAfterDays: positive,
      })
      .refine((g) => g.juvenileAfterDays < g.adultAfterDays, {
        message: 'juvenileAfterDays must be less than adultAfterDays',
        path: ['juvenileAfterDays'],
      })
      .optional(),
  })
  .refine(
    (b) =>
      b.mode === 'none' ||
      (b.minAgeDays !== undefined &&
        b.intervalDays !== undefined &&
        b.broodSize !== undefined &&
        b.fryGrowth !== undefined),
    {
      message: 'a breeding species needs minAgeDays, intervalDays, broodSize and fryGrowth',
      path: ['mode'],
    },
  );
export type Breeding = z.infer<typeof breedingSchema>;

export const speciesChemistrySchema = z.strictObject({
  nitriteTolerance: rate.default(0.5),
  phRange: z
    .tuple([z.number().min(0).max(14), z.number().min(0).max(14)])
    .refine(([lo, hi]) => lo <= hi, 'phRange must be [low, high]')
    .default([6, 8.5]),
  khMin: z.number().min(0).max(40).default(0),
  salinityPpt: z
    .tuple([z.number().min(0).max(45), z.number().min(0).max(45)])
    .refine(([lo, hi]) => lo <= hi, 'salinityPpt must be [low, high]')
    .default([0, 1]),
  temperatureC: z
    .tuple([z.number().min(0).max(45), z.number().min(0).max(45)])
    .refine(([lo, hi]) => lo <= hi, 'temperatureC must be [low, high]')
    .default([20, 30]),
  sources: z.array(z.string().min(1)).default([]).describe('where the ranges come from'),
});
export type SpeciesChemistry = z.infer<typeof speciesChemistrySchema>;

export const isWarmWater = (chemistry: SpeciesChemistry, roomC: number): boolean =>
  chemistry.temperatureC[0] > roomC;

export const speciesSchema = z.strictObject({
  id: slugSchema,
  commonName: z.string().min(1),
  scientificName: z.string().min(1),
  biome: biomeSchema,
  behaviour: behaviourSchema,
  locomotion: locomotionSchema,
  render: renderSchema,
  lifecycle: lifecycleSchema,
  chemistry: speciesChemistrySchema.prefault({}),
  breeding: breedingSchema.prefault({}),
});
export type Species = z.infer<typeof speciesSchema>;

// Cross-block rules live outside speciesSchema because refined objects cannot be .partial()-ed.
const SWIMMER_TRAITS: readonly Trait[] = [
  'shoal',
  'air-gulp',
  'amphibious',
  'glass-grazer',
  'rock-grazer',
  'anemone-host',
  'flare-display',
];
const WALKER_TRAITS: readonly Trait[] = ['biofilm-grazer'];

export function checkSpeciesRules(
  species: {
    behaviour: { traits: Trait[]; schooling?: unknown; territorial: boolean };
    locomotion: { walking?: unknown };
  },
  ctx: z.RefinementCtx,
): void {
  const { behaviour, locomotion } = species;
  const issue = (message: string, path: (string | number)[]): void =>
    ctx.addIssue({ code: 'custom', message, path });
  if (locomotion.walking === undefined) {
    for (const t of WALKER_TRAITS) {
      if (behaviour.traits.includes(t)) {
        issue(`trait "${t}" requires locomotion.walking`, ['behaviour', 'traits']);
      }
    }
    return;
  }
  for (const t of SWIMMER_TRAITS) {
    if (behaviour.traits.includes(t)) {
      issue(`trait "${t}" is for swimmers, not walkers`, ['behaviour', 'traits']);
    }
  }
  if (behaviour.schooling !== undefined) {
    issue('walkers do not school; drop behaviour.schooling', ['behaviour', 'schooling']);
  }
  if (behaviour.territorial) {
    issue('walkers hold no territory; set territorial to false', ['behaviour', 'territorial']);
  }
}

export const speciesContentSummarySchema = z.strictObject({
  id: slugSchema,
  commonName: z.string().min(1),
  scientificName: z.string().min(1),
  biome: biomeSchema,
  lifecycle: lifecycleSchema,
  chemistry: speciesChemistrySchema.prefault({}),
  breeding: breedingSchema.prefault({}),
});

export const speciesSummarySchema = speciesContentSummarySchema.extend({
  warmWater: z
    .boolean()
    .describe('its comfort range starts above room temperature, so it needs a heater'),
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

export const speciesContentSchema = speciesSchema
  .partial({ render: true })
  .superRefine(checkSpeciesRules);
