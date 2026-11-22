const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const { test } = require('node:test');
const { chromium } = require('playwright');
const { gate2BrowserFixture } = require('../../packages/db/test/gate2-browser-fixture.cjs');

const origin = process.env.TEST_WEB_URL ?? 'http://127.0.0.1:5173';

async function checkWidth(page) {
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    'page should fit without horizontal scrolling');
}

async function enter(page, identity) {
  await page.goto(origin);
  await page.getByLabel('Email or login name').fill(identity.email);
  await page.getByLabel('Password').fill(identity.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('button', { name: /Gate2 checks/ }).click();
  await page.getByRole('button', { name: 'Record 1', exact: true }).waitFor();
}

async function openRecord(page) {
  await page.getByRole('button', { name: 'Record 1', exact: true }).click();
  await page.getByRole('heading', { name: 'Record 1', exact: true }).waitFor();
}

test('G2-14 Chromium Gate 2 surfaces at 320/375/390: subtable cards, full-screen reference picker, workflow confirm, comments, notifications, tasks', async (t) => {
  const fixture = process.env.GATE2_UI_FIXTURE
    ? JSON.parse(await readFile(process.env.GATE2_UI_FIXTURE, 'utf8')) : await gate2BrowserFixture();
  const { owner } = fixture;
  assert.equal(fixture.delivered, 1);
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
  try {
    for (const width of [320, 375, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 780 }, hasTouch: true });
      page.setDefaultTimeout(8000);
      try {
        await enter(page, owner);
        await checkWidth(page);
        await openRecord(page);
        await checkWidth(page);

        // Subtable row card: expand and edit in the record form.
        await page.getByRole('button', { name: 'Edit', exact: true }).click();
        const summary = page.locator('details.panel summary', { hasText: 'Row 1' }).first();
        await summary.click();
        const qty = page.getByLabel(/Qty/).first();
        await qty.fill('3');
        assert.equal(await qty.inputValue(), '3');
        await checkWidth(page);

        // Reference picker fills the viewport on mobile, searches, cancels.
        await page.getByRole('button', { name: 'Select reference record' }).click();
        const dialog = page.getByRole('dialog', { name: 'Select reference record' });
        await dialog.waitFor();
        const box = await dialog.boundingBox();
        assert.ok(box && Math.abs(box.width - width) <= 1 && Math.abs(box.height - 780) <= 2,
          'reference picker should fill the viewport, got ' + JSON.stringify(box));
        await page.getByLabel('Search by reference key').fill('K1');
        await page.getByRole('button', { name: 'Search', exact: true }).click();
        await page.getByRole('button', { name: 'Select K1' }).waitFor();
        await checkWidth(page);
        await dialog.getByRole('button', { name: 'Cancel' }).click();
        await dialog.waitFor({ state: 'hidden' });

        await page.getByRole('button', { name: 'Save to server' }).click();
        await page.getByRole('heading', { name: 'Record 1', exact: true }).waitFor();
        await checkWidth(page);
        t.diagnostic(JSON.stringify({ width, subtableCard: 'pass', referencePicker: 'full-screen pass' }));

        if (width === 320) {
          // Workflow action from the sticky bar, confirm dialog names record + from→to.
          const bar = page.locator('.workflow-actions');
          assert.equal(await bar.evaluate((element) => getComputedStyle(element).position), 'sticky');
          await page.getByRole('button', { name: 'Approve step' }).click();
          const confirm = page.getByRole('dialog', { name: 'Confirm workflow action' });
          await confirm.waitFor();
          assert.match(await confirm.innerText(), /Record 1 · Open → Review/);
          const confirmBox = await confirm.boundingBox();
          assert.ok(confirmBox && confirmBox.x >= 0 && confirmBox.x + confirmBox.width <= width,
            'workflow confirm dialog must stay inside the viewport');
          await checkWidth(page);
          await page.getByRole('button', { name: 'Confirm Approve step' }).click();
          await page.getByRole('heading', { name: 'Review', exact: true }).waitFor();
          t.diagnostic('320px workflow sticky bar + confirm dialog (Record 1 · Open → Review) passed');
        }

        if (width === 375) {
          await page.getByRole('textbox', { name: 'Comment' }).fill('Mobile comment');
          await page.getByRole('button', { name: 'Post comment' }).click();
          await page.getByText('Mobile comment', { exact: true }).waitFor();
          await page.getByRole('button', { name: 'Delete comment' }).click();
          await page.getByRole('button', { name: 'Confirm delete comment' }).click();
          await page.getByText('Comment deleted', { exact: true }).waitFor();
          await checkWidth(page);
          t.diagnostic('375px comment post + delete placeholder passed');
        }

        if (width === 390) {
          await page.getByRole('button', { name: /Notifications, \d+ unread/ }).click();
          await page.getByRole('heading', { name: 'Notifications' }).waitFor();
          await page.getByText('Created Mobile record', { exact: true }).waitFor();
          assert.ok(await page.getByText('Unread', { exact: true }).count() >= 1);
          await page.getByRole('button', { name: 'Open record' }).first().click();
          await page.getByRole('heading', { name: 'Record 1', exact: true }).waitFor();
          await page.getByRole('button', { name: 'SuzuBase' }).click();
          await page.getByRole('button', { name: 'My tasks' }).click();
          await page.getByRole('button', { name: /Gate2 checks · Record 1 · Review/ }).click();
          await page.getByRole('heading', { name: 'Record 1', exact: true }).waitFor();
          await checkWidth(page);
          t.diagnostic('390px notification centre open + My tasks navigation passed');
        }
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
});
