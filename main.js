const { app, BrowserWindow, Menu, Tray, clipboard, ipcMain, nativeImage, powerMonitor, screen } = require('electron');
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

// Clawd chirps without ever being clicked first
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const PORT = Number(process.env.BUDDY_PORT || 8787);
const MAX_BODY = 256 * 1024; // hook payloads can contain file contents; cap what we read

const WIN_W = 240;
const WIN_H = 280;
// The character is smaller than his window. These are the transparent margins that may hang
// off the edge of the work area so his feet, sides and head (not the window) touch the edges.
const FOOT_PAD = 28;
const SIDE_PAD = 30;
const HEAD_PAD = 130;
const BALL = 56;

const WALK_STEP = 4; // px per tick
const CHASE_STEP = 7;
const PRINT_PACE = 200; // px a second while he is leaving footprints, so they keep step with him
const GRAVITY = 1.2; // px per tick, per tick
const MAX_THROW = 70; // px per tick

let win;
let tray;
let dragOffset = null; // cursor offset inside the window while Clawd is being carried
let dragTrail = []; // recent cursor positions while carried, to work out a throw
let home = null; // where Clawd lives; he wanders from here and comes back
let walk = null; // { x, y, tx, ty } while he is scuttling somewhere on his own
let fall = null; // { x, y, vx, vy, peak, bounces, ground } while he is in the air

// other apps' windows, top-most first, so he can land on and ride their top edges
let watcher = null;
let windows = []; // { h, l, t, r, b, zoomed } in screen DIPs: every window the helper reports
let platforms = []; // the same list while "Sit on windows" is on, otherwise empty
let perch = null; // { h, l, t } of the window he is standing on
let presence = { full: false, mic: false, app: '', game: '', seq: 0 }; // what else the helper notices
let lastApp = '';
let frontH = 0; // the window in front, as the helper numbers it
const printWins = new Set(); // muddy footprints across the screen, for a few seconds
let holding = null; // { until, timer } while he has the pointer and will not give it back
let war = null; // { d0, until, timer } during a tug of war over it
let awayFrom = null; // { perch } while he is sitting on what you are reading, or out roaming
let hiding = null; // hide and seek: { perch } to go back to
let cornerFrom = null; // where he lived before he took himself off to a corner, hurt

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
  typing: true, reminders: true, notice: true, autoQuiet: true, quiet: false, music: false, pages: false, meddle: false, pet: false, loud: true,
};
const PERSONALITIES = ['cheerful', 'sarcastic', 'shy', 'dramatic', 'wise', 'nerdy', 'sleepy', 'anxious'];
const settingsFile = path.join(app.getPath('userData'), 'buddy-settings.json');
let config = {}; // config.json: timings, thresholds and phrases the user can retune
// what the renderer says is unlocked and worn, for the Wardrobe menu
let wardrobe = { tasks: 0, hat: '', color: 'classic', hats: [], colors: [], extras: [] };
let badges = []; // { label, earned }, also from the renderer
let roomItems = []; // { id, label, need, unlocked, on }
let tricks = []; // { id, label, known }
let who = { name: '', code: '', friends: [], words: 0 }; // his name, his code to share, who he knows
let roomState = { on: [], plant: 0, night: false, scarf: 0 }; // what is standing in his room right now
let albumWin = null;
let pomodoro = false;
let quitting = false;
// Local dev tools, if there are any: a dev/ folder next to the app that is not part of the
// repo (see loadDev). Without it none of this does anything.
let dev = null;
let savesHeld = false; // dev sandbox: nothing he remembers is written to disk

// his room: a window of its own with the bed in it, which he walks back to when he is sleepy
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
// It never looks at which key or at anything typed. While "Notice which sites I'm on" is
// switched on it also reads the address bar of the browser in front and prints the site's
// host name, nothing after it. While "Let him mess with my desktop" is switched on it also
// takes orders on stdin (see Hands): it is the one thing here that acts instead of looking.
// Sent to PowerShell on stdin as one line, so the C# must not contain single quotes or line
// comments. With "Listen to my music" on, MUSIC_PS runs beside it (see there).
const WATCH_CS = [
  'using System; using System.Text; using System.Threading; using System.Runtime.InteropServices; using Microsoft.Win32; using UIA = System.Windows.Automation;',
  // the three corners of Windows audio needed to ask how loud the speakers are right now
  'namespace Buddy {',
  '[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumerator { }',
  '[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IMMDeviceEnumerator { int EnumAudioEndpoints(int flow, int mask, out IntPtr devs); int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice dev); }',
  '[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IMMDevice { int Activate(ref Guid iid, int ctx, IntPtr p, [MarshalAs(UnmanagedType.IUnknown)] out object o); }',
  '[ComImport, Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IAudioMeterInformation { int GetPeakValue(out float peak); }',
  '[ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IAudioEndpointVolume { int A(IntPtr p); int B(IntPtr p); int C(out int n); int D(float v, IntPtr g); int E(float v, IntPtr g); int F(out float v); int GetMasterVolumeLevelScalar(out float v); int G(int c, float v, IntPtr g); int H(int c, float v, IntPtr g); int I(int c, out float v); int J(int c, out float v); int K(int m, IntPtr g); int GetMute(out int m); }',
  'public static class Watch {',
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
  '[DllImport("user32.dll")] static extern uint GetClipboardSequenceNumber();',
  '[DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, uint f);',
  '[DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFO i);',
  '[DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);',
  '[DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);',
  '[DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);',
  '[DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint f);',
  '[DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);',
  '[DllImport("user32.dll")] static extern short GetAsyncKeyState(int k);',
  '[DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out int v, int s);',
  '[DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out RECT v, int s);',
  'static readonly object Gate = new object();',
  'public static void Say(string s) { lock (Gate) { Console.Out.WriteLine(s); Console.Out.Flush(); } }',
  // Input arrived and the pointer did not move: a key (or a click or the wheel). Only the
  // moment is known, which is all Clawd needs to bob along. The same goes for the clipboard:
  // Windows counts its changes, and a new count ("C") is all that is ever looked at.
  'static void Keys() {',
  '  LASTINPUT li = new LASTINPUT(); li.cbSize = 8; uint last = 0; POINT was = new POINT(); uint copied = GetClipboardSequenceNumber();',
  '  while (true) {',
  '    POINT p; GetCursorPos(out p);',
  '    if (GetLastInputInfo(ref li) && li.dwTime != last) { bool first = last == 0; last = li.dwTime; if (!first && p.X == was.X && p.Y == was.Y) Say("K"); }',
  '    uint cs = GetClipboardSequenceNumber(); if (cs != copied) { copied = cs; Say("C"); }',
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
  // "Notice which sites I'm on": once a second, if the window in front is a browser (and not
  // one marked private), find its address bar through UI Automation and print the host name.
  // Anything that does not look like a host (a search being typed, an internal page) is "?".
  // On a thread of its own so a slow browser cannot hold up the windows.
  'static void Pages(int owner) {',
  '  string last = null;',
  '  UIA.Condition edit = new UIA.PropertyCondition(UIA.AutomationElement.ControlTypeProperty, UIA.ControlType.Edit);',
  '  while (true) {',
  '    Thread.Sleep(1000);',
  '    try {',
  '      IntPtr fg = GetForegroundWindow(); uint fp = 0; if (fg != IntPtr.Zero) GetWindowThreadProcessId(fg, out fp);',
  '      if (fp == (uint)owner) continue;',
  '      string pg = "";',
  '      if (fp != 0 && "|chrome|msedge|firefox|brave|opera|vivaldi|arc|zen|".IndexOf("|" + System.Diagnostics.Process.GetProcessById((int)fp).ProcessName.ToLower() + "|") >= 0) {',
  '        StringBuilder tb = new StringBuilder(300); GetWindowText(fg, tb, 300); string title = tb.ToString();',
  '        if (title.IndexOf("InPrivate") < 0 && title.IndexOf("Private Browsing") < 0 && title.IndexOf("Incognito") < 0) {',
  '          UIA.AutomationElement bar = UIA.AutomationElement.FromHandle(fg).FindFirst(UIA.TreeScope.Descendants, edit);',
  '          if (bar != null) {',
  '            string v = ((UIA.ValuePattern)bar.GetCurrentPattern(UIA.ValuePattern.Pattern)).Current.Value.Trim().ToLower();',
  '            int i = v.IndexOf("://"); if (i >= 0) v = v.Substring(i + 3);',
  '            i = v.IndexOfAny(new char[] { (char)47, (char)63, (char)35, (char)58, (char)32 }); if (i >= 0) v = v.Substring(0, i);',
  '            pg = System.Text.RegularExpressions.Regex.IsMatch(v, "^[a-z0-9.-]{1,80}[.][a-z]{2,}$") ? v : "?";',
  '          }',
  '        }',
  '      }',
  '      if (pg != last) { last = pg; Say("P " + pg); }',
  '    } catch { }',
  '  }',
  '}',
  // "Let him mess with my desktop": a line from Clawd on stdin and a window gets a shake or a
  // shove sideways, or the pointer a tug. Never a window that is maximised, fills the screen,
  // belongs to the desktop or the taskbar, or while a mouse button is held (something is being
  // dragged). Where each shoved window came from is kept, and "back" slides home every one
  // that is still where he left it. Only ever moved: never resized, raised, focused or closed.
  'static readonly System.Collections.Generic.Dictionary<long, int[]> Moved = new System.Collections.Generic.Dictionary<long, int[]>();',
  'static bool Fair(IntPtr h, int owner) {',
  '  if (h == IntPtr.Zero || !IsWindow(h) || !IsWindowVisible(h) || IsIconic(h) || IsZoomed(h)) return false;',
  '  uint pid; GetWindowThreadProcessId(h, out pid); if (pid == (uint)owner) return false;',
  '  StringBuilder cn = new StringBuilder(64); GetClassName(h, cn, 64); string c = cn.ToString();',
  '  if (c == "Progman" || c == "WorkerW" || c == "Shell_TrayWnd") return false;',
  '  RECT r; MONITORINFO mi = new MONITORINFO(); mi.cbSize = 40;',
  '  if (!GetWindowRect(h, out r) || !GetMonitorInfo(MonitorFromWindow(h, 2), ref mi)) return false;',
  '  return !(r.L <= mi.rcMonitor.L && r.T <= mi.rcMonitor.T && r.R >= mi.rcMonitor.R && r.B >= mi.rcMonitor.B);',
  '}',
  'static void Slide(IntPtr h, int fl, int ft, int tl, int tt, int n) { for (int i = 1; i <= n; i++) { SetWindowPos(h, IntPtr.Zero, fl + (tl - fl) * i / n, ft + (tt - ft) * i / n, 0, 0, 0x15); Thread.Sleep(16); } }',
  'static bool Shake(IntPtr h) {',
  '  RECT r; if (!GetWindowRect(h, out r)) return false;',
  '  bool ok = true; int[] o = new int[] { -10, 10, -8, 8, -6, 6, -3, 3, 0 };',
  '  foreach (int d in o) { ok &= SetWindowPos(h, IntPtr.Zero, r.L + d, r.T, 0, 0, 0x15); Thread.Sleep(30); }',
  '  return ok;',
  '}',
  // a shove is quick and goes the other way if there is no room; a tow is slow and goes where it is told
  'static bool Shove(IntPtr h, int dx, bool tow) {',
  '  RECT r; MONITORINFO mi = new MONITORINFO(); mi.cbSize = 40;',
  '  if (!GetWindowRect(h, out r) || !GetMonitorInfo(MonitorFromWindow(h, 2), ref mi)) return false;',
  '  int lo = Math.Min(r.L, mi.rcWork.L); int hi = Math.Max(r.L, mi.rcWork.R - (r.R - r.L));',
  '  int to = Math.Max(lo, Math.Min(hi, r.L + dx)); if (!tow && Math.Abs(to - r.L) < 24) to = Math.Max(lo, Math.Min(hi, r.L - dx));',
  '  if (Math.Abs(to - r.L) < 24) return false;',
  '  long k = h.ToInt64(); int[] m;',
  '  if (!Moved.TryGetValue(k, out m) || m[2] != r.L || m[3] != r.T) m = new int[] { r.L, r.T, 0, 0 };',
  '  Slide(h, r.L, r.T, to, r.T, tow ? 140 : 12);',
  '  RECT n; if (!GetWindowRect(h, out n) || n.L == r.L) return false;',
  '  m[2] = n.L; m[3] = n.T; Moved[k] = m; return true;',
  '}',
  'static void Back() {',
  '  foreach (System.Collections.Generic.KeyValuePair<long, int[]> e in Moved) {',
  '    IntPtr h = new IntPtr(e.Key); RECT r;',
  '    if (IsWindow(h) && !IsIconic(h) && !IsZoomed(h) && GetWindowRect(h, out r) && r.L == e.Value[2] && r.T == e.Value[3]) Slide(h, r.L, r.T, e.Value[0], e.Value[1], 12);',
  '  }',
  '  Moved.Clear();',
  '}',
  'static bool Tug(int dx, int dy) { POINT p; if (!GetCursorPos(out p)) return false; for (int i = 1; i <= 16; i++) { SetCursorPos(p.X + dx * i / 16, p.Y + dy * i / 16); Thread.Sleep(14); } return true; }',
  // one order a line: "D shake|shove|tow|tug|grab|back <window, 0 = the one in front> <dx> <dy>",
  // answered with "D <order> 1" if something moved. "pull" is one small step of the pointer
  // with no answer, for holding on to it. If Clawd goes away, everything is put back first.
  'static void Hands(int owner) {',
  '  while (true) {',
  '    string s = Console.In.ReadLine(); if (s == null) { Back(); return; }',
  '    string[] a = s.Trim().Split((char)32); if (a.Length != 5 || a[0] != "D") continue;',
  '    bool ok = false;',
  '    try {',
  '      if (a[1] == "back") { Back(); continue; }',
  '      long w = long.Parse(a[2]); int x = int.Parse(a[3]); int y = int.Parse(a[4]);',
  '      if (GetAsyncKeyState(1) >= 0 && GetAsyncKeyState(2) >= 0) {',
  '        if (a[1] == "pull") { POINT p; if (GetCursorPos(out p)) SetCursorPos(p.X + x, p.Y + y); continue; }',
  '        if (a[1] == "tug" || a[1] == "grab") ok = Tug(x, y);',
  '        else { IntPtr h = w == 0 ? GetForegroundWindow() : new IntPtr(w); if (Fair(h, owner)) ok = a[1] == "shove" ? Shove(h, x, false) : a[1] == "tow" ? Shove(h, x, true) : a[1] == "shake" && Shake(h); }',
  '      } else if (a[1] == "pull") continue;',
  '    } catch { }',
  '    Say("D " + a[1] + (ok ? " 1" : " 0"));',
  '  }',
  '}',
  // "Jump at loud sounds": twenty times a second, ask Windows for the level meter of whatever
  // the speakers are playing (one number, the same one the volume mixer draws) and the volume
  // it is set to. Nothing is recorded and no microphone is involved. A level that is both
  // fairly loud and well above how things have sounded for the last couple of seconds prints
  // "L". The volume counts by its square root, so turning it down does not make him deaf.
  'static void Ears() {',
  '  IAudioMeterInformation meter = null; IAudioEndpointVolume vol = null; int n = 0; float usual = 0; int rest = 0; float knob = 1;',
  '  while (true) {',
  '    Thread.Sleep(50);',
  '    try {',
  '      if (meter == null || n % 200 == 0) {',
  '        IMMDevice dev; ((IMMDeviceEnumerator)(new MMDeviceEnumerator())).GetDefaultAudioEndpoint(0, 1, out dev);',
  '        Guid mi = typeof(IAudioMeterInformation).GUID; object mo; dev.Activate(ref mi, 23, IntPtr.Zero, out mo); meter = (IAudioMeterInformation)mo;',
  '        Guid vi = typeof(IAudioEndpointVolume).GUID; object vo; dev.Activate(ref vi, 23, IntPtr.Zero, out vo); vol = (IAudioEndpointVolume)vo;',
  '      }',
  '      if (n++ % 10 == 0) { float v; int muted; vol.GetMasterVolumeLevelScalar(out v); vol.GetMute(out muted); knob = muted != 0 ? 0 : (float)Math.Sqrt(v); }',
  '      float peak; meter.GetPeakValue(out peak); float now = peak * knob;',
  '      if (rest > 0) rest--;',
  '      else if (now > 0.12f && now > usual * 2 + 0.08f) { rest = 40; Say("L " + (int)(now * 100)); }',
  '      usual = usual * 0.97f + now * 0.03f;',
  '    } catch { meter = null; Thread.Sleep(3000); }',
  '  }',
  '}',
  'public static void Run(int owner, int ms, int sites, int hands, int ears) {',
  '  Thread t = new Thread(new ThreadStart(Keys)); t.IsBackground = true; t.Start();',
  '  if (sites != 0) { Thread p = new Thread(delegate() { Pages(owner); }); p.IsBackground = true; p.Start(); }',
  '  if (hands != 0) { Thread d = new Thread(delegate() { Hands(owner); }); d.IsBackground = true; d.Start(); }',
  '  if (ears != 0) { Thread e = new Thread(new ThreadStart(Ears)); e.IsBackground = true; e.Start(); }',
  '  string last = null; string lastFront = null; int n = 0; int full = 0; int mic = 0; uint frontPid = 0; string front = ""; IntPtr lastFg = IntPtr.Zero;',
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
  '      if (fg != lastFg) { lastFg = fg; Say("A " + fg.ToInt64()); }',
  '      if (fp != frontPid) { frontPid = fp; try { front = System.Diagnostics.Process.GetProcessById((int)fp).ProcessName; } catch { front = ""; } }',
  '    }',
  '    if (n % 20 == 1) mic = Mic() ? 1 : 0;',
  '    string f = full + " " + mic + " " + front;',
  '    if (f != lastFront) { lastFront = f; Say("F " + f); }',
  '    Thread.Sleep(ms);',
  '  }',
  '}',
  // the same on a thread of its own, leaving PowerShell free to run MUSIC_PS
  'public static void Go(int owner, int ms, int sites, int hands, int ears) { Thread t = new Thread(delegate() { Run(owner, ms, sites, hands, ears); Environment.Exit(0); }); t.Start(); }',
  '} }',
].join(' ');

// "Listen to my music": every two seconds, ask Windows what is playing (the same thing its
// own media flyout shows) and print a line when that changes: the title, the artist and the
// program it comes from, in base64 so nothing in a title can break the line. Only sent to the
// helper while the setting is on.
const MUSIC_PS = [
  'try { Add-Type -AssemblyName System.Runtime.WindowsRuntime;',
  '$at = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq \'AsTask\' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq \'IAsyncOperation`1\' })[0];',
  'function Aw($o, $t) { $k = $at.MakeGenericMethod($t).Invoke($null, @($o)); if ($k.Wait(3000)) { $k.Result } };',
  '$MT = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime];',
  '$PT = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties,Windows.Media.Control,ContentType=WindowsRuntime];',
  '$mgr = Aw ($MT::RequestAsync()) $MT; $was = \'\';',
  'while ($mgr) { $now = \'M 0\';',
  '  try { $s = @($mgr.GetCurrentSession()) + @($mgr.GetSessions()) | Where-Object { $_ -and [int]$_.GetPlaybackInfo().PlaybackStatus -eq 4 } | Select-Object -First 1;',
  '    if ($s) { $p = Aw ($s.TryGetMediaPropertiesAsync()) $PT; if ($p -and $p.Title) { $now = \'M 1 \' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($s.SourceAppUserModelId + [char]9 + $p.Title + [char]9 + $p.Artist)) } } } catch { }',
  '  if ($now -ne $was) { $was = $now; [Buddy.Watch]::Say($now) }',
  '  Start-Sleep -Milliseconds 2000 } } catch { }',
].join(' ');

// The program in front, boiled down to a kind of activity. Only the kind reaches Clawd.
const APP_KINDS = [
  ['claude', /^claude$/i],
  ['editor', /^(code|code - insiders|cursor|windsurf|zed|devenv|idea64|pycharm64|webstorm64|rider64|clion64|goland64|sublime_text|notepad\+\+|notepad|gvim|nvim-qt|neovide)$/i],
  ['terminal', /^(windowsterminal|cmd|powershell|pwsh|wezterm-gui|alacritty|conhost|mintty|warp|tabby)$/i],
  ['browser', /^(chrome|msedge|firefox|brave|opera|vivaldi|arc|zen)$/i],
  ['chat', /^(discord|slack|telegram|ms-teams|teams|whatsapp|signal|zoom|element)$/i],
  ['music', /^(spotify|applemusic|foobar2000|musicbee|vlc|mpv|mpc-hc64|wmplayer|tidal)$/i],
  ['art', /^(blender|photoshop|illustrator|figma|krita|gimp.*|aseprite|inkscape|afterfx|resolve|paintdotnet)$/i],
  ['taking', /^(ida64|ida|idaq64|ghidra.*|x64dbg|x32dbg|cheatengine.*|dnspy|ilspy)$/i],
  ['ai', /^(chatgpt|copilot|perplexity|gemini|lm studio|ollama app)$/i],
  ['files', /^explorer$/i],
  ['game', /^(steam|steamwebhelper|epicgameslauncher|galaxyclient|playnite.*)$/i],
];

// A game is the one program Clawd knows by name: whatever fills the screen and is not on
// the lists above or this one. The name is the program's file name, tidied up.
const NOT_GAMES = /^(powerpnt|mstsc|vmware.*|virtualbox.*|obs64|obs32|photos|applicationframehost|potplayer.*|kodi|searchhost|lockapp|shellexperiencehost|snippingtool|screenclippinghost|video\.ui|microsoft\.media\.player)$/i;
const GAME_NAMES = {
  javaw: 'Minecraft', cs2: 'Counter-Strike 2', dota2: 'Dota 2', rocketleague: 'Rocket League', eldenring: 'Elden Ring',
  bg3: 'Baldur\'s Gate 3', bg3_dx11: 'Baldur\'s Gate 3', gta5: 'GTA V', witcher3: 'The Witcher 3', hl2: 'Half-Life 2',
  robloxplayerbeta: 'Roblox', fortniteclient: 'Fortnite', leagueclient: 'League of Legends', r5apex: 'Apex Legends',
};
function gameName(exe) {
  const bare = exe.toLowerCase().replace(/[-_ ]?(win64|win32|x64|x86)?[-_ ]?shipping$/, '').replace(/[-_ ]?(win64|x64)$/, '');
  if (GAME_NAMES[bare]) return GAME_NAMES[bare];
  const words = exe.replace(/[-_ ]?(win64|win32|x64|x86)?[-_ ]?shipping$/i, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().slice(0, 24).trim();
  return words.length <= 4 ? words.toUpperCase() : words.replace(/(^| )\p{Ll}/gu, (c) => c.toUpperCase());
}

function onFront(line) {
  const m = /^(\d) (\d) (.*)$/.exec(line);
  if (!m) return;
  const name = m[3].trim().slice(0, 60);
  const full = m[1] === '1';
  const hit = APP_KINDS.find(([, re]) => re.test(name));
  // something unknown filling the whole screen is most likely a game or a film
  const app = hit ? hit[0] : full && name ? 'game' : '';
  const game = !hit && app === 'game' && settings.notice && !NOT_GAMES.test(name) ? gameName(name) : '';
  presence = { full, mic: m[2] === '1', app: settings.notice ? app : '', game, seq: presence.seq + (name !== lastApp ? 1 : 0) };
  lastApp = name;
  send('buddy-presence', presence);
}

// "Is it for me?": a new file in the Downloads folder. Clawd is told its extension and its
// size, like a dropped snack, and nothing else about it.
function watchDownloads() {
  const pending = new Map();
  const told = new Map();
  try {
    const dir = app.getPath('downloads');
    fs.watch(dir, (_ev, name) => {
      if (!settings.notice || typeof name !== 'string' || name.startsWith('.') || /\.(crdownload|part|partial|download|tmp|opdownload)$/i.test(name)) return;
      clearTimeout(pending.get(name));
      pending.set(name, setTimeout(() => {
        pending.delete(name);
        fs.stat(path.join(dir, name), (err, st) => {
          const now = Date.now();
          if (err || !st.isFile() || now - Math.max(st.birthtimeMs, st.ctimeMs) > 60000 || now - (told.get(name) || 0) < 600000) return;
          if (told.size > 200) told.clear();
          told.set(name, now);
          send('buddy-download', { ext: ((/\.([a-z0-9]{1,8})$/i.exec(name) || [])[1] || '').toLowerCase(), size: st.size });
        });
      }, 1500));
    }).on('error', () => {});
  } catch {}
}

// Where a tune comes from, as a kind: a music player, or a browser (where it may be a video).
const TUNE_PLAYERS = /spotify|applemusic|itunes|zunemusic|foobar|musicbee|tidal|deezer|winamp|aimp|amazon.?music|yandex.?music/i;
const TUNE_BROWSERS = /chrome|msedge|firefox|308046B0AF4A39CB|brave|opera|vivaldi|arc|zen/i;
const tidy = (s, n) => String(s || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, n);

function onMusic(line) {
  if (!settings.music) return;
  const m = /^1 ([A-Za-z0-9+/=]{1,4000})$/.exec(line);
  let tune = null;
  if (m) {
    const [src, title, artist] = Buffer.from(m[1], 'base64').toString('utf8').split('\t');
    if (tidy(title, 80)) {
      tune = { title: tidy(title, 80), artist: tidy(artist, 60), from: TUNE_PLAYERS.test(src) ? 'player' : TUNE_BROWSERS.test(src) ? 'browser' : '' };
    }
  }
  send('buddy-music', tune);
}

// The site in front, boiled down to a kind from its host name. Only the kind reaches Clawd,
// and the host is not kept. First match wins, so the google.com subdomains come before search.
const SITE_KINDS = [
  ['call', /(^|\.)(meet\.google\.com|zoom\.us|teams\.microsoft\.com|teams\.live\.com|whereby\.com)$/],
  // explicit sites: the best-known ones by name, the adult top-level domains, and any host that says so itself
  ['adult', /(^|\.)(pornhub\.[a-z]+|xvideos\.[a-z0-9]+|xnxx\.[a-z]+|xhamster[a-z0-9]*\.[a-z]+|redtube\.com|youporn\.com|spankbang\.com|eporner\.com|tube8\.com|youjizz\.com|beeg\.com|tnaflix\.com|motherless\.com|brazzers\.com|onlyfans\.com|rule34\.xxx|fansly\.com|chaturbate\.com|stripchat\.com|bongacams\.com|cam4\.com|myfreecams\.com|livejasmin\.com|literotica\.com|f95zone\.to|iwara\.tv|hanime\.tv|e-hentai\.org|exhentai\.org|gelbooru\.com|e621\.net|rule34\.[a-z.]+)$|\.(xxx|porn|sex|adult)$|porn|hentai|xxx(?!l)/],
  ['code', /(^|\.)(github\.com|gitlab\.com|bitbucket\.org|stackoverflow\.com|stackexchange\.com|npmjs\.com|developer\.mozilla\.org)$/],
  ['claude', /(^|\.)(claude\.ai|claude\.com|anthropic\.com)$/],
  ['ai', /(^|\.)(chatgpt\.com|openai\.com|gemini\.google\.com|aistudio\.google\.com|copilot\.microsoft\.com|perplexity\.ai|deepseek\.com|grok\.com|mistral\.ai|meta\.ai|poe\.com|character\.ai)$/],
  ['video', /(^|\.)(youtube\.com|twitch\.tv|netflix\.com|vimeo\.com|disneyplus\.com|primevideo\.com|hulu\.com|crunchyroll\.com)$/],
  ['social', /(^|\.)(reddit\.com|twitter\.com|x\.com|instagram\.com|facebook\.com|tiktok\.com|bsky\.app|linkedin\.com|threads\.net|threads\.com|tumblr\.com|mastodon\.social)$/],
  ['shop', /(^|\.)(amazon\.[a-z.]+|ebay\.[a-z.]+|aliexpress\.[a-z]+|etsy\.com|temu\.com)$/],
  ['mail', /(^|\.)(mail\.google\.com|outlook\.live\.com|outlook\.office\.com|mail\.proton\.me|mail\.yahoo\.com)$/],
  ['docs', /(^|\.)(docs\.google\.com|notion\.so|overleaf\.com|atlassian\.net)$/],
  ['wiki', /(^|\.)(wikipedia\.org|fandom\.com)$/],
  ['search', /(^|\.)(google\.[a-z.]+|bing\.com|duckduckgo\.com)$/],
];
let lastSite = '';

function onPage(host) {
  if (!settings.pages) return;
  const ok = /^[a-z0-9.?-]{1,100}$/.test(host);
  const hit = ok && SITE_KINDS.find(([, re]) => re.test(host));
  const kind = hit ? hit[0] : ok ? 'other' : '';
  if (kind === lastSite) return;
  lastSite = kind;
  send('buddy-page', kind);
}

function onWindows(line) {
  if (line === 'K') { if (settings.typing) send('buddy-key'); return; }
  if (line === 'C') { if (settings.notice) send('buddy-copy'); return; }
  if (line.startsWith('F ')) return onFront(line.slice(2));
  if (line.startsWith('M ')) return onMusic(line.slice(2));
  if (line === 'P' || line.startsWith('P ')) return onPage(line.slice(2));
  if (line.startsWith('A ')) { frontH = Number(line.slice(2)) || 0; return; }
  if (line.startsWith('L ')) { if (settings.loud) send('buddy-loud', Math.min(100, Math.max(0, Number(line.slice(2)) || 0))); return; }
  if (line.startsWith('D ')) {
    const m = /^D (shake|shove|tug|grab|tow) ([01])$/.exec(line);
    if (m && m[1] === 'grab') onGrab(m[2] === '1');
    else if (m && settings.meddle) send('buddy-meddled', { what: m[1], ok: m[2] === '1' });
    return;
  }
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
    if (watcher !== child) return; // replaced by restartWatcher
    watcher = null;
    windows = [];
    platforms = [];
  });
  child.stdin.on('error', () => {});
  const args = `${process.pid}, 120, ${settings.pages ? 1 : 0}, ${settings.meddle ? 1 : 0}, ${settings.loud ? 1 : 0}`;
  const run = settings.music ? `[Buddy.Watch]::Go(${args}); ${MUSIC_PS}` : `[Buddy.Watch]::Run(${args})`;
  child.stdin.write(`Add-Type -ReferencedAssemblies UIAutomationClient, UIAutomationTypes -TypeDefinition '${WATCH_CS}'; ${run}\n`);
}

// "Listen to my music" or "Notice which sites I'm on" was switched: the helper only reads
// what is playing, or the browser's address bar, while that one is on
function restartWatcher() {
  if (watcher) { const child = watcher; watcher = null; child.kill(); }
  startWatcher();
}

// ---- meddling: "Let him mess with my desktop" ----

// The renderer decides when he is cross, jealous or up to something; this decides what he
// goes after and how he gets there. He walks, floats or jumps over to it first (approach),
// and only then is the helper asked to move anything (act). The helper has the last word on
// whether a window is fair game (see Hands).
ipcMain.on('buddy-meddle', (_e, what) => {
  if (!settings.meddle || !win || win.isDestroyed()) return;
  if (what === 'back') { if (watcher) watcher.stdin.write('D back 0 0 0\n'); return; }
  if (what === 'letgo') return endHold('click');
  if (what === 'unblock') return comeBack(6);
  if (what === 'prints') {
    // the walk reports back when he gets to the end of the trail
    if (presence.full || dragOffset || fall || walk || chase || holding || war || !printsToPointer()) send('buddy-meddled', { what, ok: false });
    return;
  }
  if (!['shake', 'shove', 'tow', 'tug', 'hold', 'war', 'block'].includes(what)) return;
  if (presence.full || dragOffset || fall || walk || chase || holding || war) return send('buddy-meddled', { what, ok: false });
  if (what === 'war') startWar();
  else if (what === 'block') block();
  else if (what === 'tug' || what === 'hold') stalkPointer(what);
  else stalkWindow(what);
});

// he is where he is going to get: now the shake, the shove or the tug itself
function act(what, h) {
  let order = '';
  if (win && !win.isDestroyed() && settings.meddle && !presence.full && !dragOffset && !fall) {
    const { dx, dy, d, scale } = toHim();
    if (what === 'tug') {
      // the pointer comes part of the way over to him, if it is near enough to reach
      const k = Math.min(0.6, 280 / d) * scale;
      if (d > 60 && d < 900) order = `D tug 0 ${Math.round(dx * k)} ${Math.round(dy * k)}`;
    } else if (what === 'hold') {
      // all the way, into his arms
      if (d <= 30) return onGrab(true);
      if (d < 900) order = `D grab 0 ${Math.round(dx * scale)} ${Math.round(dy * scale)}`;
    } else if (what === 'tow') {
      // off towards his bed with it, or the nearest side of the screen if he has none
      const p = windows.find((q) => q.h === h);
      const a = area();
      if (p) {
        const mid = (p.l + p.r) / 2;
        const bed = bedWin && !bedWin.isDestroyed() ? bedWin.getBounds().x + BED_W / 2 : null;
        const goal = bed !== null ? bed : mid < a.x + a.width / 2 ? a.x + (p.r - p.l) / 2 : a.x + a.width - (p.r - p.l) / 2;
        if (Math.abs(goal - mid) > 80) order = `D tow ${h} ${Math.round((goal - mid) * scale)} 0`;
      }
      if (order) send('buddy-meddled', { what: 'towing', ok: true });
    } else {
      const far = Math.round((70 + Math.random() * 90) * scale) * (Math.random() < 0.5 ? -1 : 1);
      order = `D ${what} ${h || 0} ${what === 'shove' ? far : 0} 0`;
    }
  }
  if (!order || !watcher) return send('buddy-meddled', { what, ok: false });
  watcher.stdin.write(order + '\n');
}

// from the pointer to his middle, in screen DIPs, and the scale the helper works at
function toHim() {
  const b = win.getBounds();
  const c = screen.getCursorScreenPoint();
  const dx = b.x + WIN_W / 2 - c.x;
  const dy = b.y + WIN_H * 0.6 - c.y;
  return { dx, dy, d: Math.hypot(dx, dy) || 1, scale: screen.getDisplayNearestPoint(c).scaleFactor || 1 };
}

// He has the pointer and is not giving it back: every time it gets away it is fetched again.
// A click on him ends it (the renderer says so), and it ends by itself after a few seconds.
// Holding a mouse button down always gets it free, since the helper will not move it then.
function onGrab(ok) {
  if (!ok || holding || !settings.meddle) return send('buddy-meddled', { what: 'hold', ok: false });
  holding = { until: Date.now() + 8000, timer: setInterval(holdTick, 50) };
  send('buddy-meddled', { what: 'hold', ok: true });
}

function holdTick() {
  if (!holding) return;
  if (!win || win.isDestroyed() || !watcher || !settings.meddle || presence.full || dragOffset || fall || Date.now() > holding.until) return endHold('time');
  const { dx, dy, d, scale } = toHim();
  if (d > 24) watcher.stdin.write(`D pull 0 ${Math.round(dx * scale * 0.8)} ${Math.round(dy * scale * 0.8)}\n`);
}

function endHold(by) {
  if (!holding) return;
  clearInterval(holding.timer);
  holding = null;
  send('buddy-meddled', { what: 'letgo', ok: true, by });
}

// Tug of war: for four seconds he hauls the pointer towards himself a little at a time. Get
// it further away than it started and you win; let it reach him and he does.
function startWar() {
  const { d } = toHim();
  if (!watcher || d < 90 || d > 900) return send('buddy-meddled', { what: 'war', ok: false });
  war = { d0: d, until: Date.now() + 4000, timer: setInterval(warTick, 60) };
  send('buddy-meddled', { what: 'war', ok: true });
}

function warTick() {
  if (!war) return;
  const over = (won) => {
    clearInterval(war.timer);
    const was = war;
    war = null;
    send('buddy-meddled', { what: 'warover', ok: true, won: won || (was.last > was.d0 + 30 ? 'you' : was.last < was.d0 - 30 ? 'him' : 'draw') });
  };
  if (!win || win.isDestroyed() || !watcher || !settings.meddle || presence.full || dragOffset || fall) return over('draw');
  const { dx, dy, d, scale } = toHim();
  war.last = d;
  if (d < 60) return over('him');
  if (d > war.d0 + 420) return over('you');
  if (Date.now() > war.until) return over('');
  const k = (9 * scale) / d;
  watcher.stdin.write(`D pull 0 ${Math.round(dx * k)} ${Math.round(dy * k)}\n`);
}

// Sitting on what you are reading: he goes and plants himself over the pointer, wherever on
// the screen that is, and stays there until the renderer says he may go back ('unblock').
function block() {
  if (!settings.wander) return send('buddy-meddled', { what: 'block', ok: false });
  const c = screen.getCursorScreenPoint();
  const a = screen.getDisplayNearestPoint(c).workArea;
  if (!awayFrom) awayFrom = { perch };
  perch = null;
  errand(clampX(a, c.x - WIN_W / 2), Math.min(Math.max(c.y - WIN_H * 0.55, a.y - HEAD_PAD), floorY(a)), () => send('buddy-meddled', { what: 'block', ok: true }));
}

// back to where he lives, and onto the window he was standing on if that is where it was
function comeBack(step) {
  if (!win || win.isDestroyed() || dragOffset || fall) return send('buddy-walk-done');
  const b = win.getBounds();
  walk = { x: b.x, y: b.y, tx: home.x, ty: home.y, perch: awayFrom ? awayFrom.perch : null, step };
  awayFrom = null;
}

// Nobody has touched the computer for a while: he has the run of the screen. Each call is
// one leg to somewhere new, with footprints behind him; false sends him scrambling home.
ipcMain.on('buddy-roam', (_e, on) => {
  if (!win || win.isDestroyed()) return;
  if (!on) return awayFrom ? comeBack(14) : send('buddy-walk-done');
  if (!settings.meddle || !settings.wander || dragOffset || fall || presence.full || chase) return send('buddy-walk-done');
  if (!awayFrom) awayFrom = { perch };
  perch = null;
  const a = area();
  const b = win.getBounds();
  const tx = a.x + Math.random() * (a.width - WIN_W);
  const ty = Math.min(a.y + Math.random() * (a.height - WIN_H * 0.6) - HEAD_PAD / 2, floorY(a));
  showPrints({ x: b.x + WIN_W / 2, y: b.y + WIN_H - FOOT_PAD }, { x: tx + WIN_W / 2, y: ty + WIN_H - FOOT_PAD });
  walk = { x: b.x, y: b.y, tx, ty, pace: PRINT_PACE };
});

// Where he would stand on window number i of the list: on its top edge, as near to where he
// is now as its width allows. Nothing if it is maximised, off his screen, too near the top
// of it for him to fit, or covered there by a window above.
function footing(i) {
  const p = windows[i];
  if (!p || p.zoomed || p.r - p.l < 120) return null;
  const a = area();
  const inset = Math.min(70, (p.r - p.l) / 2);
  const sx = Math.min(Math.max(win.getBounds().x + WIN_W / 2, p.l + inset), p.r - inset);
  const y = p.t - (WIN_H - FOOT_PAD);
  if (sx < a.x || sx > a.x + a.width || y < a.y - HEAD_PAD + 10 || p.t > a.y + a.height - 8) return null;
  for (let j = 0; j < i; j++) {
    const q = windows[j];
    if (sx >= q.l && sx <= q.r && p.t >= q.t && p.t <= q.b) return null;
  }
  return { h: p.h, sx, y };
}

// a purposeful walk, quicker than a wander, with something to do at the end of it
function errand(tx, ty, then, pace = 0) {
  const b = win.getBounds();
  walk = { x: b.x, y: b.y, tx, ty, step: 6, pace, then };
  send('buddy-meddling');
}

// The window he is after is the one in front, or failing that the top-most one he can get
// onto. Standing on it already, he gets on with it; otherwise he goes there first.
function stalkWindow(what) {
  // only a small window is worth dragging home
  const a = area();
  const fits = (i) => (what !== 'tow' || (windows[i].r - windows[i].l < a.width * 0.6 && windows[i].b - windows[i].t < a.height * 0.75) ? footing(i) : null);
  const front = windows.findIndex((p) => p.h === frontH);
  let spot = front >= 0 ? fits(front) : null;
  for (let i = 0; !spot && i < windows.length; i++) spot = fits(i);
  if (what === 'tow' && !spot) return act(what, 0);
  if (perch && (!spot || spot.h === perch.h)) return act(what, perch.h);
  if (!spot || !settings.wander) return act(what, perch ? perch.h : frontH);
  const b = win.getBounds();
  const gap = spot.sx - (b.x + WIN_W / 2);
  if (!settings.gravity) return errand(spot.sx - WIN_W / 2, spot.y, () => act(what, spot.h)); // floats up to it
  if (!platforms.length) return errand(clampX(area(), spot.sx - WIN_W / 2), b.y, () => act(what, spot.h)); // as near as the floor gets
  // on the floor and a long way off: a run-up first, then the jump
  if (!perch && Math.abs(gap) > 220) return errand(clampX(area(), b.x + gap - Math.sign(gap) * 150), b.y, () => leap(what, spot.h));
  leap(what, spot.h);
}

// A jump onto a window: up over its top edge and down onto it, by the same physics as a fall.
function leap(what, h) {
  const spot = footing(windows.findIndex((p) => p.h === h));
  if (!spot || !platforms.length || dragOffset || fall) return act(what, h);
  const b = win.getBounds();
  const room = Math.max(0, Math.min(b.y, spot.y) - (area().y - HEAD_PAD));
  const rise = b.y - Math.min(b.y, spot.y) + Math.min(60, room);
  // fly it through once to see how many ticks it takes, so the sideways speed comes out right
  let vy0 = -(Math.sqrt(2 * GRAVITY * rise) + GRAVITY);
  let ticks = 0;
  for (let tries = 0; tries < 8; tries++) {
    let y = b.y;
    let vy = vy0;
    let top = y;
    for (ticks = 0; ticks < 600 && !(vy > 0 && y >= spot.y); ticks++) { vy += GRAVITY; y += vy; top = Math.min(top, y); }
    if (top <= spot.y - 2 || spot.y >= b.y) break;
    vy0 -= 2;
  }
  let reach = 0;
  for (let k = 1; k <= ticks; k++) reach += 0.995 ** k;
  perch = null;
  walk = null;
  fall = {
    x: b.x, y: b.y, vx: (spot.sx - WIN_W / 2 - b.x) / (reach || 1), vy: vy0, peak: 0, bounces: 0, ground: null, jump: true,
    // wherever he came down, that is the one that gets it
    then: () => act(what, perch ? perch.h : h),
  };
  send('buddy-fly', { speed: 0, jump: true });
}

// After the pointer: he goes over until it is within reach, then grabs it.
function stalkPointer(what) {
  const b = win.getBounds();
  const c = screen.getCursorScreenPoint();
  const dx = c.x - (b.x + WIN_W / 2);
  const dy = c.y - (b.y + WIN_H / 2);
  if (!settings.wander) return act(what);
  if (!settings.gravity) {
    const d = Math.hypot(dx, dy);
    if (d <= 220) return act(what);
    const a = screen.getDisplayNearestPoint(c).workArea;
    return errand(clampX(a, b.x + dx * (d - 150) / d), Math.min(Math.max(b.y + dy * (d - 150) / d, a.y), a.y + a.height - WIN_H), () => act(what));
  }
  // with gravity he can only get underneath it, along the floor or the window he is on
  let tx = clampX(area(), c.x - Math.sign(dx) * 110 - WIN_W / 2);
  const p = perch && platforms.find((q) => q.h === perch.h);
  if (p) tx = Math.min(Math.max(tx, p.l + 20 - WIN_W / 2), p.r - 20 - WIN_W / 2);
  if (Math.abs(dx) <= 170 || Math.abs(tx - b.x) < 30) return act(what);
  errand(tx, b.y, () => act(what));
}

// Footprints from where he stands to where the pointer is, in a window of their own that
// clicks pass straight through, and he walks along them as they appear. Gone in a few seconds.
function printsToPointer() {
  if (printWins.size || !win || win.isDestroyed() || !settings.wander) return false;
  const a = area();
  const b = win.getBounds();
  const c = screen.getCursorScreenPoint();
  const from = { x: b.x + WIN_W / 2, y: b.y + WIN_H - FOOT_PAD };
  let to = { x: Math.min(Math.max(c.x, a.x), a.x + a.width), y: Math.min(Math.max(c.y, a.y), a.y + a.height) };
  if (Math.hypot(to.x - from.x, to.y - from.y) < 260) to = { x: a.x + a.width - (from.x - a.x), y: a.y + a.height * 0.3 };
  // he makes them himself: he walks the same line, and each one appears as he passes, wherever on the
  // screen it leads, and the renderer sends him home again afterwards
  const tx = clampX(a, to.x - WIN_W / 2);
  const ty = Math.min(Math.max(to.y - (WIN_H - FOOT_PAD), a.y - HEAD_PAD), floorY(a));
  if (!showPrints(from, { x: tx + WIN_W / 2, y: ty + WIN_H - FOOT_PAD })) return false;
  if (!awayFrom) awayFrom = { perch };
  perch = null;
  errand(tx, ty, () => send('buddy-meddled', { what: 'prints', ok: true }), PRINT_PACE);
  return true;
}

// a trail between two points on his screen; a few trails can be fading at once
function showPrints(from, to) {
  if (printWins.size >= 3 || !win || win.isDestroyed()) return false;
  const a = area();
  const w = new BrowserWindow({
    x: a.x,
    y: a.y,
    width: a.width,
    height: a.height,
    frame: false,
    transparent: true,
    resizable: false,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  printWins.add(w);
  w.setIgnoreMouseEvents(true);
  w.setAlwaysOnTop(true, 'floating');
  w.webContents.on('will-navigate', (e) => e.preventDefault());
  w.once('ready-to-show', () => {
    w.showInactive();
    if (win && !win.isDestroyed()) win.moveTop(); // he stands on them, not under
  });
  w.on('closed', () => printWins.delete(w));
  w.loadFile('prints.html', { hash: [from.x - a.x, from.y - a.y, to.x - a.x, to.y - a.y, PRINT_PACE].map(Math.round).join(',') });
  setTimeout(() => { if (!w.isDestroyed()) w.close(); }, 15000);
  return true;
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

// The window he stands on moved, resized, closed or got covered.
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

// walked (or chased a ball) past the end of the window he was standing on
function checkPerchEdge() {
  if (!perch) return;
  const p = platforms.find((q) => q.h === perch.h);
  const cx = win.getBounds().x + WIN_W / 2;
  if (!p || cx < p.l || cx > p.r) dropFromPerch();
}

// Where a falling Clawd would come to rest this tick: the floor, or a window top he just
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
  // a walk with a pace goes by the clock, not by the tick, so it takes exactly as long as planned
  const tick = Date.now();
  const step = walk.pace ? (walk.pace * Math.min(100, tick - (walk.at || tick - 16))) / 1000 : walk.step || WALK_STEP;
  walk.at = tick;
  const done = d <= step;
  walk.x = done ? walk.tx : walk.x + (dx / d) * step;
  walk.y = done ? walk.ty : walk.y + (dy / d) * step;
  setPos(walk.x, walk.y);
  if (done) {
    if (walk.setHome) home = { x: Math.round(walk.tx), y: Math.round(walk.ty) };
    const back = walk.perch;
    const then = walk.then;
    const corner = walk.corner;
    walk = null;
    if (back) { perch = back; followPerch(); } // home was on top of a window
    send('buddy-walk-done', corner ? { corner } : undefined);
    if (then) then(); // he came over here to do something
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
    if (f.jump && ground.h) {
      // a jump he meant: he lands where he aimed and stays there
      f.vx = f.vy = 0;
      landed = true;
    } else if (f.vy > 6) {
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
    send('buddy-landed', { impact: f.peak, bounces: f.bounces, perch: !!perch, jump: !!f.jump, down: !!f.down });
    if (f.then) f.then();
  }
}

function stepChase(now) {
  const b = win.getBounds();
  const dx = ball.x + BALL / 2 - (b.x + WIN_W / 2);
  // without gravity he floats, so he has to fly over to the ball's height as well
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

// Polls the cursor so Clawd can watch it anywhere on screen, and moves the windows while
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
  cornerFrom = null; // put somewhere by hand: that is home now
  awayFrom = null;
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
  if (!ox && !oy && awayFrom) return comeBack(WALK_STEP); // home from sitting on your page, or from roaming
  if (!settings.wander && (ox || oy)) return send('buddy-walk-done');
  const a = screen.getDisplayNearestPoint({ x: Math.round(home.x + ox + WIN_W / 2), y: Math.round(home.y + WIN_H / 2) }).workArea;
  const b = win.getBounds();
  walk = {
    x: b.x,
    y: b.y,
    tx: clampX(a, home.x + ox),
    // with gravity he stays on his floor or window; without, he floats wherever he likes
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

// The renderer says he is sleepy: walk to the bed, and make that home.
ipcMain.on('buddy-go-bed', () => {
  if (!win || win.isDestroyed() || !bedWin || bedWin.isDestroyed() || dragOffset || fall) return send('buddy-walk-done');
  const bed = bedWin.getBounds();
  const b = win.getBounds();
  const tx = bed.x + BED_W / 2 - WIN_W / 2;
  // with gravity he stays on his own level; without, he floats over and settles into the bed
  const ty = settings.gravity ? b.y : bed.y + BED_H - (WIN_H - FOOT_PAD) - 6;
  if (Math.hypot(tx - b.x, ty - b.y) < 12) return send('buddy-walk-done');
  chase = false;
  cornerFrom = null;
  walk = { x: b.x, y: b.y, tx, ty, setHome: true };
  win.moveTop();
});

// Hurt, he takes himself off to a bottom corner of the screen and lives there until he is
// better: 'l' or 'r', or 'far' for whichever is further from the pointer. '' is the walk back
// to where he came from. Up on a window, he gets down first.
ipcMain.on('buddy-corner', (_e, side) => {
  if (!win || win.isDestroyed() || dragOffset) return send('buddy-walk-done');
  if (side === '') {
    const was = cornerFrom;
    cornerFrom = null;
    if (fall) { fall.then = null; return send('buddy-walk-done'); } // still getting down: no need to go on
    const b = win.getBounds();
    if (!was || Math.abs(was.x - b.x) < 12) {
      if (walk && walk.corner) { walk = null; home = { x: b.x, y: b.y }; }
      return send('buddy-walk-done');
    }
    walk = { x: b.x, y: b.y, tx: clampX(area(), was.x), ty: settings.gravity ? b.y : was.y, setHome: true };
    return;
  }
  if (fall) return send('buddy-walk-done');
  chase = false;
  hiding = null;
  if (!cornerFrom) cornerFrom = { x: home.x, y: home.y };
  const go = () => {
    const a = area();
    const b = win.getBounds();
    const left = side === 'l' || (side !== 'r' && screen.getCursorScreenPoint().x > a.x + a.width / 2);
    const tx = left ? a.x - SIDE_PAD : a.x + a.width - WIN_W + SIDE_PAD;
    const ty = settings.gravity ? b.y : floorY(a);
    const corner = left ? 'l' : 'r';
    if (Math.hypot(tx - b.x, ty - b.y) < 12) {
      home = { x: b.x, y: b.y };
      return send('buddy-walk-done', { corner });
    }
    walk = { x: b.x, y: b.y, tx, ty, setHome: true, corner };
  };
  if (!perch || !settings.gravity) return go();
  const b = win.getBounds();
  perch = null;
  walk = null;
  fall = { x: b.x, y: b.y, vx: 0, vy: 0, peak: 0, bounces: 0, ground: null, down: true, then: go };
  send('buddy-fly', { speed: 0, down: true });
});

// ---- hide and seek ----

// He hides mostly off an outer edge of the screen: peeking over the bottom, or round a side.
function startHide() {
  if (!win || win.isDestroyed() || dragOffset || fall) return send('buddy-hidden', false);
  const b = win.getBounds();
  const d = screen.getDisplayNearestPoint({ x: Math.round(b.x + WIN_W / 2), y: Math.round(b.y + WIN_H / 2) }).bounds;
  // an edge only hides him if there isn't another screen on the far side
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
  send('buddy-do', { what: 'album' }); // it sets him remembering
  if (albumWin && !albumWin.isDestroyed()) {
    albumWin.loadFile('album.html', { hash: tab });
    return albumWin.focus();
  }
  albumWin = new BrowserWindow({
    width: 420,
    height: 560,
    title: 'Clawd\'s photo album',
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

// his diary, and the ones who stood here before him
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

// Opens the little text box over Clawd: for his note, his name, a phrase to teach him, or a
// friend's code.
function edit(kind) {
  if (!win || win.isDestroyed()) return;
  win.show();
  win.setIgnoreMouseEvents(false);
  win.focus();
  send('buddy-edit', kind);
}

// Quit from the menu: give him a few seconds to say goodbye first.
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
  if (key === 'music' || key === 'pages') { lastSite = ''; restartWatcher(); }
  if (key === 'loud' && !settings.meddle) restartWatcher(); // the helper only listens to the level while this is on
  if (key === 'loud' && settings.meddle) setTimeout(restartWatcher, 700);
  if (key === 'meddle') {
    // the helper only listens for orders while this is on; switched off, it first puts
    // back whatever he shoved
    if (!value && watcher) watcher.stdin.write('D back 0 0 0\n');
    if (!value) { endHold('time'); for (const w of printWins) if (!w.isDestroyed()) w.close(); }
    setTimeout(restartWatcher, value ? 0 : 700);
  }
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
  if (tray) tray.setToolTip(who.name || 'Clawd');
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
    { label: who.name ? `Rename ${who.name}…` : 'Give him a name…', click: () => edit('name') },
    {
      label: 'Teach him',
      submenu: [
        { label: 'A new phrase…', click: () => edit('teach') },
        { label: `Forget what I taught him (${who.words})`, enabled: who.words > 0, click: () => send('buddy-do', { what: 'forget-words' }) },
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
    { ...toggle('Jump at loud sounds', 'loud'), enabled: process.platform === 'win32' },
    { ...toggle('Notice what I\'m doing', 'notice'), enabled: process.platform === 'win32' },
    { ...toggle('Listen to my music', 'music'), enabled: process.platform === 'win32' },
    { ...toggle('Notice which sites I\'m on', 'pages'), enabled: process.platform === 'win32' },
    toggle('Curious wandering', 'wander'),
    toggle('Gravity', 'gravity'),
    { ...toggle('Sit on windows', 'perch'), enabled: settings.gravity && process.platform === 'win32' },
    toggle('Let him mess with my desktop', 'meddle'),
    toggle('A pet of his own', 'pet'),
    {
      label: 'Start with Windows',
      type: 'checkbox',
      checked: app.getLoginItemSettings(loginItem()).openAtLogin,
      click: (i) => app.setLoginItemSettings({ openAtLogin: i.checked, ...loginItem() }),
    },
    { label: visible ? 'Hide Clawd' : 'Show Clawd', click: () => (visible ? win.hide() : win.showInactive()) },
    { type: 'separator' },
    { label: 'Reload config.json', click: () => { send('buddy-config-loaded', loadConfig()); sendSettings(); } },
    ...(dev && dev.menu ? [{ label: 'Dev', submenu: dev.menu() }] : []),
    { label: 'Quit Clawd', click: quitNicely },
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
  tray.setToolTip('Clawd');
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
    console.log(`Clawd is listening on http://127.0.0.1:${PORT}/event`);
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
    // a few things about the computer itself that he likes to remark on
    watchDownloads();
    powerMonitor.on('on-battery', () => send('buddy-world', 'battery'));
    powerMonitor.on('on-ac', () => send('buddy-world', 'ac'));
    screen.on('display-added', () => send('buddy-world', 'display-added'));
    screen.on('display-removed', () => send('buddy-world', 'display-removed'));
  });

  app.on('before-quit', () => {
    if (memoryTimer) flushMemory();
    if (watcher) {
      const child = watcher;
      watcher = null;
      // with its orders cut off the helper slides back any window he shoved, then notices
      // Clawd has gone and stops by itself
      if (settings.meddle) child.stdin.end();
      else child.kill();
    }
  });
  app.on('window-all-closed', () => app.quit());
}
