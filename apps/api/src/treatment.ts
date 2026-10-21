import {
  DISEASE_NAMES,
  idSchema,
  treatRequestSchema,
  treatResponseSchema,
  type ConflictReason,
  type Tank,
} from '@aquarium/shared';
import { addDose, syncTreatment, type LifecycleState } from '@aquarium/sim/lifecycle';
import type { ShopContext } from './shop.ts';
import { eq } from 'drizzle-orm';
import { schema } from './db/index.ts';
import { MAX_TREAT_KEYS, storedTreatKeys, type TreatKeys } from './disease.ts';
import { apiError, HttpError } from './errors.ts';
import { legacyKey } from './legacyRequests.ts';
import type { Ticked, Tx } from './tanks.ts';
import { findReplay, lockWallet, spend, type Charged } from './wallet.ts';
import { z } from 'zod';

const conflict = (message: string, reason: ConflictReason) =>
  new HttpError(409, apiError('conflict', message, undefined, reason));

export interface TreatmentContext extends ShopContext {
  persist: (tx: Tx, ticked: Ticked, state: LifecycleState) => Promise<Tank>;
}

export function registerTreatmentRoutes(ctx: TreatmentContext): void {
  const { app, economy, clock, authorize, throttle, guarded, withTank, render, persist } = ctx;

  app.post(
    '/api/tanks/:tankId/treat',
    guarded(async (req) => {
      const user = await authorize(req);
      const { tankId } = z.strictObject({ tankId: idSchema }).parse(req.params);
      const body = treatRequestSchema.parse(req.body);
      throttle(user.id, 'care');
      const premium = body.potency === 'premium';
      const itemRef = `consumable:premium-medicine:${body.kind}:${tankId}`;
      const key = legacyKey(body.idempotencyKey);

      return withTank(user, tankId, async (tx, ticked) => {
        const nowMs = clock.now();
        const respond = (tank: Tank, overdose: boolean, charged: Charged | null) =>
          treatResponseSchema.parse({
            tank,
            overdose,
            wallet: charged ? { balance: charged.balance } : null,
            entry: charged?.entry ?? null,
          });

        const keys = storedTreatKeys(ticked.tank.treatKeys);
        const seen = body.idempotencyKey
          ? keys.find((k) => k.key === body.idempotencyKey)
          : undefined;
        if (seen && (seen.kind !== body.kind || seen.potency !== body.potency)) {
          throw conflict('That idempotency key was used for a different treatment.', 'key_reused');
        }

        if (premium) {
          await lockWallet(tx, economy, user.id, nowMs);
          const replay = await findReplay(tx, user.id, key, itemRef);
          if (replay) return respond(await render(tx, ticked), seen?.overdose ?? false, replay);
        } else if (seen) {
          return respond(await render(tx, ticked), seen.overdose, null);
        }

        const { state } = ticked;
        if (!state.fish.some((f) => f.alive && f.disease?.kind === body.kind)) {
          throw conflict(
            `No fish in this tank has ${DISEASE_NAMES[body.kind]}, so there is nothing to treat.`,
            'nothing_to_treat',
          );
        }
        const dosed = addDose(state.medicine, body.kind, body.potency, nowMs);
        if (dosed === 'other-medicine') {
          throw conflict(
            'A different medicine is still in the water at full strength. Change the water until only a trace is left, then switch.',
            'other_medicine',
          );
        }
        if (dosed === 'at-limit') {
          throw conflict(
            'The water already holds the most medicine it safely can. Change the water.',
            'dose_limit',
          );
        }

        let charged: Charged | null = null;
        if (premium) {
          const price = economy.items.consumables.premiumMedicine.prices[body.kind];
          if (price === undefined) {
            throw new Error(`content/economy.json has no premiumMedicine price for ${body.kind}`);
          }
          charged = await spend(tx, user.id, { amount: price, itemRef, key, nowMs });
        }
        if (body.idempotencyKey) {
          const recent: TreatKeys = [
            ...keys,
            { key, kind: body.kind, potency: body.potency, overdose: dosed.overdose },
          ].slice(-MAX_TREAT_KEYS);
          await tx
            .update(schema.tanks)
            .set({ treatKeys: recent })
            .where(eq(schema.tanks.id, tankId));
        }
        const next: LifecycleState = {
          ...state,
          medicine: dosed.medicine,
          fish: syncTreatment(state.fish, dosed.medicine),
        };
        return respond(await persist(tx, ticked, next), dosed.overdose, charged);
      });
    }),
  );
}
