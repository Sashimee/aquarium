import {
  expect,
  test,
  devices,
  type BrowserContext,
  type BrowserContextOptions,
  type CDPSession,
  type Locator,
  type Page,
} from '@playwright/test';

const { viewport, userAgent } = devices['iPhone 15 Pro'];

interface Menu {
  name: string;
  open(page: Page): Promise<void>;
  isOpen(page: Page): Promise<void>;
}

let touch = false;

// Under software rendering the main thread can lag a running spring animation by seconds, so a
// box measured mid-animation is not where the element ends up.
async function settleAnimations(page: Page): Promise<void> {
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((animation) => Number.isFinite(animation.effect?.getComputedTiming().endTime))
        .map((animation) => animation.finished.catch(() => undefined)),
    ),
  );
}

// Locator.tap/click wait two animation frames per action, which costs seconds each under software
// rendering. This checks the same thing that matters here, that nothing covers the target, and
// then sends one real touch or mouse press at its centre.
async function press(target: Locator): Promise<void> {
  await target.waitFor({ state: 'visible' });
  await settleAnimations(target.page());
  // The HUD re-measures a frame after a panel opens or closes, so a panel can briefly sit over
  // it; a target that is still covered after that settles is a real bug.
  let point: [number, number] = [0, 0];
  await expect
    .poll(
      async () => {
        const probe = await target.evaluate((element) => {
          const box = element.getBoundingClientRect();
          const px = box.x + box.width / 2;
          const py = box.y + box.height / 2;
          const top = document.elementFromPoint(px, py);
          const cover =
            top !== null && element.contains(top)
              ? null
              : top
                ? `${top.tagName.toLowerCase()}.${top.className} "${top.textContent?.slice(0, 40)}"`
                : 'nothing';
          return { point: [px, py] as [number, number], cover };
        });
        point = probe.point;
        return probe.cover ? `covered by ${probe.cover} at ${point.join(',')}` : null;
      },
      { message: `${String(target)} cannot be pressed`, timeout: 20_000 },
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
      if ((await avatar.getAttribute('aria-expanded')) !== 'true') await press(avatar);
      await press(link);
    },
    isOpen: async (page) => {
      await expect(page).toHaveURL(new RegExp(`${path}(\\?|$)`));
      await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
    },
  };
}

type Drag = (from: [number, number], to: [number, number]) => Promise<void>;

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

// Every input event waits for the page to produce a frame, and software rendering manages a few
// frames a second, so awaiting each event in turn costs seconds apiece. Chromium handles queued
// events in order, so the whole gesture goes out at once and is awaited as one.
async function dispatchGesture(page: Page, what: string, events: Promise<unknown>[]) {
  try {
    await Promise.all(events);
  } catch (error) {
    if (page.isClosed()) {
      throw new Error(`the page closed during a ${what} (test timeout or browser crash)`, {
        cause: error,
      });
    }
    throw error;
  }
}

function touchDrag(page: Page, cdp: CDPSession, from: [number, number], to: [number, number]) {
  const send = (type: 'touchStart' | 'touchMove' | 'touchEnd', point?: [number, number]) =>
    cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: point ? [{ x: point[0], y: point[1], id: 1 }] : [],
    });
  const mid: [number, number] = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2];
  return dispatchGesture(page, 'touch drag', [
    send('touchStart', from),
    send('touchMove', mid),
    send('touchMove', to),
    send('touchEnd'),
  ]);
}

function mouseDrag(page: Page, cdp: CDPSession, from: [number, number], to: [number, number]) {
  const send = (
    type: 'mousePressed' | 'mouseMoved' | 'mouseReleased',
    point: [number, number],
    buttons: number,
  ) =>
    cdp.send('Input.dispatchMouseEvent', {
      type,
      x: point[0],
      y: point[1],
      button: type === 'mouseMoved' ? 'none' : 'left',
      buttons,
      clickCount: type === 'mouseMoved' ? 0 : 1,
    });
  const mid: [number, number] = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2];
  return dispatchGesture(page, 'mouse drag', [
    send('mouseMoved', from, 0),
    send('mousePressed', from, 1),
    send('mouseMoved', mid, 1),
    send('mouseMoved', to, 1),
    send('mouseReleased', to, 0),
  ]);
}

// The canvas sits under the overlay controls. A drag that ends on one of them is not routed to
// the canvas (the synthetic mouse gets no pointer capture), so the drag runs along the first row
// where its start, middle and end are all bare canvas. No such row means the canvas has no room
// left to drag on, which is a layout bug worth failing for. An open panel covers part of the
// canvas and a canvas press closes it, so callers close panels first.
async function dragPath(page: Page): Promise<[[number, number], [number, number]]> {
  const viewport = page.viewportSize();
  if (!viewport) throw new Error('viewport is not set');
  const xs = [0.8, 0.5, 0.2].map((fraction) => Math.round(viewport.width * fraction));
  const rows = [0.6, 0.5, 0.7, 0.4, 0.8, 0.3].map((fraction) =>
    Math.round(viewport.height * fraction),
  );
  const clear = await page.evaluate(
    ([columns, candidates]) =>
      candidates.find((y) =>
        columns.every((x) => document.elementFromPoint(x, y)?.id === 'tank'),
      ) ?? null,
    [xs, rows] as const,
  );
  if (clear === null) {
    throw new Error(`no row of the canvas is free of overlays at x=${xs.join(',')}`);
  }
  const [start, , end] = xs;
  if (start === undefined || end === undefined) throw new Error('drag columns are missing');
  return [
    [start, clear],
    [end, clear],
  ];
}

async function expectOrbits(page: Page, drag: Drag, context: string) {
  const canvas = page.locator('canvas#tank');
  // A tank switch compiles shaders on the main thread for many seconds; a drag that lands before
  // the frame loop is running again is applied too late for the wait below.
  await frames(page, 2);
  const before = await canvas.getAttribute('data-camera');
  const [from, to] = await dragPath(page);
  await drag(from, to);
  await expect(canvas, `the camera did not orbit ${context}`).not.toHaveAttribute(
    'data-camera',
    before ?? '',
  );
}

async function frames(page: Page, count: number) {
  await page.evaluate(async (n) => {
    for (let i = 0; i < n; i += 1) await new Promise((done) => requestAnimationFrame(done));
  }, count);
}

// Software rendering runs at a few frames a second, so a pose read twice within one frame proves
// nothing: each reading waits for two animation frames first.
async function settledPose(page: Page): Promise<string> {
  const canvas = page.locator('canvas#tank');
  let last = '';
  let steady = 0;
  await expect
    .poll(
      async () => {
        await frames(page, 2);
        const pose = (await canvas.getAttribute('data-camera')) ?? '';
        steady = pose === last ? steady + 1 : 0;
        last = pose;
        return steady;
      },
      { message: 'the camera never came to rest', intervals: [100], timeout: 40_000 },
    )
    .toBeGreaterThanOrEqual(2);
  return last;
}

// A real orbit moves the camera by over 1 within the frame that follows the drag.
function poseDistance(a: string, b: string): number {
  const left = a.split(' ').map(Number);
  const right = b.split(' ').map(Number);
  if (left.length !== 6 || right.length !== 6 || [...left, ...right].some(Number.isNaN)) {
    throw new Error(`data-camera is not a pose: "${a}" and "${b}"`);
  }
  return Math.max(...left.map((value, i) => Math.abs(value - (right[i] ?? Number.NaN))));
}

async function expectToolClaimsDrag(page: Page, drag: Drag) {
  await openPlay(page);
  await expectBigTargets(page);
  const laser = playGroup(page).getByRole('button', { name: 'Laser', exact: true });
  await press(laser);
  await expect(laser).toHaveAttribute('aria-pressed', 'true');
  await closeSheet(page);
  const before = await settledPose(page);
  await drag(...(await dragPath(page)));
  await frames(page, 3);
  const after = (await page.locator('canvas#tank').getAttribute('data-camera')) ?? '';
  expect(poseDistance(after, before), 'a Laser drag orbited the camera').toBeLessThan(0.1);
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
  while (/\/(sign-in|sign-up)(\?|$)/.test(page.url())) {
    await page.goBack();
    await expect.poll(() => page.getByRole('heading', { level: 1 }).count()).toBeLessThanOrEqual(0);
  }
  const tapGlass = playGroup(page).getByRole('button', { name: 'Tap glass', exact: true });
  if ((await tapGlass.count()) > 0 && (await tapGlass.getAttribute('aria-pressed')) !== 'true') {
    await press(tapGlass);
    await expect(tapGlass).toHaveAttribute('aria-pressed', 'true');
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
  await settleAnimations(page);
  const small = await page.evaluate(() =>
    [
      ...document.querySelectorAll<HTMLElement>(
        '.dock button, .hud button, .sheet .panel-head button',
      ),
    ]
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
  const point: [number, number] = [viewport.width * 0.3, viewport.height * 0.3];
  if (touch) await page.touchscreen.tap(...point);
  else await page.mouse.click(...point);
  await expect(sheet(page), 'tapping the scene left the panel open').toHaveCount(0);
}

async function openMenu(page: Page, menu: Menu) {
  await menu.open(page);
  await menu.isOpen(page);
}

async function exercise(page: Page, drag: Drag, first: Menu, second: Menu) {
  const trail = `${first.name}, then ${second.name}`;
  await openMenu(page, first);
  await openMenu(page, second);
  await expectOnePanel(page, trail);
  await closeAllPanels(page);
  await expectOrbits(page, drag, `after ${trail}`);
}

const PAIRS: [Menu, Menu][] = [];
for (let i = 0; i < MENUS.length; i += 2) {
  const first = MENUS[i];
  const second = MENUS[i + 1];
  if (!first || !second) throw new Error('MENUS needs an even number of entries');
  PAIRS.push([first, second]);
}
const decorate = MENUS.find((menu) => menu.name === 'Decorate');
const tank = MENUS.find((menu) => menu.name === 'My tank');
if (!decorate || !tank) throw new Error('MENUS lost My tank or Decorate');
PAIRS.push([decorate, tank]);

// A cold boot costs 25-45 s on a CI runner, so the tests of one describe share a page and run in
// order, each leaving the app as the next expects (no panel open, Tap glass selected).
function shared(options: BrowserContextOptions, makeDrag: (page: Page, cdp: CDPSession) => Drag) {
  let context: BrowserContext | undefined;
  let state: { page: Page; drag: Drag } | undefined;
  test.describe.configure({ mode: 'serial' });
  test.beforeAll(async ({ browser, baseURL }) => {
    if (!baseURL) throw new Error('playwright.config.ts must set use.baseURL');
    context = await browser.newContext({ ...options, baseURL });
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    const cdp = await context.newCDPSession(page);
    await ready(page);
    state = { page, drag: makeDrag(page, cdp) };
  });
  test.afterAll(async () => {
    await context?.close();
  });
  return () => {
    if (!state) throw new Error('the shared page did not start; see the beforeAll failure');
    return state;
  };
}

test.describe('menus on a phone', () => {
  test.beforeEach(() => {
    touch = true;
  });

  const app = shared(
    { viewport, userAgent, deviceScaleFactor: 1, hasTouch: true, isMobile: true },
    (page, cdp) => (from, to) => touchDrag(page, cdp, from, to),
  );

  test('the camera orbits on a fresh page and the controls are big enough to touch', async () => {
    const { page, drag } = app();
    await expectBigTargets(page);
    await expectOrbits(page, drag, 'on a fresh page');
  });

  test('tapping the scene closes an open panel', async () => {
    await expectSceneTapClosesPanel(app().page);
  });

  for (const [first, second] of PAIRS) {
    test(`${first.name}, then ${second.name} opens, switches and leaves the camera draggable`, async () => {
      const { page, drag } = app();
      await exercise(page, drag, first, second);
    });
  }
});

test.describe('menus with a mouse', () => {
  test.beforeEach(() => {
    touch = false;
  });

  const app = shared(
    { viewport: { width: 800, height: 540 } },
    (page, cdp) => (from, to) => mouseDrag(page, cdp, from, to),
  );

  // Tests run in order on one page, so Dive and Reef stay on for the pairs after theirs.
  test('a Laser drag does not move the camera, and Tap glass gives the orbit back', async () => {
    const { page, drag } = app();
    await expectToolClaimsDrag(page, drag);
  });

  test('tapping the scene closes an open panel', async () => {
    await expectSceneTapClosesPanel(app().page);
  });

  test('Escape closes a panel and gives focus back to its button', async () => {
    const { page } = app();
    const shop = dock(page, 'Shop');
    await shop.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('region', { name: 'Fish shop' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Fish shop', level: 2 })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(sheet(page)).toHaveCount(0);
    await expect(shop).toBeFocused();
  });

  for (const [first, second] of PAIRS) {
    test(`${first.name}, then ${second.name} opens, switches and leaves the camera draggable`, async () => {
      const { page, drag } = app();
      await exercise(page, drag, first, second);
    });
  }
});
