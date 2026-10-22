import { chromium } from '@playwright/test';
import { findVerificationLink, newIdentity, signUpStatus } from '../../e2e/support/signup.ts';

const origin = `http://localhost:${process.env.E2E_PORT ?? 4317}`;
const sceneTimeoutMs = 120_000;
const settleMs = 2_500;

const timings = [];
const startedAt = Date.now();
let stageStartedAt = startedAt;
function endStage(name) {
  const now = Date.now();
  timings.push(`${name} ${((now - stageStartedAt) / 1000).toFixed(1)}s`);
  stageStartedAt = now;
}

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
    // Chromium logs the expected 401 from /api/me while signed out; nothing else is exempt.
    const at = msg.location().url ? new URL(msg.location().url) : null;
    const signedOutMe =
      stage === 'signed out' &&
      /status of 401/.test(msg.text()) &&
      at?.origin === origin &&
      at.pathname === '/api/me';
    if (signedOutMe) return;
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
  const identity = newIdentity('smoke');
  const signUp = await signUpStatus(page, origin, identity);
  if (!signUp.ok) throw new Error(`sign-up failed with ${signUp.status}`);
  let link = '';
  for (let attempt = 0; attempt < 40 && !link; attempt += 1) {
    link = await findVerificationLink(origin, identity.email);
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
  endStage('signed out');

  stage = 'sign up';
  await verifiedSignUp(page);
  endStage('sign up');

  stage = 'tank';
  await page.reload();
  await sceneReady(page);
  await page.getByRole('button', { name: 'My tank' }).click();
  await page.getByRole('button', { name: 'Create tank' }).click();
  await page.getByRole('heading', { name: 'Tanks' }).waitFor({ timeout: 30_000 });
  await page.waitForTimeout(settleMs);
  endStage('tank');
} catch (error) {
  record(
    'script',
    `[${stage}] ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
  );
}

console.log(
  `smoke stages: ${timings.join(', ')}; total ${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
);

try {
  await browser.close();
} catch (error) {
  record('browser.close', error instanceof Error ? error.message : String(error));
}

if (problems.length > 0) {
  console.error(`smoke found ${problems.length} problem(s):`);
  for (const problem of problems) console.error(`- ${problem}`);
  process.exit(1);
}
console.log('smoke passed: no page errors, console errors or 5xx responses');
