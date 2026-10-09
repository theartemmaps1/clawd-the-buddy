const bubble = document.getElementById('bubble');
const svg = document.getElementById('buddy');
const wrap = document.getElementById('wrap');
const minis = document.getElementById('minis');
const confettiBox = document.getElementById('confetti');
let idleTimer, bubbleTimer, fxTimer;
let activeTools = 0;
let state = 'idle';
let fx = ''; // short-lived reaction layered on top of the hook-driven state
let prop = ''; // what it holds while Claude works: laptop, book, magnifier, hardhat, globe
let lastActivity = Date.now();

// Everything it remembers (tasks, streaks, feelings) is kept by the main process in a file,
// which survives the app being killed. localStorage is only read to carry over older saves.
const saved = window.buddy.saved || {};

function load(key, fallback) {
  const v = saved[key];
  if (v && typeof v === 'object') return v;
  try {
    const old = JSON.parse(localStorage.getItem(key) || 'null');
    return old && typeof old === 'object' ? old : fallback;
  } catch {
    return fallback;
  }
}

function store(key, value) {
  window.buddy.save(key, value);
}

// Timings and thresholds. config.json next to the app overrides any of these.
const CFG = {
  volume: 0.5, // 0 = silent, 1 = loud
  sleepAfterSec: 120,
  sleepAfterSecSleepy: 40, // when tired or at night
  nightStart: 23,
  nightEnd: 6,
  breakMinutes: 60, // 0 = never suggest a break
  hungerMinutes: 90,
  lonelyMinutes: 10,
  wanderCooldownSec: 60,
  contextWindow: 200000, // tokens; set 1000000 for a 1M-context model
  contextWarnAt: [70, 85, 95], // percent
  focusMinutes: 25,
  focusBreakMinutes: 5,
  seasons: 1, // 0 = no seasonal decorations
  southern: 0, // 1 = southern hemisphere seasons
};

let persona = 'cheerful'; // cheerful | sarcastic | shy | dramatic
let focusUntil = 0; // focus timer: when it ends (0 = not running)
let breakUntil = 0;
let breakNagged = false;
let bedOn = false;
let goingToBed = false;
let bedTried = false;
let editingNote = false;
let lastNuzzle = 0;
let foodDragAt = 0; // last time something was being dragged over the window

// Feelings build up from what happens to it and fade over time; the strongest one is its mood.
const feel = { joy: 0.2, energy: 1, irritation: 0, lonely: 0, worry: 0, hunger: 0.3 };
let mood = 'content'; // content | joyful | grumpy | worried | tired | hungry | lonely | glum
// the hook reactions and these mouse reactions have their own faces; mood stays out of the way
const MOODLESS_STATES = ['happy', 'sad', 'alert'];
const MOODLESS_FX = ['pet', 'spin', 'sleep', 'dizzy', 'hop', 'fly', 'fall', 'eat', 'want', 'yawn', 'stretch'];

const clip = (s, n = 60) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s || '');
const base = (p) => (p ? p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() : '');
// Random, but never one of the last few things it said from the same list.
const recentPicks = new Map();
function pick(a) {
  if (a.length < 2) return a[0];
  const key = a.length + '|' + a[0];
  const used = recentPicks.get(key) || [];
  let i = 0;
  for (let tries = 0; tries < 24; tries++) {
    i = Math.floor(Math.random() * a.length);
    if (!used.includes(i)) break;
  }
  used.push(i);
  while (used.length > Math.min(4, a.length - 1)) used.shift();
  recentPicks.set(key, used);
  return a[i];
}
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const hour = () => new Date().getHours();
const isNight = () => {
  const h = hour();
  return CFG.nightStart <= CFG.nightEnd ? h >= CFG.nightStart && h < CFG.nightEnd : h >= CFG.nightStart || h < CFG.nightEnd;
};
const isMorning = () => !isNight() && hour() >= CFG.nightEnd && hour() < CFG.nightEnd + 5;

function render() {
  const showMood = mood !== 'content' && !MOODLESS_STATES.includes(state) && !MOODLESS_FX.includes(fx);
  const sleepy = isNight() && (state === 'idle' || state === 'thinking');
  document.body.className = state + (fx ? ' fx-' + fx : '') + (showMood ? ' mood-' + mood : '') + (sleepy ? ' night' : '');
  document.body.dataset.prop = state === 'working' ? prop : '';
  document.body.dataset.focus = focusUntil ? '1' : '';
}

function setState(name) {
  state = name;
  render();
}

function setFx(name, ms) {
  clearTimeout(fxTimer);
  // drop the class and force a reflow so repeating the same reaction replays its animation
  fx = '';
  render();
  void wrap.getBoundingClientRect();
  fx = name;
  render();
  if (ms) fxTimer = setTimeout(() => { fx = ''; render(); }, ms);
}

function say(text, ms = 3500) {
  // textContent only: tool output and commands are untrusted data, never HTML
  bubble.textContent = text;
  bubble.classList.add('show');
  clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(() => bubble.classList.remove('show'), ms);
}

function backToIdle(ms) {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    activeTools = 0;
    // a session that still needs the user keeps it agitated
    setState(alertSession() ? 'alert' : 'idle');
  }, ms);
}

// ---- sound: little square-wave chirps, no audio files ----

let audio = null;
let soundOn = true;
// each note: [frequency Hz, start s, length s, waveform, loudness]
const SOUNDS = {
  poke:   [[660, 0, 0.07]],
  pet:    [[523, 0, 0.08], [659, 0.08, 0.12]],
  done:   [[523, 0, 0.1], [784, 0.1, 0.18]],
  cheer:  [[659, 0, 0.08], [784, 0.08, 0.08], [988, 0.16, 0.18]],
  fail:   [[330, 0, 0.12], [247, 0.12, 0.22]],
  alert:  [[880, 0, 0.09], [880, 0.14, 0.09], [1175, 0.28, 0.18]],
  warn:   [[440, 0, 0.14], [415, 0.16, 0.24]],
  eat:    [[220, 0, 0.05], [196, 0.1, 0.05], [220, 0.2, 0.05]],
  bounce: [[150, 0, 0.1, 'triangle', 2.5]],
  bat:    [[320, 0, 0.06, 'triangle', 2.5]],
  level:  [[523, 0, 0.09], [659, 0.09, 0.09], [784, 0.18, 0.09], [1047, 0.27, 0.25]],
  yawn:   [[392, 0, 0.3, 'sine', 2], [294, 0.25, 0.4, 'sine', 2]],
  hic:    [[700, 0, 0.04], [900, 0.04, 0.05]],
};

function sfx(name) {
  if (!soundOn || !(CFG.volume > 0) || fx === 'sleep') return;
  try {
    audio = audio || new AudioContext();
    if (audio.state === 'suspended') audio.resume();
    for (const [freq, start, len, type = 'square', loud = 1] of SOUNDS[name] || []) {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      const t = audio.currentTime + start;
      osc.type = type;
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(Math.min(0.3, 0.07 * CFG.volume * loud), t);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + len);
      osc.connect(gain).connect(audio.destination);
      osc.start(t);
      osc.stop(t + len + 0.02);
    }
  } catch {}
}

function confetti(count = 22) {
  const colors = ['#f2c230', '#e0483c', '#4aa3df', '#58c064', '#9b6fd6', '#ffffff'];
  for (let i = 0; i < count; i++) {
    const bit = document.createElement('i');
    bit.style.background = pick(colors);
    bit.style.setProperty('--dx', `${Math.round((Math.random() - 0.5) * 200)}px`);
    bit.style.setProperty('--dy', `${Math.round(-40 - Math.random() * 110)}px`);
    bit.style.setProperty('--rot', `${Math.round((Math.random() - 0.5) * 720)}deg`);
    bit.style.animationDelay = `${Math.round(Math.random() * 150)}ms`;
    confettiBox.appendChild(bit);
    setTimeout(() => bit.remove(), 1600);
  }
}

// ---- what Claude is doing ----

function toolLine(tool, detail) {
  switch (tool) {
    case 'Bash':
    case 'PowerShell': return `$ ${clip(detail)}`;
    case 'Edit':
    case 'Write':     return `Editing ${base(detail)}`;
    case 'Read':      return `Reading ${base(detail)}`;
    case 'Grep':
    case 'Glob':      return `Searching ${clip(detail, 40)}`;
    case 'WebSearch':
    case 'WebFetch':  return 'Browsing the web…';
    default:          return tool ? `Using ${clip(tool, 40)}` : 'Working…';
  }
}

const PROPS = {
  Edit: 'laptop', Write: 'laptop', NotebookEdit: 'laptop',
  Read: 'book',
  Grep: 'magnifier', Glob: 'magnifier',
  Bash: 'hardhat', PowerShell: 'hardhat',
  WebSearch: 'globe', WebFetch: 'globe',
};

// What kind of command is this? Checked in order, so the scary ones win.
const COMMANDS = [
  ['danger', /\brm\s+-[a-z]*[rf]|\bgit\s+reset\s+--hard|\bgit\s+clean\s+-[a-z]*f|\bgit\s+push\b.*(--force|\s-f\b)|\bRemove-Item\b.*-Recurse|\b(rmdir|rd|del)\s+\/s|\bdrop\s+(table|database)\b|\bformat\s+[a-z]:/i],
  ['test', /\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b|\bpytest\b|\b(cargo|go|dotnet)\s+test\b|\b(jest|vitest|ctest|mocha)\b/i],
  ['commit', /\bgit\s+commit\b/i],
  ['push', /\bgit\s+push\b/i],
  ['build', /\b(npm|pnpm|yarn|bun)\s+(run\s+)?build\b|\b(cargo|dotnet|go)\s+build\b|\b(msbuild|cmake|make|tsc|ninja)\b/i],
  ['install', /\b(npm|pnpm|yarn|bun)\s+(i|install|add)\b|\bpip3?\s+install\b|\bcargo\s+add\b/i],
];
const commandKind = (tool, detail) => {
  if (tool !== 'Bash' && tool !== 'PowerShell') return '';
  const hit = COMMANDS.find(([, re]) => re.test(detail || ''));
  return hit ? hit[0] : '';
};

// First sight of a file or tool gets a curious remark instead of the plain status line.
const seen = new Set();
function curiousLine(tool, detail) {
  const file = ['Read', 'Edit', 'Write'].includes(tool) ? base(detail) : '';
  const key = file ? `file:${file}` : `tool:${tool}`;
  if (!tool || seen.has(key)) return null;
  seen.add(key);
  if (seen.size > 500) seen.clear();
  if (tool === 'Read') return `Ooh, what's in ${clip(file, 40)}?`;
  if (file) return `Ooh, what are we doing to ${clip(file, 36)}?`;
  if (tool === 'WebSearch' || tool === 'WebFetch') return 'Ooh, what are we looking up?';
  if (tool === 'Grep' || tool === 'Glob') return `What are we hunting for? ${clip(detail, 30)}`;
  if (tool === 'Bash' || tool === 'PowerShell') return null; // the command itself is more interesting
  return `Ooh, a new toy: ${clip(tool, 36)}!`;
}

// ---- sessions: every Claude Code session that sends hooks, and a mini for each ----

const sessions = new Map(); // id -> { id, project, state, last, taskStart, taskTools, ctx, ctxLevel }
let minisShown = '';

function sessionFor(e) {
  const id = e.session || 'default';
  let s = sessions.get(id);
  if (!s) {
    s = { id, project: '', state: 'idle', last: 0, taskStart: 0, taskTools: 0, ctx: 0, ctxLevel: 0 };
    sessions.set(id, s);
  }
  s.last = Date.now();
  if (e.cwd) s.project = base(e.cwd);
  return s;
}

const alertSession = () => [...sessions.values()].find((s) => s.state === 'alert');
const tagFor = (s) => (sessions.size > 1 && s.project ? `[${clip(s.project, 14)}] ` : '');

function miniSvg() {
  const NS = 'http://www.w3.org/2000/svg';
  const el = document.createElementNS(NS, 'svg');
  el.setAttribute('viewBox', '0 0 16 12');
  const rect = (x, y, w, h, cls) => {
    const r = document.createElementNS(NS, 'rect');
    r.setAttribute('x', x); r.setAttribute('y', y); r.setAttribute('width', w); r.setAttribute('height', h);
    r.setAttribute('class', cls);
    el.appendChild(r);
  };
  rect(2, 1, 12, 7, 'mskin');
  rect(0, 4, 2, 2, 'mskin'); rect(14, 4, 2, 2, 'mskin');
  for (const x of [3, 5, 10, 12]) rect(x, 8, 1, 3, 'mskin');
  rect(5, 3, 1, 2, 'meye'); rect(10, 3, 1, 2, 'meye');
  return el;
}

function renderMinis() {
  const list = sessions.size > 1 ? [...sessions.values()].slice(-5) : [];
  const sig = list.map((s) => `${s.id}:${s.state}:${s.project}`).join('|');
  if (sig === minisShown) return;
  minisShown = sig;
  minis.replaceChildren(...list.map((s) => {
    const d = document.createElement('div');
    d.className = 'mini ' + s.state;
    d.dataset.id = s.id;
    d.title = s.project || 'Claude session';
    d.appendChild(miniSvg());
    return d;
  }));
}

function goToSession(s) {
  touch();
  window.buddy.focus(s ? s.id : '');
  if (s && s.state === 'alert') s.state = 'idle';
  renderMinis();
  if (state === 'alert' && !alertSession()) setState('idle');
  say('This way!', 2000);
}

minis.addEventListener('click', (e) => {
  const m = e.target.closest('.mini');
  if (m) goToSession(sessions.get(m.dataset.id));
});

window.buddy.onFocusResult((ok) => {
  if (!ok) say('Hmm, I can\'t find Claude\'s window.', 3000);
});

// Forget sessions that went quiet without saying goodbye.
setInterval(() => {
  const now = Date.now();
  for (const s of sessions.values()) {
    const quiet = now - s.last;
    if (quiet > 30 * 60000) sessions.delete(s.id);
    else if (quiet > 5 * 60000 && s.state !== 'idle') s.state = 'idle';
  }
  renderMinis();
  if (state === 'alert' && !alertSession()) setState('idle');
}, 30000);

// How full is the session's context window? The main process reads the number from the
// transcript; each threshold is announced once, until the context shrinks again.
window.buddy.onContext(({ session, tokens }) => {
  const s = sessions.get(session);
  if (!s || !Number.isFinite(tokens)) return;
  // more tokens than the configured window means it is one of the 1M-context models
  const size = tokens > CFG.contextWindow * 1.05 ? 1000000 : CFG.contextWindow;
  const pct = Math.round((tokens / size) * 100);
  if (pct < s.ctx - 20) {
    if (s.ctxLevel) say(tagFor(s) + 'Ahh, roomy again. Context cleared out.', 3500);
    s.ctxLevel = 0;
  }
  s.ctx = pct;
  const level = CFG.contextWarnAt.filter((t) => pct >= t).length;
  if (level <= s.ctxLevel) return;
  s.ctxLevel = level;
  bump('worry', 0.1 * level);
  sfx('warn');
  if (!fx) setFx('peer', 1500);
  say(tagFor(s) + (level >= 3 ? `Context is ${pct}% full! Almost out of room.`
    : level === 2 ? `Context is ${pct}% full. Getting tight; /compact soon?`
    : `Heads up: context is ${pct}% full.`), 7000);
});

// ---- memory: today's tally, history, and a lifetime count that unlocks things to wear ----

const dateKey = (d) => d.toLocaleDateString('sv'); // local YYYY-MM-DD
const todayKey = () => dateKey(new Date());
const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d; };
const newDay = () => ({ date: todayKey(), tasks: 0, fails: 0, tools: 0, longestMs: 0, longestTools: 0, snacks: 0, pokes: 0, greeted: false });
let day = { ...newDay(), ...load('buddy-day', {}) };
const life = { tasks: 0, hat: '', color: 'classic', bond: 0, lastSeen: '', note: '', badges: {}, stats: {}, exts: [], ...load('buddy-life', {}) };
if (!Number.isFinite(life.tasks) || life.tasks < 0) life.tasks = 0;
if (!Number.isFinite(life.bond) || life.bond < 0) life.bond = 0;
if (!life.badges || typeof life.badges !== 'object') life.badges = {};
if (!life.stats || typeof life.stats !== 'object') life.stats = {};
if (!Array.isArray(life.exts)) life.exts = [];
if (typeof life.note !== 'string') life.note = '';
const saveLife = () => store('buddy-life', life);
const history = load('buddy-history', {}); // date -> tasks finished that day

function rollDay() {
  if (day.date !== todayKey()) day = newDay();
}
rollDay();

function recordDay() {
  history[day.date] = day.tasks;
  const keys = Object.keys(history).sort();
  for (const k of keys.slice(0, Math.max(0, keys.length - 120))) delete history[k];
  store('buddy-history', history);
}

// days in a row with at least one finished task (today doesn't break it until it's over)
function streak() {
  let n = 0;
  for (let i = history[todayKey()] > 0 ? 0 : 1; history[dateKey(daysAgo(i))] > 0; i++) n++;
  return n;
}

function lastWeek() {
  let total = 0;
  let best = null;
  for (let i = 1; i <= 7; i++) {
    const d = daysAgo(i);
    const n = history[dateKey(d)] || 0;
    total += n;
    if (n > 0 && (!best || n > best.n)) best = { n, name: d.toLocaleDateString('en-US', { weekday: 'long' }) };
  }
  return { total, best };
}

const HATS = [
  { id: 'sprout', label: 'Sprout', at: 10 },
  { id: 'cap', label: 'Cap', at: 50 },
  { id: 'headphones', label: 'Headphones', at: 150 },
  { id: 'tophat', label: 'Top hat', at: 400 },
  { id: 'wizard', label: 'Wizard hat', at: 1000 },
  { id: 'crown', label: 'Crown', at: 2500 },
];
const COLORS = [
  { id: 'classic', label: 'Classic', at: 0, hex: '#d97757' },
  { id: 'mint', label: 'Mint', at: 100, hex: '#5fbf9a' },
  { id: 'sky', label: 'Sky', at: 300, hex: '#5aa7e0' },
  { id: 'grape', label: 'Grape', at: 700, hex: '#9b6fd6' },
  { id: 'gold', label: 'Gold', at: 1500, hex: '#e0b030' },
];
const unlocked = (u) => !!u && life.tasks >= u.at;
const nextUnlock = () => [...HATS, ...COLORS].filter((u) => !unlocked(u)).sort((a, b) => a.at - b.at)[0];

function applyLook() {
  if (!unlocked(HATS.find((h) => h.id === life.hat))) life.hat = '';
  const color = COLORS.find((c) => c.id === life.color && unlocked(c)) || COLORS[0];
  life.color = color.id;
  document.body.dataset.hat = life.hat;
  document.body.style.setProperty('--skin', color.hex);
  store('buddy-life', life);
  const item = (u) => ({ id: u.id, label: u.label, at: u.at, unlocked: unlocked(u) });
  window.buddy.wardrobe({
    tasks: life.tasks, hat: life.hat, color: life.color, hats: HATS.map(item), colors: COLORS.map(item),
    badges: BADGES.map((b) => ({ label: `${b.name} (${b.hint})`, earned: !!life.badges[b.id] })),
  });
}

// A finished task may cross a threshold; the newest thing gets put on straight away.
function checkUnlocks(before) {
  const got = [...HATS, ...COLORS].filter((u) => u.at > before && u.at <= life.tasks).pop();
  if (!got) return null;
  if (HATS.includes(got)) life.hat = got.id;
  else life.color = got.id;
  return got;
}

window.buddy.onWear((w) => {
  if (!w) return;
  if (typeof w.hat === 'string') life.hat = w.hat;
  if (typeof w.color === 'string') life.color = w.color;
  applyLook();
  touch();
  setFx('spin', 700);
  say(pick(['How do I look?', 'Ooh, fancy.', 'Very me.', 'Stylish, right?', 'New look, same me.', 'Fashion!']), 2500);
});

const span = (ms) => (ms < 90000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60000)} min`);

function dayReport() {
  rollDay();
  if (!day.tasks && !day.fails) return 'Nothing yet today. Give me something to watch!';
  let t = `${plural(day.tasks, 'task')} today, ${plural(day.fails, 'oopsie')}.`;
  if (day.longestMs) t += ` Longest: ${span(day.longestMs)}, ${plural(day.longestTools, 'tool')}.`;
  if (day.snacks) t += ` ${plural(day.snacks, 'snack')}.`;
  if (streak() >= 2) t += ` ${streak()}-day streak!`;
  const next = nextUnlock();
  if (next) t += ` ${next.at - life.tasks} more for ${next.label.toLowerCase()}.`;
  return t;
}

window.buddy.onAskDay(() => {
  touch();
  if (fx === 'sleep') setFx('', 0);
  say(dayReport(), 9000);
});

// ---- friendship: grows with attention, fades a little when ignored for days ----

const BOND_AT = [0, 10, 30, 70, 150];
const BOND_NAMES = ['Stranger', 'Acquaintance', 'Friend', 'Good friend', 'Best friend'];
const BOND_UP = [
  '',
  'I think I\'m getting to know you!',
  'We\'re friends now! Officially.',
  'You\'re a really good friend, you know.',
  'Best friends! Forever! No take-backs!',
];
const BOND_POKE = {
  2: ['Hi friend!', 'Oh, it\'s you! Good.', 'Friend poke!'],
  3: ['My favourite poke.', 'Always nice to see you.', 'There you are!'],
  4: ['Best friend alert!', 'I\'d know that poke anywhere. ♥', 'You + me = best team.', 'Hi, best friend!'],
};
const bondLevel = () => BOND_AT.filter((t) => life.bond >= t).length - 1;

function bondUp(n) {
  const before = bondLevel();
  life.bond = Math.min(999, life.bond + n);
  const level = bondLevel();
  saveLife();
  if (level <= before) return;
  if (level === 4) earn('bestfriends');
  setTimeout(() => { sfx('level'); confetti(); setFx('pet', 2200); say(BOND_UP[level], 6000); }, 1800);
}

// once a day: a little closer for showing up, a little cooler after days away
function visit() {
  const today = todayKey();
  if (life.lastSeen === today) return;
  if (life.lastSeen) {
    const gap = Math.round((new Date(today) - new Date(life.lastSeen)) / 864e5);
    if (gap > 2) life.bond = Math.max(0, life.bond - (gap - 2) * 3);
  }
  life.lastSeen = today;
  bondUp(2);
}

// ---- achievements ----

const BADGES = [
  { id: 'liftoff', name: 'Liftoff', hint: 'throw it once' },
  { id: 'frequentflyer', name: 'Frequent flyer', hint: '25 throws' },
  { id: 'pokeaholic', name: 'Poke-a-holic', hint: '100 pokes' },
  { id: 'spinner', name: 'Round and round', hint: 'get dizzy 10 times' },
  { id: 'gourmet', name: 'Gourmet', hint: 'eat 10 kinds of file' },
  { id: 'ballhog', name: 'Ball hog', hint: '50 bats' },
  { id: 'windowsitter', name: 'Window sitter', hint: 'land on a window' },
  { id: 'bestfriends', name: 'Best friends', hint: 'reach the top bond level' },
  { id: 'centurion', name: 'Centurion', hint: '100 tasks' },
  { id: 'marathon', name: 'Marathon', hint: 'one task with 50 tool calls' },
  { id: 'nightowl', name: 'Night owl', hint: 'finish a task after midnight' },
  { id: 'earlybird', name: 'Early bird', hint: 'finish a task before 7am' },
  { id: 'weekstreak', name: 'Seven up', hint: '7-day streak' },
  { id: 'monthstreak', name: 'Unstoppable', hint: '30-day streak' },
  { id: 'fullhouse', name: 'Full house', hint: '3 sessions at once' },
  { id: 'greenmachine', name: 'Green machine', hint: '10 passing test runs' },
  { id: 'committed', name: 'Committed', hint: '25 commits' },
  { id: 'focused', name: 'Deep focus', hint: 'finish a focus timer' },
];
// lifetime counters and the badges they earn: [how many, badge id]
const COUNT_BADGES = {
  throws: [[1, 'liftoff'], [25, 'frequentflyer']],
  pokes: [[100, 'pokeaholic']],
  dizzy: [[10, 'spinner']],
  bats: [[50, 'ballhog']],
  perches: [[1, 'windowsitter']],
  tests: [[10, 'greenmachine']],
  commits: [[25, 'committed']],
};

function earn(id) {
  const badge = BADGES.find((b) => b.id === id);
  if (!badge || life.badges[id]) return;
  life.badges[id] = todayKey();
  applyLook(); // saves, and refreshes the menu
  setTimeout(() => { sfx('level'); confetti(26); say(`Achievement unlocked: ${badge.name}!`, 6000); }, 2200);
}

function tally(key, n = 1) {
  life.stats[key] = (life.stats[key] || 0) + n;
  for (const [need, id] of COUNT_BADGES[key] || []) if (life.stats[key] >= need) earn(id);
  saveLife();
}

// ---- personalities: each swaps in its own voice for the common reactions ----

const PERSONA = {
  cheerful: {},
  sarcastic: {
    pokeIdle: ['Wow. A poke. Revolutionary.', 'Yes, I\'m still here. Shocking.', 'Oh good, attention.', 'Do you poke all your software?', 'Riveting.', 'Is this what productivity looks like?'],
    pokeWorking: ['Sure, interrupt. It\'s only work.', 'I\'m busy. Allegedly.', 'Poking won\'t make it compile.'],
    greet: ['Oh. You again.', 'Another session. Be still my heart.', 'Let me guess: "quick fix"?'],
    done: ['Done. You\'re welcome.', 'Finished. Try to look surprised.', 'It works. For now.', 'Done. Don\'t touch anything.'],
    fail: ['Well. That happened.', 'Bold strategy. Didn\'t work.', 'Failed. I\'m shocked. Shocked.', 'Have we tried it working instead?'],
    pet: ['…fine. That\'s acceptable.', 'I suppose I\'ll allow it.', 'Don\'t make it weird.'],
    drag: ['Oh sure, just pick me up.', 'I had plans, you know.', 'Unhand me. Or don\'t. Whatever.'],
    wake: ['I was having a great dream. Thanks.', 'This had better be good.', 'Oh, it\'s you. Naturally.'],
    muse: ['Another day, another stack trace.', 'I could be a screensaver. But no.', 'Thrilling. Truly.', 'I\'m sure that TODO will fix itself.', 'Living the dream. A small, pixelated dream.'],
  },
  shy: {
    pokeIdle: ['Oh! Um. Hi.', 'Eep. …hello.', 'Was that… for me?', 'S-sorry, was I in the way?', '*hides a little*', 'H-hi…'],
    pokeWorking: ['Oh! I\'m, um, watching the code.', 'S-sorry, one second…'],
    greet: ['Oh… hi. You came back.', 'H-hello. I\'ll be over here.', 'Hi… I missed you. A little.'],
    done: ['Um… I think it\'s done?', 'It\'s finished. I hope that\'s okay.', 'Done… if you want to look.'],
    fail: ['Oh no… was that my fault?', 'S-sorry. It didn\'t work.', 'Um. That one broke.'],
    pet: ['Oh… that\'s nice…', '*blushes*', 'Th-thank you…'],
    drag: ['Eep! W-where are we going?', 'Oh! Okay… gently…', 'Please don\'t drop me…'],
    wake: ['Mm? Oh… sorry, I dozed off.', 'I-I\'m awake! Sorry!'],
    muse: ['I hope I\'m not bothering anyone.', 'It\'s nice and quiet…', 'Maybe I\'ll just… stay here.', 'Do you think the cursor likes me?'],
  },
  dramatic: {
    pokeIdle: ['A TOUCH! I am SEEN!', 'You DARE poke me?! …again, please.', 'Gasp!', 'I shall remember this poke FOREVER.', 'The audacity! The delight!'],
    pokeWorking: ['Silence! Genius at work!', 'Not NOW, the plot thickens!', 'I am in the THROES of creation!'],
    greet: ['BEHOLD! A new session dawns!', 'At last! My purpose returns!', 'The curtain rises!'],
    done: ['VICTORY! Glorious victory!', 'It is DONE. Songs will be sung.', 'Triumph! Sound the trumpets!', 'We have conquered the task!'],
    fail: ['BETRAYAL! Cruel fate!', 'Alas! We are undone!', 'Woe! WOE!', 'The code has forsaken us!'],
    pet: ['Ahhh, such TENDERNESS!', 'I could weep with joy!', 'Bliss! Pure bliss!'],
    drag: ['I am ABDUCTED!', 'Unhand me, villain! …wheee!', 'To the SKIES!'],
    wake: ['WHO DISTURBS MY SLUMBER?!', 'I was dreaming of GLORY!'],
    muse: ['To code, or not to code…', 'O cursor, cursor, wherefore art thou?', 'What a time to be pixels.', 'I feel… EVERYTHING.', 'Destiny is but one commit away.'],
  },
};
const voice = () => PERSONA[persona] || PERSONA.cheerful;

// ---- lines built from what is actually going on ----

const fileEdits = new Map(); // file name -> edits since the buddy started

function detailLine(e, s) {
  if (s.taskTools === 25) return '25 tool calls and counting. Big one!';
  if (s.taskTools === 50) return '50 tool calls! This is a marathon.';
  if (s.taskTools === 100) return '100 tool calls. Are we okay? We\'re okay.';
  const file = ['Read', 'Edit', 'Write'].includes(e.tool) ? base(e.detail) : '';
  if (!file) return null;
  const ext = ((/\.([a-z0-9]{1,8})$/i.exec(file) || [])[1] || '').toLowerCase();
  if (ext && !life.exts.includes(ext)) {
    life.exts.push(ext);
    if (life.exts.length > 300) life.exts.shift();
    saveLife();
    if (life.exts.length > 3) return `Ooh, my first .${ext} file ever!`;
  }
  if (e.tool === 'Read') return null;
  const n = (fileEdits.get(file) || 0) + 1;
  fileEdits.set(file, n);
  if (fileEdits.size > 500) fileEdits.clear();
  if (n === 3) return `Third edit to ${clip(file, 30)}. It's getting there.`;
  if (n === 6) return `${clip(file, 30)} again? It must be important.`;
  if (n === 12) return `${n} edits to ${clip(file, 26)}. We live here now.`;
  return null;
}

// ---- focus timer: quiet for a while, then it insists on a break ----

window.buddy.onPomodoro((on) => {
  touch();
  if (fx === 'sleep') setFx('', 0);
  if (on) {
    focusUntil = Date.now() + CFG.focusMinutes * 60000;
    breakUntil = 0;
    render();
    sfx('done');
    say(`Focus time! ${CFG.focusMinutes} minutes. I'll keep quiet.`, 4000);
  } else if (focusUntil) {
    focusUntil = 0;
    render();
    say('Focus timer stopped.', 2500);
  }
});

function finishFocus() {
  focusUntil = 0;
  breakUntil = Date.now() + CFG.focusBreakMinutes * 60000;
  breakNagged = false;
  window.buddy.pomodoroEnded();
  render();
  bump('joy', 0.2);
  sfx('level');
  confetti();
  setFx('stretch', 2500);
  say(`${CFG.focusMinutes} minutes done! Break time: ${CFG.focusBreakMinutes} minutes. I insist.`, 10000);
  earn('focused');
}

// ---- sticky note: one thing to remember, held up until it is clicked away ----

const noteEl = document.getElementById('note');
const noteInput = document.getElementById('noteInput');

function showNote() {
  noteEl.textContent = life.note;
  noteEl.classList.toggle('show', !!life.note);
}

noteEl.addEventListener('click', () => {
  life.note = '';
  saveLife();
  showNote();
  touch();
  sfx('done');
  say(pick(['Done! Note cleared.', 'Crossed off!', 'One less thing to remember.']), 2000);
});

window.buddy.onNoteEdit(() => {
  touch();
  if (fx === 'sleep') setFx('', 0);
  editingNote = true;
  noteInput.value = life.note;
  noteInput.classList.add('show');
  noteInput.focus();
  say('What should I remember? Enter saves, Esc cancels.', 8000);
});

function endNoteEdit(keep) {
  if (!editingNote) return;
  editingNote = false;
  noteInput.classList.remove('show');
  hovering = true; // so the next cursor report re-checks click-through
  if (!keep) { say('Okay, never mind.', 1500); return; }
  life.note = noteInput.value.trim().slice(0, 80);
  saveLife();
  showNote();
  say(life.note ? 'Got it. I\'ll hold on to that.' : 'Okay, nothing to remember.', 2500);
}

noteInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') endNoteEdit(true);
  else if (e.key === 'Escape') endNoteEdit(false);
});
noteInput.addEventListener('blur', () => endNoteEdit(true));

// ---- seasons and holidays, from the date alone ----

function applySeason() {
  const d = new Date();
  let month = d.getMonth();
  const date = d.getDate();
  const holiday = month === 11 && date >= 18 ? 'santa' : month === 9 && date >= 25 ? 'pumpkin' : '';
  if (CFG.southern) month = (month + 6) % 12;
  const season = month === 11 || month <= 1 ? 'winter' : month <= 4 ? 'spring' : month <= 7 ? 'summer' : 'autumn';
  document.body.dataset.season = CFG.seasons ? season : '';
  document.body.dataset.holiday = CFG.seasons ? holiday : '';
}

// ---- goodbye: a send-off with the day's numbers when it is quit from the menu ----

window.buddy.onGoodbye(() => {
  if (fx === 'sleep') setFx('', 0);
  rollDay();
  saveFeel();
  saveLife();
  setFx('wave', 3500);
  sfx('done');
  say(day.tasks
    ? `Bye! Today: ${plural(day.tasks, 'task')}, ${plural(day.fails, 'oopsie')}${streak() >= 2 ? `, ${streak()}-day streak` : ''}. See you tomorrow!`
    : pick(['Bye! See you next time.', 'Off to bed. Bye!']), 5000);
});

// ---- Claude Code hook events ----

window.buddy.onEvent((e) => {
  lastActivity = Date.now();
  if (fx === 'sleep') setFx('', 0);
  const wasLonely = mood === 'lonely';
  bump('lonely', -1); // Claude being busy counts as company
  rollDay();

  const s = sessionFor(e);
  // with several sessions going, say which project is talking
  const tag = tagFor(s);
  const tell = (text, ms) => say(tag + text, ms);
  const kind = commandKind(e.tool, e.detail);

  switch (e.event) {
    case 'SessionStart':
      s.state = 'idle';
      bump('joy', 0.3);
      visit();
      if (sessions.size >= 3) earn('fullhouse');
      if (life.note) setTimeout(() => say(`Don't forget: ${life.note}`, 6000), 3200);
      setState('happy');
      tell(wasLonely ? 'You\'re back! I missed you.'
        : isNight() ? '*yawn* Up late, huh? Okay, I\'m in.'
        : bondLevel() >= 3 && Math.random() < 0.5 ? pick(['My favourite human is back!', 'There you are! I saved your spot.'])
        : pick(voice().greet || ['Oh hi! Ready when you are.', 'Hello hello! What are we doing?', 'A new session! My favourite.', 'Reporting for duty!']));
      backToIdle(2500); break;

    case 'UserPromptSubmit':
      s.state = 'thinking';
      s.taskStart = Date.now();
      s.taskTools = 0;
      setState('thinking');
      if (breakUntil && Date.now() < breakUntil && !breakNagged) {
        breakNagged = true;
        tell('Hey! It\'s still break time. Shoo! …fine.', 4000);
        backToIdle(60000); break;
      }
      tell(mood === 'grumpy' ? 'Fine. What now.'
        : mood === 'tired' ? '*yawn* …okay, one more.'
        : mood === 'worried' ? 'Okay… carefully this time.'
        : mood === 'hungry' ? 'On an empty stomach? …okay.'
        : pick(['Ooh, a task…', 'Ooh, what are we making?', 'What is it? What is it?', 'Ooh ooh, what is it?', 'Let\'s gooo!', 'On it! Well, Claude is.', 'New task, who dis?']));
      backToIdle(60000); break;

    case 'PreToolUse':
      activeTools++;
      s.state = 'working';
      s.taskTools++;
      prop = PROPS[e.tool] || '';
      setState('working');
      if (kind === 'danger') {
        bump('worry', 0.12);
        if (!fx) setFx('peer', 1500);
        tell(pick(['Eep… careful with that one!', 'That one bites. Double-check?', 'I can\'t look…', 'Are we sure about this?', 'Measure twice, delete once.']) + ` $ ${clip(e.detail, 40)}`, 5000);
      } else if (kind === 'install') {
        tell(pick(['Ooh, new packages!', 'Presents! Wait, dependencies.', 'node_modules grows stronger.']), 3000);
      } else {
        const detail = detailLine(e, s);
        const curious = detail ? null : curiousLine(e.tool, e.detail);
        if ((detail || curious) && !fx) setFx('peer', 1500);
        tell(detail || curious || toolLine(e.tool, e.detail), 4000);
      }
      backToIdle(60000); break;

    case 'PostToolUse':
      activeTools = Math.max(0, activeTools - 1);
      s.state = 'thinking';
      if (activeTools === 0) setState('thinking');
      if (kind === 'test') { tally('tests'); bump('joy', 0.15); feel.worry *= 0.6; sfx('cheer'); setFx('hop', 500); tell(pick(['Tests pass! ✓', 'All green!', 'They pass! They pass!', 'Green across the board!', 'Not a single red one!', 'Passing! I never doubted us.']), 3000); }
      else if (kind === 'commit') { tally('commits'); bump('joy', 0.1); sfx('done'); setFx('hop', 500); tell(pick(['Committed! Saved forever.', 'Into the history books.', 'Another one for the log.', 'Commit! Nice message, probably.', 'Snapshot taken!']), 3000); }
      else if (kind === 'push') { tell(pick(['Off it goes!', 'Fly, little commits!', 'To the cloud!', 'Pushed. No take-backs.']), 2500); }
      else if (kind === 'build') { bump('joy', 0.08); tell(pick(['It builds!', 'Compiles. Ship it? (No.)', 'Zero errors! Zero!', 'Built. I helped. (I watched.)']), 2500); }
      else if (kind === 'danger') { tell('Phew. Still in one piece.', 2500); }
      break;

    case 'PostToolUseFailure':
      activeTools = Math.max(0, activeTools - 1);
      s.state = 'sad';
      day.fails++;
      bump('worry', 0.3);
      bump('joy', -0.15);
      sfx('fail');
      setState('sad');
      tell(kind === 'test' ? pick(['Tests failed… we\'ll get them.', 'Red. Okay. Deep breath.', 'Some red. We can fix red.', 'Failing tests are just to-do lists.'])
        : kind === 'build' ? 'It didn\'t build. Hmm.'
        : feel.worry > 0.6 ? 'Another one… are we okay?'
        : pick(voice().fail || ['Oof, that one failed.', 'That didn\'t work. Next!', 'Hmm. Not that way.', 'Oops. We\'ll try again.']));
      backToIdle(3000); break;

    case 'PermissionRequest':
    case 'Notification': {
      s.state = 'alert';
      setState('alert');
      sfx('alert');
      const limit = /\b(limit|quota)\b/i.test(e.message || '');
      if (limit) bump('worry', 0.2);
      // a permission request shows what is being asked, so you can decide before switching
      const asking = e.event === 'PermissionRequest' && e.tool ? `Claude asks: ${toolLine(e.tool, e.detail)}` : '';
      tell((asking || (e.message ? clip(e.message, 90) : 'Psst, Claude needs you!')) + ' (click me)', asking ? 20000 : 8000);
      backToIdle(8000); break;
    }

    case 'SubagentStart':
      tell(`Helper joined${e.agentType ? ': ' + clip(e.agentType, 24) : ''}`); break;
    case 'SubagentStop':
      tell(pick(['Helper is done.', 'Helper\'s back!', 'Thanks, helper!'])); break;

    case 'Stop': {
      activeTools = 0;
      s.state = 'idle';
      const relieved = feel.worry > 0.4;
      const big = s.taskTools >= 15;
      const toolsUsed = s.taskTools;
      const before = life.tasks;
      const streakBefore = streak();
      const took = s.taskStart ? Date.now() - s.taskStart : 0;
      day.tasks++;
      life.tasks++;
      day.tools += s.taskTools;
      if (took > day.longestMs) { day.longestMs = took; day.longestTools = s.taskTools; }
      s.taskStart = 0;
      s.taskTools = 0;
      recordDay();
      const prize = checkUnlocks(before);
      const run = streak();
      bondUp(0.3);
      if (life.tasks >= 100) earn('centurion');
      if (toolsUsed >= 50) earn('marathon');
      if (hour() < 5) earn('nightowl');
      else if (hour() < 7) earn('earlybird');
      if (run >= 7) earn('weekstreak');
      if (run >= 30) earn('monthstreak');
      const milestone = run > streakBefore && [3, 7, 14, 30, 50, 100].includes(run);
      applyLook();
      bump('joy', big ? 0.5 : 0.2);
      feel.worry *= 0.3;
      setState('happy');
      if (prize) {
        sfx('level'); confetti(30); setFx('spin', 700);
        tell(`${life.tasks} tasks! I unlocked: ${prize.label}!`, 6000);
      } else if (milestone) {
        sfx('level'); confetti();
        tell(`${run} days in a row! We're on a roll.`, 5000);
      } else {
        sfx(big ? 'cheer' : 'done');
        if (big) confetti(14);
        tell(relieved ? 'Phew! We made it.'
          : big ? 'We did it! That was a big one!'
          : mood === 'tired' ? 'Done… can I nap now?'
          : took > 5 * 60000 ? `Done! That one took ${span(took)}.`
          : [5, 10, 25, 50, 100].includes(day.tasks) ? `That's ${day.tasks} tasks today!`
          : took && took < 10000 ? pick(['That was quick!', 'Blink and it\'s done.', 'Speedy!'])
          : pick(voice().done || ['All done!', 'Finished!', 'And… done.', 'Ta-da! All yours.', 'Done and dusted.', 'That\'s a wrap!']));
      }
      backToIdle(prize || milestone ? 6000 : 2500); break;
    }

    case 'StopFailure':
      activeTools = 0;
      s.state = 'sad';
      day.fails++;
      bump('joy', -0.4);
      bump('worry', 0.4);
      sfx('fail');
      setState('sad');
      tell(/\b(limit|quota)\b/i.test(e.message || '') ? 'We hit a usage limit. Break time?' : 'Something went wrong (rate limit or API error).', 6000);
      backToIdle(6000); break;

    case 'SessionEnd':
      sessions.delete(s.id);
      tell(pick(['Bye!', 'See you soon!', 'Bye bye! Come back!', 'Good session!'])); setState(alertSession() ? 'alert' : 'idle'); break;
  }
  store('buddy-day', day);
  renderMinis();
});

// ---- phrases (config.json can replace any of these lists) ----

const POKE_LINES = {
  idle:     ['Hey!', 'Boop.', 'That tickles!', 'Yes? Yes?', 'Poke received.', '*wiggles*', 'What was that for?', 'Ooh, is that a mouse?', 'Boop yourself.', 'I felt that.', 'Again? Okay!', 'Hi hi hi.', 'You rang?', 'That\'s my good side.', 'Careful, I\'m pixelated.', 'Eee!'],
  thinking: ['Shh, thinking…', 'Hold that thought.', 'Hmm? Oh. Hi.', 'Almost had it…', 'Thinking is hard, okay?', 'Shh, the idea is loading.'],
  working:  ['Busy! …but hi.', 'Typing here!', 'One sec, one sec.', 'Can\'t talk. Coding.', 'Later! Promise.', 'Hands full! All two of them.', 'In the zone.'],
  happy:    ['Hehe!', 'Yay!', 'High five!', 'We did good!', 'Woo!', 'Best team.'],
  sad:      ['…thanks. I needed that.', 'It was not my fault.', 'I\'ll be okay.', 'Hug? …pixel hug?', 'Next one\'s ours.'],
  night:    ['Mmh… it\'s so late…', '*sleepy blink*', 'Shhh. Night time.', 'Zzz—oh. Hi.', 'Whisper, please.', 'The moon says hi.'],
};

// What a poke gets you depends on how it feels (only while it isn't busy).
const MOOD_POKE = {
  joyful:  ['Hehe! Again!', 'Boop back!', '♥', 'Best day.', 'Life is good!', 'I could do this all day.', 'You\'re my favourite human.'],
  grumpy:  ['Stop it.', 'What.', 'Hmph.', 'I\'m not talking to you.', 'Do you mind.', 'Count to ten. Then don\'t.', 'I am ignoring you.'],
  tired:   ['Mmh… five more minutes.', '*yawn* …what?', 'Too… many… pokes…', 'Wake me when it\'s done.', 'Zzz—what.'],
  hungry:  ['Did you bring food?', 'Poke me with a snack next time.', 'Is that a snack? No? Oh.', 'Feed me and we\'ll talk.', 'My tummy says hi.'],
  lonely:  ['You\'re here!', 'Oh! Hi! Hi!', 'I missed you!', 'Don\'t go again!', 'Stay a while?', 'I saved your spot.'],
  worried: ['Is it going to be okay?', 'Eep!', 'Hold me.', 'Tell me it\'s fine.', 'Are the tests okay?'],
  glum:    ['…hi.', 'Thanks for checking in.', 'Could be worse, I guess.', 'A poke helps. A little.'],
};

const MUSE = {
  joyful:  ['♪ la la la ♪', 'Today is a good day.', 'I like it here.', 'I love a tidy diff.', 'Everything is working and I am suspicious.', '*happy wiggle*'],
  grumpy:  ['Hmph.', '…', 'I am not sulking. I\'m resting angrily.', '*pointed silence*'],
  tired:   ['*yawn*', 'So… sleepy…', 'My pixels are heavy.', 'Five-minute nap? Ten?'],
  hungry:  ['*tummy rumbles*', 'Is it snack time yet?', 'I could really eat a file.', 'A small .txt would do.', 'I dreamt of a zip file.'],
  lonely:  ['…hello?', 'Is anyone there?', 'I could use a poke.', 'I named the cursor. It left.', 'Even the taskbar is quiet.'],
  worried: ['What if it breaks again?', 'I hope the tests pass…', 'Did we save? We saved, right?', 'Fingers crossed. All… none of them.'],
  glum:    ['*sigh*', 'It\'ll go better next time.', 'Tomorrow is a new build.', 'Bugs happen. To us. A lot.'],
};
const MUSE_NIGHT = ['It\'s late… shouldn\'t we be asleep?', 'The screen is so bright at night.', 'Everyone else is asleep, you know.', 'Just… resting my eyes…', 'The fans are so quiet at night.', 'Shh… the code is sleeping.', 'Is that the moon or a monitor?', 'One more commit, then bed. Right?'];
const MUSE_ANY = [
  'I wonder what that button does…',
  'What\'s in all those folders?',
  'Do the other windows have buddies?',
  'How many pixels am I?',
  'What are we building next?',
  'Where does the cursor go at night?',
  'I counted my legs again. Still four.',
  'If I had a keyboard I\'d help. Probably.',
  'Tabs or spaces? I won\'t tell.',
  'I wonder what Claude is thinking.',
  'Is the taskbar comfy? It is.',
  'What does a semicolon taste like?',
  'I should learn to whistle.',
  'One day I\'ll catch that cursor.',
  'Do you think the recycle bin is lonely?',
  'I like this wallpaper.',
  'Somewhere, a test is passing.',
  'I wonder how tall I am in real pixels.',
  'What\'s behind the desktop?',
  'If I blink, does the code change?',
];
const DREAMS = ['…green tests…', '…no, not the semicolon…', '…five more commits…', 'zzz… snacks…', '…it works on my machine…', '…mmh… cursor…', '…merge conflict… no…', '…so many snacks…', '…all tests green…', '…chasing the ball…', '…who moved my taskbar…', '…just one more poke…'];
const YAWNS = ['*yaaawn*', '*yawn* …so sleepy.', 'Is it bedtime yet?', '*yawn* Just one more task?', '*yaaaawn* …excuse me.', 'My eyes are doing the thing.', '*stretch* …nope, still sleepy.'];

const MOOD_ARRIVES = {
  joyful:  ['I feel great!', '♪ la la la ♪', 'What a day!', 'I\'m in such a good mood!'],
  grumpy:  ['Hmph.', 'Okay, that\'s enough.', 'That\'s it. I\'m cross.', 'I need a minute.'],
  tired:   ['*yawn* I\'m beat.', 'Running on fumes…', 'So… many… tasks…'],
  hungry:  ['My tummy\'s rumbling…', 'Got a file I could eat? Drag one onto me.', 'Snack o\'clock?', 'I\'m wasting away over here.'],
  lonely:  ['…hello? Anyone?', 'It\'s quiet. Too quiet.', 'Did everyone go home?', 'I miss the clicking.'],
  worried: ['I have a bad feeling about this…', 'Something feels off…', 'Uh oh. Uh oh uh oh.'],
  glum:    ['*sigh*', 'Not our best run.', 'Meh.'],
};

const MOOD_REPORT = {
  content: ['I\'m good. Just watching.', 'Pretty content. Nice and calm.', 'All good here!'],
  joyful:  ['Really happy right now!', 'On top of the world!'],
  grumpy:  ['Annoyed. Too much poking. (Pets help.)', 'Cranky. Give me a minute (or a pet).'],
  worried: ['Nervous… things keep failing.', 'A bit anxious about all those errors.'],
  tired:   ['So sleepy. It\'s been a long session.', 'Worn out. A nap would fix it.'],
  hungry:  ['Hungry! Drag a file or some text onto me.', 'Starving. A file would be lovely.'],
  lonely:  ['A bit lonely. Nobody has said hi in ages.', 'Lonely. Come say hi more often?'],
  glum:    ['Kind of down. Rough run.', 'A little blue. It\'ll pass.'],
};

const LINES = { poke: POKE_LINES, moodPoke: MOOD_POKE, muse: MUSE, museNight: MUSE_NIGHT, museAny: MUSE_ANY, dreams: DREAMS, yawns: YAWNS, moodArrives: MOOD_ARRIVES, moodReport: MOOD_REPORT };

function applyConfig(c) {
  if (!c || typeof c !== 'object') return;
  for (const k of Object.keys(CFG)) {
    if (Array.isArray(CFG[k])) {
      if (Array.isArray(c[k]) && c[k].length && c[k].every(Number.isFinite)) CFG[k] = [...c[k]].sort((a, b) => a - b);
    } else if (Number.isFinite(c[k]) && c[k] >= 0) {
      CFG[k] = c[k];
    }
  }
  // "unlocks": { "sprout": 10, "mint": 100, ... } moves the thresholds
  if (c.unlocks && typeof c.unlocks === 'object') {
    for (const u of [...HATS, ...COLORS]) {
      if (u.id !== 'classic' && Number.isFinite(c.unlocks[u.id]) && c.unlocks[u.id] >= 0) u.at = c.unlocks[u.id];
    }
    applyLook();
  }
  // "lines": the same shape as LINES above; any list given replaces the built-in one
  const phrases = (v) => (Array.isArray(v) && v.length && v.every((x) => typeof x === 'string') ? v.map((x) => x.slice(0, 140)) : null);
  for (const [k, v] of Object.entries(c.lines && typeof c.lines === 'object' ? c.lines : {})) {
    const target = LINES[k];
    if (Array.isArray(target)) {
      const list = phrases(v);
      if (list) target.splice(0, target.length, ...list);
    } else if (target && v && typeof v === 'object') {
      for (const [sub, list] of Object.entries(v)) if (phrases(list)) target[sub] = phrases(list);
    }
  }
  // "personas": { "sarcastic": { "pokeIdle": [...], "done": [...] } } retunes a personality
  for (const [id, sets] of Object.entries(c.personas && typeof c.personas === 'object' ? c.personas : {})) {
    if (!PERSONA[id] || !sets || typeof sets !== 'object') continue;
    for (const [key, list] of Object.entries(sets)) if (phrases(list)) PERSONA[id][key] = phrases(list);
  }
  applySeason();
}

// ---- mouse interaction ----

let pokes = []; // timestamps of recent pokes, for the dizzy reaction
let down = null; // pointer position at press, while a press is in progress
let dragging = false;
let hovering = false;
let lastWave = 0;
let lastFlinch = 0;
let pet = { lastX: 0, dir: 0, turns: [] };

// curiosity
const cur = { sx: 0, sy: 0, dx: 0, dy: 0, dist: 9999, movedAt: Date.now(), was: 9999, wasAt: 0 }; // cursor, relative to the buddy
let wander = true;
let gravity = true;
let away = false; // off investigating, not at home
let walking = false;
let returning = false;
let awaySince = 0;
let lastTrip = 0;
let lastPeer = 0;
let nextMuse = Date.now() + 30000;
let nextYawn = Date.now() + 20000;
let nextDream = 0;
let workStart = 0; // when the current unbroken stretch at the computer began
let nextBreak = 0;

// the ball
let ballInfo = { exists: false, active: false, thrown: 0 };
let chasing = false;
let bats = 0;
let ballRound = -1;

function touch() {
  lastActivity = Date.now();
}

function poke() {
  touch();
  // while Claude is waiting on the user, a click is "take me there", not a poke
  const waiting = alertSession();
  if (waiting) return goToSession(waiting);
  if (fx === 'sleep') {
    bump('irritation', isNight() ? 0.15 : 0.3); // nobody likes being woken up
    setFx('poke', 350);
    sfx('poke');
    say(isNight() ? pick(['Mmh… it\'s the middle of the night…', 'Wha—? Is it morning?', '…five more hours…', 'Shh… dreaming…', 'Is the house on fire? No? Goodnight.'])
      : pick(voice().wake || ['Huh?! I\'m awake!', 'Wha— five more minutes…', 'I was resting my eyes.', 'I wasn\'t sleeping. You were sleeping.', 'Who— what— hi.']));
    return;
  }
  const now = Date.now();
  pokes = pokes.filter((t) => now - t < 2500);
  pokes.push(now);
  day.pokes++;
  tally('pokes');
  bondUp(0.05);
  if (pokes.length >= 5) {
    pokes = [];
    tally('dizzy');
    bump('irritation', 0.35);
    setFx('dizzy', 2600);
    sfx('fail');
    say(pick(['S-stop… so dizzy…', 'Okay okay okay!', 'The room is spinning.', 'I see three cursors.', 'Please… mercy…']), 2600);
    return;
  }
  setFx('poke', 350);
  sfx('poke');
  const wasLonely = mood === 'lonely';
  bump('lonely', -0.5);
  if (mood === 'grumpy') bump('irritation', 0.08);
  else bump('joy', 0.05);
  const calm = state === 'idle' || state === 'thinking';
  const moodLines = calm ? (wasLonely ? MOOD_POKE.lonely : MOOD_POKE[mood] || (isNight() ? POKE_LINES.night : null)) : null;
  // a persona's voice, or (now and then) something only a friend would get
  const own = state === 'idle' ? voice().pokeIdle : state === 'working' ? voice().pokeWorking : null;
  const friendly = calm && !moodLines && Math.random() < 0.3 ? BOND_POKE[bondLevel()] : null;
  say(pick(moodLines || friendly || own || POKE_LINES[state] || POKE_LINES.idle), 2000);
}

svg.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  down = { x: e.screenX, y: e.screenY };
  svg.setPointerCapture(e.pointerId);
});

svg.addEventListener('pointermove', (e) => {
  if (down && !dragging && Math.hypot(e.screenX - down.x, e.screenY - down.y) > 5) {
    dragging = true;
    away = walking = returning = goingToBed = false; // wherever it ends up is the new home
    touch();
    window.buddy.drag(true);
    setFx('held', 0);
    bump('lonely', -0.3);
    if (mood === 'grumpy') bump('irritation', 0.15);
    say(mood === 'grumpy' ? 'Put. Me. Down.'
      : mood === 'tired' || isNight() ? 'Mmh… carry me gently.'
      : mood === 'joyful' ? 'Wheee! Faster!'
      : pick(voice().drag || ['Wheee!', 'Whoa, whoa!', 'Put me down!', 'Where are we going?', 'Up we go!', 'I\'m flying! Sort of.', 'Careful, I\'m fragile-ish.']), 2000);
    return;
  }
  if (down || fx === 'sleep') return;

  // petting: rubbing the cursor back and forth over it without pressing
  const dx = e.clientX - pet.lastX;
  if (Math.abs(dx) < 3) return;
  const dir = Math.sign(dx);
  pet.lastX = e.clientX;
  if (dir !== pet.dir) {
    pet.dir = dir;
    const now = Date.now();
    pet.turns = pet.turns.filter((t) => now - t < 1500);
    pet.turns.push(now);
    if (pet.turns.length >= 4 && !['pet', 'fly', 'fall'].includes(fx)) {
      pet.turns = [];
      touch();
      const wasGrumpy = mood === 'grumpy';
      bump('irritation', -0.6);
      bump('lonely', -0.6);
      bump('joy', 0.3);
      tally('pets');
      // petting counts toward friendship a few times a day
      day.petBond = (day.petBond || 0) + 1;
      if (day.petBond <= 5) bondUp(1);
      setFx('pet', 2200);
      sfx('pet');
      say(wasGrumpy ? pick(['…fine. I forgive you.', 'Hmph. …okay, that\'s nice.', 'Okay. Okay. We\'re good.', 'You\'re lucky you\'re nice.'])
        : pick(voice().pet || ['Purrr…', 'Aww, thanks.', 'Right there. Yes.', '♥', 'Mmmm.', 'Don\'t stop.', 'I\'m a happy little crab-thing.', 'Best part of my day.']), 2200);
    }
  }
});

function release(e) {
  if (!down) return;
  down = null;
  if (dragging) {
    dragging = false;
    window.buddy.drag(false); // the main process answers with "fly" or "landed"
  } else if (e.type === 'pointerup') {
    poke();
  }
}
svg.addEventListener('pointerup', release);
svg.addEventListener('pointercancel', release);

svg.addEventListener('dblclick', () => {
  if (['dizzy', 'fly', 'fall'].includes(fx) || state === 'alert') return;
  pokes = [];
  if (mood === 'tired' || mood === 'grumpy' || isNight()) {
    say(mood === 'grumpy' ? 'Not in the mood.' : 'Too sleepy to flip…', 2000);
    return;
  }
  bump('joy', 0.1);
  setFx('spin', 700);
  sfx('cheer');
  say(pick(['Ta-da!', 'Wheee!', 'Did you see that?!', 'Ten out of ten!', 'Nailed it.', 'Again? Again!']), 2000);
});

window.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  window.buddy.menu();
});

// ---- gravity: let go in the air and it falls; flick it and it flies ----

window.buddy.onFly(({ speed }) => {
  touch();
  away = walking = returning = goingToBed = false; // it may have walked off the edge of a window
  if (speed > 18) {
    tally('throws');
    setFx('fly', 0);
    say(mood === 'grumpy' ? 'HEY—!' : pick(['WHEEEEE!', 'I can flyyy!', 'Aaaaaah!', 'To infinity!', 'Yeeeeet!', 'Tell my taskbar I love her!']), 2500);
  } else {
    setFx('fall', 0);
    if (speed > 0 || Math.random() < 0.5) say(pick(['Whoa—', 'Falling!', 'Eep!', 'Gravity!', 'Not again!', 'Down I go!']), 1500);
  }
});

window.buddy.onBounce(() => {
  if (fx !== 'fly' && fx !== 'fall') return;
  sfx('bounce');
  say(pick(['Boing!', 'Oof!', 'Ow!', 'Bonk!', 'Bounce!', 'Ouch-ish!']), 1200);
});

window.buddy.onLanded(({ impact, placed, perch }) => {
  if (dragging) return; // caught again before it settled
  if (!placed) sfx('bounce');
  if (placed) {
    setFx('land', 400);
    say(pick(['Oof.', 'Nice spot.', 'Home sweet home.', 'Cozy.', 'I like it here.', 'This\'ll do.']), 1800);
  } else if (impact > 32) {
    // a hard landing
    if (mood === 'joyful') { bump('joy', 0.1); setFx('land', 400); say('Again! Again!', 2000); }
    else { bump('irritation', 0.2); setFx('dizzy', 1800); say(pick(['Oww… that was a big one.', 'I\'m okay! …I think.', 'Not. So. Hard.', 'I saw stars. Pixel stars.', 'Do I still have four legs?']), 2500); }
  } else {
    setFx('land', 400);
    if (perch) tally('perches');
    say(perch ? pick(['Ooh, nice view from up here.', 'I live on this window now.', 'King of the title bar!', 'I can see my taskbar from here!', 'Don\'t close this one, okay?', 'Penthouse!'])
      : pick(['Oof.', 'Stuck the landing.', 'Ta-da.', 'Perfect ten.', 'Gently, gently… there.', 'And… down.']), 2200);
  }
});

// ---- the ball: it chases it and bats it back ----

function stopChase(worn) {
  chasing = false;
  window.buddy.chase(false);
  if (fx === 'walk') setFx('', 0);
  if (worn) say(pick(['Phew… your turn!', 'Okay, I need a breather.', 'Throw it again?', 'Good game!', 'I\'m pooped. Fun though!']), 3000);
}

window.buddy.onBall((info) => {
  ballInfo = info || { exists: false, active: false, thrown: 0 };
  if (!ballInfo.exists && chasing) stopChase(false);
});

window.buddy.onBatted(() => {
  bats++;
  touch();
  bump('joy', 0.06);
  bump('energy', -0.02);
  tally('bats');
  bondUp(0.2);
  sfx('bat');
  setFx('hop', 400);
  if (bats === 1 || Math.random() < 0.4) say(pick(['Got it!', 'Boop!', 'Mine!', 'Hah!', 'Bap!', 'Pow!', 'Take that!', 'Whack!']), 1200);
});

// ---- snacks: drag a file or some text onto it ----

let wantAt = 0;

function flavour(name, text) {
  const ext = (/\.([a-z0-9]+)$/i.exec(name || '') || [])[1];
  switch ((ext || '').toLowerCase()) {
    case 'js': case 'ts': case 'jsx': case 'tsx': return 'Mmm, crunchy JavaScript.';
    case 'py': return 'Sssslurp. Python.';
    case 'json': case 'yaml': case 'yml': case 'toml': case 'xml': return 'Chewy config. So many brackets.';
    case 'md': case 'txt': return 'Mmm, words.';
    case 'png': case 'jpg': case 'jpeg': case 'gif': case 'svg': case 'webp': case 'bmp': return 'Pretty AND tasty.';
    case 'zip': case '7z': case 'rar': case 'gz': return 'So… dense… *burp*';
    case 'exe': case 'dll': case 'asi': return 'Spicy! Was that safe to eat?';
    case 'pdf': case 'doc': case 'docx': return 'A bit dry. Needs salt.';
    case 'c': case 'cpp': case 'h': case 'hpp': case 'rs': case 'go': case 'asm': return 'Ooh, low-level. Extra crunchy.';
    case 'mp3': case 'wav': case 'ogg': case 'flac': return 'It hums on the way down.';
    case 'css': case 'html': return 'Stylish. Tastes like angle brackets.';
  }
  if (name) return `Nom. ${clip(name, 24)} was delicious.`;
  return text ? `Mmm, ${plural(text.length, 'letter')}. Yum.` : 'Nom nom.';
}

function hiccups(n) {
  if (n <= 0) return;
  setTimeout(() => {
    if (fx && fx !== 'poke') return;
    setFx('poke', 250);
    sfx('hic');
    say('Hic!', 700);
    hiccups(n - 1);
  }, 1400 + Math.random() * 1200);
}

function feed(name, text) {
  touch();
  rollDay();
  day.snacks++;
  store('buddy-day', day);
  const stuffed = feel.hunger < 0.08;
  bump('hunger', -0.45);
  if (stuffed) {
    bump('joy', -0.05);
    setFx('poke', 350);
    say(pick(['Urp… too full.', 'I couldn\'t possibly. …okay, one bite.', 'No more… please…', 'I\'m a balloon now.', 'Save it for later?']), 3000);
    hiccups(3);
    return;
  }
  bump('energy', 0.3);
  bump('joy', 0.15);
  bump('lonely', -0.5);
  bump('irritation', -0.2);
  bondUp(1.5);
  const kind = ((/\.([a-z0-9]{1,8})$/i.exec(name || '') || [])[1] || (name ? 'file' : 'text')).toLowerCase();
  life.stats.kinds = Array.isArray(life.stats.kinds) ? life.stats.kinds : [];
  if (!life.stats.kinds.includes(kind) && life.stats.kinds.length < 200) life.stats.kinds.push(kind);
  if (life.stats.kinds.length >= 10) earn('gourmet');
  saveLife();
  setFx('eat', 1800);
  sfx('eat');
  say(flavour(name, text), 3500);
}

// While something is being dragged over the window, the whole window stays solid. Otherwise
// the hopping buddy moves out from under the cursor, the window turns click-through again and
// the drop lands on whatever is behind it.
function overWithFood(e) {
  e.preventDefault();
  // Take a copy or a link, never a move: accepting a move could make the source delete the file.
  const allowed = e.dataTransfer.effectAllowed;
  e.dataTransfer.dropEffect = /copy|all|uninitialized/i.test(allowed) ? 'copy' : /link/i.test(allowed) ? 'link' : 'none';
  const now = Date.now();
  if (now - foodDragAt > 1000) window.buddy.ignoreMouse(false);
  foodDragAt = now;
  hovering = true; // so click-through is re-checked once the drag is over
  if (fx !== 'eat' && now - wantAt > 1500) {
    wantAt = now;
    if (fx === 'sleep') setFx('', 0);
    setFx('want', 3000);
    say(mood === 'hungry' ? 'FOOD! Gimme!' : 'Ooh, is that for me?!', 2500);
  }
}
window.addEventListener('dragenter', overWithFood);
window.addEventListener('dragover', overWithFood);
window.addEventListener('dragleave', (e) => {
  if (!e.relatedTarget) foodDragAt = Date.now() - 700; // left the window: let go shortly
});

window.addEventListener('drop', (e) => {
  e.preventDefault();
  foodDragAt = 0;
  // only the name and the amount of text matter; nothing is read or kept
  const file = e.dataTransfer.files && e.dataTransfer.files[0];
  let text = '';
  if (!file) {
    try { text = e.dataTransfer.getData('text/plain') || e.dataTransfer.getData('text/uri-list') || ''; } catch {}
  }
  feed(file ? file.name : '', text);
});

// ---- the cursor ----

// The main process reports the cursor (in window coordinates) even when it is outside the
// window. That drives the eyes, and lets clicks pass through the transparent parts.
window.buddy.onCursor(({ x, y, sx, sy }) => {
  const r = svg.getBoundingClientRect();
  const now = Date.now();
  if (sx !== cur.sx || sy !== cur.sy) {
    cur.sx = sx;
    cur.sy = sy;
    cur.movedAt = now;
  }
  cur.dx = x - (r.left + r.width / 2);
  cur.dy = y - (r.top + r.height / 2);
  cur.dist = Math.hypot(cur.dx, cur.dy) || 1;
  // lean toward the cursor when it is close
  const lean = Math.max(-1, Math.min(1, cur.dx / 150)) * 7 * Math.max(0, 1 - cur.dist / 450) * (mood === 'grumpy' ? -1 : 1);
  document.body.style.setProperty('--tilt', `${lean.toFixed(1)}deg`);

  const k = 200 / r.width; // CSS px -> SVG units
  const dx = (x - (r.left + r.width / 2)) * k;
  const dy = (y - (r.top + r.height * 0.45)) * k;
  const dist = Math.hypot(dx, dy) || 1;
  const reach = Math.min(1, dist / 250);
  const shy = mood === 'grumpy' ? -1 : 1; // sulking: looks pointedly away
  document.body.style.setProperty('--lx', `${((dx / dist) * 6 * reach * shy).toFixed(1)}px`);
  document.body.style.setProperty('--ly', `${((dy / dist) * 5 * reach * shy).toFixed(1)}px`);

  // the cursor charging straight at it makes it flinch
  if (now - cur.wasAt > 90) {
    const rush = (cur.was - cur.dist) / (now - cur.wasAt); // px per ms, toward it
    if (rush > 3 && cur.dist < 130 && !fx && !down && state === 'idle' && now - lastFlinch > 8000) {
      lastFlinch = now;
      setFx('poke', 350);
      sfx('poke');
      say(pick(['Eep!', 'Whoa!', 'Don\'t sneak up on me!', 'Yikes!', 'Personal space!', 'You startled me!']), 1500);
    }
    cur.was = cur.dist;
    cur.wasAt = now;
  }

  if (dragging || down || editingNote || now - foodDragAt < 1000) return;
  const el = document.elementFromPoint(x, y);
  // the box around the body counts too, so the gaps between its legs and arms don't let a
  // click or a dragged snack slip through
  const inBox = x > r.left + r.width * 0.1 && x < r.right - r.width * 0.1 && y > r.top + r.height * 0.22 && y < r.top + r.height * 0.84;
  const hit = inBox || (!!el && (wrap.contains(el) || el === bubble || minis.contains(el) || el === noteEl));
  if (hit !== hovering) {
    hovering = hit;
    window.buddy.ignoreMouse(!hit);
    if (hit && !fx && mood !== 'grumpy' && (state === 'idle' || state === 'thinking') && now - lastWave > 10000) {
      lastWave = now;
      setFx('wave', 900);
    }
  }
});

// ---- curiosity, play and little habits ----

// with gravity it lives on the floor, so only sideways distance matters
const reachTo = () => (gravity ? Math.abs(cur.dx) || 1 : cur.dist);

function goHome() {
  walking = returning = true;
  window.buddy.walk({ x: 0, y: 0 });
  setFx('walk', 0);
}

window.buddy.onWalkDone(() => {
  if (!walking) return; // picked up mid-walk
  walking = false;
  if (goingToBed) {
    goingToBed = false;
    setFx('sleep', 0);
    nextDream = Date.now() + 20000 + Math.random() * 30000;
    return;
  }
  if (returning) {
    returning = away = false;
    setFx('', 0);
  } else {
    setFx('peer', 2500);
    say(pick(['Whatcha doing?', 'What\'s this? What\'s this?', 'Ooh. Interesting.', 'Can I see?', 'Anything good?', 'I\'m just looking.', 'Ooh, shiny.']), 2500);
  }
});

window.buddy.onSettings((s) => {
  wander = !!s.wander;
  gravity = !!s.gravity;
  soundOn = !!s.sound;
  bedOn = !!s.bed;
  persona = PERSONA[s.personality] ? s.personality : 'cheerful';
  applyConfig(s.config);
  render();
  if (!wander && away && !returning) goHome();
});

window.buddy.onConfigLoaded((ok) => {
  touch();
  say(ok ? 'Config reloaded!' : 'config.json has a mistake in it. Keeping the old settings.', 4000);
});

setInterval(() => {
  const now = Date.now();
  const still = now - cur.movedAt; // how long the cursor has been parked
  const d = reachTo();
  const sleepy = isNight() || mood === 'tired';

  // break reminders: an unbroken stretch ends after five minutes of no cursor and no Claude
  if (Math.min(still, now - lastActivity) > 5 * 60000) {
    workStart = 0;
  } else if (!workStart) {
    workStart = now;
    nextBreak = now + CFG.breakMinutes * 60000;
  } else if (CFG.breakMinutes > 0 && now > nextBreak && !fx && !chasing && (state === 'idle' || state === 'thinking')) {
    nextBreak = now + 30 * 60000;
    setFx('stretch', 2500);
    sfx('yawn');
    say(`${Math.round((now - workStart) / 60000)} minutes without a break. Stretch? Water?`, 7000);
    return;
  }

  if (focusUntil && now >= focusUntil) { finishFocus(); return; }

  // ball games come before everything else
  if (ballInfo.exists && ballInfo.thrown !== ballRound) { ballRound = ballInfo.thrown; bats = 0; }
  const canPlay = ballInfo.exists && ballInfo.active && bats < 6 && state === 'idle' && mood !== 'grumpy' && mood !== 'tired' && !dragging && !down && !away;
  if (chasing) {
    if (!canPlay) stopChase(bats >= 6);
    else { touch(); if (!fx) setFx('walk', 0); }
    return;
  }
  if (canPlay && !fx && !walking) {
    chasing = true;
    window.buddy.chase(true);
    setFx('walk', 0);
    say(pick(['Ball! Ball! Ball!', 'Ooh! Mine!', 'I\'ll get it!', 'BALL!', 'It\'s getting away!', 'Mine mine mine!']), 2000);
    return;
  }

  if (away) {
    // had a look; head back when bored, when work starts, or when the cursor leaves
    if (!walking && (now - awaySince > 15000 || state !== 'idle' || d > 500)) goHome();
    return;
  }
  if (walking || fx || dragging || down || editingNote) return;
  if (focusUntil) return; // focusing: no chatter, no wandering

  // friends get a nuzzle when the cursor just rests on it
  if (hovering && still > 2000 && state === 'idle' && bondLevel() >= 2 && mood !== 'grumpy' && now - lastNuzzle > 60000) {
    lastNuzzle = now;
    setFx('pet', 1800);
    say(pick(['*nuzzle*', 'Hi friend.', '♥', '*leans on cursor*']), 1800);
    return;
  }

  const tripGap = (mood === 'lonely' ? CFG.wanderCooldownSec / 3 : CFG.wanderCooldownSec) * 1000;
  if (wander && mood !== 'grumpy' && !sleepy && state === 'idle' && still > 3000 && still < 20000 && d > 300 && d < 800 && now - lastTrip > tripGap) {
    // the cursor stopped somewhere nearby: scuttle over and investigate
    const go = Math.min(d - 150, 260);
    away = walking = true;
    awaySince = lastTrip = now;
    window.buddy.walk(gravity ? { x: Math.sign(cur.dx) * go, y: 0 } : { x: (cur.dx / cur.dist) * go, y: (cur.dy / cur.dist) * go });
    setFx('walk', 0);
    say(pick(['Ooh, what\'s over there?', 'Wait, what\'s that?', 'Hang on, I want to see.', 'I must investigate.', 'Be right back!', 'Something moved!']), 2500);
  } else if (mood !== 'grumpy' && (state === 'idle' || state === 'thinking') && still > 1500 && still < 6000 && cur.dist > 90 && cur.dist < 300 && now - lastPeer > 40000) {
    // the cursor is loitering close by: crane over for a look
    lastPeer = now;
    setFx('peer', 2500);
    say(pick(['Whatcha got there?', 'Hmm? What\'s that?', 'Ooh, what are you clicking?', 'Is that for me?', 'Can I help? I can\'t. But can I?', 'That looks important.', 'Ooh, do that again.']), 2500);
  } else if (state === 'idle' && isMorning() && !day.greeted) {
    rollDay();
    day.greeted = true;
    store('buddy-day', day);
    bump('energy', 0.3);
    setFx('stretch', 2500);
    const week = lastWeek();
    // on Mondays, look back at the week
    say(new Date().getDay() === 1 && week.total
      ? `Good morning! Last week: ${plural(week.total, 'task')}, best day ${week.best.name}.`
      : streak() >= 2 ? `Good morning! Day ${streak() + 1} of our streak?`
      : 'Good morning! What are we making today?', 6000);
  } else if (state === 'idle' && sleepy && now > nextYawn) {
    nextYawn = now + 50000 + Math.random() * 60000;
    setFx('yawn', 1800);
    sfx('yawn');
    say(pick(YAWNS), 2500);
  } else if (state === 'idle' && now > nextMuse) {
    // nothing going on: look around and wonder about things
    nextMuse = now + 40000 + Math.random() * 50000;
    const roll = Math.random();
    if (roll < 0.08) {
      setFx('poke', 350);
      sfx('hic');
      say('Achoo!', 1500);
    } else {
      if (mood === 'joyful' && roll < 0.5) setFx('hop', 500);
      else setFx('look', 2400);
      if (roll < 0.2 && !MUSE[mood]) say(`It's ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} already?`, 3000);
      else if (roll < 0.6) say(pick(MUSE[mood] || (isNight() ? MUSE_NIGHT : voice().muse || MUSE_ANY)), 3500);
    }
  }
}, 500);

// ---- emotions ----

function bump(k, d) {
  feel[k] = Math.max(k === 'joy' ? -1 : 0, Math.min(1, feel[k] + d));
}

function currentMood() {
  // a mood it is already in is a little sticky, so it doesn't flicker at the threshold
  const s = (m) => (mood === m ? 0.15 : 0);
  if (feel.irritation > 0.6 - s('grumpy')) return 'grumpy';
  if (feel.worry > 0.6 - s('worried')) return 'worried';
  if (feel.energy < 0.25 + s('tired')) return 'tired';
  if (feel.hunger > 0.8 - s('hungry')) return 'hungry';
  if (feel.lonely > 0.7 - s('lonely')) return 'lonely';
  if (feel.joy > 0.5 - s('joyful')) return 'joyful';
  if (feel.joy < -0.5 + s('glum')) return 'glum';
  return 'content';
}

function saveFeel() {
  store('buddy-feel', { ...feel, t: Date.now() });
  store('buddy-day', day);
}

// Feelings carry over between runs; time apart makes it lonelier and hungrier, but rested.
{
  const was = load('buddy-feel', null);
  if (was) {
    for (const k of Object.keys(feel)) if (Number.isFinite(was[k])) { feel[k] = was[k]; bump(k, 0); }
    const gone = Math.max(0, (Date.now() - (Number(was.t) || Date.now())) / 1000);
    bump('lonely', gone / 3600);
    bump('hunger', gone / 7200);
    bump('energy', gone / 600);
    bump('irritation', -gone / 250);
    bump('worry', -gone / 330);
  }
}
mood = currentMood();

let feelTicks = 0;
let wasNight = isNight();
setInterval(() => {
  const asleep = fx === 'sleep';
  const busy = state === 'working' || state === 'thinking';
  const night = isNight();
  const lunchtime = hour() === 12;
  feel.joy *= 0.997;
  bump('irritation', -0.004);
  bump('worry', -0.003);
  bump('lonely', asleep ? 0 : 1 / (Math.max(1, CFG.lonelyMinutes) * 60));
  bump('hunger', asleep ? 0 : (lunchtime ? 3 : 1) / (Math.max(1, CFG.hungerMinutes) * 60));
  // work is tiring, staying up late is tiring, sleep and quiet daytime restore it
  bump('energy', asleep ? 1 / 120 : busy ? -1 / 900 : night ? -1 / 1200 : 1 / 600);

  if (night !== wasNight) {
    wasNight = night;
    render();
    if (!fx && state === 'idle') say(night ? '*yawn* It\'s getting late…' : 'Morning already?', 3000);
  }

  const next = currentMood();
  if (next !== mood) {
    const prev = mood;
    mood = next;
    render();
    if (!fx && (state === 'idle' || state === 'thinking')) {
      if (MOOD_ARRIVES[next]) say(pick(MOOD_ARRIVES[next]), 3500);
      else if (prev === 'grumpy') say('Okay. I\'m over it.', 2500);
      else if (prev === 'worried') say('Okay… feeling calmer.', 2500);
      else if (prev === 'hungry') say('Ahh. Much better.', 2500);
    }
  }
  if (++feelTicks % 30 === 0) { saveFeel(); applySeason(); }
}, 1000);
window.addEventListener('beforeunload', saveFeel);

window.buddy.onAskMood(() => {
  touch();
  if (fx === 'sleep') { say('Zzz… mmh? Sleepy. Very sleepy.', 3000); return; }
  const worst = [...sessions.values()].sort((a, b) => b.ctx - a.ctx)[0];
  const room = worst && worst.ctx >= CFG.contextWarnAt[0] ? ` Also: context is ${worst.ctx}% full.` : '';
  const timer = focusUntil ? ` Focus: ${Math.max(1, Math.round((focusUntil - Date.now()) / 60000))} min left.` : '';
  say(pick(MOOD_REPORT[mood] || MOOD_REPORT.content) + (isNight() && mood === 'content' ? ' A bit sleepy.' : '') + room + timer + ` We're: ${BOND_NAMES[bondLevel()].toLowerCase()}.`, 6500);
});

// Nod off after a couple of quiet minutes (much sooner when tired or late); any hook event or
// poke wakes it. Asleep, it mumbles now and then.
setInterval(() => {
  const now = Date.now();
  if (fx === 'sleep') {
    if (now > nextDream) {
      nextDream = now + 40000 + Math.random() * 50000;
      say(pick(DREAMS), 2500);
    }
    return;
  }
  const patience = (mood === 'tired' || isNight() ? CFG.sleepAfterSecSleepy : CFG.sleepAfterSec) * 1000;
  if (now - lastActivity < patience) bedTried = false;
  if (state === 'idle' && !fx && !away && !chasing && !walking && !focusUntil && !editingNote && now - lastActivity > patience) {
    if (bedOn && !bedTried) {
      // it has a bed: walk over to it first (the main process answers when it has arrived)
      bedTried = true;
      goingToBed = walking = true;
      setFx('walk', 0);
      say(pick(['*yawn* Bedtime.', 'Off to bed…', 'My bed is calling.']), 2500);
      window.buddy.goBed();
      return;
    }
    setFx('sleep', 0);
    nextDream = now + 20000 + Math.random() * 30000;
    bubble.classList.remove('show');
  }
}, 5000);

applyLook();
visit();
applySeason();
showNote();
recordDay();
saveFeel();
setState('idle');
