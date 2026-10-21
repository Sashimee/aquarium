import { z } from 'zod';
import { idempotencyKeySchema, ledgerEntrySchema, walletSchema } from './economy.js';
import { diseaseKindSchema, medicinePotencySchema } from './fishState.js';
import { tankSchema } from './tank.js';

// POST /api/tanks/:tankId/treat doses a tank for one disease.
//   standard: free, a long course (basic care is never charged).
//   premium: costs economy.items.consumables.premiumMedicine.prices[kind] Pearls and runs a course
//     half as long; takes an idempotency key, or the server makes one.
// A dose needs at least one living fish with that disease in the tank (409 otherwise), and a tank
// holds one medicine at a time (409 for another kind while it is at full strength; once water
// changes have thinned it to a residue, a dose of another kind replaces it). Dosing again while
// the course runs adds a dose: more than one is an overdose, which the response flags. A water change dilutes the course
// and drops one dose, so dosing again after it is never an overdose.
// The idempotency key is honoured for both potencies: a retry replays the first answer, and a key
// used for another kind or potency (or, premium, another tank) is a 409. Only the last 8 keys are
// remembered: a premium retry older than that is still not charged twice, but its overdose flag
// reads false. Heat (30 C or more) only helps ich for the few species that tolerate it.
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
