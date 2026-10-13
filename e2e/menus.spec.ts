import { expect, test, devices, type CDPSession, type Locator, type Page } from '@playwright/test';

const { viewport, userAgent } = devices['iPhone 15 Pro'];

const SEED = 188;
const STEPS = 4;

function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

interface Menu {
  name: string;
  open(page: Page): Promise<void>;
  isOpen(page: Page): Promise<void>;
}

let touch = false;

const press = (target: Locator) => (touch ? target.tap() : target.click());

const bar = (page: Page) => page.locator('header.bar');

function toggle(
  label: string,
  attribute: 'aria-expanded' | 'aria-pressed',
  scope: (page: Page) => Locator,
  beforeOpen?: (page: Page) => Promise<void>,
): Menu {
  const button = (page: Page): Locator =>
    scope(page).getByRole('button', { name: label, exact: true });
  return {
    name: label,
    open: async (page) => {
      await beforeOpen?.(page);
      await press(button(page));
    },
    isOpen: (page) => expect(button(page)).toHaveAttribute(attribute, 'true'),
  };
}

function route(label: string, path: string, heading: string): Menu {
  return {
    name: label,
    open: (page) => press(bar(page).getByRole('link', { name: label, exact: true })),
    isOpen: async (page) => {
      await expect(page).toHaveURL(new RegExp(`${path}(\\?|$)`));
      await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
    },
  };
}

async function leaveDecorate(page: Page) {
  const decorate = bar(page).getByRole('button', { name: 'Decorate' });
  if ((await decorate.getAttribute('aria-pressed')) === 'true') await press(decorate);
}

const playGroup = (page: Page) => page.getByRole('group', { name: 'Play and feed' });
const tankType = (page: Page) => page.getByRole('group', { name: 'Tank type' });

const MENUS: Menu[] = [
  {
    name: 'My tank',
    open: (page) => press(bar(page).getByRole('button', { name: 'My tank' })),
    isOpen: (page) => expect(page.getByRole('region', { name: 'Your tank' })).toBeVisible(),
  },
  {
    name: 'Decorate',
    open: (page) => press(bar(page).getByRole('button', { name: 'Decorate' })),
    isOpen: (page) => expect(page.getByRole('region', { name: 'Decorate the tank' })).toBeVisible(),
  },
  toggle('Tank report', 'aria-expanded', (page) =>
    page.getByRole('region', { name: 'Tank report' }),
  ),
  route('Sign in', '/sign-in', 'Sign in'),
  route('Create account', '/sign-up', 'Create an account'),
  toggle('Hand-feed', 'aria-pressed', playGroup, leaveDecorate),
  toggle('Laser', 'aria-pressed', playGroup, leaveDecorate),
  toggle('Bubbles', 'aria-pressed', playGroup, leaveDecorate),
  toggle('Dive', 'aria-pressed', (page) => page.getByRole('group', { name: 'Camera' })),
  toggle('Reef', 'aria-pressed', tankType),
];

type Drag = (from: [number, number], to: [number, number]) => Promise<void>;

async function touchDrag(cdp: CDPSession, from: [number, number], to: [number, number]) {
  const send = (type: 'touchStart' | 'touchMove' | 'touchEnd', point?: [number, number]) =>
    cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: point ? [{ x: point[0], y: point[1], id: 1 }] : [],
    });
  await send('touchStart', from);
  const steps = 4;
  for (let i = 1; i <= steps; i += 1) {
    await send('touchMove', [
      from[0] + ((to[0] - from[0]) * i) / steps,
      from[1] + ((to[1] - from[1]) * i) / steps,
    ]);
  }
  await send('touchEnd');
}

async function mouseDrag(page: Page, from: [number, number], to: [number, number]) {
  await page.mouse.move(...from);
  await page.mouse.down();
  await page.mouse.move(...to, { steps: 4 });
  await page.mouse.up();
}

async function expectOrbits(page: Page, drag: Drag, context: string) {
  const viewport = page.viewportSize();
  if (!viewport) throw new Error('viewport is not set');
  const y = Math.round(viewport.height * 0.6);
  const canvas = page.locator('canvas#tank');
  const before = await canvas.getAttribute('data-camera');
  await drag([viewport.width * 0.8, y], [viewport.width * 0.2, y]);
  await expect(canvas, `the camera did not orbit ${context}`).not.toHaveAttribute(
    'data-camera',
    before ?? '',
  );
}

async function ready(page: Page) {
  await page.goto('/?tier=low&backend=webgl', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('button', { name: 'Hand-feed' })).toBeEnabled({ timeout: 45_000 });
  await expect(page.locator('canvas#tank')).toBeVisible();
}

async function closeAllPanels(page: Page) {
  const tank = bar(page).getByRole('button', { name: 'My tank' });
  if ((await tank.getAttribute('aria-expanded')) === 'true') await press(tank);
  const decorate = bar(page).getByRole('button', { name: 'Decorate' });
  if ((await decorate.getAttribute('aria-pressed')) === 'true') await press(decorate);
  if (/\/(sign-in|sign-up)(\?|$)/.test(page.url())) {
    await press(bar(page).getByRole('link', { name: 'Aquarium', exact: true }));
  }
  await expect(page.getByRole('region', { name: 'Your tank' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Decorate the tank' })).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(0);
}

async function expectOnePanel(page: Page, context: string) {
  const open = await page.getByRole('region', { name: /^(Your tank|Decorate the tank)$/ }).count();
  expect(open, `two panels were open ${context}`).toBeLessThanOrEqual(1);
}

async function exercise(page: Page, drag: Drag) {
  await ready(page);
  await expectOrbits(page, drag, 'on a fresh page');
  const next = random(SEED);
  const pick = () => {
    const menu = MENUS[Math.floor(next() * MENUS.length)];
    if (!menu) throw new Error('unreachable');
    return menu;
  };
  for (let step = 0; step < STEPS; step += 1) {
    const first = pick();
    const second = pick();
    const trail = `step ${step} (${first.name}, then ${second.name})`;
    await first.open(page);
    await first.isOpen(page);
    await second.open(page);
    await second.isOpen(page);
    await expectOnePanel(page, trail);
    if (next() < 0.2) {
      await ready(page);
      continue;
    }
    await closeAllPanels(page);
    await expectOrbits(page, drag, `after ${trail}`);
  }
}

test.describe('menus on a phone', () => {
  test.use({
    viewport,
    userAgent,
    deviceScaleFactor: 1,
    hasTouch: true,
    isMobile: true,
    actionTimeout: 30_000,
  });

  test.beforeEach(() => {
    touch = true;
  });

  test('every menu opens, switches and leaves the camera draggable', async ({ page }) => {
    test.setTimeout(900_000);
    const cdp = await page.context().newCDPSession(page);
    await exercise(page, (from, to) => touchDrag(cdp, from, to));
  });
});

test.describe('menus with a mouse', () => {
  test.use({ viewport: { width: 1280, height: 800 }, actionTimeout: 30_000 });

  test.beforeEach(() => {
    touch = false;
  });

  test('every menu opens, switches and leaves the camera draggable', async ({ page }) => {
    test.setTimeout(900_000);
    await exercise(page, (from, to) => mouseDrag(page, from, to));
  });
});
