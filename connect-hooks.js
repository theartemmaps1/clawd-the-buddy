'use strict';
// Adds Clawd's hooks to Claude Code's settings.json without touching anything else in it.
// Safe to run twice: events that already point at Clawd are left alone. The file is backed up
// first, and a settings.json that is not valid JSON is never modified.
const fs = require('fs');
const os = require('os');
const path = require('path');

const EVENTS = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
  'PermissionRequest', 'Notification', 'SubagentStart', 'SubagentStop', 'PreCompact',
  'Stop', 'StopFailure', 'SessionEnd',
];

const defaultSettingsPath = () => path.join(os.homedir(), '.claude', 'settings.json');

const entryFor = (url) => ({ hooks: [{ type: 'http', url, timeout: 2 }] });

// True if any hook already registered for this event posts to the given url.
function hasUrl(list, url) {
  return Array.isArray(list) && list.some((g) => g && Array.isArray(g.hooks) && g.hooks.some((h) => h && h.url === url));
}

// Returns { ok, added, already, backup, file, error }.
function connect({ port = 8787, file = defaultSettingsPath() } = {}) {
  const url = `http://127.0.0.1:${port}/event`;
  let settings = {};
  let existed = false;
  try {
    const raw = fs.readFileSync(file, 'utf8');
    existed = true;
    if (raw.trim()) settings = JSON.parse(raw);
  } catch (e) {
    if (e.code !== 'ENOENT') return { ok: false, file, error: `Could not read settings.json: ${e.message}` };
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    return { ok: false, file, error: 'settings.json is not a JSON object, so it was left alone.' };
  }
  if (settings.hooks !== undefined && (typeof settings.hooks !== 'object' || settings.hooks === null || Array.isArray(settings.hooks))) {
    return { ok: false, file, error: 'The "hooks" entry in settings.json is not an object, so it was left alone.' };
  }
  settings.hooks = settings.hooks || {};

  let added = 0;
  let already = 0;
  for (const ev of EVENTS) {
    const list = settings.hooks[ev];
    if (list !== undefined && !Array.isArray(list)) return { ok: false, file, error: `"${ev}" in settings.json is not a list, so it was left alone.` };
    if (hasUrl(list, url)) { already++; continue; }
    settings.hooks[ev] = [...(list || []), entryFor(url)];
    added++;
  }
  if (added === 0) return { ok: true, added, already, file };

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let backup;
    if (existed) {
      backup = `${file}.clawd-backup-${Date.now()}`;
      fs.copyFileSync(file, backup);
    }
    const tmp = `${file}.clawd-tmp`;
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
    fs.renameSync(tmp, file);
    return { ok: true, added, already, file, backup };
  } catch (e) {
    return { ok: false, file, error: `Could not write settings.json: ${e.message}` };
  }
}

// Removes every hook that posts to Clawd's address and leaves all other settings and hooks alone.
// Returns { ok, removed, backup, file, error }.
function disconnect({ port = 8787, file = defaultSettingsPath() } = {}) {
  const url = `http://127.0.0.1:${port}/event`;
  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return { ok: true, removed: 0, file };
    return { ok: false, file, error: `Could not read settings.json: ${e.message}` };
  }
  if (!settings || typeof settings !== 'object' || !settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) {
    return { ok: true, removed: 0, file };
  }
  let removed = 0;
  for (const ev of Object.keys(settings.hooks)) {
    const list = settings.hooks[ev];
    if (!Array.isArray(list)) continue;
    const kept = [];
    for (const group of list) {
      if (!group || !Array.isArray(group.hooks)) { kept.push(group); continue; }
      const rest = group.hooks.filter((h) => !(h && h.url === url));
      removed += group.hooks.length - rest.length;
      if (rest.length) kept.push({ ...group, hooks: rest });
    }
    if (kept.length) settings.hooks[ev] = kept; else delete settings.hooks[ev];
  }
  if (removed === 0) return { ok: true, removed, file };
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  try {
    const backup = `${file}.clawd-backup-${Date.now()}`;
    fs.copyFileSync(file, backup);
    const tmp = `${file}.clawd-tmp`;
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
    fs.renameSync(tmp, file);
    return { ok: true, removed, file, backup };
  } catch (e) {
    return { ok: false, file, error: `Could not write settings.json: ${e.message}` };
  }
}

module.exports = { connect, disconnect, EVENTS, defaultSettingsPath };
