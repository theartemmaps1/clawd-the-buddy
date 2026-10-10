const { app, BrowserWindow, Menu, Tray, clipboard, ipcMain, nativeImage, powerMonitor, screen } = require('electron');
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

// the buddy chirps without ever being clicked first
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const PORT = Number(process.env.BUDDY_PORT || 8787);
const MAX_BODY = 256 * 1024; // hook payloads can contain file contents; cap what we read

const WIN_W = 240;
const WIN_H = 280;
// The character is smaller than its window. These are the transparent margins that may hang
// off the edge of the work area so its feet, sides and head (not the window) touch the edges.
const FOOT_PAD = 28;
const SIDE_PAD = 30;
const HEAD_PAD = 130;
const BALL = 56;

const WALK_STEP = 4; // px per tick
const CHASE_STEP = 7;
const GRAVITY = 1.2; // px per tick, per tick
const MAX_THROW = 70; // px per tick

let win;
let tray;
let dragOffset = null; // cursor offset inside the window while the buddy is being carried
let dragTrail = []; // recent cursor positions while carried, to work out a throw
let home = null; // where the buddy lives; it wanders from here and comes back
let walk = null; // { x, y, tx, ty } while it is scuttling somewhere on its own
let fall = null; // { x, y, vx, vy, peak, bounces, ground } while it is in the air

// other apps' windows, top-most first, so it can land on and ride their top edges
let watcher = null;
let windows = []; // { h, l, t, r, b, zoomed } in screen DIPs: every window the helper reports
let platforms = []; // the same list while "Sit on windows" is on, otherwise empty
let perch = null; // { h, l, t } of the window it is standing on
let presence = { full: false, mic: false, app: '', seq: 0 }; // what else the helper notices
let lastApp = '';
let hiding = null; // hide and seek: { perch } to go back to

// the toy ball: its own little window with the same physics
let ballWin = null;
let ball = null; // { x, y, vx, vy, rest, restSince, thrown }
let ballDrag = null;
let ballTrail = [];
let chase = false;
let lastBat = 0;
let ticks = 0;

const settings = {
  wander: true, gravity: true, sound: true, perch: true, bed: false, bedX: 0, bedY: 0, personality: 'cheerful',
  typing: true, reminders: true, notice: true, autoQuiet: true, quiet: false,
};
const PERSONALITIES = ['cheerful', 'sarcastic', 'shy', 'dramatic'];
const settingsFile = path.join(app.getPath('userData'), 'buddy-settings.json');
let config = {}; // config.json: timings, thresholds and phrases the user can retune
// what the renderer says is unlocked and worn, for the Wardrobe menu
let wardrobe = { tasks: 0, hat: '', color: 'classic', hats: [], colors: [], extras: [] };
let badges = []; // { label, earned }, also from the renderer
let roomItems = []; // { id, label, need, unlocked, on }
let tricks = []; // { id, label, known }
let who = { name: '', code: '', friends: [], words: 0 }; // its name, its code to share, who it knows
let roomState = { on: [], plant: 0, night: false, scarf: 0 }; // what is standing in its room right now
let albumWin = null;
let pomodoro = false;
let quitting = false;
// Local dev tools, if there are any: a dev/ folder next to the app that is not part of the
// repo (see loadDev). Without it none of this does anything.
let dev = null;
let savesHeld = false; // dev sandbox: nothing it remembers is written to disk

// its room: a window of its own with the bed in it, which it walks back to when it is sleepy
const BED_W = 300;
const BED_H = 160;
const ROOM_SCALE = 5; // room.html is drawn on a 60x32 grid
// where each thing stands on that grid, so the window can be cut to their outlines
const ROOM_BOXES = {
  bed: [13, 18, 34, 14],
  rug: [6, 30, 48, 2],
  plant: [1, 12, 12, 20],
  lamp: [48, 10, 12, 22],
  poster: [20, 2, 11, 12],
  shelf: [33, 2, 14, 8],
  lights: [3, 0, 54, 4],
};
let bedWin = null;
let bedDrag = null;

// Claude Code session id -> pid of the process that sent its hooks, to find its window later
const sessionPids = new Map();
const pidTries = new Map();
const contextReadAt = new Map();
let lastSession = '';

function loadSettings() {
  try {
    const saved = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    for (const k of Object.keys(settings)) if (typeof saved[k] === typeof settings[k]) settings[k] = saved[k];
    if (!PERSONALITIES.includes(settings.personality)) settings.personality = 'cheerful';
  } catch {}
}

function saveSettings() {
  try { fs.writeFileSync(settingsFile, JSON.stringify(settings)); } catch {}
}

// ---- memory: tasks, streaks and feelings, kept in a file so they survive anything ----

const memoryFile = path.join(app.getPath('userData'), 'buddy-memory.json');
const MEMORY_KEYS = ['buddy-day', 'buddy-life', 'buddy-history', 'buddy-feel'];
let memory = {};
let memoryTimer = null;

function loadMemory() {
  // the .bak copy covers a crash in the middle of a write
  for (const file of [memoryFile, memoryFile + '.bak']) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed && typeof parsed === 'object') { memory = parsed; return; }
    } catch {}
  }
}

function flushMemory() {
  clearTimeout(memoryTimer);
  memoryTimer = null;
  if (savesHeld) return;
  try {
    const tmp = memoryFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(memory));
    if (fs.existsSync(memoryFile)) fs.copyFileSync(memoryFile, memoryFile + '.bak');
    fs.renameSync(tmp, memoryFile); // swap in whole, never a half-written file
  } catch (e) {
    console.error('could not save memory:', e.message);
  }
}

ipcMain.on('buddy-memory-load', (e) => { e.returnValue = memory; });

ipcMain.on('buddy-memory-save', (_e, key, value) => {
  if (!MEMORY_KEYS.includes(key) || !value || typeof value !== 'object') return;
  if (JSON.stringify(value).length > 200000) return;
  memory[key] = value;
  if (!memoryTimer) memoryTimer = setTimeout(flushMemory, 800);
});

function loadConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
    config = parsed && typeof parsed === 'object' ? parsed : {};
    return true;
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('config.json:', e.message);
    return e.code === 'ENOENT';
  }
}

function send(channel, data) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, data);
}

const sendSettings = () => send('buddy-settings', { ...settings, config });

function area() {
  const b = win.getBounds();
  return screen.getDisplayNearestPoint({ x: Math.round(b.x + WIN_W / 2), y: Math.round(b.y + WIN_H / 2) }).workArea;
}

const floorY = (a) => a.y + a.height - WIN_H + FOOT_PAD;
const clampX = (a, x) => Math.min(Math.max(x, a.x - SIDE_PAD), a.x + a.width - WIN_W + SIDE_PAD);

function setPos(x, y) {
  // setBounds, not setPosition: keeps the size from drifting on scaled displays
  win.setBounds({ x: Math.round(x), y: Math.round(y), width: WIN_W, height: WIN_H });
}

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();

  win = new BrowserWindow({
    width: WIN_W,
    height: WIN_H,
    x: workArea.x + workArea.width - WIN_W - 24,
    y: settings.gravity ? floorY(workArea) : workArea.y + workArea.height - WIN_H - 24,
    frame: false,
    transparent: true,
    resizable: false,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.setAlwaysOnTop(true, 'floating');
  // Transparent parts of the window let clicks through; the renderer turns this off while the
  // cursor is over the character (see trackCursor).
  win.setIgnoreMouseEvents(true, { forward: true });
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) console.error('renderer:', message);
  });
  // a file dropped as a snack must never navigate the window to it
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('did-finish-load', sendSettings);
  home = { x: win.getBounds().x, y: win.getBounds().y };
  win.on('blur', endDrag);
  win.on('closed', () => {
    if (ballWin && !ballWin.isDestroyed()) ballWin.close();
    if (bedWin && !bedWin.isDestroyed()) bedWin.close();
    if (albumWin && !albumWin.isDestroyed()) albumWin.close();
  });
  win.loadFile('index.html');
}

// ---- other windows as platforms ----

// A tiny always-running helper. It prints the visible top-level windows (top-most first)
// whenever they change, a line whenever a key goes down, and a line about the window in front:
// whether it fills the screen, whether a microphone is in use, and which program it belongs to.
// It never looks at which key, at window titles, or at anything typed.
// Sent to PowerShell on stdin as one line, so the C# must not contain single quotes or line
// comments.
const WATCH_CS = [
  'using System; using System.Text; using System.Threading; using System.Runtime.InteropServices; using Microsoft.Win32;',
  'namespace Buddy { public static class Watch {',
  'delegate bool EnumProc(IntPtr h, IntPtr l);',
  '[StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }',
  '[StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }',
  '[StructLayout(LayoutKind.Sequential)] public struct LASTINPUT { public uint cbSize; public uint dwTime; }',
  '[StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }',
  '[DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);',
  '[DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);',
  '[DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);',
  '[DllImport("user32.dll")] static extern bool IsZoomed(IntPtr h);',
  '[DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);',
  '[DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);',
  '[DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);',
  '[DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
  '[DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUT i);',
  '[DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);',
  '[DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();',
  '[DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, uint f);',
  '[DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFO i);',
  '[DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);',
  '[DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out int v, int s);',
  '[DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out RECT v, int s);',
  'static readonly object Gate = new object();',
  'static void Say(string s) { lock (Gate) { Console.Out.WriteLine(s); Console.Out.Flush(); } }',
  // Input arrived and the pointer did not move: a key (or a click or the wheel). Only the
  // moment is known, which is all the buddy needs to bob along.
  'static void Keys() {',
  '  LASTINPUT li = new LASTINPUT(); li.cbSize = 8; uint last = 0; POINT was = new POINT();',
  '  while (true) {',
  '    POINT p; GetCursorPos(out p);',
  '    if (GetLastInputInfo(ref li) && li.dwTime != last) { bool first = last == 0; last = li.dwTime; if (!first && p.X == was.X && p.Y == was.Y) Say("K"); }',
  '    was = p; Thread.Sleep(45);',
  '  }',
  '}',
  // Windows keeps a "last used" time per app for the microphone; zero means it is in use now.
  'static bool Used(RegistryKey k) {',
  '  foreach (string n in k.GetSubKeyNames()) { using (RegistryKey s = k.OpenSubKey(n)) { if (s == null) continue; object v = s.GetValue("LastUsedTimeStop"); if (v is long && (long)v == 0) return true; } }',
  '  return false;',
  '}',
  'static bool Mic() {',
  '  try { using (RegistryKey k = Registry.CurrentUser.OpenSubKey("Software\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\CapabilityAccessManager\\\\ConsentStore\\\\microphone")) {',
  '    if (k == null) return false; if (Used(k)) return true;',
  '    using (RegistryKey np = k.OpenSubKey("NonPackaged")) { if (np != null && Used(np)) return true; }',
  '  } } catch { }',
  '  return false;',
  '}',
  'public static void Run(int owner, int ms) {',
  '  Thread t = new Thread(new ThreadStart(Keys)); t.IsBackground = true; t.Start();',
  '  string last = null; string lastFront = null; int n = 0; int full = 0; int mic = 0; uint frontPid = 0; string front = "";',
  '  while (true) {',
  '    if (n++ % 8 == 0) { try { System.Diagnostics.Process.GetProcessById(owner); } catch { return; } }',
  '    StringBuilder sb = new StringBuilder();',
  '    EnumWindows(delegate(IntPtr h, IntPtr l) {',
  '      if (!IsWindowVisible(h) || IsIconic(h)) return true;',
  '      uint pid; GetWindowThreadProcessId(h, out pid); if (pid == (uint)owner) return true;',
  '      if ((GetWindowLong(h, -20) & 0x80) != 0) return true;',
  '      if (GetWindowTextLength(h) == 0) return true;',
  '      int cloaked; if (DwmGetWindowAttribute(h, 14, out cloaked, 4) == 0 && cloaked != 0) return true;',
  '      RECT r; if (DwmGetWindowAttribute(h, 9, out r, 16) != 0) { if (!GetWindowRect(h, out r)) return true; }',
  '      if (r.R - r.L < 120 || r.B - r.T < 60) return true;',
  '      sb.Append(h.ToInt64()).Append(",").Append(r.L).Append(",").Append(r.T).Append(",").Append(r.R).Append(",").Append(r.B).Append(",").Append(IsZoomed(h) ? 1 : 0).Append(";");',
  '      return true;',
  '    }, IntPtr.Zero);',
  '    string s = sb.ToString();',
  '    if (s != last) { last = s; Say("W " + s); }',
  '    IntPtr fg = GetForegroundWindow(); uint fp = 0;',
  '    if (fg != IntPtr.Zero) GetWindowThreadProcessId(fg, out fp);',
  '    if (fp != 0 && fp != (uint)owner) {',
  '      StringBuilder cn = new StringBuilder(64); GetClassName(fg, cn, 64); string c = cn.ToString();',
  '      RECT fr; MONITORINFO mi = new MONITORINFO(); mi.cbSize = 40; full = 0;',
  '      if (c != "Progman" && c != "WorkerW" && c != "Shell_TrayWnd" && !IsZoomed(fg) && GetWindowRect(fg, out fr) && GetMonitorInfo(MonitorFromWindow(fg, 2), ref mi)) {',
  '        if (fr.L <= mi.rcMonitor.L && fr.T <= mi.rcMonitor.T && fr.R >= mi.rcMonitor.R && fr.B >= mi.rcMonitor.B) full = 1;',
  '      }',
  '      if (fp != frontPid) { frontPid = fp; try { front = System.Diagnostics.Process.GetProcessById((int)fp).ProcessName; } catch { front = ""; } }',
  '    }',
  '    if (n % 20 == 1) mic = Mic() ? 1 : 0;',
  '    string f = full + " " + mic + " " + front;',
  '    if (f != lastFront) { lastFront = f; Say("F " + f); }',
  '    Thread.Sleep(ms);',
  '  }',
  '} } }',
].join(' ');

// The program in front, boiled down to a kind of activity. Only the kind reaches the buddy.
const APP_KINDS = [
  ['claude', /^claude$/i],
  ['editor', /^(code|code - insiders|cursor|windsurf|zed|devenv|idea64|pycharm64|webstorm64|rider64|clion64|goland64|sublime_text|notepad\+\+|notepad|gvim|nvim-qt|neovide)$/i],
  ['terminal', /^(windowsterminal|cmd|powershell|pwsh|wezterm-gui|alacritty|conhost|mintty|warp|tabby)$/i],
  ['browser', /^(chrome|msedge|firefox|brave|opera|vivaldi|arc|zen)$/i],
  ['chat', /^(discord|slack|telegram|ms-teams|teams|whatsapp|signal|zoom|element)$/i],
  ['music', /^(spotify|applemusic|foobar2000|musicbee|vlc|mpv|mpc-hc64|wmplayer|tidal)$/i],
  ['art', /^(blender|photoshop|illustrator|figma|krita|gimp.*|aseprite|inkscape|afterfx|resolve|paintdotnet)$/i],
  ['taking', /^(ida64|ida|idaq64|ghidra.*|x64dbg|x32dbg|cheatengine.*|dnspy|ilspy)$/i],
  ['files', /^explorer$/i],
  ['game', /^(steam|steamwebhelper|epicgameslauncher|galaxyclient|playnite.*)$/i],
];

function onFront(line) {
  const m = /^(\d) (\d) (.*)$/.exec(line);
  if (!m) return;
  const name = m[3].trim().slice(0, 60);
  const full = m[1] === '1';
  const hit = APP_KINDS.find(([, re]) => re.test(name));
  // something unknown filling the whole screen is most likely a game or a film
  const app = hit ? hit[0] : full && name ? 'game' : '';
  presence = { full, mic: m[2] === '1', app: settings.notice ? app : '', seq: presence.seq + (name !== lastApp ? 1 : 0) };
  lastApp = name;
  send('buddy-presence', presence);
}

function onWindows(line) {
  if (line === 'K') { if (settings.typing) send('buddy-key'); return; }
  if (line.startsWith('F ')) return onFront(line.slice(2));
  if (!line.startsWith('W ')) return;
  const list = [];
  for (const part of line.slice(2).split(';')) {
    const n = part.split(',').map(Number);
    if (n.length !== 6 || n.some((v) => !Number.isFinite(v))) continue;
    const r = screen.screenToDipRect(null, { x: n[1], y: n[2], width: n[3] - n[1], height: n[4] - n[2] });
    list.push({ h: n[0], l: r.x, t: r.y, r: r.x + r.width, b: r.y + r.height, zoomed: n[5] === 1 });
  }
  windows = list;
  platforms = settings.perch && settings.gravity ? list : [];
  followPerch();
}

function startWatcher() {
  if (watcher || process.platform !== 'win32') return;
  try {
    watcher = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '-'], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  } catch {
    watcher = null;
    return;
  }
  const child = watcher;
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      onWindows(buf.slice(0, i).trim());
      buf = buf.slice(i + 1);
    }
    if (buf.length > 1e6) buf = '';
  });
  child.on('error', () => {});
  child.on('exit', () => {
    if (watcher === child) watcher = null;
    windows = [];
    platforms = [];
  });
  child.stdin.on('error', () => {});
  child.stdin.write(`Add-Type -TypeDefinition '${WATCH_CS}'; [Buddy.Watch]::Run(${process.pid}, 120)\n`);
}

// "Sit on windows" (or gravity) was switched: the helper keeps running for everything else it
// reports, but the windows only count as places to stand while both are on.
function refreshPlatforms() {
  platforms = settings.perch && settings.gravity ? windows : [];
  if (!platforms.length && perch) dropFromPerch();
}

// is this point hidden behind a window that is above platform number `index`?
function covered(x, y, index) {
  for (let i = 0; i < index; i++) {
    const p = platforms[i];
    if (x >= p.l && x <= p.r && y >= p.t && y <= p.b) return true;
  }
  return false;
}

function dropFromPerch() {
  perch = null;
  walk = null;
  if (!win || win.isDestroyed() || dragOffset || fall) return;
  const b = win.getBounds();
  fall = { x: b.x, y: b.y, vx: 0, vy: 0, peak: 0, bounces: 0, ground: null };
  send('buddy-fly', { speed: 0 });
}

// The window it stands on moved, resized, closed or got covered.
function followPerch() {
  if (!perch || dragOffset || fall || !win || win.isDestroyed()) return;
  const i = platforms.findIndex((p) => p.h === perch.h);
  const p = platforms[i];
  if (!p || p.zoomed) return dropFromPerch();
  const b = win.getBounds();
  const dx = p.l - perch.l;
  const cx = b.x + dx + WIN_W / 2;
  if (cx < p.l || cx > p.r || covered(cx, p.t, i)) return dropFromPerch();
  const y = p.t - (WIN_H - FOOT_PAD);
  if (dx || y !== b.y) {
    home = { x: home.x + dx, y };
    if (walk) { walk.x += dx; walk.tx += dx; walk.y = y; walk.ty = y; }
    setPos(b.x + dx, y);
  }
  perch.l = p.l;
  perch.t = p.t;
}

// walked (or chased a ball) past the end of the window it was standing on
function checkPerchEdge() {
  if (!perch) return;
  const p = platforms.find((q) => q.h === perch.h);
  const cx = win.getBounds().x + WIN_W / 2;
  if (!p || cx < p.l || cx > p.r) dropFromPerch();
}

// Where a falling buddy would come to rest this tick: the floor, or a window top it just
// passed through on the way down.
function groundFor(f, prevFeet, a) {
  const ground = { y: floorY(a), h: null, l: 0, t: 0 };
  if (!settings.perch || f.vy <= 0) return ground;
  const feet = f.y + WIN_H - FOOT_PAD;
  const cx = f.x + WIN_W / 2;
  for (let i = 0; i < platforms.length; i++) {
    const p = platforms[i];
    const y = p.t - (WIN_H - FOOT_PAD);
    if (p.zoomed || prevFeet > p.t + 0.5 || feet < p.t) continue;
    if (cx < p.l + 15 || cx > p.r - 15 || covered(cx, p.t, i)) continue;
    if (y < a.y - HEAD_PAD || p.t > a.y + a.height - 8) continue; // must fit on screen
    if (y < ground.y) Object.assign(ground, { y, h: p.h, l: p.l, t: p.t });
  }
  return ground;
}

// ---- movement: carrying, walking, falling ----

function stepWalk() {
  const dx = walk.tx - walk.x;
  const dy = walk.ty - walk.y;
  const d = Math.hypot(dx, dy);
  const done = d <= WALK_STEP;
  walk.x = done ? walk.tx : walk.x + (dx / d) * WALK_STEP;
  walk.y = done ? walk.ty : walk.y + (dy / d) * WALK_STEP;
  setPos(walk.x, walk.y);
  if (done) {
    if (walk.setHome) home = { x: Math.round(walk.tx), y: Math.round(walk.ty) };
    const back = walk.perch;
    walk = null;
    if (back) { perch = back; followPerch(); } // home was on top of a window
    send('buddy-walk-done');
  }
  checkPerchEdge();
}

function stepFall() {
  const a = area();
  const f = fall;
  const prevFeet = f.y + WIN_H - FOOT_PAD;
  f.vy += GRAVITY;
  f.vx *= 0.995;
  f.x += f.vx;
  f.y += f.vy;

  const x = clampX(a, f.x);
  if (x !== f.x) { f.x = x; f.vx = -f.vx * 0.55; } // off the walls
  if (f.y < a.y - HEAD_PAD) { f.y = a.y - HEAD_PAD; f.vy = -f.vy * 0.4; } // and the ceiling

  const ground = groundFor(f, prevFeet, a);
  let landed = false;
  if (f.y >= ground.y) {
    f.y = ground.y;
    f.ground = ground;
    f.peak = Math.max(f.peak, f.vy);
    if (f.vy > 6) {
      f.vy = -f.vy * 0.45;
      f.vx *= 0.75;
      f.bounces++;
      send('buddy-bounce');
    } else {
      f.vy = 0;
      f.vx *= 0.82; // skid to a stop
      landed = Math.abs(f.vx) < 0.6;
    }
  }
  setPos(f.x, f.y);
  if (landed) {
    fall = null;
    home = { x: Math.round(f.x), y: Math.round(f.y) };
    perch = f.ground && f.ground.h ? { h: f.ground.h, l: f.ground.l, t: f.ground.t } : null;
    send('buddy-landed', { impact: f.peak, bounces: f.bounces, perch: !!perch });
  }
}

function stepChase(now) {
  const b = win.getBounds();
  const dx = ball.x + BALL / 2 - (b.x + WIN_W / 2);
  // without gravity it floats, so it has to fly over to the ball's height as well
  const dy = settings.gravity ? 0 : ball.y + BALL - (b.y + WIN_H - FOOT_PAD);
  if (Math.abs(dx) > 46 || Math.abs(dy) > 30) {
    const stepX = Math.abs(dx) > 46 ? Math.sign(dx) * Math.min(CHASE_STEP, Math.abs(dx)) : 0;
    const stepY = Math.abs(dy) > 30 ? Math.sign(dy) * Math.min(CHASE_STEP, Math.abs(dy)) : 0;
    setPos(clampX(area(), b.x + stepX), b.y + stepY);
    checkPerchEdge();
    if (fall) return;
  }
  // close enough, and the ball is at about body height: bat it away
  const feet = b.y + WIN_H - FOOT_PAD;
  const ballBottom = ball.y + BALL;
  if (Math.abs(dx) <= 62 && ballBottom > feet - 110 && ballBottom < feet + 60 && now - lastBat > 700) {
    lastBat = now;
    const dir = Math.random() < 0.7 ? Math.sign(dx) || 1 : -(Math.sign(dx) || 1);
    ball.vx = dir * (6 + Math.random() * 9);
    ball.vy = -(14 + Math.random() * 8);
    ball.rest = false;
    send('buddy-batted');
  }
}

function stepBall(c, now) {
  if (!ballWin || ballWin.isDestroyed()) return;
  if (ballDrag) {
    ball.x = c.x - ballDrag.x;
    ball.y = c.y - ballDrag.y;
    ballTrail.push({ x: c.x, y: c.y });
    if (ballTrail.length > 6) ballTrail.shift();
  } else if (!ball.rest) {
    const a = screen.getDisplayNearestPoint({ x: Math.round(ball.x + BALL / 2), y: Math.round(ball.y + BALL / 2) }).workArea;
    ball.vy += GRAVITY;
    ball.x += ball.vx;
    ball.y += ball.vy;
    const maxX = a.x + a.width - BALL;
    const maxY = a.y + a.height - BALL;
    if (ball.x < a.x) { ball.x = a.x; ball.vx = -ball.vx * 0.7; }
    if (ball.x > maxX) { ball.x = maxX; ball.vx = -ball.vx * 0.7; }
    if (ball.y < a.y) { ball.y = a.y; ball.vy = -ball.vy * 0.6; }
    if (ball.y >= maxY) {
      ball.y = maxY;
      if (ball.vy > 4) {
        ball.vy = -ball.vy * 0.68;
        ball.vx *= 0.92;
      } else {
        ball.vy = 0;
        ball.vx *= 0.9;
        if (Math.abs(ball.vx) < 0.4) { ball.rest = true; ball.restSince = now; }
      }
    }
  } else {
    return;
  }
  ballWin.setBounds({ x: Math.round(ball.x), y: Math.round(ball.y), width: BALL, height: BALL });
}

const ballState = () => (ball
  ? { exists: true, active: !ball.rest || Date.now() - ball.restSince < 4000, thrown: ball.thrown }
  : { exists: false, active: false, thrown: 0 });

// Polls the cursor so the buddy can watch it anywhere on screen, and moves the windows while
// things are being carried, walking, falling or bouncing.
function trackCursor() {
  let last = '';
  setInterval(() => {
    if (!win || win.isDestroyed()) return;
    const c = screen.getCursorScreenPoint();
    const now = Date.now();
    if (dragOffset) {
      setPos(c.x - dragOffset.x, c.y - dragOffset.y);
      dragTrail.push({ x: c.x, y: c.y });
      if (dragTrail.length > 6) dragTrail.shift();
    } else if (fall) {
      stepFall();
    } else if (walk) {
      stepWalk();
    } else if (chase && ball && !ballDrag) {
      stepChase(now);
    }
    if (ball) {
      stepBall(c, now);
      if (++ticks % 12 === 0) send('buddy-ball', ballState());
    }
    if (bedDrag && bedWin && !bedWin.isDestroyed()) {
      bedWin.setBounds({ x: c.x - bedDrag.x, y: c.y - bedDrag.y, width: BED_W, height: BED_H });
    }
    const b = win.getBounds();
    const rel = { x: c.x - b.x, y: c.y - b.y, sx: c.x, sy: c.y };
    const key = rel.x + ',' + rel.y;
    if (key === last) return;
    last = key;
    send('buddy-cursor', rel);
  }, 16);
}

ipcMain.on('buddy-ignore-mouse', (_e, ignore) => {
  if (win && !win.isDestroyed()) win.setIgnoreMouseEvents(!!ignore, { forward: true });
});

// how fast the cursor was moving when it let go, in px per tick
function throwSpeed(trail) {
  if (trail.length < 2) return { vx: 0, vy: 0, speed: 0 };
  const first = trail[0];
  const lastPt = trail[trail.length - 1];
  let vx = (lastPt.x - first.x) / (trail.length - 1);
  let vy = (lastPt.y - first.y) / (trail.length - 1);
  const speed = Math.hypot(vx, vy);
  if (speed > MAX_THROW) { vx *= MAX_THROW / speed; vy *= MAX_THROW / speed; }
  return { vx, vy, speed: Math.min(speed, MAX_THROW) };
}

function endDrag() {
  if (!dragOffset || !win || win.isDestroyed()) return;
  dragOffset = null;
  const b = win.getBounds();
  const { vx, vy, speed } = throwSpeed(dragTrail);
  dragTrail = [];

  if (settings.gravity && (speed > 3 || Math.abs(b.y - floorY(area())) > 2)) {
    fall = { x: b.x, y: b.y, vx, vy, peak: 0, bounces: 0, ground: null };
    send('buddy-fly', { speed });
  } else {
    home = { x: b.x, y: b.y };
    send('buddy-landed', { impact: 0, bounces: 0, placed: true });
  }
}

ipcMain.on('buddy-drag', (_e, on) => {
  if (!win || win.isDestroyed()) return;
  if (!on) {
    // the drag may already have been ended by the window losing focus; still answer
    if (!dragOffset) return fall ? send('buddy-fly', { speed: 0 }) : send('buddy-landed', { impact: 0, bounces: 0, placed: true });
    return endDrag();
  }
  walk = null;
  fall = null;
  perch = null;
  hiding = null;
  dragTrail = [];
  const c = screen.getCursorScreenPoint();
  const b = win.getBounds();
  dragOffset = { x: c.x - b.x, y: c.y - b.y };
});

// The renderer asks to scuttle to an offset from home ({0,0} = go back home).
ipcMain.on('buddy-walk', (_e, off) => {
  if (!win || win.isDestroyed() || dragOffset || fall) return;
  const ox = Number(off && off.x) || 0;
  const oy = Number(off && off.y) || 0;
  if (!settings.wander && (ox || oy)) return send('buddy-walk-done');
  const a = screen.getDisplayNearestPoint({ x: Math.round(home.x + ox + WIN_W / 2), y: Math.round(home.y + WIN_H / 2) }).workArea;
  const b = win.getBounds();
  walk = {
    x: b.x,
    y: b.y,
    tx: clampX(a, home.x + ox),
    // with gravity it stays on its floor or window; without, it floats wherever it likes
    ty: settings.gravity ? home.y : Math.min(Math.max(home.y + oy, a.y), a.y + a.height - WIN_H),
  };
});

// ---- the ball ----

function toggleBall() {
  if (ballWin && !ballWin.isDestroyed()) return ballWin.close();
  const b = win.getBounds();
  ball = { x: b.x + WIN_W / 2 - BALL / 2, y: b.y + 20, vx: (Math.random() - 0.5) * 16, vy: -12, rest: false, restSince: 0, thrown: 1 };
  ballWin = new BrowserWindow({
    width: BALL,
    height: BALL,
    x: Math.round(ball.x),
    y: Math.round(ball.y),
    frame: false,
    transparent: true,
    resizable: false,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    webPreferences: { preload: path.join(__dirname, 'ball-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  ballWin.setAlwaysOnTop(true, 'floating');
  ballWin.webContents.on('will-navigate', (e) => e.preventDefault());
  ballWin.on('closed', () => {
    ballWin = null;
    ball = null;
    ballDrag = null;
    if (chase) endChase();
    send('buddy-ball', ballState());
  });
  ballWin.loadFile('ball.html');
  send('buddy-ball', ballState());
}

ipcMain.on('ball-drag', (e, on) => {
  if (!ball || !ballWin || e.sender !== ballWin.webContents) return;
  if (on) {
    const c = screen.getCursorScreenPoint();
    ballDrag = { x: c.x - ball.x, y: c.y - ball.y };
    ballTrail = [];
    ball.rest = false;
  } else if (ballDrag) {
    const { vx, vy } = throwSpeed(ballTrail);
    ballDrag = null;
    ball.vx = vx;
    ball.vy = vy;
    ball.rest = false;
    ball.thrown++;
  }
});

function endChase() {
  chase = false;
  if (win && !win.isDestroyed() && !fall && !dragOffset) {
    const b = win.getBounds();
    home = { x: b.x, y: b.y };
  }
}

ipcMain.on('buddy-chase', (_e, on) => {
  if (on && ball) { chase = true; walk = null; } else if (chase) endChase();
});

// ---- the bed ----

function createBed() {
  if (bedWin && !bedWin.isDestroyed()) return;
  let x = settings.bedX;
  let y = settings.bedY;
  if (!x && !y) {
    const a = area();
    x = a.x + 60;
    y = a.y + a.height - BED_H;
  }
  // keep it on a screen that still exists
  const a = screen.getDisplayNearestPoint({ x: Math.round(x), y: Math.round(y) }).workArea;
  x = Math.min(Math.max(x, a.x), a.x + a.width - BED_W);
  y = Math.min(Math.max(y, a.y), a.y + a.height - BED_H);
  bedWin = new BrowserWindow({
    width: BED_W,
    height: BED_H,
    x: Math.round(x),
    y: Math.round(y),
    frame: false,
    transparent: true,
    resizable: false,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    webPreferences: { preload: path.join(__dirname, 'bed-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  bedWin.setAlwaysOnTop(true, 'floating');
  bedWin.webContents.on('will-navigate', (e) => e.preventDefault());
  bedWin.on('closed', () => {
    bedWin = null;
    bedDrag = null;
  });
  bedWin.webContents.on('did-finish-load', sendRoom);
  bedWin.loadFile('bed.html');
  bedWin.once('ready-to-show', () => { if (win && !win.isDestroyed()) win.moveTop(); });
}

// Tell the room what is standing in it, and cut the window down to those things so the empty
// wall around them doesn't swallow clicks.
function sendRoom() {
  if (!bedWin || bedWin.isDestroyed()) return;
  bedWin.webContents.send('room-state', roomState);
  try {
    bedWin.setShape(['bed', ...roomState.on].filter((id) => ROOM_BOXES[id]).map((id) => {
      const [x, y, w, h] = ROOM_BOXES[id];
      return { x: x * ROOM_SCALE, y: y * ROOM_SCALE, width: w * ROOM_SCALE, height: h * ROOM_SCALE };
    }));
  } catch {}
}

ipcMain.on('buddy-room', (_e, r) => {
  if (!r || typeof r !== 'object') return;
  roomState = {
    on: Array.isArray(r.on) ? r.on.filter((id) => typeof id === 'string' && ROOM_BOXES[id]).slice(0, 10) : [],
    plant: Math.max(0, Math.min(3, Number(r.plant) || 0)),
    night: !!r.night,
    scarf: Math.max(0, Math.min(4, Math.floor(Number(r.scarf)) || 0)),
  };
  sendRoom();
});

ipcMain.on('bed-drag', (e, on) => {
  if (!bedWin || e.sender !== bedWin.webContents) return;
  const b = bedWin.getBounds();
  if (on) {
    const c = screen.getCursorScreenPoint();
    bedDrag = { x: c.x - b.x, y: c.y - b.y };
  } else if (bedDrag) {
    bedDrag = null;
    let y = b.y;
    if (settings.gravity) {
      // beds don't float: it settles on the bottom of whichever screen it was dropped on
      const a = screen.getDisplayNearestPoint({ x: b.x + BED_W / 2, y: b.y + BED_H / 2 }).workArea;
      y = a.y + a.height - BED_H;
      bedWin.setBounds({ x: b.x, y, width: BED_W, height: BED_H });
    }
    settings.bedX = b.x;
    settings.bedY = y;
    saveSettings();
    if (win && !win.isDestroyed()) win.moveTop();
  }
});

// The renderer says it is sleepy: walk to the bed, and make that home.
ipcMain.on('buddy-go-bed', () => {
  if (!win || win.isDestroyed() || !bedWin || bedWin.isDestroyed() || dragOffset || fall) return send('buddy-walk-done');
  const bed = bedWin.getBounds();
  const b = win.getBounds();
  const tx = bed.x + BED_W / 2 - WIN_W / 2;
  // with gravity it stays on its own level; without, it floats over and settles into the bed
  const ty = settings.gravity ? b.y : bed.y + BED_H - (WIN_H - FOOT_PAD) - 6;
  if (Math.hypot(tx - b.x, ty - b.y) < 12) return send('buddy-walk-done');
  chase = false;
  walk = { x: b.x, y: b.y, tx, ty, setHome: true };
  win.moveTop();
});

// ---- hide and seek ----

// It hides mostly off an outer edge of the screen: peeking over the bottom, or round a side.
function startHide() {
  if (!win || win.isDestroyed() || dragOffset || fall) return send('buddy-hidden', false);
  const b = win.getBounds();
  const d = screen.getDisplayNearestPoint({ x: Math.round(b.x + WIN_W / 2), y: Math.round(b.y + WIN_H / 2) }).bounds;
  // an edge only hides it if there isn't another screen on the far side
  const open = (x, y) => !screen.getAllDisplays().some((o) => x >= o.bounds.x && x < o.bounds.x + o.bounds.width && y >= o.bounds.y && y < o.bounds.y + o.bounds.height);
  const sides = [];
  if (open(d.x + d.width / 2, d.y + d.height + 40)) sides.push('bottom', 'bottom');
  if (open(d.x - 40, d.y + d.height / 2)) sides.push('left');
  if (open(d.x + d.width + 40, d.y + d.height / 2)) sides.push('right');
  const side = sides.length ? sides[Math.floor(Math.random() * sides.length)] : 'bottom';
  const y = d.y + Math.random() * Math.max(1, d.height - WIN_H);
  const spot = side === 'left' ? { x: d.x - 128, y }
    : side === 'right' ? { x: d.x + d.width - 112, y }
    : { x: d.x - 45 + Math.random() * (d.width - 150), y: d.y + d.height - 208 };
  hiding = { perch };
  walk = null;
  chase = false;
  perch = null;
  setPos(spot.x, spot.y);
  win.moveTop();
  send('buddy-hidden', true);
}

ipcMain.on('buddy-hide', (_e, on) => {
  if (on) return startHide();
  if (!win || win.isDestroyed() || dragOffset || fall) return send('buddy-walk-done');
  const b = win.getBounds();
  walk = { x: b.x, y: b.y, tx: home.x, ty: home.y, perch: hiding ? hiding.perch : null };
  hiding = null;
});

// ---- photo album ----

// `tab`: which page it opens at ('' for the photos, 'diary', 'family')
function openAlbum(tab = '') {
  if (albumWin && !albumWin.isDestroyed()) {
    albumWin.loadFile('album.html', { hash: tab });
    return albumWin.focus();
  }
  albumWin = new BrowserWindow({
    width: 420,
    height: 560,
    title: 'Buddy\'s photo album',
    autoHideMenuBar: true,
    backgroundColor: '#f6efe6',
    webPreferences: { preload: path.join(__dirname, 'album-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  albumWin.setMenu(null);
  albumWin.webContents.on('will-navigate', (e) => e.preventDefault());
  albumWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  albumWin.on('closed', () => { albumWin = null; });
  albumWin.loadFile('album.html', { hash: tab });
}

ipcMain.on('album-load', (e) => {
  const life = memory['buddy-life'];
  e.returnValue = life && Array.isArray(life.album) ? life.album.slice(-150) : [];
});

// its diary, and the ones who stood here before it
ipcMain.on('album-more', (e) => {
  const life = memory['buddy-life'] || {};
  e.returnValue = {
    diary: Array.isArray(life.diary) ? life.diary.slice(-120) : [],
    elders: Array.isArray(life.elders) ? life.elders.slice(-12) : [],
    now: { n: String(life.name || ''), c: life.color, h: life.hat, gen: Number(life.gen) || 1, born: life.born },
    scarf: Number(life.scarf) || 0,
  };
});

// ---- focus timer, notes, goodbye ----

ipcMain.on('buddy-pomodoro-ended', () => { pomodoro = false; });

// Opens the little text box over the buddy: for its note, its name, a phrase to teach it, or a
// friend's code.
function edit(kind) {
  if (!win || win.isDestroyed()) return;
  win.show();
  win.setIgnoreMouseEvents(false);
  win.focus();
  send('buddy-edit', kind);
}

// Quit from the menu: give it a few seconds to say goodbye first.
function quitNicely() {
  if (quitting || !win || win.isDestroyed() || !win.isVisible()) return app.quit();
  quitting = true;
  send('buddy-goodbye');
  setTimeout(() => app.quit(), 4500);
}

// ---- finding Claude's window ----

// Which process is on the other end of a hook connection? (Windows only.)
function findPeerPid(remotePort, cb) {
  execFile('netstat', ['-ano', '-p', 'TCP'], { windowsHide: true, timeout: 1500, maxBuffer: 4 * 1024 * 1024 }, (err, out) => {
    if (err || !out) return cb(0);
    for (const line of out.split('\n')) {
      const m = /^\s*TCP\s+127\.0\.0\.1:(\d+)\s+127\.0\.0\.1:(\d+)\s+\S+\s+(\d+)\s*$/.exec(line);
      if (m && Number(m[1]) === remotePort && Number(m[2]) === PORT && Number(m[3]) !== process.pid) return cb(Number(m[3]));
    }
    cb(0);
  });
}

// Walks up from the hook's process to the first ancestor that owns a window (the terminal,
// editor or Claude app) and brings that window to the front. PID is replaced by a number.
const FOCUS_PS = [
  '$p = PID;',
  "$w = Add-Type -Name Win -Namespace Buddy -PassThru -MemberDefinition '",
  '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);',
  '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);',
  '[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);',
  "';",
  'for ($i = 0; $i -lt 12 -and $p -gt 4; $i++) {',
  '  $g = Get-Process -Id $p -ErrorAction SilentlyContinue;',
  '  if ($g -and $g.MainWindowHandle -ne 0) {',
  '    if ($w::IsIconic($g.MainWindowHandle)) { [void]$w::ShowWindow($g.MainWindowHandle, 9) };',
  "    if (-not $env:BUDDY_DRY_RUN) { [void]$w::SetForegroundWindow($g.MainWindowHandle) };",
  "    'ok ' + $g.ProcessName; exit",
  '  };',
  "  $p = (Get-CimInstance Win32_Process -Filter ('ProcessId=' + $p)).ParentProcessId",
  '};',
  "'none'",
].join(' ');

function focusSession(id) {
  const pid = sessionPids.get(id) || sessionPids.get(lastSession) || [...sessionPids.values()].pop();
  if (process.platform !== 'win32' || !Number.isInteger(pid) || pid <= 4) return send('buddy-focus-result', false);
  execFile(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', FOCUS_PS.replace('PID', String(pid))],
    { windowsHide: true, timeout: 10000 },
    (err, out) => send('buddy-focus-result', !err && /^ok/.test(String(out).trim())),
  );
}

ipcMain.on('buddy-focus', (_e, id) => focusSession(typeof id === 'string' ? id : ''));

// ---- how full is Claude's context window? ----

// Hooks don't report token use, but each session's transcript does. This reads only the tail of
// the transcript and forwards one number: the size of the latest request.
function checkContext(sid, file) {
  if (!sid || typeof file !== 'string' || !file.toLowerCase().endsWith('.jsonl')) return;
  const full = path.resolve(file);
  const root = path.join(os.homedir(), '.claude') + path.sep;
  if (!full.toLowerCase().startsWith(root.toLowerCase())) return; // Claude Code's own files only
  const now = Date.now();
  if (now - (contextReadAt.get(sid) || 0) < 15000) return;
  contextReadAt.set(sid, now);

  fs.promises.open(full, 'r').then(async (fh) => {
    try {
      const { size } = await fh.stat();
      const len = Math.min(size, 512 * 1024);
      const { buffer } = await fh.read(Buffer.alloc(len), 0, len, size - len);
      const lines = buffer.toString('utf8').split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].includes('"usage"')) continue;
        let o;
        try { o = JSON.parse(lines[i]); } catch { continue; }
        const u = o && o.type === 'assistant' && !o.isSidechain && o.message && o.message.usage;
        if (!u) continue;
        const tokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0);
        if (tokens > 0) send('buddy-context', { session: sid, tokens });
        return;
      }
    } finally {
      await fh.close();
    }
  }).catch(() => {});
}

// ---- menus, tray, start at login ----

const loginItem = () => (app.isPackaged ? {} : { path: process.execPath, args: [app.getAppPath()] });

function setSetting(key, value) {
  settings[key] = value;
  saveSettings();
  sendSettings();
  if (key === 'bed') {
    if (value) createBed();
    else if (bedWin && !bedWin.isDestroyed()) bedWin.close();
  }
  if (key === 'gravity' && value && win && !dragOffset) {
    walk = null;
    const b = win.getBounds();
    fall = { x: b.x, y: b.y, vx: 0, vy: 0, peak: 0, bounces: 0, ground: null };
    send('buddy-fly', { speed: 0 });
  }
  if (key === 'gravity' || key === 'perch') refreshPlatforms();
  if (key === 'gravity') hiding = null;
}

ipcMain.on('buddy-wardrobe', (_e, w) => {
  if (!w || typeof w !== 'object') return;
  const items = (list) => (Array.isArray(list) ? list.slice(0, 20).map((i) => ({
    id: String(i.id).slice(0, 20),
    label: String(i.label).slice(0, 30),
    at: Number(i.at) || 0,
    unlocked: !!i.unlocked,
    on: !!i.on,
  })) : []);
  wardrobe = { tasks: Number(w.tasks) || 0, hat: String(w.hat || ''), color: String(w.color || 'classic'), hats: items(w.hats), colors: items(w.colors), extras: items(w.extras) };
  badges = Array.isArray(w.badges) ? w.badges.slice(0, 60).map((b) => ({ label: String(b.label).slice(0, 70), earned: !!b.earned })) : [];
  roomItems = Array.isArray(w.room) ? w.room.slice(0, 20).map((r) => ({
    id: String(r.id).slice(0, 20),
    label: String(r.label).slice(0, 30),
    need: Number(r.need) || 0,
    unlocked: !!r.unlocked,
    on: !!r.on,
  })) : [];
  who = {
    name: String(w.name || '').slice(0, 16),
    code: /^BUD-\d{4}-.{1,16}$/.test(String(w.code)) ? String(w.code) : '',
    friends: Array.isArray(w.friends) ? w.friends.slice(0, 8).map((n) => String(n).slice(0, 16)) : [],
    words: Number(w.words) || 0,
  };
  if (tray) tray.setToolTip(who.name ? `${who.name} (Claude Buddy)` : 'Claude Buddy');
  tricks = Array.isArray(w.tricks) ? w.tricks.slice(0, 20).map((t) => ({ id: String(t.id).slice(0, 20), label: String(t.label).slice(0, 90), known: !!t.known })) : [];
});

function wardrobeMenu() {
  const entry = (kind, worn) => (i) => ({
    label: i.unlocked ? i.label : `${i.label} (at ${i.at} tasks)`,
    type: 'radio',
    enabled: i.unlocked,
    checked: i.id === worn,
    click: () => send('buddy-wear', { [kind]: i.id }),
  });
  return [
    { label: `${wardrobe.tasks} tasks finished so far`, enabled: false },
    { type: 'separator' },
    { label: 'No hat', type: 'radio', checked: !wardrobe.hat, click: () => send('buddy-wear', { hat: '' }) },
    ...wardrobe.hats.map(entry('hat', wardrobe.hat)),
    { type: 'separator' },
    ...wardrobe.colors.map(entry('color', wardrobe.color)),
    ...(wardrobe.extras.length ? [{ type: 'separator' }] : []),
    ...wardrobe.extras.map((i) => ({
      label: i.unlocked ? i.label : `${i.label} (at ${i.at} tasks)`,
      type: 'checkbox',
      enabled: i.unlocked,
      checked: i.unlocked && i.on,
      click: () => send('buddy-wear', { extra: i.id }),
    })),
  ];
}

function buildMenu() {
  const visible = win && !win.isDestroyed() && win.isVisible();
  const toggle = (label, key) => ({ label, type: 'checkbox', checked: settings[key], click: (i) => setSetting(key, i.checked) });
  return Menu.buildFromTemplate([
    { label: 'Go to Claude', click: () => focusSession(lastSession) },
    { label: 'How are you feeling?', click: () => send('buddy-ask-mood') },
    { label: 'How was today?', click: () => send('buddy-ask-day') },
    { label: 'How was this week?', click: () => send('buddy-ask-week') },
    {
      label: 'Play',
      submenu: [
        { label: ball ? 'Put the ball away' : 'Throw a ball', click: toggleBall },
        { label: 'Rock, paper, scissors', click: () => send('buddy-play', 'rps') },
        { label: 'Hide and seek', click: () => send('buddy-play', 'hide') },
      ],
    },
    {
      label: `Tricks (${tricks.filter((t) => t.known).length}/${tricks.length})`,
      submenu: tricks.length ? tricks.map((t) => ({ label: t.label, enabled: t.known, click: () => send('buddy-trick', t.id) })) : [{ label: 'None yet', enabled: false }],
    },
    { label: pomodoro ? 'Stop focus timer' : 'Start focus timer', click: () => { pomodoro = !pomodoro; send('buddy-pomodoro', pomodoro); } },
    { label: 'Leave a note…', click: () => edit('note') },
    { label: who.name ? `Rename ${who.name}…` : 'Give it a name…', click: () => edit('name') },
    {
      label: 'Teach it',
      submenu: [
        { label: 'A new phrase…', click: () => edit('teach') },
        { label: `Forget what I taught it (${who.words})`, enabled: who.words > 0, click: () => send('buddy-do', { what: 'forget-words' }) },
      ],
    },
    {
      label: 'Friends',
      submenu: [
        { label: `Copy my code (${who.code})`, enabled: !!who.code, click: () => { clipboard.writeText(who.code); send('buddy-do', { what: 'copied' }); } },
        { label: 'Add a friend\'s code…', click: () => edit('invite') },
        ...(who.friends.length ? [{ type: 'separator' }] : []),
        ...who.friends.map((name) => ({ label: `Invite ${name} over`, click: () => send('buddy-do', { what: 'visit', arg: name }) })),
        ...(who.friends.length ? [{ type: 'separator' }, { label: 'Forget all friends', click: () => send('buddy-do', { what: 'forget-friends' }) }] : []),
      ],
    },
    { label: 'Wardrobe', submenu: wardrobeMenu() },
    {
      label: 'Room',
      submenu: [
        toggle('Bed', 'bed'),
        { type: 'separator' },
        ...roomItems.map((r) => ({
          label: r.unlocked ? r.label : `${r.label} (at ${r.need} achievements)`,
          type: 'checkbox',
          enabled: r.unlocked && settings.bed,
          checked: r.unlocked && r.on,
          click: () => send('buddy-room-toggle', r.id),
        })),
      ],
    },
    { label: 'Photo album', click: () => openAlbum() },
    { label: 'Diary', click: () => openAlbum('diary') },
    {
      label: `Achievements (${badges.filter((b) => b.earned).length}/${badges.length})`,
      submenu: badges.length ? badges.map((b) => ({ label: (b.earned ? '★ ' : '☆ ') + b.label, enabled: b.earned })) : [{ label: 'None yet', enabled: false }],
    },
    {
      label: 'Personality',
      submenu: PERSONALITIES.map((id) => ({
        label: id[0].toUpperCase() + id.slice(1),
        type: 'radio',
        checked: settings.personality === id,
        click: () => setSetting('personality', id),
      })),
    },
    { type: 'separator' },
    toggle('Sound', 'sound'),
    toggle('Quiet mode', 'quiet'),
    { ...toggle('Go quiet in fullscreen and on calls', 'autoQuiet'), enabled: process.platform === 'win32' },
    toggle('Gentle reminders', 'reminders'),
    { ...toggle('Bob along when I type', 'typing'), enabled: process.platform === 'win32' },
    { ...toggle('Notice what I\'m doing', 'notice'), enabled: process.platform === 'win32' },
    toggle('Curious wandering', 'wander'),
    toggle('Gravity', 'gravity'),
    { ...toggle('Sit on windows', 'perch'), enabled: settings.gravity && process.platform === 'win32' },
    {
      label: 'Start with Windows',
      type: 'checkbox',
      checked: app.getLoginItemSettings(loginItem()).openAtLogin,
      click: (i) => app.setLoginItemSettings({ openAtLogin: i.checked, ...loginItem() }),
    },
    { label: visible ? 'Hide buddy' : 'Show buddy', click: () => (visible ? win.hide() : win.showInactive()) },
    { type: 'separator' },
    { label: 'Reload config.json', click: () => { send('buddy-config-loaded', loadConfig()); sendSettings(); } },
    ...(dev && dev.menu ? [{ label: 'Dev', submenu: dev.menu() }] : []),
    { label: 'Quit Buddy', click: quitNicely },
  ]);
}

ipcMain.on('buddy-menu', () => {
  if (win && !win.isDestroyed()) buildMenu().popup({ window: win });
});

// A 32x32 pixel-art icon drawn here so the app needs no image files.
function trayImage() {
  const size = 32;
  const buf = Buffer.alloc(size * size * 4);
  const fill = (x0, y0, w, h, [r, g, b]) => {
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) buf.set([b, g, r, 255], (y * size + x) * 4); // BGRA
    }
  };
  const skin = [217, 119, 87];
  fill(6, 7, 20, 13, skin); // body
  fill(2, 12, 4, 4, skin); // arms
  fill(26, 12, 4, 4, skin);
  for (const x of [8, 12, 18, 22]) fill(x, 20, 2, 6, skin); // legs
  fill(11, 11, 2, 4, [31, 20, 16]); // eyes
  fill(19, 11, 2, 4, [31, 20, 16]);
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

function createTray() {
  tray = new Tray(trayImage());
  tray.setToolTip('Claude Buddy');
  const open = () => tray.popUpContextMenu(buildMenu());
  tray.on('click', open);
  tray.on('right-click', open);
}

// ---- dev tools ----

// dev/index.js, when it exists, gets a handle on the app and may add a "Dev" menu and listen
// in on hook events. The folder is in .gitignore, so it only ever exists where someone made it.
function loadDev() {
  if (!fs.existsSync(path.join(__dirname, 'dev', 'index.js'))) return;
  try {
    dev = require('./dev')({
      app,
      getWin: () => win,
      send,
      getMemory: () => memory,
      setMemory: (m) => { memory = m; },
      holdSaves: (on) => { savesHeld = !!on; },
      flushMemory,
      settings,
    });
  } catch (e) {
    console.error('dev tools:', e.message);
  }
}

// ---- hook server ----

// Only the fields the mascot needs are forwarded to the renderer.
function slim(p) {
  const input = p.tool_input || {};
  return {
    event: p.hook_event_name,
    tool: p.tool_name,
    // Bash command, file path, or search pattern - whatever is handy to show
    detail: input.command || input.file_path || input.pattern || input.description || '',
    notificationType: p.notification_type,
    message: p.message,
    agentType: p.agent_type,
    agentId: typeof p.agent_id === 'string' ? p.agent_id.slice(0, 80) : '',
    mode: typeof p.permission_mode === 'string' ? p.permission_mode.slice(0, 30) : '',
    source: typeof p.source === 'string' ? p.source.slice(0, 30) : '',
    cwd: p.cwd,
    session: typeof p.session_id === 'string' ? p.session_id.slice(0, 80) : '',
  };
}

function startServer() {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end('ok');
    }

    if (req.method !== 'POST' || req.url !== '/event') {
      res.writeHead(404);
      return res.end();
    }

    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      // 2xx with empty body = "no decision", so the hook never blocks or alters anything
      const finish = () => {
        if (res.writableEnded) return;
        res.writeHead(200);
        res.end();
      };
      try {
        const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const e = slim(payload);
        send('claude-event', e);
        if (dev && dev.onHook) dev.onHook(e);
        const sid = e.session;
        if (sid) lastSession = sid;
        if (['PostToolUse', 'Stop', 'UserPromptSubmit'].includes(e.event)) checkContext(sid, payload.transcript_path);
        if (sid && e.event === 'SessionEnd') {
          sessionPids.delete(sid);
          pidTries.delete(sid);
          contextReadAt.delete(sid);
        } else if (sid && process.platform === 'win32' && !sessionPids.has(sid) && (pidTries.get(sid) || 0) < 3) {
          // First contact from a session: note which process it is while the connection is
          // still open, so a click can bring its window forward later. Briefly holds the reply.
          pidTries.set(sid, (pidTries.get(sid) || 0) + 1);
          const giveUp = setTimeout(finish, 500);
          return findPeerPid(req.socket.remotePort, (pid) => {
            if (pid) sessionPids.set(sid, pid);
            clearTimeout(giveUp);
            finish();
          });
        }
      } catch (e) {
        // ignore malformed input; never let the mascot break a Claude Code session
      }
      finish();
    });
    req.on('error', () => {});
  });

  // Loopback only: nothing on your network can poke the mascot
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`claude-buddy listening on http://127.0.0.1:${PORT}/event`);
  });
  server.on('error', (e) => console.error('server error:', e.message));
}

// A second copy (say, started at login and again by hand) would fight over the port.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win && !win.isDestroyed()) win.showInactive();
  });

  app.whenReady().then(() => {
    loadSettings();
    loadMemory();
    loadConfig();
    createWindow();
    createTray();
    loadDev();
    if (settings.bed) createBed();
    trackCursor();
    startWatcher();
    startServer();
    // a few things about the computer itself that it likes to remark on
    powerMonitor.on('on-battery', () => send('buddy-world', 'battery'));
    powerMonitor.on('on-ac', () => send('buddy-world', 'ac'));
    screen.on('display-added', () => send('buddy-world', 'display-added'));
    screen.on('display-removed', () => send('buddy-world', 'display-removed'));
  });

  app.on('before-quit', () => {
    if (memoryTimer) flushMemory();
    if (watcher) { const child = watcher; watcher = null; child.kill(); }
  });
  app.on('window-all-closed', () => app.quit());
}
