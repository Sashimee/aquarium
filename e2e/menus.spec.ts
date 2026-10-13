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
async function press(target: Locator, timeout = 30_000): Promise<void> {
  await target.waitFor({ state: 'visible' });
  // Under software rendering the main thread can lag a running spring animation by seconds, so a
  // box measured mid-animation is not where the element ends up.
  await target.page().evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((animation) => Number.isFinite(animation.effect?.getComputedTiming().endTime))
        .map((animation) => animation.finished.catch(() => undefined)),
    ),
  );
  // The header re-measures a frame after a panel opens or closes, so a panel can briefly sit over
  // it; a target that is still covered after that settles is a real bug.
  let point: [number, number] = [0, 0];
  let previous = '';
  await expect
    .poll(
      async () => {
        const box = await target.boundingBox();
        if (!box) return `${String(target)} has no box to press`;
        point = [box.x + box.width / 2, box.y + box.height / 2];
        const here = point.join(',');
        const moving = here !== previous;
        previous = here;
        if (moving) return `${String(target)} is still moving at ${here}`;
        const cover = await target.evaluate((element, [px, py]) => {
          const top = document.elementFromPoint(px ?? 0, py ?? 0);
          if (top !== null && element.contains(top)) return null;
          return top
            ? `${top.tagName.toLowerCase()}.${top.className} "${top.textContent?.slice(0, 40)}"`
            : 'nothing';
        }, point);
        return cover ? `covered by ${cover} at ${point.join(',')}` : null;
      },
      { message: `${String(target)} cannot be pressed`, intervals: [300], timeout },
    )
    .toBeNull();
  if (touch) await target.page().touchscreen.tap(...point);
  else await target.page().mouse.click(...point);
}

const dock = (page: Page, label: string) =>
  page
    .getByRole('navigation', { name: 'Actions' })
    .getByRole('button', { name: label, exact: true });
const hud = (page: Page, label: string | RegExp) =>
  page.locator('header.hud').getByRole('button', { name: label });
const sheet = (page: Page) => page.locator('section.sheet');
const playGroup = (page: Page) => page.getByRole('group', { name: 'Play tools' });
const tankType = (page: Page) => page.getByRole('group', { name: 'Tank type' });
const camera = (page: Page) => page.getByRole('group', { name: 'Camera' });

function panel(
  name: string,
  button: (page: Page) => Locator,
  attribute: 'aria-expanded' | 'aria-pressed',
  region: string,
): Menu {
  return {
    name,
    open: (page) => press(button(page)),
    isOpen: async (page) => {
      await expect(button(page)).toHaveAttribute(attribute, 'true');
      await expect(page.getByRole('region', { name: region })).toBeVisible();
    },
  };
}

function dockPanel(label: string, region: string): Menu {
  return panel(label, (page) => dock(page, label), 'aria-pressed', region);
}

async function openPlay(page: Page) {
  const play = dock(page, 'Play');
  if ((await play.getAttribute('aria-pressed')) !== 'true') await press(play);
  await expect(playGroup(page)).toBeVisible();
}

function tool(label: string): Menu {
  const button = (page: Page) => playGroup(page).getByRole('button', { name: label, exact: true });
  return {
    name: label,
    open: async (page) => {
      await openPlay(page);
      await press(button(page));
    },
    isOpen: (page) => expect(button(page)).toHaveAttribute('aria-pressed', 'true'),
  };
}

function toggle(label: string, scope: (page: Page) => Locator): Menu {
  const button = (page: Page): Locator =>
    scope(page).getByRole('button', { name: label, exact: true });
  return {
    name: label,
    open: (page) => press(button(page)),
    isOpen: (page) => expect(button(page)).toHaveAttribute('aria-pressed', 'true'),
  };
}

function route(label: string, path: string, heading: string): Menu {
  return {
    name: label,
    open: async (page) => {
      const avatar = hud(page, /^Account/);
      const link = page
        .getByRole('navigation', { name: 'Account' })
        .getByRole('link', { name: label, exact: true });
      await expect(async () => {
        if ((await avatar.getAttribute('aria-expanded')) !== 'true') await press(avatar, 10_000);
        await press(link, 10_000);
      }).toPass({ timeout: 90_000 });
    },
    isOpen: async (page) => {
      await expect(page).toHaveURL(new RegExp(`${path}(\\?|$)`));
      await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
    },
  };
}

const MENUS: Menu[] = [
  dockPanel('Feed', 'Feed the fish'),
  dockPanel('Play', 'Play with the fish'),
  dockPanel('Decorate', 'Decorate the tank'),
  dockPanel('Shop', 'Fish shop'),
  dockPanel('Care', 'Care'),
  panel('My tank', (page) => hud(page, 'My tank'), 'aria-expanded', 'Your tank'),
  panel('Tank report', (page) => hud(page, /^Tank report/), 'aria-expanded', 'Tank report'),
  panel('Account', (page) => hud(page, /^Account/), 'aria-expanded', 'Account menu'),
  route('Sign in', '/sign-in', 'Sign in'),
  route('Create account', '/sign-up', 'Create an account'),
  tool('Hand-feed'),
  tool('Bubbles'),
  toggle('Dive', camera),
  toggle('Reef', tankType),
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

function dragRow(page: Page): number {
  const viewport = page.viewportSize();
  if (!viewport) throw new Error('viewport is not set');
  return Math.round(viewport.height * 0.3);
}

async function expectOrbits(page: Page, drag: Drag, context: string) {
  const viewport = page.viewportSize();
  if (!viewport) throw new Error('viewport is not set');
  const y = dragRow(page);
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

function poseDistance(a: string, b: string): number {
  const left = a.split(' ').map(Number);
  const right = b.split(' ').map(Number);
  return Math.max(...left.map((value, i) => Math.abs(value - (right[i] ?? Number.NaN))));
}

async function expectToolClaimsDrag(page: Page, drag: Drag) {
  const viewport = page.viewportSize();
  if (!viewport) throw new Error('viewport is not set');
  const y = dragRow(page);
  await openPlay(page);
  const laser = playGroup(page).getByRole('button', { name: 'Laser', exact: true });
  await press(laser);
  await expect(laser).toHaveAttribute('aria-pressed', 'true');
  const before = await settledPose(page);
  await drag([viewport.width * 0.8, y], [viewport.width * 0.2, y]);
  expect(
    poseDistance(await settledPose(page), before),
    'a Laser drag orbited the camera',
  ).toBeLessThan(0.1);
  await resetTool(page);
  await expectOrbits(page, drag, 'after switching Laser back to Tap glass');
}

async function ready(page: Page) {
  await page.goto('/?tier=low&backend=webgl&e2e', { waitUntil: 'domcontentloaded' });
  await expect(dock(page, 'Feed')).toBeEnabled({ timeout: 45_000 });
  await expect(page.locator('canvas#tank')).toBeVisible();
  await expect(hud(page, /^Account/)).toBeEnabled();
}

async function resetTool(page: Page) {
  await openPlay(page);
  await press(playGroup(page).getByRole('button', { name: 'Tap glass', exact: true }));
  await closeSheet(page);
}

async function closeSheet(page: Page) {
  if ((await sheet(page).count()) === 0) return;
  await press(sheet(page).getByRole('button', { name: /^(Close|Done)$/ }));
  await expect(sheet(page)).toHaveCount(0);
}

async function closeAllPanels(page: Page) {
  if (/\/(sign-in|sign-up)(\?|$)/.test(page.url())) {
    await page.goBack();
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(0);
  }
  await closeSheet(page);
  if (await dock(page, 'Play').evaluate((element) => element.classList.contains('glow'))) {
    await resetTool(page);
  }
  await expect(sheet(page)).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(0);
}

async function expectOnePanel(page: Page, context: string) {
  const open = await sheet(page).count();
  expect(open, `two panels were open ${context}`).toBeLessThanOrEqual(1);
}

async function expectBigTargets(page: Page) {
  const small = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.dock button, .hud button')]
      .map((el) => ({
        label: el.getAttribute('aria-label') ?? el.textContent ?? '',
        box: el.getBoundingClientRect(),
      }))
      .filter(({ box }) => box.width < 44 || box.height < 44)
      .map(
        ({ label, box }) =>
          `${label.slice(0, 30)} ${Math.round(box.width)}x${Math.round(box.height)}`,
      ),
  );
  expect(small, 'touch targets under 44px').toEqual([]);
}

async function expectSceneTapClosesPanel(page: Page) {
  const viewport = page.viewportSize();
  if (!viewport) throw new Error('viewport is not set');
  await press(dock(page, 'Shop'));
  await expect(sheet(page)).toHaveCount(1);
  const point: [number, number] = [viewport.width * 0.3, dragRow(page)];
  if (touch) await page.touchscreen.tap(...point);
  else await page.mouse.click(...point);
  await expect(sheet(page), 'tapping the scene left the panel open').toHaveCount(0);
}

async function exercise(page: Page, drag: Drag) {
  await ready(page);
  await expectBigTargets(page);
  await expectOrbits(page, drag, 'on a fresh page');
  await expectToolClaimsDrag(page, drag);
  await expectSceneTapClosesPanel(page);
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

  test('Escape closes a panel and gives focus back to its button', async ({ page }) => {
    test.setTimeout(120_000);
    await ready(page);
    const shop = dock(page, 'Shop');
    await shop.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('region', { name: 'Fish shop' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Fish shop', level: 2 })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(sheet(page)).toHaveCount(0);
    await expect(shop).toBeFocused();
  });
});
