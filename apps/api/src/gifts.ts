import {
  acceptGiftRequestSchema,
  acceptGiftResponseSchema,
  cancelGiftResponseSchema,
  confirmGiftRequestSchema,
  confirmGiftResponseSchema,
  createGiftRequestSchema,
  createGiftResponseSchema,
  declineGiftResponseSchema,
  containsBlockedWord,
  diseaseStateSchema,
  type DiseaseKind,
  fishSexSchema,
  fishStageSchema,
  GIFT_MAX_OPEN_RECEIVED,
  GIFT_MAX_OPEN_SENT,
  GIFT_OFFER_TTL_HOURS,
  GIFT_SETTLED_VISIBLE_DAYS,
  giftListResponseSchema,
  giftOfferSchema,
  idSchema,
  personalitySchema,
  TANK_SIZES,
  type ChemistryParameters,
  type ConflictReason,
  type GiftArrival,
  type GiftFish,
  type GiftOffer,
  type Tank,
} from '@aquarium/shared';
import {
  BIOLOAD_CAPACITY_BY_SIZE,
  hasCapacityFor,
  syncTreatment,
  waterStress,
} from '@aquarium/sim/lifecycle';
import { and, desc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audit, type AuditAction } from './audit.ts';
import type { Clock } from './clock.ts';
import { schema, type Database } from './db/index.ts';
import { wireDisease } from './disease.ts';
import { apiError, HttpError } from './errors.ts';
import type { SpeciesCatalog } from './species.ts';
import {
  toLifecycleFish,
  type CareLimits,
  type SessionUser,
  type Ticked,
  type Tx,
} from './tanks.ts';

type OfferRow = typeof schema.giftOffers.$inferSelect;
type FishRow = typeof schema.fish.$inferSelect;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const SWEEP_BATCH = 100;
const SETTLE_AUDIT = {
  declined: 'gift_declined',
  cancelled: 'gift_cancelled',
  expired: 'gift_expired',
} as const satisfies Record<string, AuditAction>;

const idParams = z.strictObject({ id: idSchema });

export const storedFishSchema = z.object({
  id: idSchema,
  tankId: idSchema,
  species: z.string(),
  name: z.string(),
  sex: fishSexSchema,
  bornAt: z.coerce.date(),
  size: z.number(),
  hunger: z.number(),
  health: z.number(),
  stage: fishStageSchema,
  lastBroodAt: z.coerce.date().nullable(),
  personality: personalitySchema,
  disease: diseaseStateSchema.nullable(),
  introducedAt: z.coerce.date().nullable(),
  previousTankId: idSchema.nullable(),
  previousIntroducedAt: z.coerce.date().nullable(),
});
type StoredFish = z.infer<typeof storedFishSchema>;

declare module 'fastify' {
  interface FastifyInstance {
    settleDueGifts: () => Promise<number>;
    settleGiftOffers: (ids: readonly string[]) => Promise<number>;
  }
}

const refuse = (status: 400 | 409, message: string, reason?: ConflictReason) =>
  new HttpError(
    status,
    apiError(status === 400 ? 'validation_failed' : 'conflict', message, undefined, reason),
  );

const offerNotFound = () => new HttpError(404, apiError('not_found', 'Offer not found.'));

export interface GiftContext {
  app: FastifyInstance;
  database: Database;
  species: SpeciesCatalog;
  chemistryParams: ChemistryParameters;
  clock: Clock;
  authorize: (req: FastifyRequest, requireVerified?: boolean) => Promise<SessionUser>;
  throttle: (userId: string, bucket: keyof CareLimits) => void;
  guarded: <T>(
    handler: (req: FastifyRequest, reply: FastifyReply) => Promise<T>,
  ) => (req: FastifyRequest, reply: FastifyReply) => Promise<T | FastifyReply>;
  withTanksOf: <T>(
    targets: readonly { user: SessionUser; tankId: string }[],
    fn: (tx: Tx, ticked: Ticked[]) => Promise<T>,
  ) => Promise<T>;
  render: (tx: Tx, ticked: Ticked, fishRows?: Ticked['fishRows']) => Promise<Tank>;
}

const isLive = (offer: Pick<OfferRow, 'status'>) =>
  offer.status === 'open' || offer.status === 'countered';

const dueStatus = (offer: Pick<OfferRow, 'toUserId'>) =>
  offer.toUserId === null ? ('declined' as const) : ('expired' as const);

const isDue = (offer: OfferRow, nowMs: number) =>
  isLive(offer) && (offer.toUserId === null || offer.expiresAt.getTime() <= nowMs);

const snapshotOf = (row: FishRow): StoredFish => storedFishSchema.parse(row);

const giftFishOf = (
  fish: {
    id: string;
    species: string;
    name: string;
    sex: StoredFish['sex'];
    stage: StoredFish['stage'];
    size: number;
    health: number;
    disease: { kind: DiseaseKind } | null;
  },
  ownedByViewer: boolean,
): GiftFish => ({
  id: fish.id,
  species: fish.species,
  name: !ownedByViewer && containsBlockedWord(fish.name) ? fish.species : fish.name,
  sex: fish.sex,
  stage: fish.stage,
  size: fish.size,
  health: fish.health,
  disease: fish.disease?.kind ?? null,
});

async function loadUser(tx: Pick<Database['db'], 'select'>, id: string): Promise<SessionUser> {
  const [row] = await tx
    .select({
      id: schema.user.id,
      emailVerified: schema.user.emailVerified,
      createdAt: schema.user.createdAt,
    })
    .from(schema.user)
    .where(eq(schema.user.id, id));
  if (!row) throw new HttpError(404, apiError('not_found', 'Player not found.'));
  return row;
}

export function registerGiftRoutes(ctx: GiftContext): void {
  const { app, database, species, chemistryParams, clock, authorize, throttle, guarded } = ctx;
  const { withTanksOf, render } = ctx;

  async function views(
    tx: Pick<Database['db'], 'select'>,
    rows: readonly OfferRow[],
    viewerId: string,
  ): Promise<GiftOffer[]> {
    const userIds = [
      ...new Set(rows.flatMap((r) => [r.fromUserId, r.toUserId]).filter((x) => x !== null)),
    ];
    const handles = new Map<string, string | null>();
    if (userIds.length > 0) {
      for (const u of await tx
        .select({ id: schema.user.id, handle: schema.user.handle })
        .from(schema.user)
        .where(inArray(schema.user.id, userIds))) {
        handles.set(u.id, u.handle);
      }
    }
    const pledgedIds = rows.flatMap((r) =>
      r.status === 'countered' && r.pledgedFishId ? [r.pledgedFishId] : [],
    );
    const pledged = new Map<string, FishRow & { ownerId: string | null }>();
    if (pledgedIds.length > 0) {
      for (const p of await tx
        .select({ fish: schema.fish, ownerId: schema.tanks.ownerId })
        .from(schema.fish)
        .innerJoin(schema.tanks, eq(schema.tanks.id, schema.fish.tankId))
        .where(inArray(schema.fish.id, pledgedIds))) {
        pledged.set(p.fish.id, { ...p.fish, ownerId: p.ownerId });
      }
    }
    const out: GiftOffer[] = [];
    for (const r of rows) {
      try {
        out.push(viewRow(r));
      } catch (error) {
        app.log.error({ err: error, offerId: r.id }, 'gift offer could not be rendered, skipped');
      }
    }
    return out;

    function viewRow(r: OfferRow): GiftOffer {
      const role = r.fromUserId === viewerId ? 'sender' : 'recipient';
      const otherId = role === 'sender' ? r.toUserId : r.fromUserId;
      const stored = storedFishSchema.parse(r.fish);
      const pledge = r.pledgedFishId ? pledged.get(r.pledgedFishId) : undefined;
      const available = pledge && pledge.status === 'alive' && pledge.ownerId === r.toUserId;
      return giftOfferSchema.parse({
        id: r.id,
        status: r.status,
        role,
        counterpart: otherId ? (handles.get(otherId) ?? null) : null,
        fish: giftFishOf(stored, role === 'sender'),
        wantsReturn: r.wantsReturn,
        pledged:
          r.status === 'countered' && available
            ? giftFishOf(
                {
                  ...pledge,
                  disease:
                    pledge.disease === null ? null : diseaseStateSchema.parse(pledge.disease),
                },
                role === 'recipient',
              )
            : null,
        createdAt: r.createdAt.toISOString(),
        expiresAt: r.expiresAt.toISOString(),
        settledAt: r.settledAt?.toISOString() ?? null,
      });
    }
  }

  const viewOf = async (tx: Tx, row: OfferRow, viewerId: string): Promise<GiftOffer> => {
    const [view] = await views(tx, [row], viewerId);
    if (!view) throw new Error('views returned nothing for an offer');
    return view;
  };

  async function lockOffer(tx: Tx, id: string): Promise<OfferRow> {
    const [row] = await tx
      .select()
      .from(schema.giftOffers)
      .where(eq(schema.giftOffers.id, id))
      .for('update');
    if (!row) throw offerNotFound();
    return row;
  }

  async function settle(
    tx: Tx,
    offer: OfferRow,
    home: Ticked,
    status: 'declined' | 'cancelled' | 'expired',
    nowMs: number,
    actorId: string | null,
  ): Promise<Ticked['fishRows']> {
    const stored = storedFishSchema.parse(offer.fish);
    const [synced] = syncTreatment(
      [
        toLifecycleFish({
          ...stored,
          tankId: home.tank.id,
          status: 'alive',
          diedAt: null,
          cause: null,
        }),
      ],
      home.state.medicine,
    );
    // A fish is never lost: the home tank may end over its animal limit if the slot was refilled
    // while the fish was in escrow, which only blocks adding more.
    const [row] = await tx
      .insert(schema.fish)
      .values({
        ...stored,
        tankId: home.tank.id,
        status: 'alive',
        disease: wireDisease(synced?.disease ?? null),
      })
      .returning();
    if (!row) throw new Error('returning an escrowed fish inserted nothing');
    await tx
      .update(schema.giftOffers)
      .set({ status, settledAt: new Date(nowMs) })
      .where(eq(schema.giftOffers.id, offer.id));
    await audit(tx, {
      action: SETTLE_AUDIT[status],
      actorId: actorId ?? offer.fromUserId,
      tankId: home.tank.id,
      detail: { offerId: offer.id },
    });
    return [...home.fishRows, row];
  }

  function requirePlacement(
    snapshot: { species: string },
    dest: Ticked,
    leavingFishId: string | null,
  ): void {
    const spec = species.get(snapshot.species);
    if (!spec) throw new Error(`fish has unknown species "${snapshot.species}"`);
    if (spec.biome !== dest.tank.biome) {
      throw refuse(
        409,
        `${spec.commonName} needs a ${spec.biome} tank, and that one is ${dest.tank.biome}.`,
        'wrong_biome',
      );
    }
    const existing = dest.fishRows
      .filter((f) => f.id !== leavingFishId)
      .map((f) => ({
        alive: f.status === 'alive',
        maxBioload: species.get(f.species)?.lifecycle.bioload ?? 0,
      }));
    const roomy = hasCapacityFor(
      existing,
      spec.lifecycle.bioload,
      BIOLOAD_CAPACITY_BY_SIZE[dest.tank.size],
      TANK_SIZES[dest.tank.size].maxAnimals,
    );
    if (!roomy) {
      throw refuse(409, 'That tank is at capacity. Make room or pick another tank.', 'tank_full');
    }
  }

  function stressIn(speciesId: string, dest: Ticked): number {
    const spec = species.get(speciesId);
    if (!spec) throw new Error(`fish has unknown species "${speciesId}"`);
    return waterStress(dest.state.chemistry, spec.chemistry, chemistryParams);
  }

  async function arrive(
    tx: Tx,
    stored: StoredFish,
    dest: Ticked,
    nowMs: number,
  ): Promise<{ row: FishRow; arrival: GiftArrival }> {
    const row: FishRow = {
      ...stored,
      tankId: dest.tank.id,
      status: 'alive',
      diedAt: null,
      cause: null,
      introducedAt: new Date(nowMs),
      previousTankId: null,
      previousIntroducedAt: null,
    };
    const [synced] = syncTreatment([toLifecycleFish(row)], dest.state.medicine);
    const disease = wireDisease(synced?.disease ?? null);
    const [inserted] = await tx
      .insert(schema.fish)
      .values({ ...row, disease })
      .returning();
    if (!inserted) throw new Error('delivering an escrowed fish inserted nothing');
    return {
      row: inserted,
      arrival: { fishId: inserted.id, tankId: dest.tank.id, stress: stressIn(row.species, dest) },
    };
  }

  async function sweepOne(offerId: string): Promise<boolean> {
    const [pre] = await database.db
      .select()
      .from(schema.giftOffers)
      .where(eq(schema.giftOffers.id, offerId));
    if (!pre || !isDue(pre, clock.now())) return false;
    const sender = await loadUser(database.db, pre.fromUserId);
    return withTanksOf([{ user: sender, tankId: pre.fromTankId }], async (tx, [home]) => {
      if (!home) throw new Error('withTanksOf returned fewer tanks than asked');
      const offer = await lockOffer(tx, offerId);
      const nowMs = clock.now();
      if (!isDue(offer, nowMs)) return false;
      await settle(tx, offer, home, dueStatus(offer), nowMs, null);
      return true;
    });
  }

  async function settleDue(where: ReturnType<typeof or>): Promise<number> {
    const due = await database.db
      .select({ id: schema.giftOffers.id })
      .from(schema.giftOffers)
      .where(
        and(
          inArray(schema.giftOffers.status, ['open', 'countered']),
          or(
            lte(schema.giftOffers.expiresAt, new Date(clock.now())),
            isNull(schema.giftOffers.toUserId),
          ),
          where,
        ),
      )
      .limit(SWEEP_BATCH);
    return settleEach(due.map((o) => o.id));
  }

  async function settleEach(ids: readonly string[]): Promise<number> {
    let settled = 0;
    for (const id of ids) {
      try {
        if (await sweepOne(id)) settled += 1;
      } catch (error) {
        app.log.error({ err: error, offerId: id }, 'gift offer could not be settled, skipped');
      }
    }
    return settled;
  }

  app.decorate('settleDueGifts', () => settleDue(undefined));
  app.decorate('settleGiftOffers', (ids: readonly string[]) => settleEach(ids));

  const expired = (offer: Pick<OfferRow, 'toUserId'>) =>
    offer.toUserId === null
      ? refuse(409, 'The other player left. The fish went back to its owner.', 'offer_closed')
      : refuse(409, 'That offer ran out. The fish went back to its owner.', 'offer_expired');
  const closedToGifts = (message = 'That tank does not take gifts. Turn gifts on for it first.') =>
    refuse(409, message, 'gifts_closed');
  const closed = () => refuse(409, 'That offer is already settled.', 'offer_closed');

  app.post(
    '/api/gifts',
    guarded(async (req, reply) => {
      const user = await authorize(req);
      const body = createGiftRequestSchema.parse(req.body);

      const out = await withTanksOf([{ user, tankId: body.fromTankId }], async (tx, [source]) => {
        if (!source) throw new Error('withTanksOf returned fewer tanks than asked');

        const [seen] = await tx
          .select()
          .from(schema.giftOffers)
          .where(
            and(
              eq(schema.giftOffers.fromUserId, user.id),
              eq(schema.giftOffers.creationKey, body.idempotencyKey),
            ),
          );
        if (seen) {
          const view = await viewOf(tx, seen, user.id);
          if (
            seen.fromTankId !== body.fromTankId ||
            view.fish.id !== body.fishId ||
            view.counterpart !== body.toHandle ||
            seen.wantsReturn !== body.wantsReturn
          ) {
            throw refuse(409, 'That idempotency key was used for a different offer.', 'key_reused');
          }
          return { replayed: true, offer: view, tank: await render(tx, source) };
        }

        throttle(user.id, 'gift');
        const [recipient] = await tx
          .select({
            id: schema.user.id,
            emailVerified: schema.user.emailVerified,
          })
          .from(schema.user)
          .where(eq(schema.user.handle, body.toHandle));
        if (!recipient || !recipient.emailVerified) {
          throw new HttpError(404, apiError('not_found', 'No player has that handle.'));
        }
        if (recipient.id === user.id) {
          throw refuse(400, 'You cannot send a fish to yourself.');
        }
        const [open] = await tx
          .select({ id: schema.tanks.id })
          .from(schema.tanks)
          .where(and(eq(schema.tanks.ownerId, recipient.id), eq(schema.tanks.acceptsGifts, true)))
          .limit(1);
        if (!open) throw closedToGifts('That player is not taking gifts right now.');
        const row = source.fishRows.find((f) => f.id === body.fishId);
        if (!row) throw new HttpError(404, apiError('not_found', 'Fish not found.'));
        if (row.status !== 'alive') {
          throw refuse(409, 'A dead fish cannot be gifted. Net it instead.', 'fish_dead');
        }

        for (const key of [`from:${user.id}`, `to:${recipient.id}`]) {
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtextextended(${`gift:${key}`}, 0))`,
          );
        }
        const live = inArray(schema.giftOffers.status, ['open', 'countered']);
        const [sent] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(schema.giftOffers)
          .where(and(eq(schema.giftOffers.fromUserId, user.id), live));
        const [received] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(schema.giftOffers)
          .where(and(eq(schema.giftOffers.toUserId, recipient.id), live));
        if ((sent?.n ?? 0) >= GIFT_MAX_OPEN_SENT) {
          throw refuse(
            409,
            `You have ${GIFT_MAX_OPEN_SENT} open offers. Wait for one to settle or cancel one.`,
            'too_many_offers',
          );
        }
        if ((received?.n ?? 0) >= GIFT_MAX_OPEN_RECEIVED) {
          throw refuse(
            409,
            'That player has too many offers waiting. Try again later.',
            'too_many_offers',
          );
        }

        const nowMs = clock.now();
        const [offer] = await tx
          .insert(schema.giftOffers)
          .values({
            fromUserId: user.id,
            toUserId: recipient.id,
            fromTankId: source.tank.id,
            fish: snapshotOf(row),
            wantsReturn: body.wantsReturn,
            creationKey: body.idempotencyKey,
            createdAt: new Date(nowMs),
            expiresAt: new Date(nowMs + GIFT_OFFER_TTL_HOURS * HOUR_MS),
          })
          .returning();
        if (!offer) throw new Error('offer insert returned nothing');
        await tx.delete(schema.fish).where(eq(schema.fish.id, row.id));
        await audit(tx, {
          action: 'gift_offered',
          actorId: user.id,
          tankId: source.tank.id,
          detail: { offerId: offer.id },
        });
        const remaining = source.fishRows.filter((f) => f.id !== row.id);
        return {
          replayed: false,
          offer: await viewOf(tx, offer, user.id),
          tank: await render(tx, source, remaining),
        };
      });
      const { replayed, ...payload } = out;
      return reply.code(replayed ? 200 : 201).send(createGiftResponseSchema.parse(payload));
    }),
  );

  app.get(
    '/api/gifts',
    guarded(async (req) => {
      const user = await authorize(req);
      await settleDue(
        or(eq(schema.giftOffers.fromUserId, user.id), eq(schema.giftOffers.toUserId, user.id)),
      );
      const cutoff = new Date(clock.now() - GIFT_SETTLED_VISIBLE_DAYS * DAY_MS);
      const rows = await database.db
        .select()
        .from(schema.giftOffers)
        .where(
          and(
            or(eq(schema.giftOffers.fromUserId, user.id), eq(schema.giftOffers.toUserId, user.id)),
            or(
              inArray(schema.giftOffers.status, ['open', 'countered']),
              sql`${schema.giftOffers.settledAt} > ${cutoff}`,
            ),
          ),
        )
        .orderBy(desc(schema.giftOffers.createdAt));
      const all = await views(database.db, rows, user.id);
      return giftListResponseSchema.parse({
        incoming: all.filter((o) => o.role === 'recipient'),
        outgoing: all.filter((o) => o.role === 'sender'),
      });
    }),
  );

  async function preRead(id: string, party: 'sender' | 'recipient', userId: string) {
    const [pre] = await database.db
      .select()
      .from(schema.giftOffers)
      .where(eq(schema.giftOffers.id, id));
    const mine = party === 'sender' ? pre?.fromUserId : pre?.toUserId;
    if (!pre || mine !== userId) throw offerNotFound();
    return pre;
  }

  async function fishLocation(fishId: string, ownerId: string): Promise<string> {
    const [row] = await database.db
      .select({ tankId: schema.fish.tankId })
      .from(schema.fish)
      .innerJoin(schema.tanks, eq(schema.tanks.id, schema.fish.tankId))
      .where(and(eq(schema.fish.id, fishId), eq(schema.tanks.ownerId, ownerId)));
    if (!row) throw new HttpError(404, apiError('not_found', 'Fish not found.'));
    return row.tankId;
  }

  const tankOf = (ticked: readonly Ticked[], tankId: string): Ticked => {
    const found = ticked.find((t) => t.tank.id === tankId);
    if (!found) throw new Error('a locked tank is missing from the ticked set');
    return found;
  };

  const recipientLeft = () =>
    refuse(409, 'The other player left, so this offer is closed.', 'offer_closed');

  type Outcome<T> = { done: T } | { raise: HttpError };

  async function recipientVanished(
    error: unknown,
    recipientId: string | null,
    senderId: string,
  ): Promise<boolean> {
    if (!(error instanceof HttpError) || error.status !== 401 || !recipientId) return false;
    const present = await database.db
      .select({ id: schema.user.id })
      .from(schema.user)
      .where(inArray(schema.user.id, [recipientId, senderId]));
    return present.some((u) => u.id === senderId) && !present.some((u) => u.id === recipientId);
  }

  app.post(
    '/api/gifts/:id/accept',
    guarded(async (req) => {
      const user = await authorize(req);
      const { id } = idParams.parse(req.params);
      const body = acceptGiftRequestSchema.parse(req.body);
      const pre = await preRead(id, 'recipient', user.id);
      const seenAt = clock.now();
      const due = isDue(pre, seenAt);

      const targets = [{ user, tankId: body.toTankId }];
      if (body.returnFishId) {
        targets.push({ user, tankId: await fishLocation(body.returnFishId, user.id) });
      }
      if (due) {
        targets.push({ user: await loadUser(database.db, pre.fromUserId), tankId: pre.fromTankId });
      }

      const outcome = await withTanksOf(targets, async (tx, ticked): Promise<Outcome<unknown>> => {
        const offer = await lockOffer(tx, id);
        const nowMs = clock.now();
        const dest = tankOf(ticked, body.toTankId);

        if (offer.acceptKey === body.idempotencyKey) {
          const samePledge = (offer.pledgedFishId ?? undefined) === body.returnFishId;
          if (offer.recipientTankId !== body.toTankId || !samePledge) {
            return {
              raise: refuse(
                409,
                'That idempotency key was used for a different accept.',
                'key_reused',
              ),
            };
          }
          const arrival =
            offer.status === 'accepted'
              ? (() => {
                  const stored = storedFishSchema.parse(offer.fish);
                  const here = dest.fishRows.some((f) => f.id === stored.id);
                  return here
                    ? {
                        fishId: stored.id,
                        tankId: dest.tank.id,
                        stress: stressIn(stored.species, dest),
                      }
                    : null;
                })()
              : null;
          return {
            done: acceptGiftResponseSchema.parse({
              offer: await viewOf(tx, offer, user.id),
              tank: await render(tx, dest),
              arrival,
            }),
          };
        }

        if (!isLive(offer) || offer.status === 'countered') return { raise: closed() };
        if (isDue(offer, seenAt)) {
          const home = tankOf(ticked, offer.fromTankId);
          await settle(tx, offer, home, dueStatus(offer), nowMs, null);
          return { raise: expired(offer) };
        }

        throttle(user.id, 'gift');
        const stored = storedFishSchema.parse(offer.fish);
        if (!offer.wantsReturn && body.returnFishId) {
          throw refuse(400, 'This offer is a gift. Do not name a fish to send back.');
        }
        if (offer.wantsReturn && !body.returnFishId) {
          throw refuse(400, 'This offer is a trade. Name one of your fish to send back.');
        }
        let pledged: FishRow | undefined;
        if (body.returnFishId) {
          pledged = ticked.flatMap((t) => t.fishRows).find((f) => f.id === body.returnFishId);
          if (!pledged) throw new HttpError(404, apiError('not_found', 'Fish not found.'));
          if (pledged.status !== 'alive') {
            throw refuse(409, 'A dead fish cannot be traded. Net it instead.', 'fish_dead');
          }
        }
        if (!dest.tank.acceptsGifts) throw closedToGifts();
        const leaving = pledged && pledged.tankId === dest.tank.id ? pledged.id : null;
        requirePlacement(stored, dest, leaving);

        if (!offer.wantsReturn) {
          const { row, arrival } = await arrive(tx, stored, dest, nowMs);
          await tx
            .update(schema.giftOffers)
            .set({
              status: 'accepted',
              acceptKey: body.idempotencyKey,
              recipientTankId: dest.tank.id,
              settledAt: new Date(nowMs),
            })
            .where(eq(schema.giftOffers.id, offer.id));
          await audit(tx, {
            action: 'gift_accepted',
            actorId: user.id,
            tankId: dest.tank.id,
            detail: { offerId: offer.id },
          });
          const [updated] = await tx
            .select()
            .from(schema.giftOffers)
            .where(eq(schema.giftOffers.id, offer.id));
          if (!updated) throw new Error('offer vanished inside its own transaction');
          return {
            done: acceptGiftResponseSchema.parse({
              offer: await viewOf(tx, updated, user.id),
              tank: await render(tx, dest, [...dest.fishRows, row]),
              arrival,
            }),
          };
        }

        const [updated] = await tx
          .update(schema.giftOffers)
          .set({
            status: 'countered',
            acceptKey: body.idempotencyKey,
            recipientTankId: dest.tank.id,
            pledgedFishId: body.returnFishId ?? null,
          })
          .where(eq(schema.giftOffers.id, offer.id))
          .returning();
        if (!updated) throw new Error('offer vanished inside its own transaction');
        return {
          done: acceptGiftResponseSchema.parse({
            offer: await viewOf(tx, updated, user.id),
            tank: await render(tx, dest),
            arrival: null,
          }),
        };
      });
      if ('raise' in outcome) throw outcome.raise;
      return outcome.done;
    }),
  );

  app.post(
    '/api/gifts/:id/confirm',
    guarded(async (req) => {
      const user = await authorize(req);
      const { id } = idParams.parse(req.params);
      const body = confirmGiftRequestSchema.parse(req.body);
      const pre = await preRead(id, 'sender', user.id);
      const seenAt = clock.now();
      const due = isDue(pre, seenAt);

      const targets = [{ user, tankId: body.toTankId }];
      if (due) targets.push({ user, tankId: pre.fromTankId });
      if (
        !due &&
        pre.status === 'countered' &&
        pre.toUserId &&
        pre.recipientTankId &&
        pre.pledgedFishId
      ) {
        const recipient = await loadUser(database.db, pre.toUserId).catch((error: unknown) => {
          if (error instanceof HttpError && error.status === 404) throw recipientLeft();
          throw error;
        });
        targets.push({ user: recipient, tankId: pre.recipientTankId });
        const [where] = await database.db
          .select({ tankId: schema.fish.tankId, ownerId: schema.tanks.ownerId })
          .from(schema.fish)
          .innerJoin(schema.tanks, eq(schema.tanks.id, schema.fish.tankId))
          .where(eq(schema.fish.id, pre.pledgedFishId));
        if (where && where.ownerId === pre.toUserId) {
          targets.push({ user: recipient, tankId: where.tankId });
        }
      }

      let outcome: Outcome<unknown>;
      try {
        outcome = await withTanksOf(targets, async (tx, ticked): Promise<Outcome<unknown>> => {
          const offer = await lockOffer(tx, id);
          const nowMs = clock.now();
          const mine = tankOf(ticked, body.toTankId);

          if (offer.confirmKey === body.idempotencyKey && offer.status === 'accepted') {
            const pledgedId = offer.pledgedFishId;
            const here = mine.fishRows.find((f) => f.id === pledgedId);
            if (!here) {
              return {
                raise: refuse(
                  409,
                  'That idempotency key was used for a different confirm.',
                  'key_reused',
                ),
              };
            }
            return {
              done: confirmGiftResponseSchema.parse({
                offer: await viewOf(tx, offer, user.id),
                tank: await render(tx, mine),
                arrival: {
                  fishId: here.id,
                  tankId: mine.tank.id,
                  stress: stressIn(here.species, mine),
                },
              }),
            };
          }

          if (offer.status !== 'countered') {
            if (isDue(offer, seenAt) && offer.status === 'open') {
              const home = tankOf(ticked, offer.fromTankId);
              await settle(tx, offer, home, dueStatus(offer), nowMs, null);
              return { raise: expired(offer) };
            }
            return { raise: closed() };
          }
          if (isDue(offer, seenAt)) {
            const home = tankOf(ticked, offer.fromTankId);
            await settle(tx, offer, home, dueStatus(offer), nowMs, null);
            return { raise: expired(offer) };
          }

          throttle(user.id, 'gift');
          if (offer.recipientTankId && !ticked.some((t) => t.tank.id === offer.recipientTankId)) {
            throw refuse(
              409,
              'The offer changed while you were confirming. Reload it and try again.',
              'offer_changed',
            );
          }
          const recipientTank = offer.recipientTankId
            ? tankOf(ticked, offer.recipientTankId)
            : undefined;
          const pledgedRow = ticked
            .filter((t) => t.tank.ownerId === offer.toUserId)
            .flatMap((t) => t.fishRows)
            .find((f) => f.id === offer.pledgedFishId);
          if (!recipientTank || !pledgedRow || pledgedRow.status !== 'alive') {
            throw refuse(
              409,
              'The fish offered in return is no longer available. Cancel the offer or wait for another.',
              'fish_unavailable',
            );
          }
          if (!mine.tank.acceptsGifts || !recipientTank.tank.acceptsGifts) throw closedToGifts();
          const stored = storedFishSchema.parse(offer.fish);
          requirePlacement(
            stored,
            recipientTank,
            pledgedRow.tankId === recipientTank.tank.id ? pledgedRow.id : null,
          );
          requirePlacement(pledgedRow, mine, null);

          await arrive(tx, stored, recipientTank, nowMs);
          const pledgedSim = tankOf(ticked, pledgedRow.tankId).state.fish.find(
            (f) => f.id === pledgedRow.id,
          );
          if (!pledgedSim) throw new Error('lifecycle state lost a fish the database still has');
          const [synced] = syncTreatment([pledgedSim], mine.state.medicine);
          const moved = {
            tankId: mine.tank.id,
            disease: wireDisease(synced?.disease ?? null),
            introducedAt: new Date(nowMs),
            previousTankId: null,
            previousIntroducedAt: null,
          };
          await tx.update(schema.fish).set(moved).where(eq(schema.fish.id, pledgedRow.id));
          const [updated] = await tx
            .update(schema.giftOffers)
            .set({
              status: 'accepted',
              confirmKey: body.idempotencyKey,
              settledAt: new Date(nowMs),
            })
            .where(eq(schema.giftOffers.id, offer.id))
            .returning();
          if (!updated) throw new Error('offer vanished inside its own transaction');
          await audit(tx, {
            action: 'gift_accepted',
            actorId: user.id,
            tankId: mine.tank.id,
            detail: { offerId: offer.id },
          });
          return {
            done: confirmGiftResponseSchema.parse({
              offer: await viewOf(tx, updated, user.id),
              tank: await render(tx, mine, [...mine.fishRows, { ...pledgedRow, ...moved }]),
              arrival: {
                fishId: pledgedRow.id,
                tankId: mine.tank.id,
                stress: stressIn(pledgedRow.species, mine),
              },
            }),
          };
        });
      } catch (error) {
        if (!(await recipientVanished(error, pre.toUserId, user.id))) throw error;
        throw recipientLeft();
      }
      if ('raise' in outcome) throw outcome.raise;
      return outcome.done;
    }),
  );

  const closeRoute = (action: 'decline' | 'cancel') =>
    guarded(async (req) => {
      const user = await authorize(req);
      const { id } = idParams.parse(req.params);
      const party = action === 'decline' ? 'recipient' : 'sender';
      const status = action === 'decline' ? 'declined' : 'cancelled';
      const pre = await preRead(id, party, user.id);
      const sender = party === 'sender' ? user : await loadUser(database.db, pre.fromUserId);

      return withTanksOf([{ user: sender, tankId: pre.fromTankId }], async (tx, [home]) => {
        if (!home) throw new Error('withTanksOf returned fewer tanks than asked');
        const offer = await lockOffer(tx, id);
        const respond = async (row: OfferRow, tank: Ticked['fishRows']) => {
          const offerView = await viewOf(tx, row, user.id);
          return action === 'decline'
            ? declineGiftResponseSchema.parse({ offer: offerView })
            : cancelGiftResponseSchema.parse({
                offer: offerView,
                tank: await render(tx, home, tank),
              });
        };
        if (offer.status === status) return respond(offer, home.fishRows);
        if (!isLive(offer)) throw closed();

        throttle(user.id, 'care');
        const nowMs = clock.now();
        const fishRows = await settle(tx, offer, home, status, nowMs, user.id);
        return respond({ ...offer, status, settledAt: new Date(nowMs) }, fishRows);
      });
    });

  app.post('/api/gifts/:id/decline', closeRoute('decline'));
  app.post('/api/gifts/:id/cancel', closeRoute('cancel'));
}
