import { z } from 'zod';
import { idempotencyKeySchema, ledgerEntrySchema, walletSchema } from './economy.js';
import { diseaseKindSchema, medicinePotencySchema } from './fishState.js';
import { tankSchema } from './tank.js';

// POST /api/tanks/:tankId/treat doses a tank for one disease.
//   standard: free, a long course (basic care is never charged).
//   premium: costs economy.items.consumables.premiumMedicine.prices[kind] Pearls and runs a course
//     half as long; takes an idempotency key, or the server makes one.
// A dose needs at least one living fish with that disease in the tank (409 otherwise), and a tank
// holds one medicine at a time (409 for another kind). Dosing again while the course runs adds a
// dose: more than one is an overdose, which the response flags. A water change dilutes the course.
// Moving a fish to the quarantine tank is T39's route; treat works in any tank.
export const treatRequestSchema = z.strictObject({
  kind: diseaseKindSchema,
  potency: medicinePotencySchema.default('standard'),
  idempotencyKey: idempotencyKeySchema.optional(),
});
export type TreatRequest = z.input<typeof treatRequestSchema>;

export const treatResponseSchema = z.strictObject({
  tank: tankSchema,
  overdose: z.boolean().describe('true when this dose took the water above one dose'),
  wallet: walletSchema.nullable().describe('null for the free standard medicine'),
  entry: ledgerEntrySchema.nullable(),
});
export type TreatResponse = z.infer<typeof treatResponseSchema>;
