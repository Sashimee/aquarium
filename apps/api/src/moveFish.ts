import {
  idSchema,
  moveFishRequestSchema,
  moveFishResponseSchema,
  tankLengthRefusal,
  TANK_SIZES,
  type ConflictReason,
  type Economy,
  type Tank,
} from '@aquarium/shared';
import { adultLengthRefusal } from './fishFit.ts';
import { BIOLOAD_CAPACITY_BY_SIZE, hasCapacityFor, syncTreatment } from '@aquarium/sim/lifecycle';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Clock } from './clock.ts';
import { schema } from './db/index.ts';
import { wireDisease } from './disease.ts';
import { apiError, HttpError } from './errors.ts';
import type { SpeciesCatalog } from './species.ts';
import type { CareLimits, SessionUser, Ticked, Tx } from './tanks.ts';

const paramsSchema = z.strictObject({ tankId: idSchema, fishId: idSchema });
const movedPayloadSchema = z.looseObject({
  fishId: idSchema,
  otherTankId: idSchema,
  direction: z.enum(['in', 'out']),
});

const refuse = (status: 400 | 409, message: string, reason?: ConflictReason) =>
  new HttpError(
    status,
    apiError(status === 400 ? 'validation_failed' : 'conflict', message, undefined, reason),
  );

export interface MoveContext {
  app: FastifyInstance;
  species: SpeciesCatalog;
  economy: Economy;
  clock: Clock;
  authorize: (req: FastifyRequest, requireVerified?: boolean) => Promise<SessionUser>;
  throttle: (userId: string, bucket: keyof CareLimits) => void;
  guarded: <T>(
    handler: (req: FastifyRequest, reply: FastifyReply) => Promise<T>,
  ) => (req: FastifyRequest, reply: FastifyReply) => Promise<T | FastifyReply>;
  withTanks: <T>(
    user: SessionUser,
    tankIds: readonly string[],
    fn: (tx: Tx, ticked: Ticked[]) => Promise<T>,
  ) => Promise<T>;
  render: (tx: Tx, ticked: Ticked, fishRows?: Ticked['fishRows']) => Promise<Tank>;
}

export function registerMoveRoutes(ctx: MoveContext): void {
  const { app, species, economy, clock, authorize, throttle, guarded, withTanks, render } = ctx;

  app.post(
    '/api/tanks/:tankId/fish/:fishId/move',
    guarded(async (req) => {
      const user = await authorize(req);
      const { tankId, fishId } = paramsSchema.parse(req.params);
      const body = moveFishRequestSchema.parse(req.body);
      if (body.toTankId === tankId) {
        throw refuse(400, 'The fish is already in that tank. Pick another tank.');
      }

      return withTanks(user, [tankId, body.toTankId], async (tx, [source, destination]) => {
        if (!source || !destination) throw new Error('withTanks returned fewer tanks than asked');
        const respond = async (from: Ticked, to: Ticked) =>
          moveFishResponseSchema.parse({
            source: await render(tx, from),
            destination: await render(tx, to),
          });

        if (body.idempotencyKey) {
          const seen = await tx
            .select({ tankId: schema.events.tankId, payload: schema.events.payload })
            .from(schema.events)
            .where(
              and(
                inArray(schema.events.tankId, [tankId, body.toTankId]),
                eq(schema.events.kind, 'fish_moved'),
                sql`${schema.events.payload}->>'key' = ${body.idempotencyKey}`,
              ),
            );
          if (seen.length > 0) {
            const sameMove = seen.some((e) => {
              const prior = movedPayloadSchema.parse(e.payload);
              return (
                prior.fishId === fishId &&
                prior.direction === 'out' &&
                e.tankId === tankId &&
                prior.otherTankId === body.toTankId
              );
            });
            if (!sameMove) {
              throw refuse(
                409,
                'That idempotency key was used for a different move.',
                'key_reused',
              );
            }
            return respond(source, destination);
          }
        }

        throttle(user.id, 'care');
        const row = source.fishRows.find((f) => f.id === fishId);
        if (!row) throw new HttpError(404, apiError('not_found', 'Fish not found.'));
        if (row.status !== 'alive') {
          throw refuse(409, 'A dead fish cannot be moved. Net it instead.', 'fish_dead');
        }
        const spec = species.get(row.species);
        if (!spec) throw new Error(`fish ${row.id} has unknown species "${row.species}"`);
        if (spec.biome !== destination.tank.biome) {
          throw refuse(
            409,
            `${spec.commonName} needs a ${spec.biome} tank, and that one is ${destination.tank.biome}.`,
            'wrong_biome',
          );
        }
        const tooShort = tankLengthRefusal(economy, spec.id, destination.tank, spec.commonName);
        if (tooShort) throw refuse(409, tooShort);
        const tooLong = adultLengthRefusal(spec, destination.tank.size);
        if (tooLong) throw refuse(409, tooLong);
        const existing = destination.fishRows.map((f) => ({
          alive: f.status === 'alive',
          maxBioload: species.get(f.species)?.lifecycle.bioload ?? 0,
        }));
        const roomy = hasCapacityFor(
          existing,
          spec.lifecycle.bioload,
          BIOLOAD_CAPACITY_BY_SIZE[destination.tank.size],
          TANK_SIZES[destination.tank.size].maxAnimals,
        );
        if (!roomy) {
          throw refuse(
            409,
            'That tank is at capacity. Make room or pick another tank.',
            'tank_full',
          );
        }

        const simFish = source.state.fish.find((f) => f.id === fishId);
        if (!simFish) throw new Error('lifecycle state lost a fish the database still has');
        const [synced] = syncTreatment([simFish], destination.state.medicine);
        const nowMs = clock.now();
        const returning = row.previousTankId === destination.tank.id;
        const changed = {
          tankId: destination.tank.id,
          disease: wireDisease(synced?.disease ?? null),
          introducedAt: returning ? row.previousIntroducedAt : new Date(nowMs),
          previousTankId: source.tank.id,
          previousIntroducedAt: row.introducedAt,
        };
        await tx.update(schema.fish).set(changed).where(eq(schema.fish.id, fishId));
        const at = new Date(nowMs);
        await tx.insert(schema.events).values([
          {
            tankId: source.tank.id,
            at,
            kind: 'fish_moved',
            payload: {
              fishId,
              direction: 'out',
              otherTankId: destination.tank.id,
              ...(body.idempotencyKey ? { key: body.idempotencyKey } : {}),
            },
          },
          {
            tankId: destination.tank.id,
            at,
            kind: 'fish_moved',
            payload: {
              fishId,
              direction: 'in',
              otherTankId: source.tank.id,
              ...(body.idempotencyKey ? { key: body.idempotencyKey } : {}),
            },
          },
        ]);

        return respond(
          { ...source, fishRows: source.fishRows.filter((f) => f.id !== fishId) },
          { ...destination, fishRows: [...destination.fishRows, { ...row, ...changed }] },
        );
      });
    }),
  );
}
