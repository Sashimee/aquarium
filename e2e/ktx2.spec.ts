import { expect, test, type Page } from '@playwright/test';
import { SCENE_TIMEOUT_MS, dockButton } from './support/app';

declare global {
  interface Window {
    __cspViolations?: string[];
    __ktx2Transcodes?: { decoded: number; failed: string[] };
  }
}

interface Load {
  problems: string[];
  textures: { url: string; status: number }[];
  workers: { url: string; status: number }[];
}

const PROBLEM = /EvalError|Content Security Policy|Refused to|unsafe-eval/i;

function watch(page: Page): Load {
  const load: Load = { problems: [], textures: [], workers: [] };
  page.on('pageerror', (error) => load.problems.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (PROBLEM.test(message.text())) load.problems.push(`console: ${message.text()}`);
  });
  page.on('response', (response) => {
    const { pathname } = new URL(response.url());
    const entry = { url: response.url(), status: response.status() };
    if (pathname.endsWith('.ktx2')) load.textures.push(entry);
    if (pathname === '/ktx2-worker.js') load.workers.push(entry);
  });
  return load;
}

async function expectCleanLoad(page: Page, load: Load, what: string): Promise<void> {
  await expect(dockButton(page, 'Feed')).toBeEnabled({ timeout: SCENE_TIMEOUT_MS });
  await expect
    .poll(() => page.evaluate(() => window.__ktx2Transcodes?.decoded ?? 0), {
      message: `textures transcoded by the worker ${what}`,
      timeout: SCENE_TIMEOUT_MS,
    })
    .toBeGreaterThan(0);
  const failed = await page.evaluate(() => window.__ktx2Transcodes?.failed ?? []);
  expect(failed, `transcode errors ${what}`).toEqual([]);
  const violations = await page.evaluate(() => window.__cspViolations ?? []);
  expect(violations, `CSP violations ${what}`).toEqual([]);
  expect(load.problems, `EvalError or CSP errors ${what}`).toEqual([]);
  expect(load.textures.length, `KTX2 textures fetched ${what}`).toBeGreaterThan(0);
  for (const { url, status } of [...load.textures, ...load.workers]) {
    expect([200, 304], `${url} ${what}`).toContain(status);
  }
}

test('KTX2 textures decode with no EvalError or CSP violation, also after a reload', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const transcodes = { decoded: 0, failed: [] as string[] };
    window.__ktx2Transcodes = transcodes;
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        if (!String(url).includes('ktx2-worker.js')) return;
        this.addEventListener(
          'message',
          (event: MessageEvent<{ type?: string; error?: string }>) => {
            if (event.data.type === 'transcode') transcodes.decoded += 1;
            if (event.data.type === 'error') transcodes.failed.push(event.data.error ?? 'unknown');
          },
        );
      }
    };
    window.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      window.__cspViolations?.push(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });
  const load = watch(page);

  await page.goto('/?tier=low&backend=webgl&e2e', { waitUntil: 'domcontentloaded' });
  await expectCleanLoad(page, load, 'on the first load');
  expect(load.workers.length, 'the transcoder worker was requested').toBeGreaterThan(0);

  load.textures.length = 0;
  load.workers.length = 0;
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expectCleanLoad(page, load, 'after a reload');
});
