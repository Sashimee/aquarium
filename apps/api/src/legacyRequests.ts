import { randomUUID } from 'node:crypto';
import { DEFAULT_PURCHASE_STAGE, type PurchasableStage } from '@aquarium/shared';

// TODO(T71, #765): delete this file, make stage and idempotencyKey required in the shared request
// schemas, and drop the two calls in tanks.ts. It exists only so a client that predates the shop
// keeps working: it sends neither field, so it is charged the adult price and gets no retry dedupe.

export const legacyStage = (stage: PurchasableStage | undefined): PurchasableStage =>
  stage ?? DEFAULT_PURCHASE_STAGE;

export const legacyKey = (key: string | undefined): string => key ?? randomUUID();
