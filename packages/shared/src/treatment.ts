import { z } from 'zod';
import { idSchema } from './common.js';
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
// Refusals carry a machine-readable error.reason: nothing_to_treat, other_medicine, dose_limit, key_reused.
// other_medicine and dose_limit are the two that a water change clears.
// Moving a fish to the quarantine tank is POST /api/tanks/:tankId/fish/:fishId/move (below); treat works in any tank.
export const treatRequestSchema = z.strictObject({
  kind: diseaseKindSchema,
  potency: medicinePotencySchema.default('standard'),
  idempotencyKey: idempotencyKeySchema,
});
export type TreatRequest = z.input<typeof treatRequestSchema>;

export const treatResponseSchema = z.strictObject({
  tank: tankSchema,
  overdose: z.boolean().describe('true when this dose took the water above one dose'),
  wallet: walletSchema.nullable().describe('null for the free standard medicine'),
  entry: ledgerEntrySchema.nullable(),
});
export type TreatResponse = z.infer<typeof treatResponseSchema>;

// POST /api/tanks/:tankId/fish/:fishId/move moves a living fish to another tank of the same owner.
// Both tanks are caught up to now first. The fish keeps its id, name, age, personality, health and
// disease; the destination's medicine decides whether the disease counts as treated (it is the
// tank's, not the fish's). A fish counts as newly introduced in the tank it moves to (the new-fish
// disease window restarts) unless it goes back to the tank it was last moved out of, which restores
// the introduction time it had there.
// Refusals: 404 unknown fish or a tank that is not the caller's; 400 same tank; 409 with
// error.reason fish_dead, wrong_biome (the species' biome is not the destination's), tank_full
// (the destination's animal cap or bioload capacity), key_reused (the key, in either tank, moved
// another fish or went elsewhere). wrong_biome is a 409 here, unlike adding a fish (400): the fish
// is valid and the refusal depends on the destination tank's state, like tank_full. A retry with the same idempotencyKey replays the first answer with the current
// state of both tanks. Without a key a retry finds the fish already gone from the source (404).
// The move is recorded as a fish_moved event in each tank.
export const moveFishRequestSchema = z.strictObject({
  toTankId: idSchema,
  idempotencyKey: idempotencyKeySchema.optional(),
});
export type MoveFishRequest = z.infer<typeof moveFishRequestSchema>;

export const moveFishResponseSchema = z.strictObject({
  source: tankSchema,
  destination: tankSchema,
});
export type MoveFishResponse = z.infer<typeof moveFishResponseSchema>;
