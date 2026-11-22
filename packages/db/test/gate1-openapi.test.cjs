const assert = require('node:assert/strict');
const test = require('node:test');

test('GF-11 Gate 1 OpenAPI documents live request, query, and response contracts', async (t) => {
  const response = await fetch(new URL('/docs-json', process.env.TEST_API_URL ?? 'http://api:3000'));
  assert.equal(response.status, 200);
  const { paths } = await response.json();
  const methods = ['get', 'post', 'put', 'patch', 'delete'];
  const operations = Object.entries(paths).flatMap(([path, item]) =>
    methods.filter((method) => item[method]).map((method) => ({ path, method, ...item[method] })));
  assert.ok(operations.length >= 60);
  for (const { path, method, responses, parameters } of operations) {
    const successful = Object.entries(responses).filter(([status]) => /^2\d\d$/.test(status));
    assert.equal(successful.length, 1, method + ' ' + path);
    for (const { content } of Object.values(responses)) {
      assert.ok(content && Object.values(content).every(({ schema }) => Object.keys(schema).length > 0), method + ' ' + path);
    }
    for (const match of path.matchAll(/\{([^}]+)\}/g)) {
      // Gate 2 correction: `version` is a legitimately integer workflow version
      // number whose schema carries type 'integer' and no format (see
      // GATE2-REPORT.md); every other path parameter is a uuid.
      assert.ok(parameters.some((parameter) => parameter.name === match[1] && parameter.in === 'path' &&
        parameter.required && (match[1] === 'version'
          ? parameter.schema.type === 'integer'
          : parameter.schema.format === 'uuid')), path);
    }
  }
  const getSchema = (operation, status, media = 'application/json') => operation.responses[status].content[media].schema;
  const root = '/apps/{appId}';
  const record = root + '/records/{recordId}';
  const login = paths['/auth/login'].post;
  assert.ok(login.requestBody.content['application/json'].schema.properties.factor);
  assert.ok(getSchema(login, '200').anyOf.some(({ properties }) => properties.secondFactorRequired));
  const publish = paths[root + '/publish'].post;
  assert.equal(publish.requestBody.required, false);
  assert.ok(getSchema(publish, '409').properties.problems);
  const update = paths[root + '/records/batch'].patch;
  assert.deepEqual(update.requestBody.content['application/json'].schema.required, ['fieldId', 'value', 'items']);
  assert.ok(getSchema(update, '200').properties.results);
  assert.ok(paths[record + '/history/export'].get.parameters.some(({ name }) => name === 'includeArchived'));
  assert.equal(getSchema(paths[root + '/csv/export'].get, '200', 'application/zip').format, 'binary');
  assert.ok(getSchema(paths[root + '/tokens'].post, '201').properties.token);
  assert.equal(getSchema(paths[root + '/tokens'].get, '200').items.properties.token, undefined);
  // Gate 2 routes carry complete contracts too.
  for (const gate2Path of [root + '/workflow/publish', root + '/workflow/versions/{version}',
    record + '/workflow/repair', record + '/workflow/history', '/workflow/tasks',
    record + '/lookups/{fieldId}/refresh', record + '/comments', '/notifications']) {
    assert.ok(paths[gate2Path], gate2Path);
  }
  assert.ok(getSchema(paths[root + '/workflow/publish'].post, '201').properties);
  assert.ok(getSchema(paths['/workflow/tasks'].get, '200').properties.items);
  const preflightSchema = getSchema(paths[root + '/csv/preflight'].post, '201');
  assert.ok(preflightSchema.properties.eligibleRows && preflightSchema.properties.importedRows);
  t.diagnostic(operations.length + ' live operations with response schemas');
});
