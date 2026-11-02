import { expect, type APIResponse, type Page } from '@playwright/test';
import { APP_URL } from './app.ts';

export const sameOrigin = { headers: { origin: APP_URL } };

export interface Biomes {
  freshwater: string;
  reef: string;
  cichlid: string;
  blackwater: string;
  mangrove: string;
}

export type Biome = keyof Biomes;
export type Size = 'nano30' | 'standard' | 'std200' | 'long300';

export interface ApiTank {
  id: string;
  name: string;
  biome: Biome;
  size: Size;
  quarantine: boolean;
  backgroundId: string;
  roomId: string | null;
  fish: { id: string; species: string; status: string; stage: string }[];
}

export interface ApiError {
  error: { code: string; message: string; reason?: string };
}

export interface LedgerRow {
  delta: number;
  reason: string;
  source: string;
  itemRef: string | null;
}

export interface Wallet {
  wallet: { balance: number };
  ledger: LedgerRow[];
  owned: string[];
}

export const key = (): string => crypto.randomUUID();

export function createTankRaw(
  page: Page,
  {
    name = 'Pond',
    biome = 'freshwater',
    size = 'standard',
    quarantine = false,
    idempotencyKey = key(),
  }: {
    name?: string;
    biome?: Biome;
    size?: Size;
    quarantine?: boolean;
    idempotencyKey?: string;
  } = {},
): Promise<APIResponse> {
  return page.request.post('/api/tanks', {
    ...sameOrigin,
    data: { name, biome, size, quarantine, idempotencyKey },
  });
}

export async function createTank(
  page: Page,
  options: Parameters<typeof createTankRaw>[1] = {},
): Promise<ApiTank> {
  const res = await createTankRaw(page, options);
  expect(
    res.status(),
    `create ${options.biome ?? 'freshwater'} ${options.size ?? 'standard'}`,
  ).toBe(201);
  return (await res.json()) as ApiTank;
}

export function addFishRaw(
  page: Page,
  tankId: string,
  species: string,
  { stage = 'juvenile', name = 'Pip' }: { stage?: 'juvenile' | 'adult'; name?: string } = {},
): Promise<APIResponse> {
  return page.request.post(`/api/tanks/${tankId}/fish`, {
    ...sameOrigin,
    data: { species, name, stage, idempotencyKey: key() },
  });
}

export async function addFish(
  page: Page,
  tankId: string,
  species: string,
  options: Parameters<typeof addFishRaw>[3] = {},
): Promise<ApiTank> {
  const res = await addFishRaw(page, tankId, species, options);
  expect(res.ok(), `add ${species}: ${await res.text()}`).toBe(true);
  return (await res.json()) as ApiTank;
}

export async function getTank(page: Page, tankId: string): Promise<ApiTank> {
  const res = await page.request.get(`/api/tanks/${tankId}`);
  expect(res.ok(), 'GET tank').toBe(true);
  return (await res.json()) as ApiTank;
}

export async function patchTank(
  page: Page,
  tankId: string,
  data: Record<string, unknown>,
): Promise<APIResponse> {
  return page.request.patch(`/api/tanks/${tankId}`, { ...sameOrigin, data });
}

export async function wallet(page: Page): Promise<Wallet> {
  const res = await page.request.get('/api/wallet');
  expect(res.ok(), 'GET /api/wallet').toBe(true);
  return (await res.json()) as Wallet;
}

export async function balance(page: Page): Promise<number> {
  return (await wallet(page)).wallet.balance;
}

export async function me(page: Page): Promise<{ id: string; email: string }> {
  const res = await page.request.get('/api/me');
  expect(res.ok(), 'GET /api/me').toBe(true);
  return (await res.json()) as { id: string; email: string };
}

export async function setBalance(page: Page, balanceNow: number): Promise<void> {
  const { email } = await me(page);
  await wallet(page);
  const res = await page.request.post('/__e2e/set-balance', {
    data: { email, balance: balanceNow },
  });
  expect(res.status(), 'set-balance (the e2e server hook)').toBe(204);
}

export async function errorOf(res: APIResponse): Promise<ApiError['error']> {
  const body = (await res.json()) as Partial<ApiError>;
  if (!body.error)
    throw new Error(`expected an API error, got ${res.status()} ${JSON.stringify(body)}`);
  return body.error;
}

export async function purchase(
  page: Page,
  itemRef: string,
  { tankId, idempotencyKey = key() }: { tankId?: string; idempotencyKey?: string } = {},
): Promise<APIResponse> {
  return page.request.post('/api/shop/purchase', {
    ...sameOrigin,
    data: { itemRef, idempotencyKey, ...(tankId ? { tankId } : {}) },
  });
}
