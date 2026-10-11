// Run by the uninstaller: ELECTRON_RUN_AS_NODE=1 Clawd.exe disconnect-hooks.js
// Takes Clawd's hooks back out of Claude Code's settings.json (a backup is kept).
const { disconnect } = require('./connect-hooks');
const r = disconnect({ port: Number(process.env.BUDDY_PORT || 8787) });
process.exit(r.ok ? 0 : 1);
