import {
  backgroundIdSchema,
  DEFAULT_BACKGROUND_ID,
  equipmentProblems,
  equipmentSchema,
  idSchema,
  isBackgroundForBiome,
  isDecorAssetForBiome,
  purchaseRequestSchema,
  purchaseResponseSchema,
  sellFryResponseSchema,
  walletResponseSchema,
  type BackgroundId,
  type Economy,
  type PurchaseResponse,
  type Tank,
} from '@aquarium/shared';
import { desc, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Clock } from './clock.ts';
import { schema, type Database } from './db/index.ts';
import { claimAchievementRewards, fryItemRef, fryRoom } from './earn.ts';
import { apiError, HttpError } from './errors.ts';
import { EUPHYLLIA_LICENSE_REF, licenseForRef, type License } from './items.ts';
import type { CareLimits, SessionUser, Ticked, Tx } from './tanks.ts';
import {
  balanceOf,
  credit,
  findReplay,
  lockWallet,
  owns,
  serverKey,
  spend,
  toEntry,
  type Charged,
} from './wallet.ts';

const WALLET_LEDGER_PAGE = 100;

type Device = keyof Economy['items']['equipment'];

type Item =
  | { kind: 'background'; id: BackgroundId; price: number }
  | { kind: 'equipment'; device: Device; tier: number; price: number }
  | { kind: 'license'; license: License };

export interface ShopContext {
  app: FastifyInstance;
  database: Database;
  economy: Economy;
  clock: Clock;
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
  render: (tx: Tx, ticked: Ticked, fishRows?: Ticked['fishRows']) => Promise<Tank>;
}

const tankFishParamsSchema = z.strictObject({ tankId: idSchema, fishId: idSchema });

const refused = (message: string) => new HttpError(400, apiError('validation_failed', message));

const EQUIPMENT_REF = /^equipment:(heater|filter|light|co2|waveMaker):([1-9])$/;

function parseItem(economy: Economy, itemRef: string): Item {
  if (itemRef.startsWith('species:')) {
    throw refused('Fish are bought when you add them to a tank, not through the shop.');
  }
  if (itemRef.startsWith('tank:')) {
    throw refused('Tanks are bought when you create them, not through the shop.');
  }
  if (itemRef.startsWith('background:')) {
    const id = backgroundIdSchema.safeParse(itemRef.slice('background:'.length));
    if (!id.success) throw refused(`Unknown background "${itemRef}".`);
    return { kind: 'background', id: id.data, price: economy.items.background.price };
  }
  const equipment = EQUIPMENT_REF.exec(itemRef);
  if (equipment) {
    const device = equipment[1] as Device;
    const tier = Number(equipment[2]);
    const price = economy.items.equipment[device][tier - 1];
    if (price === undefined) throw refused(`There is no tier ${tier} ${device}.`);
    return { kind: 'equipment', device, tier, price };
  }
  const license = licenseForRef(economy, itemRef);
  if (license) return { kind: 'license', license };
  throw refused(`"${itemRef}" cannot be bought here.`);
}

const conflict = (message: string) => new HttpError(409, apiError('conflict', message));

export function registerShopRoutes(ctx: ShopContext): void {
  const { app, database, economy, clock, authorize, throttle, guarded, withTank, render } = ctx;

  const respond = (charged: Charged): PurchaseResponse =>
    purchaseResponseSchema.parse({
      wallet: { balance: charged.balance },
      entry: charged.entry,
      replayed: charged.replayed,
    });

  async function buy(
    tx: Tx,
    ticked: Ticked | null,
    user: SessionUser,
    body: z.infer<typeof purchaseRequestSchema>,
    item: Item,
  ): Promise<PurchaseResponse> {
    const nowMs = clock.now();
    await lockWallet(tx, economy, user.id, nowMs, ticked !== null);
    const replay = await findReplay(tx, user.id, body.idempotencyKey, body.itemRef);
    if (replay) return respond(replay);

    const charge = (price: number) =>
      spend(tx, user.id, {
        amount: price,
        itemRef: body.itemRef,
        key: body.idempotencyKey,
        nowMs,
      });

    if (item.kind === 'background') {
      if (Object.values(DEFAULT_BACKGROUND_ID).includes(item.id)) {
        throw refused('That background is free in its tank type; there is nothing to buy.');
      }
      if (ticked && !isBackgroundForBiome(ticked.tank.biome, item.id)) {
        throw refused(`That background does not belong in a ${ticked.tank.biome} tank.`);
      }
      if (await owns(tx, user.id, body.itemRef)) throw conflict('You already own this background.');
      const charged = await charge(item.price);
      if (ticked) {
        await tx
          .update(schema.tanks)
          .set({ backgroundId: item.id, updatedAt: new Date(nowMs) })
          .where(eq(schema.tanks.id, ticked.tank.id));
      }
      return respond(charged);
    }

    if (item.kind === 'equipment') {
      if (!ticked) throw refused('Say which tank the equipment is for.');
      const equipment = equipmentSchema.parse(ticked.tank.equipment);
      if (item.tier <= equipment[item.device].tier) {
        throw conflict(`This tank already has a ${item.device} of tier ${item.tier} or better.`);
      }
      const upgraded = {
        ...equipment,
        [item.device]: { ...equipment[item.device], tier: item.tier },
      };
      const problems = equipmentProblems(ticked.tank.biome, equipmentSchema.parse(upgraded));
      if (problems.length > 0) throw refused(`${problems.join('; ')}.`);
      const charged = await charge(item.price);
      await tx
        .update(schema.tanks)
        .set({ equipment: upgraded, updatedAt: new Date(nowMs) })
        .where(eq(schema.tanks.id, ticked.tank.id));
      return respond(charged);
    }

    const { license } = item;
    const assetId = license.ref === EUPHYLLIA_LICENSE_REF ? null : license.ref.split(':')[1];
    if (assetId !== null && !ticked) throw refused('Say which tank the piece is for.');
    if (ticked) {
      const probe = assetId ?? 'euphyllia-hammer-0';
      if (!isDecorAssetForBiome(ticked.tank.biome, probe)) {
        throw refused(`That piece does not belong in a ${ticked.tank.biome} tank.`);
      }
    }
    if (await owns(tx, user.id, license.ref)) throw conflict('You already own this piece.');
    return respond(await charge(license.price));
  }

  app.get(
    '/api/wallet',
    guarded(async (req) => {
      const user = await authorize(req);
      throttle(user.id, 'wallet');
      return database.db.transaction(async (tx) => {
        const nowMs = clock.now();
        await lockWallet(tx, economy, user.id, nowMs);
        await claimAchievementRewards(tx, economy, user.id, nowMs);
        const rows = await tx
          .select()
          .from(schema.ledger)
          .where(eq(schema.ledger.userId, user.id))
          .orderBy(desc(schema.ledger.createdAt), desc(schema.ledger.id))
          .limit(WALLET_LEDGER_PAGE);
        return walletResponseSchema.parse({
          wallet: { balance: await balanceOf(tx, user.id) },
          ledger: rows.map(toEntry),
        });
      });
    }),
  );

  app.post(
    '/api/shop/purchase',
    guarded(async (req) => {
      const user = await authorize(req);
      const body = purchaseRequestSchema.parse(req.body);
      throttle(user.id, 'purchase');
      const item = parseItem(economy, body.itemRef);
      if (body.tankId === undefined) {
        return database.db.transaction((tx) => buy(tx, null, user, body, item));
      }
      return withTank(user, body.tankId, (tx, ticked) => buy(tx, ticked, user, body, item));
    }),
  );

  app.post(
    '/api/tanks/:tankId/fish/:fishId/sell',
    guarded(async (req) => {
      const user = await authorize(req);
      const { tankId, fishId } = tankFishParamsSchema.parse(req.params);
      throttle(user.id, 'purchase');
      return withTank(user, tankId, async (tx, ticked) => {
        const row = ticked.fishRows.find((f) => f.id === fishId);
        if (!row) throw new HttpError(404, apiError('not_found', 'Fish not found.'));
        if (row.status !== 'alive' || row.stage !== 'fry') {
          throw conflict('Only a living fry can be sold.');
        }
        const price = Object.hasOwn(economy.species, row.species)
          ? economy.species[row.species]
          : undefined;
        const amount = price
          ? Math.floor((price.juvenile * economy.earn.frySale.percentOfJuvenilePrice) / 100)
          : 0;
        if (amount <= 0) throw conflict('This species cannot be sold.');
        const nowMs = clock.now();
        await lockWallet(tx, economy, user.id, nowMs);
        const room = await fryRoom(tx, economy, user.id, nowMs);
        if (amount > room) {
          throw conflict(
            'You have sold as many fry as the shop takes today. Try again tomorrow, or keep them.',
          );
        }
        const paid = await credit(tx, user.id, {
          amount,
          reason: 'earn',
          itemRef: fryItemRef(fishId),
          key: serverKey(`fry-${fishId}`),
          nowMs,
        });
        if (!paid) throw conflict('This fry was already sold.');
        await tx.delete(schema.fish).where(eq(schema.fish.id, fishId));
        const fishRows = ticked.fishRows.filter((f) => f.id !== fishId);
        return sellFryResponseSchema.parse({
          tank: await render(tx, ticked, fishRows),
          wallet: { balance: paid.balance },
          entry: paid.entry,
        });
      });
    }),
  );
}
