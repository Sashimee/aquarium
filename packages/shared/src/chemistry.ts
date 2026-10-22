import { z } from 'zod';
import { MAX_EQUIPMENT_TIER } from './equipment.js';
import { biomeSchema, unitSchema, type Biome } from './common.js';

export const bacteriaSchema = z.strictObject({
  ammoniaOxidisers: unitSchema.describe('colony size 0..1: ammonia to nitrite'),
  nitriteOxidisers: unitSchema.describe('colony size 0..1: nitrite to nitrate'),
});
export type Bacteria = z.infer<typeof bacteriaSchema>;

export const chemistrySchema = z.object({
  nitrite: z.number().nonnegative(),
  ph: z.number().min(0).max(14),
  kh: z.number().min(0).max(40).describe('carbonate hardness in dKH'),
  temperatureC: z.number().min(0).max(45),
  salinity: z.number().min(0).max(45).describe('parts per thousand; 0 is fresh, 35 is sea'),
  bacteria: bacteriaSchema,
});
export type Chemistry = z.infer<typeof chemistrySchema>;

const SEEDED_FILTER: Bacteria = { ammoniaOxidisers: 1, nitriteOxidisers: 1 };

// A new tank comes with a seeded filter, so it starts cycled (PLAN 9.1).
export const NEW_TANK_CHEMISTRY_BY_BIOME: Readonly<Record<Biome, Chemistry>> = {
  freshwater: { nitrite: 0, ph: 7, kh: 4, temperatureC: 25, salinity: 0, bacteria: SEEDED_FILTER },
  reef: { nitrite: 0, ph: 8.2, kh: 8, temperatureC: 25.5, salinity: 35, bacteria: SEEDED_FILTER },
  cichlid: { nitrite: 0, ph: 8.2, kh: 10, temperatureC: 25, salinity: 0, bacteria: SEEDED_FILTER },
  blackwater: {
    nitrite: 0,
    ph: 5.5,
    kh: 1,
    temperatureC: 27,
    salinity: 0,
    bacteria: SEEDED_FILTER,
  },
  mangrove: { nitrite: 0, ph: 8, kh: 8, temperatureC: 26, salinity: 15, bacteria: SEEDED_FILTER },
};

export const newTankChemistry = (biome: Biome): Chemistry => ({
  ...NEW_TANK_CHEMISTRY_BY_BIOME[biome],
  bacteria: { ...SEEDED_FILTER },
});

const rate = z.number().nonnegative();
const perTier = z.array(rate).length(MAX_EQUIPMENT_TIER + 1);
const perBiome = <T extends z.ZodType>(value: T) => z.record(biomeSchema, value);

const colonySchema = z.strictObject({
  growthPerHour: rate.describe('colony growth per hour while its food is present'),
  dieOffPerHour: rate.describe('colony loss per hour without food'),
  conversionPerHour: rate.describe('substrate converted per hour at a full colony'),
});

// content/chemistry.json. Every rate of the v2 water model lives here, nothing is hard-coded in sim.
export const chemistryParametersSchema = z.strictObject({
  bacteria: z.strictObject({
    ammoniaOxidisers: colonySchema,
    nitriteOxidisers: colonySchema,
    bottledBoost: unitSchema.describe('colony added by one dose of bottled bacteria'),
    overCapacityDieOffPerHour: rate.describe(
      'colony loss per hour above what the filter media can host',
    ),
    rinseSurvival: unitSchema.describe(
      'share of each colony left after rinsing media in tap water',
    ),
    ambientSeed: rate.describe('colony-equivalent that lets a colony start from nothing'),
    minSubstrate: rate.describe(
      'ammonia or nitrite present plus the supply of one step, below which a colony starves',
    ),
    mediaCapacityPerFilterTier: unitSchema.describe('share of full colony one filter tier hosts'),
  }),
  nitrite: z.strictObject({
    toxicityPerUnit: rate.describe('health loss multiplier per unit nitrite above tolerance'),
  }),
  nitrate: z.strictObject({
    yieldPerNitrite: rate.describe('nitrate units made by one unit of nitrite oxidised'),
  }),
  ph: z.strictObject({
    target: perBiome(z.number().min(0).max(14)),
    driftPerHour: rate.describe('fraction of the gap to the buffered target closed per hour'),
    acidificationPerNitrate: rate.describe('pH drop per nitrate unit at 1 dKH, divided by KH'),
    minBufferKh: rate.describe('KH below which the buffer stops getting weaker'),
  }),
  salinity: z.strictObject({
    target: perBiome(z.number().min(0).max(45)),
    driftPerHour: rate.describe('fraction of the gap to the target closed per hour'),
  }),
  kh: z.strictObject({
    consumedPerNitrate: rate,
    restoredPerWaterChange: unitSchema.describe('fraction of the gap to the source water closed'),
    sourceWater: perBiome(z.number().min(0).max(40)).describe(
      'dKH of the water a change adds: tap for fresh biomes, salt mix for marine and brackish',
    ),
  }),
  temperature: z.strictObject({
    target: perBiome(z.number().min(0).max(45)),
    roomC: z.number().min(0).max(45),
    driftPerHour: rate.describe('fraction of the gap to the room temperature closed per hour'),
    heaterWarmingPerHourPerTier: rate,
    heaterWarmupRatePerHourPerTier: rate.describe(
      'fraction of the gap to the setpoint a heater closes per hour per tier while warming up',
    ),
  }),
  stress: z.strictObject({
    healthLossFraction: unitSchema.describe(
      'health loss per hour at full stress, as a share of the species starvation rate',
    ),
    fullStressDeviation: z.strictObject({
      ph: rate.describe('pH units outside the species range that count as full stress'),
      temperatureC: rate,
      salinity: rate.describe('ppt outside the species range'),
      kh: rate.describe('dKH below the species minimum'),
    }),
  }),
  equipment: z.strictObject({
    light: z.strictObject({
      algaeGrowthPerTier: perTier.describe(
        'algae growth multiplier at full intensity while the lamp is on, index = tier; the lamp is dark outside its schedule',
      ),
    }),
    co2: z.strictObject({
      phDropPerTier: perTier.describe(
        'pH units the injected CO2 pulls the target down, index = tier',
      ),
      algaeFactorPerTier: perTier.describe(
        'algae growth multiplier from plants growing faster, index = tier',
      ),
    }),
    waveMaker: z.strictObject({
      algaeFactorPerTier: perTier.describe('algae growth multiplier from flow, index = tier'),
    }),
  }),
  sources: z
    .record(z.string(), z.array(z.string().min(1)).min(1))
    .describe('where each section of rates comes from'),
});
export type ChemistryParameters = z.infer<typeof chemistryParametersSchema>;
