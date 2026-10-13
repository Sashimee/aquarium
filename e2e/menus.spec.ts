import { expect, test, devices, type CDPSession, type Locator, type Page } from '@playwright/test';

const { viewport, userAgent } = devices['iPhone 15 Pro'];

interface Menu {
  name: string;
  open(page: Page): Promise<void>;
  isOpen(page: Page): Promise<void>;
}

let touch = false;

// Locator.tap/click wait two animation frames per action, which costs seconds each under software
// rendering. This checks the same thing that matters here, that nothing covers the target, and
// then sends one real touch or mouse press at its centre.
async function press(target: Locator): Promise<void> {
  await target.waitFor({ state: 'visible' });
  // The header re-measures a frame after a panel opens or closes, so a panel can briefly sit over
  // it; a target that is still covered after that settles is a real bug.
  let point: [number, number] = [0, 0];
  await expect
    .poll(
      async () => {
        const box = await target.boundingBox();
        if (!box) return `${String(target)} has no box to press`;
        point = [box.x + box.width / 2, box.y + box.height / 2];
        const cover = await target.evaluate((element, [px, py]) => {
          const top = document.elementFromPoint(px ?? 0, py ?? 0);
          if (top !== null && element.contains(top)) return null;
          return top
            ? `${top.tagName.toLowerCase()}.${top.className} "${top.textContent?.slice(0, 40)}"`
            : 'nothing';
        }, point);
        return cover ? `covered by ${cover} at ${point.join(',')}` : null;
      },
      { message: `${String(target)} cannot be pressed`, timeout: 5_000 },
    )
    .toBeNull();
  if (touch) await target.page().touchscreen.tap(...point);
  else await target.page().mouse.click(...point);
}

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
  const steps = 2;
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
  await page.mouse.move(...to, { steps: 2 });
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

// Software rendering runs at a few frames a second, so one unchanged reading proves nothing.
async function settledPose(page: Page): Promise<string> {
  const canvas = page.locator('canvas#tank');
  let last = '';
  let steady = 0;
  await expect
    .poll(
      async () => {
        const pose = (await canvas.getAttribute('data-camera')) ?? '';
        steady = pose === last ? steady + 1 : 0;
        last = pose;
        return steady;
      },
      { message: 'the camera never came to rest', intervals: [500], timeout: 40_000 },
    )
    .toBeGreaterThanOrEqual(4);
  return last;
}

async function expectToolClaimsDrag(page: Page, drag: Drag) {
  const viewport = page.viewportSize();
  if (!viewport) throw new Error('viewport is not set');
  const y = Math.round(viewport.height * 0.6);
  const laser = playGroup(page).getByRole('button', { name: 'Laser', exact: true });
  await press(laser);
  await expect(laser).toHaveAttribute('aria-pressed', 'true');
  const before = await settledPose(page);
  await drag([viewport.width * 0.8, y], [viewport.width * 0.2, y]);
  expect(await settledPose(page), 'a Laser drag orbited the camera').toBe(before);
  await press(playGroup(page).getByRole('button', { name: 'Tap glass', exact: true }));
  await expectOrbits(page, drag, 'after switching Laser back to Tap glass');
}

async function ready(page: Page) {
  await page.goto('/?tier=low&backend=webgl&e2e', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('button', { name: 'Hand-feed' })).toBeEnabled({ timeout: 45_000 });
  await expect(page.locator('canvas#tank')).toBeVisible();
}

async function closeAllPanels(page: Page) {
  const tapGlass = playGroup(page).getByRole('button', { name: 'Tap glass', exact: true });
  if ((await tapGlass.count()) > 0 && (await tapGlass.getAttribute('aria-pressed')) !== 'true') {
    await press(tapGlass);
  }
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
  await expectToolClaimsDrag(page, drag);
  for (let i = 0; i < MENUS.length; i += 2) {
    const first = MENUS[i];
    const second = MENUS[i + 1];
    if (!first || !second) throw new Error('MENUS needs an even number of entries');
    const trail = `${first.name}, then ${second.name}`;
    await first.open(page);
    await first.isOpen(page);
    await second.open(page);
    await second.isOpen(page);
    await expectOnePanel(page, trail);
    await closeAllPanels(page);
    await expectOrbits(page, drag, `after ${trail}`);
  }
  const [tank, decorate] = MENUS;
  if (!tank || !decorate) throw new Error('MENUS lost My tank or Decorate');
  await decorate.open(page);
  await decorate.isOpen(page);
  await tank.open(page);
  await tank.isOpen(page);
  await expectOnePanel(page, 'Decorate, then My tank');
  await closeAllPanels(page);
  await expectOrbits(page, drag, 'after Decorate, then My tank');
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
    test.setTimeout(420_000);
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
    test.setTimeout(420_000);
    await exercise(page, (from, to) => mouseDrag(page, from, to));
  });
});
