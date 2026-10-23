import { z } from 'zod';

export const foodTypeSchema = z.enum([
  'flakes',
  'pellets',
  'bloodworms',
  'brine-shrimp',
  'nori',
  'algae-wafer',
]);
export type FoodType = z.infer<typeof foodTypeSchema>;
