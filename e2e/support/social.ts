import type { Browser, Page } from '@playwright/test';
import { APP_URL, registerVerifiedUser } from './app.ts';
import { sameOrigin } from './api.ts';

export async function freshPlayer(browser: Browser, label: string): Promise<Page> {
  const context = await browser.newContext({ baseURL: APP_URL, serviceWorkers: 'block' });
  const page = await context.newPage();
  await registerVerifiedUser(page, label);
  return page;
}

export async function anonymousVisitor(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ baseURL: APP_URL, serviceWorkers: 'block' });
  return context.newPage();
}

export const uniqueHandle = (prefix: string): string =>
  `${prefix}${crypto.randomUUID().replaceAll('-', '').slice(0, 10)}`;

export async function setHandle(page: Page, handle: string) {
  return page.request.put('/api/me/handle', { ...sameOrigin, data: { handle } });
}
