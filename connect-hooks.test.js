'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { connect, disconnect, EVENTS } = require('./connect-hooks');

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'clawd-')), '.claude', 'settings.json');
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

test('creates settings.json when there is none', () => {
  const file = tmpFile();
  const r = connect({ file });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.added, EVENTS.length);
  assert.strictEqual(read(file).hooks.Stop[0].hooks[0].url, 'http://127.0.0.1:8787/event');
});

test('keeps other settings and existing hooks, and makes a backup', () => {
  const file = tmpFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const mine = { model: 'x', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] } };
  fs.writeFileSync(file, JSON.stringify(mine));
  const r = connect({ file });
  assert.strictEqual(r.ok, true);
  assert.ok(r.backup && fs.existsSync(r.backup));
  const out = read(file);
  assert.strictEqual(out.model, 'x');
  assert.strictEqual(out.hooks.Stop.length, 2);
  assert.strictEqual(out.hooks.Stop[0].hooks[0].command, 'echo hi');
});

test('running twice adds nothing the second time', () => {
  const file = tmpFile();
  connect({ file });
  const r = connect({ file });
  assert.strictEqual(r.added, 0);
  assert.strictEqual(r.already, EVENTS.length);
  assert.strictEqual(read(file).hooks.Stop.length, 1);
});

test('never touches a settings.json that is not valid JSON', () => {
  const file = tmpFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ not json');
  const r = connect({ file });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '{ not json');
});

test('refuses unexpected shapes instead of overwriting them', () => {
  const file = tmpFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ hooks: { Stop: 'nope' } }));
  assert.strictEqual(connect({ file }).ok, false);
});

test('uses a custom port', () => {
  const file = tmpFile();
  connect({ file, port: 9000 });
  assert.strictEqual(read(file).hooks.Stop[0].hooks[0].url, 'http://127.0.0.1:9000/event');
});

test('disconnect removes only Clawd hooks and keeps everything else', () => {
  const file = tmpFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ model: 'x', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] } }));
  connect({ file });
  const r = disconnect({ file });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.removed, EVENTS.length);
  assert.ok(r.backup && fs.existsSync(r.backup));
  const out = read(file);
  assert.strictEqual(out.model, 'x');
  assert.deepStrictEqual(Object.keys(out.hooks), ['Stop']);
  assert.strictEqual(out.hooks.Stop[0].hooks[0].command, 'echo hi');
});

test('disconnect drops the hooks key when nothing else is left', () => {
  const file = tmpFile();
  connect({ file });
  disconnect({ file });
  assert.strictEqual(read(file).hooks, undefined);
});

test('disconnect is harmless with no file, no hooks or bad JSON', () => {
  const none = tmpFile();
  assert.deepStrictEqual({ ok: true, removed: 0 }, (({ ok, removed }) => ({ ok, removed }))(disconnect({ file: none })));
  const bad = tmpFile();
  fs.mkdirSync(path.dirname(bad), { recursive: true });
  fs.writeFileSync(bad, '{ nope');
  assert.strictEqual(disconnect({ file: bad }).ok, false);
  assert.strictEqual(fs.readFileSync(bad, 'utf8'), '{ nope');
});
