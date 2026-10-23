import {
  idSchema,
  PLANT_TRIM_KEYS_REMEMBERED,
  trimKeysSchema,
  trimPlantRequestSchema,
  type ConflictReason,
  type Tank,
} from '@aquarium/shared';
import { trimPlant, type PlantTable } from '@aquarium/sim/lifecycle';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { schema } from './db/index.ts';
import { apiError, HttpError } from './errors.ts';
import { wirePlants } from './plants.ts';
import type { Presets } from './presets.ts';
import type { CareLimits, SessionUser, Ticked, Tx } from './tanks.ts';

const paramsSchema = z.strictObject({ tankId: idSchema });

const conflict = (message: string, reason: ConflictReason) =>
  new HttpError(409, apiError('conflict', message, undefined, reason));

export interface TrimContext {
  app: FastifyInstance;
  table: PlantTable;
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

export function registerPlantRoutes(ctx: TrimContext): void {
  const { app, table, presets, authorize, throttle, guarded, withTank, render } = ctx;

  app.post(
    '/api/tanks/:tankId/plants/trim',
    guarded(async (req) => {
      const user = await authorize(req);
      const { tankId } = paramsSchema.parse(req.params);
      const body = trimPlantRequestSchema.parse(req.body);

      return withTank(user, tankId, async (tx, ticked) => {
        const remembered = trimKeysSchema.parse(ticked.tank.plantTrimKeys);
        const seen = remembered.find((k) => k.key === body.idempotencyKey);
        if (seen) {
          if (seen.plantKey !== body.plantKey || seen.size !== body.size) {
            throw conflict('That idempotency key was used for a different trim.', 'key_reused');
          }
          return render(tx, ticked);
        }
        throttle(user.id, 'care');

        const trimmed = trimPlant(ticked.plants, body.plantKey, body.size, table);
        if (!trimmed.ok) {
          switch (trimmed.reason) {
            case 'unknown':
              throw new HttpError(404, apiError('not_found', 'Plant not found.'));
            case 'below_minimum':
              throw new HttpError(
                400,
                apiError(
                  'validation_failed',
                  'That is below the smallest size this plant can be trimmed to.',
                  [{ path: ['size'], message: 'below the plant minimum size' }],
                ),
              );
            case 'not_grown':
              throw conflict(
                'The plant is not that big. Wait for it to grow before trimming.',
                'plant_not_grown',
              );
          }
        }

        const plantTrimKeys = [
          ...remembered,
          { key: body.idempotencyKey, plantKey: body.plantKey, size: body.size },
        ].slice(-PLANT_TRIM_KEYS_REMEMBERED);
        await tx
          .update(schema.tanks)
          .set({ plants: trimmed.plants, plantTrimKeys })
          .where(eq(schema.tanks.id, tankId));
        const tank = { ...ticked.tank, plants: trimmed.plants, plantTrimKeys };
        return render(tx, {
          ...ticked,
          tank,
          plants: trimmed.plants,
          plantView: wirePlants(tank, presets, table, trimmed.plants),
        });
      });
    }),
  );
}
