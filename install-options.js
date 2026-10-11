// The setup wizard drops install-options.json in the app's data folder with the choices made on
// its "How should Clawd behave?" page. The first time Clawd runs he applies them, then deletes the file.
const fs = require('fs');

function apply({ file, port, connectHooks, setStartup }) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return { applied: false }; }
  try { fs.unlinkSync(file); } catch {} // one shot, even if something below goes wrong
  let o;
  try { o = JSON.parse(raw); } catch { return { applied: false }; }
  if (!o || typeof o !== 'object') return { applied: false };
  const done = { applied: true };
  if (o.startWithWindows === true) {
    try { setStartup(true); done.startWithWindows = true; } catch { done.startWithWindows = false; }
  }
  if (o.connectClaudeCode === true) {
    try { done.connectClaudeCode = connectHooks({ port }).ok; } catch { done.connectClaudeCode = false; }
  }
  return done;
}

module.exports = { apply };
