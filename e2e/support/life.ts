import { expect, type APIResponse, type Page } from '@playwright/test';
import { advanceServerClock } from './app.ts';
import { key, sameOrigin, type ApiTank } from './api.ts';

export interface LifeFish {
  id: string;
  name: string;
  species: string;
  status: string;
  stage: string;
  personality: { boldness: number; greed: number; sociability: number } | null;
  disease: { kind: string } | null;
}

export interface LifePlant {
  key: string;
  assetId: string;
  size: number;
  minSize: number;
  maxSize: number;
}

export interface LifeCoral {
  key: string;
  assetId: string;
  parentKey: string | null;
  size: number;
  minSize: number;
  maxSize: number;
  fragMinSize: number;
  bleach: number;
}

export interface LifeTank extends Omit<ApiTank, 'fish'> {
  fish: LifeFish[];
  plants?: LifePlant[];
  corals?: LifeCoral[];
  water: { algae: number; ammonia: number; nitrate: number; uneatenFood: number };
  equipment: {
    heater: { tier: number };
    filter: { tier: number };
    co2: { tier: number };
    waveMaker: { tier: number };
    light: { tier: number; intensity: number; onHour: number; offHour: number };
  };
  co2OwnedTier: number;
  recentVisitDays: number;
  away?: { births?: { fishId: string; parentId: string; species: string }[] };
}

export async function readTank(page: Page, tankId: string): Promise<LifeTank> {
  const res = await page.request.get(`/api/tanks/${tankId}`);
  expect(res.ok(), `GET tank: ${await res.text()}`).toBe(true);
  return (await res.json()) as LifeTank;
}

export function careRaw(
  page: Page,
  tankId: string,
  action: Record<string, unknown>,
): Promise<APIResponse> {
  return page.request.post(`/api/tanks/${tankId}/care`, { ...sameOrigin, data: action });
}

/** A feed the tank may refuse as too much; the caller only wants the fish fed when it can be. */
export async function feedIfPossible(page: Page, tankId: string): Promise<void> {
  const res = await careRaw(page, tankId, { type: 'feed', food: 'flakes', portion: 0.3 });
  expect([200, 422], `feed ${tankId}: ${await res.text()}`).toContain(res.status());
}

export async function waterChange(page: Page, tankId: string): Promise<void> {
  const res = await careRaw(page, tankId, { type: 'water_change' });
  expect(res.ok(), `water change: ${await res.text()}`).toBe(true);
}

export async function advanceDays(page: Page, days: number): Promise<void> {
  await advanceServerClock(page, days * 24 * 60);
}

export async function advanceDaysAndRead(
  page: Page,
  tankId: string,
  days: number,
): Promise<LifeTank> {
  await advanceDays(page, days);
  return readTank(page, tankId);
}

export function trimRaw(
  page: Page,
  tankId: string,
  plantKey: string,
  size: number,
  idempotencyKey: string = key(),
): Promise<APIResponse> {
  return page.request.post(`/api/tanks/${tankId}/plants/trim`, {
    ...sameOrigin,
    data: { plantKey, size, idempotencyKey },
  });
}

export function fragRaw(
  page: Page,
  tankId: string,
  coralKey: string,
  idempotencyKey: string = key(),
): Promise<APIResponse> {
  return page.request.post(`/api/tanks/${tankId}/corals/frag`, {
    ...sameOrigin,
    data: { coralKey, idempotencyKey },
  });
}

export function moveRaw(
  page: Page,
  fromTankId: string,
  fishId: string,
  toTankId: string,
): Promise<APIResponse> {
  return page.request.post(`/api/tanks/${fromTankId}/fish/${fishId}/move`, {
    ...sameOrigin,
    data: { toTankId, idempotencyKey: key() },
  });
}

export function treatRaw(
  page: Page,
  tankId: string,
  kind: 'ich' | 'fin-rot' | 'velvet',
): Promise<APIResponse> {
  return page.request.post(`/api/tanks/${tankId}/treat`, {
    ...sameOrigin,
    data: { kind, potency: 'standard', idempotencyKey: key() },
  });
}
