import {
  CORAL_FRAG_KEYS_REMEMBERED,
  fragCoralRequestSchema,
  fragKeysSchema,
  idSchema,
  type ConflictReason,
  type Tank,
} from '@aquarium/shared';
import { fragCoral, type CoralTable, type PlantTable } from '@aquarium/sim/lifecycle';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { wireCorals } from './corals.ts';
import { schema } from './db/index.ts';
import { apiError, HttpError } from './errors.ts';
import { plantObstacles, substrateBounds } from './plants.ts';
import type { Presets } from './presets.ts';
import type { CareLimits, SessionUser, Ticked, Tx } from './tanks.ts';

const paramsSchema = z.strictObject({ tankId: idSchema });

const conflict = (message: string, reason: ConflictReason) =>
  new HttpError(409, apiError('conflict', message, undefined, reason));

export interface FragContext {
  app: FastifyInstance;
  table: CoralTable;
  plants: PlantTable;
  presets: Presets;
  authorize: (req: FastifyRequest, requireVerified?: boolean) => Promise<SessionUser>;
  throttle: (userId: string, bucket: keyof CareLimits) => void;
  guarded: <T>(
    handler: (req: FastifyRequest, reply: FastifyReply) => Promise<T>,
  ) => (req: FastifyRequest, reply: FastifyReply) => Promise<T | FastifyReply>;
  withTank: <T>(
    user: SessionUser,
    tankId: string,
    fn: (tx: Tx, ticked: Ticked) => Promise<T>,
  ) => Promise<T>;
  render: (tx: Tx, ticked: Ticked) => Promise<Tank>;
}

export function registerCoralRoutes(ctx: FragContext): void {
  const { app, table, plants, presets, authorize, throttle, guarded, withTank, render } = ctx;

  app.post(
    '/api/tanks/:tankId/corals/frag',
    guarded(async (req) => {
      const user = await authorize(req);
      const { tankId } = paramsSchema.parse(req.params);
      const body = fragCoralRequestSchema.parse(req.body);

      return withTank(user, tankId, async (tx, ticked) => {
        const remembered = fragKeysSchema.parse(ticked.tank.coralFragKeys);
        const seen = remembered.find((k) => k.key === body.idempotencyKey);
        if (seen) {
          if (seen.coralKey !== body.coralKey) {
            throw conflict('That idempotency key was used for a different coral.', 'key_reused');
          }
          return render(tx, ticked);
        }
        throttle(user.id, 'care');

        const cut = fragCoral(
          ticked.corals,
          body.coralKey,
          table,
          substrateBounds(ticked.tank.size),
          plantObstacles(ticked.tank, presets, plants),
        );
        if (!cut.ok) {
          switch (cut.reason) {
            case 'unknown':
              throw new HttpError(404, apiError('not_found', 'Coral not found.'));
            case 'not_grown':
              throw conflict(
                'The coral is too small to cut a fragment from. Wait for it to grow.',
                'coral_not_grown',
              );
            case 'bleached':
              throw conflict(
                'The coral is too bleached to fragment. Fix the water and let it recover first.',
                'coral_bleached',
              );
            case 'no_room':
              throw conflict(
                'There is no clear spot beside the colony for a fragment. Move the rock or wood and try again.',
                'coral_no_room',
              );
            case 'limit':
              throw conflict('The tank already holds as many fragments as it can.', 'coral_limit');
          }
        }

        const coralFragKeys = [
          ...remembered,
          { key: body.idempotencyKey, coralKey: body.coralKey },
        ].slice(-CORAL_FRAG_KEYS_REMEMBERED);
        await tx
          .update(schema.tanks)
          .set({ corals: cut.corals, coralFragKeys })
          .where(eq(schema.tanks.id, tankId));
        const tank = { ...ticked.tank, corals: cut.corals, coralFragKeys };
        return render(tx, {
          ...ticked,
          tank,
          corals: cut.corals,
          coralView: wireCorals(tank, presets, table, cut.corals),
        });
      });
    }),
  );
}
