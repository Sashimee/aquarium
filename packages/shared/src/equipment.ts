import { z } from 'zod';
import type { Biome } from './common.js';
import { unitSchema } from './common.js';

export const MAX_EQUIPMENT_TIER = 3;
const tierSchema = z.int().min(0).max(MAX_EQUIPMENT_TIER).describe('0 = not installed');

const hourSchema = z.int().min(0).max(23);

export const equipmentSchema = z.strictObject({
  filter: z.strictObject({ tier: tierSchema }),
  heater: z.strictObject({ tier: tierSchema }),
  light: z
    .strictObject({
      tier: tierSchema,
      intensity: unitSchema,
      onHour: hourSchema,
      offHour: hourSchema,
    })
    .refine((l) => l.onHour !== l.offHour, {
      message: 'onHour and offHour must differ',
      path: ['offHour'],
    }),
  co2: z.strictObject({ tier: tierSchema }).describe('fresh water only'),
  waveMaker: z.strictObject({ tier: tierSchema }).describe('salt and brackish water only'),
});
export type Equipment = z.infer<typeof equipmentSchema>;

// What every tank had before equipment existed: the implicit filter and light, nothing else.
export const DEFAULT_EQUIPMENT: Equipment = {
  filter: { tier: 1 },
  heater: { tier: 0 },
  light: { tier: 1, intensity: 0.8, onHour: 8, offHour: 20 },
  co2: { tier: 0 },
  waveMaker: { tier: 0 },
};

// Per biome, which of the two water-specific devices fit. Cichlid and blackwater are fresh water,
// so CO2 is fine and a wave maker is not. Mangrove is brackish: planted-tank CO2 does not belong
// in it, while a wave maker (tidal flow) does.
const DEVICES_BY_BIOME: Readonly<Record<Biome, { co2: boolean; waveMaker: boolean }>> = {
  freshwater: { co2: true, waveMaker: false },
  cichlid: { co2: true, waveMaker: false },
  blackwater: { co2: true, waveMaker: false },
  reef: { co2: false, waveMaker: true },
  mangrove: { co2: false, waveMaker: true },
};

export function equipmentProblems(biome: Biome, equipment: Equipment): string[] {
  const allowed = DEVICES_BY_BIOME[biome];
  const problems: string[] = [];
  if (!allowed.co2 && equipment.co2.tier > 0) problems.push(`co2 is not used in ${biome} tanks`);
  if (!allowed.waveMaker && equipment.waveMaker.tier > 0) {
    problems.push(`a wave maker is not used in ${biome} tanks`);
  }
  return problems;
}
