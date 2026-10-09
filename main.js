const { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, screen } = require('electron');
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
let platforms = []; // { h, l, t, r, b, zoomed } in screen DIPs
let perch = null; // { h, l, t } of the window it is standing on

// the toy ball: its own little window with the same physics
let ballWin = null;
let ball = null; // { x, y, vx, vy, rest, restSince, thrown }
let ballDrag = null;
let ballTrail = [];
let chase = false;
let lastBat = 0;
let ticks = 0;

const settings = { wander: true, gravity: true, sound: true, perch: true };
const settingsFile = path.join(app.getPath('userData'), 'buddy-settings.json');
let config = {}; // config.json: timings, thresholds and phrases the user can retune
// what the renderer says is unlocked and worn, for the Wardrobe menu
let wardrobe = { tasks: 0, hat: '', color: 'classic', hats: [], colors: [] };

// Claude Code session id -> pid of the process that sent its hooks, to find its window later
const sessionPids = new Map();
const pidTries = new Map();
const contextReadAt = new Map();
let lastSession = '';

function loadSettings() {
  try {
    const saved = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    for (const k of Object.keys(settings)) if (typeof saved[k] === 'boolean') settings[k] = saved[k];
  } catch {}
}

function saveSettings() {
  try { fs.writeFileSync(settingsFile, JSON.stringify(settings)); } catch {}
}

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
  });
  win.loadFile('index.html');
}

// ---- other windows as platforms ----

// A tiny always-running helper that prints the visible top-level windows (top-most first)
// whenever they change. Sent to PowerShell on stdin as one line, so the C# must not contain
// single quotes or line comments.
const WATCH_CS = [
  'using System; using System.Text; using System.Threading; using System.Runtime.InteropServices;',
  'namespace Buddy { public static class Watch {',
  'delegate bool EnumProc(IntPtr h, IntPtr l);',
  '[StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }',
  '[DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);',
  '[DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);',
  '[DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);',
  '[DllImport("user32.dll")] static extern bool IsZoomed(IntPtr h);',
  '[DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);',
  '[DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);',
  '[DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);',
  '[DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
  '[DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out int v, int s);',
  '[DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out RECT v, int s);',
  'public static void Run(int owner, int ms) {',
  '  string last = null; int n = 0;',
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
  '    if (s != last) { last = s; Console.Out.WriteLine("W " + s); Console.Out.Flush(); }',
  '    Thread.Sleep(ms);',
  '  }',
  '} } }',
].join(' ');

function onWindows(line) {
  if (!line.startsWith('W ')) return;
  const list = [];
  for (const part of line.slice(2).split(';')) {
    const n = part.split(',').map(Number);
    if (n.length !== 6 || n.some((v) => !Number.isFinite(v))) continue;
    const r = screen.screenToDipRect(null, { x: n[1], y: n[2], width: n[3] - n[1], height: n[4] - n[2] });
    list.push({ h: n[0], l: r.x, t: r.y, r: r.x + r.width, b: r.y + r.height, zoomed: n[5] === 1 });
  }
  platforms = list;
  followPerch();
}

function startWatcher() {
  if (watcher || process.platform !== 'win32' || !settings.perch || !settings.gravity) return;
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
    platforms = [];
  });
  child.stdin.on('error', () => {});
  child.stdin.write(`Add-Type -TypeDefinition '${WATCH_CS}'; [Buddy.Watch]::Run(${process.pid}, 120)\n`);
}

function stopWatcher() {
  if (watcher) {
    const child = watcher;
    watcher = null;
    child.kill();
  }
  platforms = [];
  if (perch) dropFromPerch();
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
    walk = null;
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
  if (Math.abs(dx) > 46) {
    setPos(clampX(area(), b.x + Math.sign(dx) * Math.min(CHASE_STEP, Math.abs(dx))), b.y);
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
  if (on && ball && settings.gravity) { chase = true; walk = null; } else if (chase) endChase();
});

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
  if (key === 'gravity' && value && win && !dragOffset) {
    walk = null;
    const b = win.getBounds();
    fall = { x: b.x, y: b.y, vx: 0, vy: 0, peak: 0, bounces: 0, ground: null };
    send('buddy-fly', { speed: 0 });
  }
  if (key === 'gravity' || key === 'perch') {
    if (settings.gravity && settings.perch) startWatcher();
    else stopWatcher();
  }
  if (key === 'gravity' && !value && chase) endChase();
}

ipcMain.on('buddy-wardrobe', (_e, w) => {
  if (!w || typeof w !== 'object') return;
  const items = (list) => (Array.isArray(list) ? list.slice(0, 20).map((i) => ({
    id: String(i.id).slice(0, 20),
    label: String(i.label).slice(0, 30),
    at: Number(i.at) || 0,
    unlocked: !!i.unlocked,
  })) : []);
  wardrobe = { tasks: Number(w.tasks) || 0, hat: String(w.hat || ''), color: String(w.color || 'classic'), hats: items(w.hats), colors: items(w.colors) };
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
  ];
}

function buildMenu() {
  const visible = win && !win.isDestroyed() && win.isVisible();
  const toggle = (label, key) => ({ label, type: 'checkbox', checked: settings[key], click: (i) => setSetting(key, i.checked) });
  return Menu.buildFromTemplate([
    { label: 'Go to Claude', click: () => focusSession(lastSession) },
    { label: 'How are you feeling?', click: () => send('buddy-ask-mood') },
    { label: 'How was today?', click: () => send('buddy-ask-day') },
    { label: ball ? 'Put the ball away' : 'Throw a ball', click: toggleBall },
    { label: 'Wardrobe', submenu: wardrobeMenu() },
    { type: 'separator' },
    toggle('Sound', 'sound'),
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
    { label: 'Quit Buddy', click: () => app.quit() },
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
    loadConfig();
    createWindow();
    createTray();
    trackCursor();
    startWatcher();
    startServer();
  });

  app.on('before-quit', () => {
    if (watcher) { const child = watcher; watcher = null; child.kill(); }
  });
  app.on('window-all-closed', () => app.quit());
}
