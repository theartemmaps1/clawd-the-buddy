const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { check, remember } = require('./hook-guard');

function listen() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => { res.writeHead(check(req, server.address().port) || 200); res.end(); });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function send(port, { method = 'POST', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/event', method, headers }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end(method === 'POST' ? '{}' : undefined);
  });
}

test('request guard', async (t) => {
  const server = await listen();
  t.after(() => server.close());
  const port = server.address().port;
  const json = { 'content-type': 'application/json' };

  await t.test('a plain hook post is let through', async () => {
    assert.strictEqual(await send(port, { headers: json }), 200);
    assert.strictEqual(await send(port, { headers: { 'content-type': 'application/json; charset=utf-8' } }), 200);
  });
  await t.test('no content type is let through (the Origin check covers browsers)', async () => {
    assert.strictEqual(await send(port), 200);
  });
  await t.test('a browser post (Origin set) is refused, even with a simple content type', async () => {
    assert.strictEqual(await send(port, { headers: { origin: 'https://evil.example', 'content-type': 'text/plain' } }), 403);
    assert.strictEqual(await send(port, { headers: { origin: 'null' } }), 403);
  });
  await t.test('a rebinding host name is refused', async () => {
    assert.strictEqual(await send(port, { headers: { ...json, host: `evil.example:${port}` } }), 403);
    assert.strictEqual(await send(port, { headers: { ...json, host: 'localhost' } }), 403);
  });
  await t.test('localhost is fine', async () => {
    assert.strictEqual(await send(port, { headers: { ...json, host: `localhost:${port}` } }), 200);
  });
  await t.test('a non-JSON content type is refused', async () => {
    assert.strictEqual(await send(port, { headers: { 'content-type': 'text/plain' } }), 415);
    assert.strictEqual(await send(port, { headers: { 'content-type': 'application/jsonx' } }), 415);
  });
});

test('remember keeps a map small and drops the oldest', () => {
  const m = new Map();
  for (let i = 0; i < 10; i++) remember(m, 's' + i, i, 4);
  assert.deepStrictEqual([...m.keys()], ['s6', 's7', 's8', 's9']);
  remember(m, 's6', 'again', 4); // a live session moves to the back
  remember(m, 's10', 10, 4);
  assert.deepStrictEqual([...m.keys()], ['s8', 's9', 's6', 's10']);
});
