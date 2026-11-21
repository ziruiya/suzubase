const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const { test } = require('node:test');
const { chromium } = require('playwright');
const { browserFixture } = require('../../packages/db/test/browser-fixture.cjs');

const origin = process.env.TEST_WEB_URL ?? 'http://127.0.0.1:5173';

async function enter(page, identity) {
  await page.goto(origin);
  await page.getByLabel('Email or login name').fill(identity.email);
  await page.getByLabel('Password').fill(identity.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('button', { name: /Orders/ }).click();
  await page.getByRole('button', { name: 'Record 1', exact: true }).waitFor();
}

async function checkWidth(page) {
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'page should fit without horizontal scrolling');
}

async function directory(page) {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const database = indexedDB.open('suzubase-drafts', 1);
    database.onsuccess = () => {
      const connection = database.result;
      const result = connection.transaction('drafts', 'readonly').objectStore('drafts').getAll();
      result.onsuccess = () => { connection.close(); resolve(result.result); };
      result.onerror = () => { connection.close(); reject(result.error); };
    };
    database.onerror = () => reject(database.error);
  }));
}

async function backend(page, token, path, method, body) {
  const result = await page.request.fetch(origin + '/api' + path, {
    method, data: body, headers: { Authorization: 'Bearer ' + token },
  });
  assert.ok(result.ok(), await result.text());
  return result.json();
}

test('G1-13 Chromium viewports, field ACL, date controls, upload retry and draft recovery', async (t) => {
  const fixture = process.env.GATE1_UI_FIXTURE
    ? JSON.parse(await readFile(process.env.GATE1_UI_FIXTURE, 'utf8')) : await browserFixture();
  const { owner, viewer, app, token, sample, aclPublished, fields } = fixture;
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
  });
  try {
    for (const width of [320, 375, 390, 1280]) {
      const page = await browser.newPage({ viewport: { width, height: 780 }, hasTouch: width < 640 });
      page.setDefaultTimeout(5000);
      try {
        await enter(page, owner);
        await checkWidth(page);
        await page.getByRole('button', { name: 'Record 1', exact: true }).click();
        await page.getByRole('heading', { name: 'Record 1', exact: true }).waitFor();
        assert.match(await page.locator('.record-values').innerText(), /Second line/);
        await checkWidth(page);
        await page.getByRole('button', { name: 'Move to recycle bin' }).click();
        await page.getByText('Move record 1 from Active to Recycle bin?', { exact: true }).waitFor();
        await page.getByRole('button', { name: 'Cancel' }).click();

        await page.getByRole('button', { name: 'Edit', exact: true }).click();
        const note = page.getByLabel('note', { exact: true });
        await note.waitFor();
        await note.focus();
        assert.equal(await note.evaluate((element) => element.matches(':focus-visible')), true);
        assert.equal(await page.getByLabel('date', { exact: true }).getAttribute('type'), 'date');
        assert.equal(await page.getByLabel('time', { exact: true }).getAttribute('type'), 'time');
        assert.equal(await page.getByLabel('datetime', { exact: true }).getAttribute('type'), 'datetime-local');
        assert.match(await page.getByLabel('datetime', { exact: true }).inputValue(), /^2026-11-21T10:30/);
        await checkWidth(page);
        await page.getByRole('button', { name: 'Save to server' }).waitFor();
        assert.equal(await page.locator('.save-bar').evaluate((element) => getComputedStyle(element).position), 'sticky');
        t.diagnostic(JSON.stringify({ width, list: 'pass', detail: 'pass', edit: 'pass', wrap: 'pass',
          nativeInputTypes: 'pass', confirmation: 'pass', focus: 'pass', saveBar: 'sticky' }));

        if (width === 375) {
          const draftValue = sample.data[fields.note.fieldId] + '\nDraft example';
          await note.fill(draftValue);
          await page.getByRole('button', { name: 'Save local draft' }).click();
          await page.getByText('Draft saved on this device', { exact: true }).waitFor();
          const drafts = await directory(page);
          assert.equal(drafts.length, 1);
          assert.deepEqual(JSON.parse(drafts[0].key), [owner.tenantId, owner.userId, app.id, sample.id, aclPublished.publishedSchemaVersion]);
          assert.equal(drafts[0].values[fields.note.fieldId], draftValue);
          const path = '/apps/' + app.id;
          await backend(page, token, path + '/fields', 'POST', { name: 'Later', code: 'later', type: 'text' });
          await backend(page, token, path + '/publish', 'POST');
          await page.getByRole('button', { name: 'Applications', exact: true }).click();
          await page.getByRole('button', { name: /Orders/ }).click();
          await page.getByRole('button', { name: 'Record 1', exact: true }).click();
          await page.getByRole('button', { name: 'Edit', exact: true }).click();
          await page.getByText(/Form version changed/).waitFor();
          await page.getByRole('button', { name: 'Recover draft' }).click();
          assert.equal(await page.getByLabel('note', { exact: true }).inputValue(), draftValue);
          await backend(page, token, path + '/records/' + sample.id, 'PUT', {
            revision: sample.revision, data: { ...sample.data, [fields.secret.fieldId]: 'Changed on server' },
          });
          await page.getByRole('button', { name: 'Save to server' }).click();
          await page.getByRole('region', { name: 'Record version conflict' }).waitFor();
          assert.match(await page.getByRole('region', { name: 'Record version conflict' }).innerText(), /Server revision 2/);
          await page.getByRole('button', { name: 'Copy my changes onto the latest version' }).click();
          assert.equal(await page.getByLabel('secret', { exact: true }).inputValue(), 'Changed on server');
          await page.getByRole('button', { name: 'Save to server' }).click();
          await page.getByRole('heading', { name: 'Record 1', exact: true }).waitFor();
          assert.equal((await directory(page)).length, 0);
          t.diagnostic('IndexedDB tuple, version warning, field merge on conflict and cleanup after server save passed');
        }

        if (width === 390) {
          await page.route('**/files?*', (route) => route.fulfill({ status: 503, json: { message: 'Simulated retry' } }), { times: 1 });
          await page.getByLabel('attachment', { exact: true }).setInputFiles({
            name: 'test.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n%%EOF\n'),
          });
          await page.getByText('test.pdf · Simulated retry').waitFor();
          await page.getByRole('button', { name: 'Save to server' }).click();
          await page.getByText('Retry or discard pending attachments before saving.').waitFor();
          await page.getByRole('button', { name: 'Retry upload' }).click();
          await page.getByText('Attachment 1', { exact: true }).waitFor();
          await page.getByRole('button', { name: 'Save to server' }).click();
          await page.getByRole('button', { name: 'Download attachment 1' }).waitFor();
          t.diagnostic('Upload interruption simulation, protected save, retry and readable attachment passed');
        }
      } finally {
        await page.close();
      }
    }

    const page = await browser.newPage({ viewport: { width: 320, height: 780 }, hasTouch: true });
    await enter(page, viewer);
    assert.equal(await page.getByRole('button', { name: 'Settings' }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'New record' }).count(), 0);
    assert.equal(await page.getByText('Changed on server').count(), 0);
    await page.route('**/records/*/form', (route) => route.fulfill({
      status: 403, json: { message: 'Hidden content marker' },
    }), { times: 1 });
    await page.getByRole('button', { name: 'Record 1', exact: true }).click();
    await page.getByText('无权限', { exact: true }).waitFor();
    assert.equal(await page.getByText('Hidden content marker').count(), 0);
    t.diagnostic('Mobile ordinary user saw no management entry, hidden field content, or permission-error details');
    await page.close();
  } finally {
    await browser.close();
  }
});
