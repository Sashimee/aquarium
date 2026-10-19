import { idSchema, treatRequestSchema, treatResponseSchema, type Tank } from '@aquarium/shared';
import { addDose, syncTreatment, type LifecycleState } from '@aquarium/sim/lifecycle';
import type { ShopContext } from './shop.ts';
import { apiError, HttpError } from './errors.ts';
import { legacyKey } from './legacyRequests.ts';
import type { Ticked, Tx } from './tanks.ts';
import { findReplay, lockWallet, spend, type Charged } from './wallet.ts';
import { z } from 'zod';

const conflict = (message: string) => new HttpError(409, apiError('conflict', message));

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
      const itemRef = `consumable:premium-medicine:${body.kind}`;
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

        if (premium) {
          await lockWallet(tx, economy, user.id, nowMs);
          const replay = await findReplay(tx, user.id, key, itemRef);
          if (replay) return respond(await render(tx, ticked), false, replay);
        }

        const { state } = ticked;
        if (!state.fish.some((f) => f.alive && f.disease?.kind === body.kind)) {
          throw conflict(`No fish in this tank has ${body.kind}, so there is nothing to treat.`);
        }
        const dosed = addDose(state.medicine, body.kind, body.potency, nowMs);
        if (dosed === 'other-medicine') {
          throw conflict('Another medicine is in the water. Change the water before you switch.');
        }
        if (dosed === 'at-limit') {
          throw conflict(
            'The water already holds the most medicine it safely can. Change the water.',
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
