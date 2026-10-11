const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { apply } = require('./install-options');

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'clawd-io-')), 'install-options.json');

test('applies both choices once and deletes the file', () => {
  const file = tmp();
  fs.writeFileSync(file, JSON.stringify({ startWithWindows: true, connectClaudeCode: true }));
  const calls = [];
  const r = apply({ file, port: 8787, connectHooks: (o) => { calls.push(['hooks', o.port]); return { ok: true }; }, setStartup: (v) => calls.push(['startup', v]) });
  assert.deepStrictEqual(calls, [['startup', true], ['hooks', 8787]]);
  assert.strictEqual(r.applied, true);
  assert.strictEqual(fs.existsSync(file), false);
  assert.strictEqual(apply({ file, port: 8787, connectHooks: () => assert.fail(), setStartup: () => assert.fail() }).applied, false);
});

test('does nothing for choices left unticked', () => {
  const file = tmp();
  fs.writeFileSync(file, JSON.stringify({ startWithWindows: false, connectClaudeCode: false }));
  apply({ file, port: 1, connectHooks: () => assert.fail(), setStartup: () => assert.fail() });
});

test('a broken file is ignored and removed', () => {
  const file = tmp();
  fs.writeFileSync(file, 'garbage');
  assert.strictEqual(apply({ file, port: 1, connectHooks: () => assert.fail(), setStartup: () => assert.fail() }).applied, false);
  assert.strictEqual(fs.existsSync(file), false);
});

test('a failing action does not stop the other one', () => {
  const file = tmp();
  fs.writeFileSync(file, JSON.stringify({ startWithWindows: true, connectClaudeCode: true }));
  let hooked = false;
  const r = apply({ file, port: 1, connectHooks: () => { hooked = true; return { ok: true }; }, setStartup: () => { throw new Error('nope'); } });
  assert.strictEqual(hooked, true);
  assert.strictEqual(r.startWithWindows, false);
});
