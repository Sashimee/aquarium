import { chromium } from '@playwright/test';

const origin = `http://localhost:${process.env.E2E_PORT ?? 4317}`;
const password = 'a long enough passphrase 9';
const sceneTimeoutMs = 120_000;
const settleMs = 5_000;

const problems = [];
const record = (kind, detail) => problems.push(`${kind}: ${detail}`);

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const context = await browser.newContext({
  baseURL: origin,
  viewport: { width: 800, height: 540 },
  reducedMotion: 'reduce',
  serviceWorkers: 'block',
});

context.setDefaultNavigationTimeout(sceneTimeoutMs);

let stage = 'setup';
function watch(page) {
  page.on('pageerror', (error) =>
    record('pageerror', `[${stage}] ${error.stack ?? error.message}`),
  );
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    // A signed-out visitor is expected to get 401 from the session endpoints.
    if (/Failed to load resource: .*status of 401/.test(msg.text())) return;
    record('console.error', `[${stage}] ${msg.text()}`);
  });
  page.on('response', (res) => {
    if (res.status() >= 500 && new URL(res.url()).origin === origin) {
      record('http', `[${stage}] ${res.status()} ${res.request().method()} ${res.url()}`);
    }
  });
}

async function sceneReady(page) {
  await page
    .locator('#app[data-scene-biome]')
    .waitFor({ state: 'attached', timeout: sceneTimeoutMs });
  await page.locator('.loading').waitFor({ state: 'detached', timeout: sceneTimeoutMs });
  await page.waitForTimeout(settleMs);
}

async function verifiedSignUp(page) {
  const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const email = `smoke-${tag}@bas.lu`;
  const signUp = await page.request.post('/api/auth/sign-up/email', {
    headers: { origin },
    data: { name: 'Smoke', email, password, callbackURL: '/verify-email' },
  });
  if (!signUp.ok()) throw new Error(`sign-up failed with ${signUp.status()}`);
  let link = '';
  for (let attempt = 0; attempt < 40 && !link; attempt += 1) {
    const outbox = await (await fetch(`${origin}/__e2e/outbox`)).json();
    const mail = outbox.find((m) => m.to.toLowerCase() === email && /verify/i.test(m.subject));
    link = mail ? (/<(https?:\/\/[^>\s]+)>/.exec(mail.text)?.[1] ?? '') : '';
    if (!link) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!link) throw new Error('no verification mail reached the test outbox');
  const verified = await page.request.get(link);
  if (!verified.ok()) throw new Error(`verification link failed with ${verified.status()}`);
}

try {
  const page = await context.newPage();
  watch(page);

  stage = 'signed out';
  await page.goto('/?tier=low&backend=webgl');
  await sceneReady(page);

  stage = 'sign up';
  await verifiedSignUp(page);

  stage = 'tank';
  await page.close();
  const tankPage = await context.newPage();
  watch(tankPage);
  await tankPage.goto('/?tier=low&backend=webgl');
  await sceneReady(tankPage);
  await tankPage.getByRole('button', { name: 'My tank' }).click();
  await tankPage.getByRole('button', { name: 'Create tank' }).click();
  await tankPage.getByRole('heading', { name: 'Tanks' }).waitFor({ timeout: 30_000 });
  await tankPage.waitForTimeout(settleMs);
} catch (error) {
  record(
    'script',
    `[${stage}] ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
  );
} finally {
  await browser.close();
}

if (problems.length > 0) {
  console.error(`smoke found ${problems.length} problem(s):`);
  for (const problem of problems) console.error(`- ${problem}`);
  process.exit(1);
}
console.log('smoke passed: no page errors, console errors or 5xx responses');
