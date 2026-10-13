import { expect, test, devices, type CDPSession, type Locator, type Page } from '@playwright/test';

const { viewport, userAgent } = devices['iPhone 15 Pro'];

const SEED = 188;
const STEPS = 10;

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
  close(page: Page): Promise<void>;
  closed(page: Page): Promise<void>;
}

const bar = (page: Page) => page.locator('header.bar');

function toggle(
  label: string,
  attribute: 'aria-expanded' | 'aria-pressed',
  scope: (page: Page) => Locator,
): Menu {
  const button = (page: Page): Locator =>
    scope(page).getByRole('button', { name: label, exact: true });
  return {
    name: label,
    open: (page) => button(page).tap(),
    isOpen: (page) => expect(button(page)).toHaveAttribute(attribute, 'true'),
    close: (page) => button(page).tap(),
    closed: (page) => expect(button(page)).toHaveAttribute(attribute, 'false'),
  };
}

function route(label: string, path: string, heading: string): Menu {
  return {
    name: label,
    open: (page) => bar(page).getByRole('link', { name: label, exact: true }).tap(),
    isOpen: async (page) => {
      await expect(page).toHaveURL(new RegExp(`${path}(\\?|$)`));
      await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
    },
    close: (page) => bar(page).getByRole('link', { name: 'Aquarium', exact: true }).tap(),
    closed: (page) => expect(page.getByRole('heading', { level: 1 })).toHaveCount(0),
  };
}

const MENUS: Menu[] = [
  {
    name: 'My tank',
    open: (page) => bar(page).getByRole('button', { name: 'My tank' }).tap(),
    isOpen: (page) => expect(page.getByRole('region', { name: 'Your tank' })).toBeVisible(),
    close: (page) => bar(page).getByRole('button', { name: 'My tank' }).tap(),
    closed: (page) => expect(page.getByRole('region', { name: 'Your tank' })).toHaveCount(0),
  },
  {
    name: 'Decorate',
    open: (page) => bar(page).getByRole('button', { name: 'Decorate' }).tap(),
    isOpen: (page) => expect(page.getByRole('region', { name: 'Decorate the tank' })).toBeVisible(),
    close: (page) => bar(page).getByRole('button', { name: 'Decorate' }).tap(),
    closed: (page) =>
      expect(page.getByRole('region', { name: 'Decorate the tank' })).toHaveCount(0),
  },
  toggle('Tank report', 'aria-expanded', (page) =>
    page.getByRole('region', { name: 'Tank report' }),
  ),
  route('Sign in', '/sign-in', 'Sign in'),
  route('Create account', '/sign-up', 'Create an account'),
  toggle('Hand-feed', 'aria-pressed', (page) => page.getByRole('group', { name: 'Play and feed' })),
  toggle('Laser', 'aria-pressed', (page) => page.getByRole('group', { name: 'Play and feed' })),
  toggle('Bubbles', 'aria-pressed', (page) => page.getByRole('group', { name: 'Play and feed' })),
  toggle('Dive', 'aria-pressed', (page) => page.getByRole('group', { name: 'Camera' })),
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

async function backToTank(page: Page) {
  if (/\/(sign-in|sign-up)(\?|$)/.test(page.url())) {
    await bar(page).getByRole('link', { name: 'Aquarium', exact: true }).tap();
  }
}

async function exercise(page: Page, drag: Drag) {
  await ready(page);
  await expectOrbits(page, drag, 'on a fresh page');
  const next = random(SEED);
  for (let step = 0; step < STEPS; step += 1) {
    const menu = MENUS[Math.floor(next() * MENUS.length)];
    if (!menu) throw new Error('unreachable');
    await menu.open(page);
    await menu.isOpen(page);
    if (next() < 0.5) {
      await menu.close(page);
      await menu.closed(page);
    }
    if (next() < 0.2) await ready(page);
    await backToTank(page);
    await expectOrbits(page, drag, `after step ${step} (${menu.name})`);
  }
}

test.describe('menus on a phone', () => {
  test.use({ viewport, userAgent, deviceScaleFactor: 1, hasTouch: true, isMobile: true });

  test('every menu opens, switches and leaves the camera draggable', async ({ page }) => {
    test.setTimeout(900_000);
    const cdp = await page.context().newCDPSession(page);
    await exercise(page, (from, to) => touchDrag(cdp, from, to));
  });
});

test.describe('menus with a mouse', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('every menu opens, switches and leaves the camera draggable', async ({ page }) => {
    test.setTimeout(900_000);
    await exercise(page, (from, to) => mouseDrag(page, from, to));
  });
});
