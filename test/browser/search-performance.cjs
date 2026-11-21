const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const { chromium } = require('playwright');

const origin = process.env.TEST_WEB_URL ?? 'http://127.0.0.1:5173';
const calculateP95 = (values) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];

async function main() {
  const fixture = JSON.parse(await readFile(process.env.GATE1_SEARCH_FIXTURE, 'utf8'));
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(origin);
    await page.getByLabel('Email or login name').fill(fixture.reader.email);
    await page.getByLabel('Password').fill(fixture.reader.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByRole('button', { name: /Orders/ }).click();
    await page.getByText('80000 records', { exact: true }).waitFor();
    async function search(mode, value, expectedRecord, count) {
      await page.locator('select[name=mode]').selectOption(mode);
      const response = page.waitForResponse((result) => result.url().includes('/records/search?'));
      const start = performance.now();
      await page.getByLabel('Search value').fill(value);
      await page.getByRole('button', { name: 'Search', exact: true }).click();
      const result = await response;
      assert.equal(result.status(), 200);
      const output = await result.json();
      assert.equal(Number(output.count), count);
      assert.ok(output.items.every(({ data }) => data[fixture.marker.fieldId] === undefined));
      assert.ok(Number.isFinite(output.databaseRoundTripMs), 'Start the API with SEARCH_TIMING=1');
      const actionable = expectedRecord === null ? page.getByRole('heading', { name: 'No records found' })
        : page.getByRole('button', { name: 'Record ' + expectedRecord, exact: true });
      await actionable.waitFor();
      return { browserMs: performance.now() - start, databaseMs: output.databaseRoundTripMs };
    }

    const stats = {};
    for (const mode of ['exact', 'tail']) {
      const samples = [];
      let attempted = 0;
      for (let number = 81; samples.length < 40; number++) {
        if (number % 5 === 0) continue;
        const value = mode === 'exact' ? '090' + String(number + 50000).padStart(8, '0') : String(number).padStart(4, '0');
        const hit = mode === 'exact' ? number + 50000 : number;
        const result = await search(mode, value, hit, mode === 'exact' ? 1 : 10);
        if (++attempted > 5) samples.push(result);
      }
      const browserP95Ms = calculateP95(samples.map(({ browserMs }) => browserMs));
      const databaseP95Ms = calculateP95(samples.map(({ databaseMs }) => databaseMs));
      stats[mode] = { samples: samples.length, warmups: 5, browserP95Ms, databaseP95Ms, targetMet: browserP95Ms <= 500 };
    }
    await search('exact', '090' + '50000'.padStart(8, '0'), null, 0);
    await search('tail', '0100', null, 0);
    console.log(JSON.stringify({
      records: 100000, visible: 80000, hiddenParityChecks: '0 exact hits, 0 suffix hits', ...stats, explain: fixture.explain,
    }, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
