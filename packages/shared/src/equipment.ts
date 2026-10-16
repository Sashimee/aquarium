import { z } from 'zod';
import type { Biome } from './common.js';
import { unitSchema } from './common.js';

export const MAX_EQUIPMENT_TIER = 3;
const tierSchema = z.int().min(0).max(MAX_EQUIPMENT_TIER).describe('0 = not installed');

const hourSchema = z.int().min(0).max(23);

export const equipmentSchema = z.strictObject({
  filter: z.strictObject({ tier: tierSchema }),
  heater: z.strictObject({ tier: tierSchema }),
  light: z.strictObject({
    tier: tierSchema,
    intensity: unitSchema,
    onHour: hourSchema,
    offHour: hourSchema,
  }),
  co2: z.strictObject({ tier: tierSchema }).describe('freshwater only'),
  waveMaker: z.strictObject({ tier: tierSchema }).describe('reef only'),
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

export function equipmentProblems(biome: Biome, equipment: Equipment): string[] {
  const problems: string[] = [];
  if (biome === 'reef' && equipment.co2.tier > 0) problems.push('co2 is for freshwater tanks');
  if (biome === 'freshwater' && equipment.waveMaker.tier > 0) {
    problems.push('a wave maker is for reef tanks');
  }
  return problems;
}
