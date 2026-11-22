const assert = require('node:assert/strict');
const { test } = require('node:test');

test('P2-M3 kintone source safety and field mapping are explicit', async () => {
  const { validateKintoneDomain, mapKintoneField } = await import('../../../apps/api/dist/kintone-import.js');
  assert.equal(validateKintoneDomain('https://example.cybozu.com', 'example.cybozu.com'), 'https://example.cybozu.com');
  assert.throws(() => validateKintoneDomain('http://example.cybozu.com', 'example.cybozu.com'), /HTTPS/);
  assert.throws(() => validateKintoneDomain('https://127.0.0.1', '127.0.0.1'), /public origin/);
  assert.throws(() => validateKintoneDomain('https://evil.example', 'example.cybozu.com'), /allowlisted/);

  const calc = mapKintoneField({ code: 'total', type: 'CALC', expression: 'SUM(qty)' });
  assert.equal(calc.status, 'UNRESOLVED');
  assert.equal(calc.targetType, 'calculation');
  assert.equal(mapKintoneField({ code: 'category', type: 'CATEGORY' }).status, 'UNSUPPORTED');
  assert.equal(mapKintoneField({ code: 'owner', type: 'USER_SELECT' }).status, 'UNRESOLVED');
  assert.equal(mapKintoneField({ code: 'title', type: 'SINGLE_LINE_TEXT' }).status, 'EQUIVALENT');
  assert.equal(mapKintoneField({ code: 'mystery', type: 'NEW_TYPE' }).status, 'UNSUPPORTED');
});
