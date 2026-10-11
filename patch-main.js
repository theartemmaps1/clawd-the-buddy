// Run once from the repo root:   node patch-main.js
// Adds everything the installer needs to main.js. Safe to run twice, and it skips any edit
// you already made by hand. A backup is saved as main.js.before-installer, and if the result
// fails `node --check` the original is put back.
const fs = require('fs');
const { execFileSync } = require('child_process');

const FILE = 'main.js';
const BACKUP = 'main.js.before-installer';
const src = fs.readFileSync(FILE, 'utf8');
const EOL = src.includes('\r\n') ? '\r\n' : '\n';
const eol = (t) => t.replace(/\n/g, EOL);
let s = src;
const done = [];
const skipped = [];

// Inserts `text` right before `anchor`, unless `marker` is already in the file.
function insertBefore(name, anchor, text, marker) {
  if (s.includes(marker)) return skipped.push(name);
  if (s.split(anchor).length !== 2) throw new Error(`Could not find a single place for "${name}" (${JSON.stringify(anchor.trim())}). Has main.js changed a lot?`);
  s = s.replace(anchor, () => eol(text) + anchor);
  done.push(name);
}
function insertAfter(name, anchor, text, marker) {
  if (s.includes(marker)) return skipped.push(name);
  if (s.split(anchor).length !== 2) throw new Error(`Could not find a single place for "${name}" (${JSON.stringify(anchor.trim())}). Has main.js changed a lot?`);
  s = s.replace(anchor, () => anchor + eol(text));
  done.push(name);
}
function replaceOnce(name, from, to, marker) {
  if (s.includes(marker)) return skipped.push(name);
  if (s.split(from).length !== 2) throw new Error(`Could not find "${name}" to change. Has main.js changed a lot?`);
  s = s.replace(from, () => to);
  done.push(name);
}

try {
  // 1. modules (each one on its own, so an earlier hand edit never causes a duplicate)
  const hookGuardLine = `const hookGuard = require('./hook-guard');${EOL}`;
  const connectOld = "const { connect: connectHooks } = require('./connect-hooks');";
  const connectNew = "const { connect: connectHooks, disconnect: disconnectHooks } = require('./connect-hooks');";
  if (s.includes(connectNew)) skipped.push('module: connect-hooks');
  else if (s.includes(connectOld)) { s = s.replace(connectOld, () => connectNew); done.push('module: connect-hooks (added disconnect)'); }
  else insertAfter('module: connect-hooks', hookGuardLine, connectNew + '\n', "require('./connect-hooks')");
  insertAfter('module: install-options', hookGuardLine, "const installOptions = require('./install-options');\n", "require('./install-options')");
  insertAfter('module: updater', hookGuardLine, "const updater = require('./updater');\n", "require('./updater')");

  // 2. the new setting
  replaceOnce('autoUpdate setting', 'pet: false, loud: true,', 'pet: false, loud: true, autoUpdate: true,', 'autoUpdate: true');

  // 3. config.json lives in resources once installed
  insertBefore('config.json location', `function loadConfig() {${EOL}`,
`// config.json: a copy in the app's data folder wins (it survives updates); otherwise the one
// that ships with the app (next to the sources when run from source, in resources when installed).
function configPath() {
  const mine = path.join(app.getPath('userData'), 'config.json');
  if (fs.existsSync(mine)) return mine;
  return path.join(app.isPackaged ? process.resourcesPath : __dirname, 'config.json');
}

`, 'function configPath()');
  replaceOnce('config.json read', "fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')", "fs.readFileSync(configPath(), 'utf8')", 'fs.readFileSync(configPath()');

  // 4. first start: apply the wizard's choices, start the update checks
  insertAfter('first start', `    startWatcher();${EOL}    startServer();${EOL}`,
`    installOptions.apply({
      file: path.join(app.getPath('userData'), 'install-options.json'),
      port: PORT,
      connectHooks,
      setStartup: (on) => app.setLoginItemSettings({ openAtLogin: on, ...loginItem() }),
    });
    updater.init({ enabled: () => settings.autoUpdate });
`, 'installOptions.apply(');

  // 5. tray menu
  const reload = `    { label: 'Reload config.json',`;
  const dlg = (extra) => `require('electron').dialog.showMessageBox({ type: r.ok ? 'info' : 'error', title: 'Clawd', message${extra} })`;
  insertBefore('menu: connect', reload,
`    {
      label: 'Connect to Claude Code',
      click: () => {
        const r = connectHooks({ port: PORT });
        const message = !r.ok ? r.error
          : r.added ? \`Connected. Added \${r.added} hook\${r.added === 1 ? '' : 's'} to \${r.file}.\\nRestart Claude Code to pick them up.\`
          : 'Already connected. Nothing to change.';
        ${dlg(', detail: r.backup ? `Your old settings were saved to ${r.backup}` : undefined')};
      },
    },
`, "'Connect to Claude Code'");
  insertBefore('menu: disconnect', reload,
`    {
      label: 'Disconnect from Claude Code',
      click: () => {
        const r = disconnectHooks({ port: PORT });
        const message = !r.ok ? r.error
          : r.removed ? \`Disconnected. Removed \${r.removed} hook\${r.removed === 1 ? '' : 's'} from \${r.file}.\\nRestart Claude Code to finish.\`
          : 'He was not connected. Nothing to change.';
        ${dlg(', detail: r.backup ? `Your old settings were saved to ${r.backup}` : undefined')};
      },
    },
`, "'Disconnect from Claude Code'");
  insertBefore('menu: updates', reload,
`    { type: 'separator' },
    { label: \`Clawd v\${app.getVersion()}\`, enabled: false },
    { label: 'Check for updates\\u2026', click: () => updater.check(true) },
    toggle('Check for updates automatically', 'autoUpdate'),
    { type: 'separator' },
`, "'Check for updates automatically'");

  if (s !== src) {
    if (!fs.existsSync(BACKUP)) fs.writeFileSync(BACKUP, src);
    fs.writeFileSync(FILE, s);
    try {
      execFileSync(process.execPath, ['--check', FILE], { stdio: 'pipe' });
    } catch (e) {
      fs.writeFileSync(FILE, src);
      console.error('The patched main.js did not pass `node --check`, so the original was put back.\n' + String(e.stderr || e.message));
      process.exit(1);
    }
  }
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

if (done.length) console.log('Added:   ' + done.join(', '));
if (skipped.length) console.log('Already there: ' + skipped.join(', '));
console.log(done.length ? `Done. Backup: ${BACKUP}` : 'Nothing to change.');
