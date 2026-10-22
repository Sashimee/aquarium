import { z } from 'zod';
import type { Biome } from './common.js';
import { unitSchema } from './common.js';

export const MAX_EQUIPMENT_TIER = 3;
const tierSchema = z.int().min(0).max(MAX_EQUIPMENT_TIER).describe('0 = not installed');

const hourSchema = z.int().min(0).max(23).describe('UTC hour of day');

const lightScheduleShape = {
  intensity: unitSchema,
  onHour: hourSchema,
  offHour: hourSchema,
};
const hoursDiffer = (l: { onHour: number; offHour: number }): boolean => l.onHour !== l.offHour;
const hoursDifferIssue = { message: 'onHour and offHour must differ', path: ['offHour'] };

export const lightScheduleSchema = z
  .strictObject(lightScheduleShape)
  .refine(hoursDiffer, hoursDifferIssue);
export type LightSchedule = z.infer<typeof lightScheduleSchema>;

export const equipmentSchema = z.strictObject({
  filter: z.strictObject({ tier: tierSchema }),
  heater: z.strictObject({ tier: tierSchema }),
  light: z
    .strictObject({ tier: tierSchema, ...lightScheduleShape })
    .refine(hoursDiffer, hoursDifferIssue),
  co2: z.strictObject({ tier: tierSchema }).describe('fresh water only'),
  waveMaker: z.strictObject({ tier: tierSchema }).describe('salt and brackish water only'),
});
export type Equipment = z.infer<typeof equipmentSchema>;

// The implicit filter and light every tank had, plus a thermostat heater: without one a tank cools to
// room temperature, which the chemistry model would punish before the shop sells heaters.
export const DEFAULT_EQUIPMENT: Equipment = {
  filter: { tier: 1 },
  heater: { tier: 1 },
  light: { tier: 1, intensity: 0.8, onHour: 8, offHour: 20 },
  co2: { tier: 0 },
  waveMaker: { tier: 0 },
};

// Per biome, which of the two water-specific devices fit. Cichlid is fresh water, so CO2 is
// fine and a wave maker is not. Blackwater is near-unbuffered (KH ~1): injected CO2 would crash
// pH below what its species tolerate, and blackwater biotopes do not use it. Mangrove is
// brackish: planted-tank CO2 does not belong in it, while a wave maker (tidal flow) does.
const DEVICES_BY_BIOME: Readonly<Record<Biome, { co2: boolean; waveMaker: boolean }>> = {
  freshwater: { co2: true, waveMaker: false },
  cichlid: { co2: true, waveMaker: false },
  blackwater: { co2: false, waveMaker: false },
  reef: { co2: false, waveMaker: true },
  mangrove: { co2: false, waveMaker: true },
};

export function usableEquipment(biome: Biome, equipment: Equipment): Equipment {
  const allowed = DEVICES_BY_BIOME[biome];
  return {
    ...equipment,
    co2: allowed.co2 ? equipment.co2 : { tier: 0 },
    waveMaker: allowed.waveMaker ? equipment.waveMaker : { tier: 0 },
  };
}

export function equipmentProblems(biome: Biome, equipment: Equipment): string[] {
  const allowed = DEVICES_BY_BIOME[biome];
  const problems: string[] = [];
  if (!allowed.co2 && equipment.co2.tier > 0) problems.push(`co2 is not used in ${biome} tanks`);
  if (!allowed.waveMaker && equipment.waveMaker.tier > 0) {
    problems.push(`a wave maker is not used in ${biome} tanks`);
  }
  return problems;
}
