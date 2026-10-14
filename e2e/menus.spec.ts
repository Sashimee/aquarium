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

type Drag = (from: [number, number], to: [number, number]) => Promise<void>;

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

async function expectOrbits(page: Page, drag: Drag, context: string) {
  const viewport = page.viewportSize();
  if (!viewport) throw new Error('viewport is not set');
  const y = Math.round(viewport.height * 0.6);
  const canvas = page.locator('canvas#tank');
  const before = await canvas.getAttribute('data-camera');
  const from: [number, number] = [viewport.width * 0.8, y];
  const to: [number, number] = [viewport.width * 0.2, y];
  const orbited = () =>
    expect(canvas, `the camera did not orbit ${context}`).not.toHaveAttribute(
      'data-camera',
      before ?? '',
    );
  await drag(from, to);
  // A frame longer than the long-press delay between press and move turns the drag into a
  // long-press, so a camera that has not moved after a generous wait gets one more drag.
  try {
    await expect(async () => orbited()).toPass({ timeout: 12_000 });
  } catch {
    await drag(from, to);
    await orbited();
  }
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
        await page.evaluate(
          () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
        );
        const pose = (await canvas.getAttribute('data-camera')) ?? '';
        steady = pose === last ? steady + 1 : 0;
        last = pose;
        return steady;
      },
      { message: 'the camera never came to rest', intervals: [100], timeout: 60_000 },
    )
    .toBeGreaterThanOrEqual(3);
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

// Under load a tap right after a camera drag can be swallowed; a menu that has not opened after a
// generous wait most likely never received the tap. A late first tap would make the second one
// close the menu again, so the retry is only worth it after the wait is clearly over.
async function openMenu(page: Page, menu: Menu) {
  await menu.open(page);
  try {
    await expect(async () => menu.isOpen(page)).toPass({ timeout: 15_000 });
  } catch {
    await menu.open(page);
    await menu.isOpen(page);
  }
}

async function exercise(page: Page, drag: Drag, first: Menu, second: Menu) {
  const trail = `${first.name}, then ${second.name}`;
  await openMenu(page, first);
  await openMenu(page, second);
  await expectOnePanel(page, trail);
  await closeAllPanels(page);
  await expectOrbits(page, drag, `after ${trail}`);
}

const [tank, decorate] = MENUS;
if (!tank || !decorate) throw new Error('MENUS lost My tank or Decorate');
const PAIRS: [Menu, Menu][] = [];
for (let i = 0; i < MENUS.length; i += 2) {
  const first = MENUS[i];
  const second = MENUS[i + 1];
  if (!first || !second) throw new Error('MENUS needs an even number of entries');
  PAIRS.push([first, second]);
}
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

  test('the camera orbits on a fresh page', async () => {
    const { page, drag } = app();
    await expectOrbits(page, drag, 'on a fresh page');
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
    { viewport: { width: 1280, height: 800 } },
    (page, cdp) => (from, to) => mouseDrag(page, cdp, from, to),
  );

  test('the camera orbits on a fresh page, and a Laser drag does not move it', async () => {
    const { page, drag } = app();
    await expectOrbits(page, drag, 'on a fresh page');
    await expectToolClaimsDrag(page, drag);
  });

  for (const [first, second] of PAIRS) {
    test(`${first.name}, then ${second.name} opens, switches and leaves the camera draggable`, async () => {
      const { page, drag } = app();
      await exercise(page, drag, first, second);
    });
  }
});
