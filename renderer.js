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

function load(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key) || 'null');
    return v && typeof v === 'object' ? v : fallback;
  } catch {
    return fallback;
  }
}

function store(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
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
};

// Feelings build up from what happens to it and fade over time; the strongest one is its mood.
const feel = { joy: 0.2, energy: 1, irritation: 0, lonely: 0, worry: 0, hunger: 0.3 };
let mood = 'content'; // content | joyful | grumpy | worried | tired | hungry | lonely | glum
// the hook reactions and these mouse reactions have their own faces; mood stays out of the way
const MOODLESS_STATES = ['happy', 'sad', 'alert'];
const MOODLESS_FX = ['pet', 'spin', 'sleep', 'dizzy', 'hop', 'fly', 'fall', 'eat', 'want', 'yawn', 'stretch'];

const clip = (s, n = 60) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s || '');
const base = (p) => (p ? p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() : '');
const pick = (a) => a[Math.floor(Math.random() * a.length)];
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
const life = { tasks: 0, hat: '', color: 'classic', ...load('buddy-life', {}) };
if (!Number.isFinite(life.tasks) || life.tasks < 0) life.tasks = 0;
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
  window.buddy.wardrobe({ tasks: life.tasks, hat: life.hat, color: life.color, hats: HATS.map(item), colors: COLORS.map(item) });
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
  say(pick(['How do I look?', 'Ooh, fancy.', 'Very me.']), 2500);
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
      setState('happy');
      tell(wasLonely ? 'You\'re back! I missed you.'
        : isNight() ? '*yawn* Up late, huh? Okay, I\'m in.'
        : 'Oh hi! Ready when you are.');
      backToIdle(2500); break;

    case 'UserPromptSubmit':
      s.state = 'thinking';
      s.taskStart = Date.now();
      s.taskTools = 0;
      setState('thinking');
      tell(mood === 'grumpy' ? 'Fine. What now.'
        : mood === 'tired' ? '*yawn* …okay, one more.'
        : mood === 'worried' ? 'Okay… carefully this time.'
        : mood === 'hungry' ? 'On an empty stomach? …okay.'
        : pick(['Ooh, a task…', 'Ooh, what are we making?', 'What is it? What is it?']));
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
        tell(pick(['Eep… careful with that one!', 'That one bites. Double-check?', 'I can\'t look…']) + ` $ ${clip(e.detail, 40)}`, 5000);
      } else if (kind === 'install') {
        tell('Ooh, new packages!', 3000);
      } else {
        const curious = curiousLine(e.tool, e.detail);
        if (curious && !fx) setFx('peer', 1500);
        tell(curious || toolLine(e.tool, e.detail), 4000);
      }
      backToIdle(60000); break;

    case 'PostToolUse':
      activeTools = Math.max(0, activeTools - 1);
      s.state = 'thinking';
      if (activeTools === 0) setState('thinking');
      if (kind === 'test') { bump('joy', 0.15); feel.worry *= 0.6; sfx('cheer'); setFx('hop', 500); tell(pick(['Tests pass! ✓', 'All green!', 'They pass! They pass!']), 3000); }
      else if (kind === 'commit') { bump('joy', 0.1); sfx('done'); setFx('hop', 500); tell(pick(['Committed! Saved forever.', 'Into the history books.']), 3000); }
      else if (kind === 'push') { tell(pick(['Off it goes!', 'Fly, little commits!']), 2500); }
      else if (kind === 'build') { bump('joy', 0.08); tell(pick(['It builds!', 'Compiles. Ship it? (No.)']), 2500); }
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
      tell(kind === 'test' ? pick(['Tests failed… we\'ll get them.', 'Red. Okay. Deep breath.'])
        : kind === 'build' ? 'It didn\'t build. Hmm.'
        : feel.worry > 0.6 ? 'Another one… are we okay?'
        : 'Oof, that one failed.');
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
      tell('Helper is done.'); break;

    case 'Stop': {
      activeTools = 0;
      s.state = 'idle';
      const relieved = feel.worry > 0.4;
      const big = s.taskTools >= 15;
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
          : 'All done!');
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
      tell('Bye!'); setState(alertSession() ? 'alert' : 'idle'); break;
  }
  store('buddy-day', day);
  renderMinis();
});

// ---- phrases (config.json can replace any of these lists) ----

const POKE_LINES = {
  idle:     ['Hey!', 'Boop.', 'That tickles!', 'Yes? Yes?', 'Poke received.', '*wiggles*', 'What was that for?', 'Ooh, is that a mouse?'],
  thinking: ['Shh, thinking…', 'Hold that thought.', 'Hmm? Oh. Hi.'],
  working:  ['Busy! …but hi.', 'Typing here!', 'One sec, one sec.'],
  happy:    ['Hehe!', 'Yay!', 'High five!'],
  sad:      ['…thanks. I needed that.', 'It was not my fault.'],
  night:    ['Mmh… it\'s so late…', '*sleepy blink*', 'Shhh. Night time.'],
};

// What a poke gets you depends on how it feels (only while it isn't busy).
const MOOD_POKE = {
  joyful:  ['Hehe! Again!', 'Boop back!', '♥', 'Best day.'],
  grumpy:  ['Stop it.', 'What.', 'Hmph.', 'I\'m not talking to you.'],
  tired:   ['Mmh… five more minutes.', '*yawn* …what?'],
  hungry:  ['Did you bring food?', 'Poke me with a snack next time.'],
  lonely:  ['You\'re here!', 'Oh! Hi! Hi!', 'I missed you!'],
  worried: ['Is it going to be okay?', 'Eep!'],
  glum:    ['…hi.', 'Thanks for checking in.'],
};

const MUSE = {
  joyful:  ['♪ la la la ♪', 'Today is a good day.', 'I like it here.'],
  grumpy:  ['Hmph.', '…'],
  tired:   ['*yawn*', 'So… sleepy…'],
  hungry:  ['*tummy rumbles*', 'Is it snack time yet?', 'I could really eat a file.'],
  lonely:  ['…hello?', 'Is anyone there?', 'I could use a poke.'],
  worried: ['What if it breaks again?', 'I hope the tests pass…'],
  glum:    ['*sigh*', 'It\'ll go better next time.'],
};
const MUSE_NIGHT = ['It\'s late… shouldn\'t we be asleep?', 'The screen is so bright at night.', 'Everyone else is asleep, you know.', 'Just… resting my eyes…'];
const MUSE_ANY = [
  'I wonder what that button does…',
  'What\'s in all those folders?',
  'Do the other windows have buddies?',
  'How many pixels am I?',
  'What are we building next?',
  'Where does the cursor go at night?',
  'I counted my legs again. Still four.',
  'If I had a keyboard I\'d help. Probably.',
];
const DREAMS = ['…green tests…', '…no, not the semicolon…', '…five more commits…', 'zzz… snacks…', '…it works on my machine…', '…mmh… cursor…'];
const YAWNS = ['*yaaawn*', '*yawn* …so sleepy.', 'Is it bedtime yet?', '*yawn* Just one more task?'];

const MOOD_ARRIVES = {
  joyful:  ['I feel great!', '♪ la la la ♪'],
  grumpy:  ['Hmph.', 'Okay, that\'s enough.'],
  tired:   ['*yawn* I\'m beat.'],
  hungry:  ['My tummy\'s rumbling…', 'Got a file I could eat? Drag one onto me.'],
  lonely:  ['…hello? Anyone?', 'It\'s quiet. Too quiet.'],
  worried: ['I have a bad feeling about this…'],
  glum:    ['*sigh*'],
};

const MOOD_REPORT = {
  content: ['I\'m good. Just watching.'],
  joyful:  ['Really happy right now!'],
  grumpy:  ['Annoyed. Too much poking. (Pets help.)'],
  worried: ['Nervous… things keep failing.'],
  tired:   ['So sleepy. It\'s been a long session.'],
  hungry:  ['Hungry! Drag a file or some text onto me.'],
  lonely:  ['A bit lonely. Nobody has said hi in ages.'],
  glum:    ['Kind of down. Rough run.'],
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
    say(isNight() ? pick(['Mmh… it\'s the middle of the night…', 'Wha—? Is it morning?', '…five more hours…'])
      : pick(['Huh?! I\'m awake!', 'Wha— five more minutes…', 'I was resting my eyes.']));
    return;
  }
  const now = Date.now();
  pokes = pokes.filter((t) => now - t < 2500);
  pokes.push(now);
  day.pokes++;
  if (pokes.length >= 5) {
    pokes = [];
    bump('irritation', 0.35);
    setFx('dizzy', 2600);
    sfx('fail');
    say(pick(['S-stop… so dizzy…', 'Okay okay okay!', 'The room is spinning.']), 2600);
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
  say(pick(moodLines || POKE_LINES[state] || POKE_LINES.idle), 2000);
}

svg.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  down = { x: e.screenX, y: e.screenY };
  svg.setPointerCapture(e.pointerId);
});

svg.addEventListener('pointermove', (e) => {
  if (down && !dragging && Math.hypot(e.screenX - down.x, e.screenY - down.y) > 5) {
    dragging = true;
    away = walking = returning = false; // wherever it ends up is the new home
    touch();
    window.buddy.drag(true);
    setFx('held', 0);
    bump('lonely', -0.3);
    if (mood === 'grumpy') bump('irritation', 0.15);
    say(mood === 'grumpy' ? 'Put. Me. Down.'
      : mood === 'tired' || isNight() ? 'Mmh… carry me gently.'
      : mood === 'joyful' ? 'Wheee! Faster!'
      : pick(['Wheee!', 'Whoa, whoa!', 'Put me down!', 'Where are we going?']), 2000);
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
      setFx('pet', 2200);
      sfx('pet');
      say(wasGrumpy ? pick(['…fine. I forgive you.', 'Hmph. …okay, that\'s nice.'])
        : pick(['Purrr…', 'Aww, thanks.', 'Right there. Yes.', '♥']), 2200);
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
  say(pick(['Ta-da!', 'Wheee!', 'Did you see that?!']), 2000);
});

window.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  window.buddy.menu();
});

// ---- gravity: let go in the air and it falls; flick it and it flies ----

window.buddy.onFly(({ speed }) => {
  touch();
  away = walking = returning = false; // it may have walked off the edge of a window
  if (speed > 18) {
    setFx('fly', 0);
    say(mood === 'grumpy' ? 'HEY—!' : pick(['WHEEEEE!', 'I can flyyy!', 'Aaaaaah!']), 2500);
  } else {
    setFx('fall', 0);
    if (speed > 0 || Math.random() < 0.5) say(pick(['Whoa—', 'Falling!', 'Eep!']), 1500);
  }
});

window.buddy.onBounce(() => {
  if (fx !== 'fly' && fx !== 'fall') return;
  sfx('bounce');
  say(pick(['Boing!', 'Oof!', 'Ow!']), 1200);
});

window.buddy.onLanded(({ impact, placed, perch }) => {
  if (dragging) return; // caught again before it settled
  if (!placed) sfx('bounce');
  if (placed) {
    setFx('land', 400);
    say(pick(['Oof.', 'Nice spot.', 'Home sweet home.']), 1800);
  } else if (impact > 32) {
    // a hard landing
    if (mood === 'joyful') { bump('joy', 0.1); setFx('land', 400); say('Again! Again!', 2000); }
    else { bump('irritation', 0.2); setFx('dizzy', 1800); say(pick(['Oww… that was a big one.', 'I\'m okay! …I think.', 'Not. So. Hard.']), 2500); }
  } else {
    setFx('land', 400);
    say(perch ? pick(['Ooh, nice view from up here.', 'I live on this window now.', 'King of the title bar!'])
      : pick(['Oof.', 'Stuck the landing.', 'Ta-da.']), 2200);
  }
});

// ---- the ball: it chases it and bats it back ----

function stopChase(worn) {
  chasing = false;
  window.buddy.chase(false);
  if (fx === 'walk') setFx('', 0);
  if (worn) say(pick(['Phew… your turn!', 'Okay, I need a breather.', 'Throw it again?']), 3000);
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
  sfx('bat');
  setFx('hop', 400);
  if (bats === 1 || Math.random() < 0.4) say(pick(['Got it!', 'Boop!', 'Mine!', 'Hah!']), 1200);
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
    say(pick(['Urp… too full.', 'I couldn\'t possibly. …okay, one bite.', 'No more… please…']), 3000);
    hiccups(3);
    return;
  }
  bump('energy', 0.3);
  bump('joy', 0.15);
  bump('lonely', -0.5);
  bump('irritation', -0.2);
  setFx('eat', 1800);
  sfx('eat');
  say(flavour(name, text), 3500);
}

window.addEventListener('dragover', (e) => {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  const now = Date.now();
  if (fx !== 'eat' && now - wantAt > 1500) {
    wantAt = now;
    setFx('want', 3000);
    say(mood === 'hungry' ? 'FOOD! Gimme!' : 'Ooh, is that for me?!', 2500);
  }
});

window.addEventListener('drop', (e) => {
  e.preventDefault();
  // only the name and the amount of text matter; nothing is read or kept
  const file = e.dataTransfer.files && e.dataTransfer.files[0];
  feed(file ? file.name : '', file ? '' : e.dataTransfer.getData('text/plain'));
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
      say(pick(['Eep!', 'Whoa!', 'Don\'t sneak up on me!']), 1500);
    }
    cur.was = cur.dist;
    cur.wasAt = now;
  }

  if (dragging || down) return;
  const el = document.elementFromPoint(x, y);
  const hit = !!el && (wrap.contains(el) || el === bubble || minis.contains(el));
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
  if (returning) {
    returning = away = false;
    setFx('', 0);
  } else {
    setFx('peer', 2500);
    say(pick(['Whatcha doing?', 'What\'s this? What\'s this?', 'Ooh. Interesting.', 'Can I see?']), 2500);
  }
});

window.buddy.onSettings((s) => {
  wander = !!s.wander;
  gravity = !!s.gravity;
  soundOn = !!s.sound;
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

  // ball games come before everything else
  if (ballInfo.exists && ballInfo.thrown !== ballRound) { ballRound = ballInfo.thrown; bats = 0; }
  const canPlay = gravity && ballInfo.exists && ballInfo.active && bats < 6 && state === 'idle' && mood !== 'grumpy' && mood !== 'tired' && !dragging && !down && !away;
  if (chasing) {
    if (!canPlay) stopChase(bats >= 6);
    else { touch(); if (!fx) setFx('walk', 0); }
    return;
  }
  if (canPlay && !fx && !walking) {
    chasing = true;
    window.buddy.chase(true);
    setFx('walk', 0);
    say(pick(['Ball! Ball! Ball!', 'Ooh! Mine!', 'I\'ll get it!']), 2000);
    return;
  }

  if (away) {
    // had a look; head back when bored, when work starts, or when the cursor leaves
    if (!walking && (now - awaySince > 15000 || state !== 'idle' || d > 500)) goHome();
    return;
  }
  if (walking || fx || dragging || down) return;

  const tripGap = (mood === 'lonely' ? CFG.wanderCooldownSec / 3 : CFG.wanderCooldownSec) * 1000;
  if (wander && mood !== 'grumpy' && !sleepy && state === 'idle' && still > 3000 && still < 20000 && d > 300 && d < 800 && now - lastTrip > tripGap) {
    // the cursor stopped somewhere nearby: scuttle over and investigate
    const go = Math.min(d - 150, 260);
    away = walking = true;
    awaySince = lastTrip = now;
    window.buddy.walk(gravity ? { x: Math.sign(cur.dx) * go, y: 0 } : { x: (cur.dx / cur.dist) * go, y: (cur.dy / cur.dist) * go });
    setFx('walk', 0);
    say(pick(['Ooh, what\'s over there?', 'Wait, what\'s that?', 'Hang on, I want to see.']), 2500);
  } else if (mood !== 'grumpy' && (state === 'idle' || state === 'thinking') && still > 1500 && still < 6000 && cur.dist > 90 && cur.dist < 300 && now - lastPeer > 40000) {
    // the cursor is loitering close by: crane over for a look
    lastPeer = now;
    setFx('peer', 2500);
    say(pick(['Whatcha got there?', 'Hmm? What\'s that?', 'Ooh, what are you clicking?', 'Is that for me?']), 2500);
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
      else if (roll < 0.6) say(pick(MUSE[mood] || (isNight() ? MUSE_NIGHT : MUSE_ANY)), 3500);
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
  const saved = load('buddy-feel', null);
  if (saved) {
    for (const k of Object.keys(feel)) if (Number.isFinite(saved[k])) { feel[k] = saved[k]; bump(k, 0); }
    const gone = Math.max(0, (Date.now() - (Number(saved.t) || Date.now())) / 1000);
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
  if (++feelTicks % 30 === 0) saveFeel();
}, 1000);
window.addEventListener('beforeunload', saveFeel);

window.buddy.onAskMood(() => {
  touch();
  if (fx === 'sleep') { say('Zzz… mmh? Sleepy. Very sleepy.', 3000); return; }
  const worst = [...sessions.values()].sort((a, b) => b.ctx - a.ctx)[0];
  const room = worst && worst.ctx >= CFG.contextWarnAt[0] ? ` Also: context is ${worst.ctx}% full.` : '';
  say(pick(MOOD_REPORT[mood] || MOOD_REPORT.content) + (isNight() && mood === 'content' ? ' A bit sleepy.' : '') + room, 5000);
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
  if (state === 'idle' && !fx && !away && !chasing && now - lastActivity > patience) {
    setFx('sleep', 0);
    nextDream = now + 20000 + Math.random() * 30000;
    bubble.classList.remove('show');
  }
}, 5000);

applyLook();
setState('idle');
