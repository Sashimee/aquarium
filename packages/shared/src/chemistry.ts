import { z } from 'zod';
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
    mediaCapacityPerFilterTier: unitSchema.describe('share of full colony one filter tier hosts'),
  }),
  nitrite: z.strictObject({
    toxicityPerUnit: rate.describe('health loss multiplier per unit nitrite above tolerance'),
  }),
  ph: z.strictObject({
    target: perBiome(z.number().min(0).max(14)),
    driftPerHour: rate.describe('fraction of the gap to the buffered target closed per hour'),
    acidificationPerNitrate: rate,
  }),
  salinity: z.strictObject({
    target: perBiome(z.number().min(0).max(45)),
    driftPerHour: rate.describe('fraction of the gap to the target closed per hour'),
  }),
  kh: z.strictObject({
    consumedPerNitrate: rate,
    restoredPerWaterChange: unitSchema.describe('fraction of the gap to the source water closed'),
    sourceWater: z.number().min(0).max(40),
  }),
  temperature: z.strictObject({
    target: perBiome(z.number().min(0).max(45)),
    roomC: z.number().min(0).max(45),
    driftPerHour: rate.describe('fraction of the gap to the room temperature closed per hour'),
    heaterWarmingPerHourPerTier: rate,
  }),
});
export type ChemistryParameters = z.infer<typeof chemistryParametersSchema>;
