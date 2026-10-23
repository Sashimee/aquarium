import { expect, test, type Page } from '@playwright/test';
import {
  advanceServerClock,
  createFirstTank,
  openDock,
  openTank,
  registerVerifiedUser,
  returnToTab,
} from '../support/app.ts';
import { addFish, createTank } from '../support/api.ts';

const THIRTY_DAYS_IN_MINUTES = 30 * 24 * 60;

const lighting = (page: Page) => page.getByRole('button', { name: /^Lighting: / });
const statusCard = (page: Page) => page.getByRole('button', { name: /^Tank report: / });

test.describe('photo mode', () => {
  test('frames a shot, hides the controls, takes the photo and saves it', async ({ page }) => {
    test.setTimeout(420_000);
    await registerVerifiedUser(page, 'photo');
    await createTank(page, { name: 'Studio' });
    await openTank(page, { e2e: true });

    await page
      .getByRole('navigation', { name: 'Actions' })
      .getByRole('button', { name: 'Photo' })
      .click();
    const bar = page.getByRole('group', { name: 'Photo mode' });
    await expect(bar).toBeVisible();
    const tools = page.getByRole('region', { name: 'Photo controls' });
    await expect(tools).toBeVisible();

    await tools.getByRole('radio', { name: 'Black and white' }).check();
    await expect(tools.getByRole('radio', { name: 'Black and white' })).toBeChecked();
    await tools.getByRole('checkbox', { name: 'Freeze the fish' }).check();
    await expect(tools.getByRole('checkbox', { name: 'Freeze the fish' })).toBeChecked();

    const forward = tools.getByRole('button', { name: 'Move forward' });
    const box = await forward.boundingBox();
    if (!box) throw new Error('the Move forward pad button has no box on screen');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(500);
    await page.mouse.up();

    await bar.getByRole('button', { name: 'Hide controls' }).click();
    await expect(bar.getByRole('button', { name: 'Show controls' })).toBeVisible();
    await bar.getByRole('button', { name: 'Show controls' }).click();

    await bar.getByRole('button', { name: 'Take photo' }).click();
    const result = page.getByRole('dialog', { name: 'Your photo' });
    await expect(result).toBeVisible({ timeout: 60_000 });
    await expect(
      result.getByRole('img', { name: 'The picture you just took of your tank.' }),
    ).toBeVisible();

    const download = page.waitForEvent('download');
    await result.getByRole('button', { name: 'Save picture' }).click();
    expect((await download).suggestedFilename()).toMatch(/\.(png|jpe?g|webp)$/);
    await expect(result.getByRole('status')).toContainText('Saved to your downloads.');

    await result.getByRole('button', { name: 'Keep shooting' }).click();
    await expect(result).toBeHidden();
    await expect(bar).toBeVisible();

    await bar.getByRole('button', { name: 'Exit' }).click();
    await expect(bar).toBeHidden();
    await expect(tools).toBeHidden();
  });

  test('Escape leaves photo mode', async ({ page }) => {
    test.setTimeout(420_000);
    await registerVerifiedUser(page, 'photoesc');
    await createTank(page, { name: 'Studio' });
    await openTank(page);
    await page
      .getByRole('navigation', { name: 'Actions' })
      .getByRole('button', { name: 'Photo' })
      .click();
    const bar = page.getByRole('group', { name: 'Photo mode' });
    await expect(bar).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(bar).toBeHidden();
  });
});

test.describe('away replay', () => {
  test('a long absence can be watched back, caption by caption', async ({ page }) => {
    test.setTimeout(420_000);
    await registerVerifiedUser(page, 'replay');
    await openTank(page);
    await createFirstTank(page);
    await openDock(page, 'Shop', 'Fish shop');
    await page.getByLabel('Name for the new fish').fill('Biscuit');
    await page.getByRole('button', { name: 'Add', exact: true }).first().click();
    await expect(page.getByRole('region', { name: 'Fish in bags' })).toContainText('Biscuit');

    await advanceServerClock(page, THIRTY_DAYS_IN_MINUTES);
    await returnToTab(page, THIRTY_DAYS_IN_MINUTES);

    const away = page.getByRole('dialog', { name: 'We are sorry' });
    await expect(away).toBeVisible();
    await away.getByRole('button', { name: 'Watch what happened' }).click();

    const replay = page.getByRole('region', { name: 'Away replay' });
    await expect(
      replay.getByRole('heading', { name: 'What happened while you were away' }),
    ).toBeVisible();
    const scrub = replay.getByLabel('Scrub the replay');
    await expect(scrub).toBeVisible({ timeout: 30_000 });
    const events = Number(await scrub.getAttribute('max'));
    expect(events, 'the replay has events to show').toBeGreaterThan(0);

    await scrub.fill(String(events));
    const captions = replay.getByRole('list', { name: 'Captions' });
    await expect(captions.getByRole('listitem')).toHaveCount(events);
    await expect(captions).toContainText('Biscuit');

    await replay.getByRole('button', { name: 'Skip replay' }).focus();
    await page.keyboard.press('Enter');
    await expect(replay).toBeHidden();
  });

  test('a quiet absence has a calm welcome-back and nothing is lost', async ({ page }) => {
    test.setTimeout(420_000);
    await registerVerifiedUser(page, 'quiet');
    const tank = await createTank(page, { name: 'Calm' });
    await addFish(page, tank.id, 'neon-tetra', { name: 'Ada' });
    await openTank(page);

    await advanceServerClock(page, 3 * 60);
    await returnToTab(page, 3 * 60);
    const away = page.getByRole('dialog', { name: 'Welcome back' });
    await expect(away).toContainText('You were away for 3 hours.');
    await expect(away).toContainText('Everyone is still alive.');
    await away.getByRole('button', { name: 'Continue' }).click();
    await expect(away).toBeHidden();
  });
});

test.describe('time of day and night', () => {
  test('the lighting button cycles automatic, day and night, and the choice is kept', async ({
    page,
  }) => {
    test.setTimeout(420_000);
    await registerVerifiedUser(page, 'daynight');
    await createTank(page, { name: 'Window' });
    await openTank(page);

    await expect(lighting(page)).toHaveAttribute(
      'aria-label',
      'Lighting: automatic. Switch to day',
    );
    await lighting(page).click();
    await expect(lighting(page)).toHaveAttribute('aria-label', 'Lighting: day. Switch to night');
    await expect(statusCard(page)).toHaveAttribute('aria-label', /, day$/);
    await expect(page.getByText('Lighting set to day')).toBeAttached();

    await lighting(page).click();
    await expect(lighting(page)).toHaveAttribute(
      'aria-label',
      'Lighting: night. Switch to automatic',
    );
    await expect(statusCard(page)).toHaveAttribute('aria-label', /, night$/);

    await openTank(page);
    await expect(lighting(page)).toHaveAttribute(
      'aria-label',
      'Lighting: night. Switch to automatic',
    );
    await expect(statusCard(page)).toHaveAttribute('aria-label', /, night$/);

    await lighting(page).click();
    await expect(lighting(page)).toHaveAttribute(
      'aria-label',
      'Lighting: automatic. Switch to day',
    );
  });
});
