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
  // a copy: what comes across from the preload is frozen, and all of this gets added to
  if (v && typeof v === 'object') return JSON.parse(JSON.stringify(v));
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
  longJobSec: 60, // a command running this long gets waited out (0 = never)
  waterMinutes: 90, // gentle reminders; 0 turns one off
  postureMinutes: 60,
  eyeMinutes: 40,
  quietStart: 0, // quiet hours, e.g. 9 and 12; the same number twice = none
  quietEnd: 0,
  growAt: [25, 150, 500], // finished tasks at which it becomes a kid, a teenager, a grown-up
  eggAt: 1500, // finished tasks in one lifetime before an egg turns up (0 = never)
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
let quiet = false; // meeting mode: tiny and silent
let quietManual = false;
let autoQuiet = true;
let presence = { full: false, mic: false, app: '', seq: 0 }; // what the main process noticed about the desktop
let typeAlong = true;
let remindersOn = true;
let noticeOn = true;
let moment = ''; // a prop held up for a few seconds: flag, plane, popper, tea, water
let momentTimer;
let waiting = ''; // a long command is running: knit | tap
let jobStart = 0;
let jobTimer;
let failStreak = 0;
let lastTestFailed = false;
let lastCheer = 0;
let planOn = false;
let hobby = '';
let dream = '';
let dreamTimer;
let hiding = 0; // hide and seek: when it hid (0 = not playing)
let lastTouched = Date.now(); // the last time the user did something to it
let lastKey = 0; // the last time a key was pressed anywhere (timing only)
let sulk = ''; // grumpy with its back turned, facing 'l' or 'r'; 'front' once you have gone round to it
let sulkTurns = 0;
let frontSince = 0;
let fiveUntil = 0; // an arm is up for a high five until then
let gift = null; // { g, until } while it is holding a present out
let guest = null; // { f, step, timer } while a friend's buddy is visiting
let editKind = 'note'; // what the text box is for: note | name | teach | invite
let hushUntil = 0; // a big announcement is up: no idle thoughts or mood remarks over it
let fleeing = false; // backing away from a cursor that hurt it
let lastEnough = 0;
let invite = null; // { kind, until } while it is asking you to play
let asking = null; // the question it is waiting on an answer to
let askTimer;
let nextInit = Date.now() + (4 + Math.random() * 4) * 60000; // when it next starts something itself
let lastTap = 0;
let tapAt = 0; // it tapped on the glass and is waiting to see whether you come
let lastComfort = 0;
let testReds = 0; // failed test runs in a row
let roughRun = 0; // failures since the last finished task
let longCared = false;
let defiedBed = 0;

// Feelings build up from what happens to it and fade over time; the strongest one is its mood.
const feel = { joy: 0.2, energy: 1, irritation: 0, lonely: 0, worry: 0, hunger: 0.3, fear: 0, shame: 0, excite: 0, pride: 0, love: 0, envy: 0, boredom: 0, hurt: 0 };
// content | joyful | grumpy | worried | tired | hungry | lonely | glum | scared | embarrassed | excited | proud | loving | jealous | bored | hurt
let mood = 'content';
// the hook reactions and these mouse reactions have their own faces; mood stays out of the way
const MOODLESS_STATES = ['happy', 'sad', 'alert'];
const MOODLESS_FX = ['pet', 'spin', 'sleep', 'dizzy', 'hop', 'fly', 'fall', 'eat', 'want', 'yawn', 'stretch', 'hobby', 'jump', 'sit', 'twirl', 'dance', 'shake', 'surprise', 'quest', 'yuck', 'hide', 'hug', 'knock', 'eyeroll'];

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
const capital = (t) => t.charAt(0).toUpperCase() + t.slice(1);
const hour = () => new Date().getHours();
const isNight = () => {
  const h = hour();
  return CFG.nightStart <= CFG.nightEnd ? h >= CFG.nightStart && h < CFG.nightEnd : h >= CFG.nightStart || h < CFG.nightEnd;
};
const isMorning = () => !isNight() && hour() >= CFG.nightEnd && hour() < CFG.nightEnd + 5;

function render() {
  const showMood = mood !== 'content' && !MOODLESS_STATES.includes(state) && !MOODLESS_FX.includes(fx);
  const sleepy = isNight() && (state === 'idle' || state === 'thinking');
  const cry = (feel.joy < -0.6 && (state === 'sad' || (showMood && mood === 'glum'))) || (showMood && mood === 'hurt');
  const sulking = showMood && mood === 'grumpy' && (sulk === 'l' || sulk === 'r') && !fx;
  document.body.className = state + (fx ? ' fx-' + fx : '') + (showMood ? ' mood-' + mood : '') + (sleepy ? ' night' : '') + (quiet ? ' quiet' : '') + (cry ? ' cry' : '') + (sulking ? ' sulk' : '');
  const d = document.body.dataset;
  d.prop = state === 'working' ? prop : '';
  d.focus = focusUntil ? '1' : '';
  d.moment = moment;
  d.wait = state === 'working' ? waiting : '';
  d.plan = planOn && fx !== 'sleep' ? '1' : '';
  d.hobby = fx === 'hobby' ? hobby : '';
  d.dream = fx === 'sleep' ? dream : '';
  d.sulk = sulking ? sulk : '';
  d.five = state === 'happy' && Date.now() < fiveUntil ? '1' : '';
  d.visiting = guest ? '1' : '';
  renderSign();
}

// hold something up for a few seconds
function showMoment(name, ms) {
  clearTimeout(momentTimer);
  moment = name;
  render();
  momentTimer = setTimeout(() => { moment = ''; render(); }, ms);
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

// `force` is for answers to something the user just asked; the rest goes unsaid in quiet mode
function say(text, ms = 3500, force = false) {
  if (quiet && !force) return;
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
  snap:   [[1400, 0, 0.03, 'triangle', 2], [900, 0.05, 0.05, 'triangle', 2]],
  hum:    [[392, 0, 0.25, 'sine', 2], [440, 0.3, 0.25, 'sine', 2], [523, 0.6, 0.4, 'sine', 2]],
  sip:    [[300, 0, 0.08, 'sine', 2], [360, 0.1, 0.12, 'sine', 2]],
};

function sfx(name) {
  if (!soundOn || quiet || !(CFG.volume > 0) || fx === 'sleep') return;
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
  ['pr', /\bgh\s+pr\s+create\b/i],
  ['merge', /\bgh\s+pr\s+merge\b|\bgit\s+merge\s+(?!--abort)/i],
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
    s = { id, project: '', state: 'idle', last: 0, taskStart: 0, taskTools: 0, ctx: 0, ctxLevel: 0, mode: '', crew: [], alertAt: 0, ask: '', files: new Map(), clashUntil: 0, lastFile: '', bit: '' };
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
  renderSign();
  const list = sessions.size > 1 ? [...sessions.values()].slice(-5) : [];
  const now = Date.now();
  const sig = list.map((s) => `${s.id}:${s.state}:${s.project}:${s.clashUntil > now}`).join('|');
  if (sig === minisShown) return;
  minisShown = sig;
  minis.replaceChildren(...list.map((s) => {
    const d = document.createElement('div');
    d.className = 'mini ' + s.state + (s.clashUntil > now ? ' clash' : '');
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

// ---- helpers: a little one scurries out for every subagent, and back in when it is done ----

const helpersBox = document.getElementById('helpers');

// what a helper carries says what it was sent to do: [x, y, width, height, colour] on the mini
const HELPER_KIT = {
  explore: [[13, -1, 4, 4, '#33363d'], [14, 0, 2, 2, '#bfe6ff'], [12, 3, 1, 2, '#33363d']],
  plan: [[13, -2, 1, 6, '#f2c230'], [13, 4, 1, 1, '#1f1410'], [13, -3, 1, 1, '#e86a9a']],
  check: [[11, 2, 1, 1, '#3fae5a'], [12, 3, 1, 1, '#3fae5a'], [13, 2, 1, 1, '#3fae5a'], [14, 1, 1, 1, '#3fae5a'], [15, 0, 1, 1, '#3fae5a']],
  build: [[3, -1, 10, 2, '#f2c230'], [2, 1, 12, 1, '#d9a520']],
};
const helperKind = (type) => (/explor|search|research/i.test(type) ? 'explore' : /plan|architect|design/i.test(type) ? 'plan' : /review|verif|test|check|audit/i.test(type) ? 'check' : 'build');
let crewSeq = 0;
let crewPeak = 0;

const crewOut = () => [...sessions.values()].flatMap((s) => s.crew);

function syncHelpers() {
  const crew = crewOut().slice(0, 4);
  const live = [...helpersBox.querySelectorAll('.helper:not(.out)')];
  for (const d of live) {
    if (crew.some((h) => h.key === d.dataset.key)) continue;
    d.classList.add('out');
    setTimeout(() => d.remove(), 420);
  }
  for (const h of crew) {
    if (live.some((d) => d.dataset.key === h.key)) continue;
    const d = document.createElement('div');
    d.className = 'helper k-' + h.kind;
    d.dataset.key = h.key;
    const el = miniSvg();
    for (const [x, y, w, height, fill] of HELPER_KIT[h.kind]) {
      const r = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      r.setAttribute('x', x); r.setAttribute('y', y); r.setAttribute('width', w); r.setAttribute('height', height);
      r.setAttribute('fill', fill);
      el.appendChild(r);
    }
    d.appendChild(el);
    helpersBox.appendChild(d);
  }
}

// a subagent sets off: it gets a helper of its own, and a big enough crew makes it the boss
function helperOut(e, s) {
  const type = typeof e.agentType === 'string' ? e.agentType : '';
  if (s.crew.length >= 9) s.crew.shift();
  s.crew.push({ key: `h${++crewSeq}`, id: e.agentId || '', type, kind: helperKind(type), at: Date.now(), fretted: false });
  tally('helpers');
  did('helper');
  bump('excite', 0.1);
  const out = crewOut().length;
  const more = out > crewPeak;
  crewPeak = Math.max(crewPeak, out);
  if (out >= 4) earn('crewchief');
  if (more && out === 3) { bump('pride', 0.3); return pick(['Three helpers out at once! I\'m management now.', 'A whole crew! Everyone know their job?']); }
  if (more && out === 4) return pick(['Four of them! I need a clipboard.', 'Full crew. Nobody touch anything I wouldn\'t.']);
  return type ? `Off you go, ${clip(type, 24)}!` : pick(['Off you go, little one!', 'A helper! Go, go, go!', 'Reinforcements!']);
}

// the one that finished hops back in: by its id, else the oldest of its kind, else the oldest
function helperBack(e, s) {
  const i = Math.max(0, e.agentId ? s.crew.findIndex((h) => h.id === e.agentId) : -1, e.agentType ? s.crew.findIndex((h) => h.type === e.agentType) : -1);
  const [h] = s.crew.splice(i, 1);
  if (!crewOut().length) crewPeak = 0;
  if (!h) return pick(['Helper is done.', 'Thanks, helper!']);
  const gone = Date.now() - h.at;
  const name = h.type ? clip(h.type, 20) : 'Helper';
  if (h.fretted) { feel.worry *= 0.7; return `${name} is back! I was getting worried. ${capital(span(gone))}!`; }
  if (gone > 3 * 60000) return `${name} is back after ${span(gone)}. Tell me everything.`;
  if (!crewOut().length && crewSeq > 1 && Math.random() < 0.4) return pick(['Everyone\'s home. Good work, team.', 'All back in. Nobody got lost.']);
  return h.type ? pick([`${name} is back!`, `Thanks, ${name}!`, `Welcome back, ${name}.`]) : pick(['Helper is done.', 'Helper\'s back!', 'Thanks, helper!', 'Welcome back, little one.']);
}

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
    // one that never reported back is given up on after half an hour; before that, it frets
    s.crew = s.crew.filter((h) => now - h.at < 30 * 60000);
    const late = s.crew.find((h) => !h.fretted && now - h.at > 8 * 60000);
    if (late) {
      late.fretted = true;
      bump('worry', 0.15);
      if (!fx && !quiet && ageIndex() > 0) say(tagFor(s) + `${late.type ? clip(late.type, 20) : 'My helper'} has been gone ${span(now - late.at)}. I hope it's alright out there.`, 5000);
    }
  }
  renderMinis();
  syncHelpers();
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
  if (level >= 3) bump('fear', 0.3);
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
const newDay = () => ({ date: todayKey(), tasks: 0, fails: 0, tools: 0, longestMs: 0, longestTools: 0, snacks: 0, pokes: 0, greeted: false, did: {} });
let day = { ...newDay(), ...load('buddy-day', {}) };
const life = { tasks: 0, hat: '', color: 'classic', bond: 0, lastSeen: '', note: '', badges: {}, stats: {}, exts: [], album: [], tricks: {}, room: {}, fav: '', favFound: false, recap: '', name: '', words: [], friends: [], born: '', partied: '', lastGift: '', answers: {}, asked: '', secrets: [], secretOn: '', hurtOn: '', wary: false, scarf: 0, diary: [], omens: {}, projects: {}, extras: {}, gen: 1, genFrom: 0, elders: [], egg: null, ...load('buddy-life', {}) };
if (!Number.isFinite(life.tasks) || life.tasks < 0) life.tasks = 0;
if (!Number.isFinite(life.bond) || life.bond < 0) life.bond = 0;
if (!life.badges || typeof life.badges !== 'object') life.badges = {};
if (!life.stats || typeof life.stats !== 'object') life.stats = {};
if (!Array.isArray(life.exts)) life.exts = [];
if (typeof life.note !== 'string') life.note = '';
if (!Array.isArray(life.album)) life.album = [];
if (!life.tricks || typeof life.tricks !== 'object') life.tricks = {};
if (!life.room || typeof life.room !== 'object') life.room = {};
if (typeof life.name !== 'string') life.name = '';
if (!life.answers || typeof life.answers !== 'object') life.answers = {};
if (!Array.isArray(life.secrets)) life.secrets = [];
life.words = Array.isArray(life.words) ? life.words.filter((w) => w && typeof w.t === 'string') : [];
life.friends = Array.isArray(life.friends) ? life.friends.filter((f) => f && typeof f.n === 'string') : [];
if (!Number.isFinite(life.scarf) || life.scarf < 0) life.scarf = 0;
life.diary = Array.isArray(life.diary) ? life.diary.filter((p) => p && typeof p.t === 'string') : [];
if (!life.omens || typeof life.omens !== 'object') life.omens = {};
if (!life.omens.runs || typeof life.omens.runs !== 'object') life.omens.runs = {};
life.omens.held = Array.isArray(life.omens.held) ? life.omens.held.filter((b) => b && typeof b.c === 'string') : [];
if (!life.projects || typeof life.projects !== 'object') life.projects = {};
if (!life.extras || typeof life.extras !== 'object') life.extras = {};
life.elders = Array.isArray(life.elders) ? life.elders.filter((f) => f && typeof f.n === 'string') : [];
if (!Number.isFinite(life.gen) || life.gen < 1) life.gen = 1;
if (!Number.isFinite(life.genFrom) || life.genFrom < 0 || life.genFrom > life.tasks) life.genFrom = 0;
if (!life.egg || typeof life.egg !== 'object') life.egg = null;
if (!day.did || typeof day.did !== 'object') day.did = {};
const saveLife = () => store('buddy-life', life);
// tasks finished in this lifetime; `life.tasks` counts every generation's
const genTasks = () => Math.max(0, life.tasks - life.genFrom);
const history = load('buddy-history', {}); // date -> tasks finished that day

let unwritten = null; // a day that is over and not in the diary yet

function rollDay() {
  if (day.date === todayKey()) return;
  unwritten = day;
  day = newDay();
}
rollDay();

// what happened today, for it to dream about later
function did(key) {
  day.did[key] = (day.did[key] || 0) + 1;
}

// ---- photo album: a card for every milestone, kept for good ----

// `pic` adds a little drawing beside the portrait (the gifts use it); `unseen` skips the flash
function snap(kind, title, text, pic, unseen) {
  life.album.push({ d: todayKey(), k: kind, t: clip(title, 40), x: clip(text, 90), hat: life.hat, color: life.color, age: ageIndex(), ...(pic ? { p: pic } : {}) });
  if (life.album.length > 150) life.album.shift();
  saveLife();
  if (unseen) return;
  setTimeout(() => {
    sfx('snap');
    svg.animate([{ filter: 'brightness(2.6)' }, { filter: 'brightness(1)' }], { duration: 450 });
  }, 700);
}

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
// worn as well as a hat, each on or off by itself
const EXTRAS = [
  { id: 'glasses', label: 'Glasses', at: 200 },
];
const unlocked = (u) => !!u && life.tasks >= u.at;
const nextUnlock = () => [...HATS, ...COLORS, ...EXTRAS].filter((u) => !unlocked(u)).sort((a, b) => a.at - b.at)[0];

function applyLook() {
  if (!unlocked(HATS.find((h) => h.id === life.hat))) life.hat = '';
  const color = COLORS.find((c) => c.id === life.color && unlocked(c)) || COLORS[0];
  life.color = color.id;
  document.body.dataset.hat = life.hat;
  for (const x of EXTRAS) document.body.dataset[x.id] = life.extras[x.id] && unlocked(x) ? '1' : '';
  document.body.dataset.bond = bondLevel();
  document.body.style.setProperty('--skin', color.hex);
  store('buddy-life', life);
  const held = (u) => life.omens.held.find((b) => b.c === `hat:${u.id}`);
  const item = (u) => ({ id: u.id, label: u.label + (held(u) ? (held(u).good ? ' (lucky)' : ' (cursed)') : ''), at: u.at, unlocked: unlocked(u) });
  window.buddy.wardrobe({
    tasks: life.tasks, hat: life.hat, color: life.color, hats: HATS.map(item), colors: COLORS.map(item),
    extras: EXTRAS.map((x) => ({ ...item(x), on: !!life.extras[x.id] })),
    badges: BADGES.map((b) => ({ label: `${b.name} (${b.hint})`, earned: !!life.badges[b.id] })),
    room: ROOM.map((r) => ({ id: r.id, label: r.label, need: r.need, unlocked: badgeCount() >= r.need, on: life.room[r.id] !== false })),
    name: life.name,
    code: myCode(),
    friends: life.friends.map((f) => f.n),
    words: life.words.length,
    tricks: TRICKS.map((t) => ({ id: t.id, label: knows(t.id) ? t.name : `??? (${t.how}; needs: ${BOND_NAMES[t.bond].toLowerCase()})`, known: knows(t.id) })),
  });
  sendRoom();
}

// A finished task may cross a threshold; the newest thing gets put on straight away.
function checkUnlocks(before) {
  const got = [...HATS, ...COLORS, ...EXTRAS].filter((u) => u.at > before && u.at <= life.tasks).pop();
  if (!got) return null;
  if (EXTRAS.includes(got)) life.extras[got.id] = true;
  else if (HATS.includes(got)) life.hat = got.id;
  else life.color = got.id;
  return got;
}

window.buddy.onWear((w) => {
  if (!w) return;
  const before = life.hat;
  if (typeof w.hat === 'string') life.hat = w.hat;
  if (typeof w.color === 'string') life.color = w.color;
  if (EXTRAS.some((x) => x.id === w.extra)) life.extras[w.extra] = !life.extras[w.extra];
  applyLook();
  touch();
  setFx('spin', 700);
  // it has views on some of these hats
  const off = before !== life.hat && life.omens.held.find((b) => b.good && b.c === `hat:${before}`);
  const on = before !== life.hat && life.omens.held.find((b) => b.c === `hat:${life.hat}`);
  say(on && !on.good ? 'Not that one! It\'s cursed! …fine. You\'ll see.'
    : on ? 'The lucky one! Good choice.'
    : off ? 'My lucky hat! …okay. But if anything breaks, that\'s on you.'
    : pick(['How do I look?', 'Ooh, fancy.', 'Very me.', 'Stylish, right?', 'New look, same me.', 'Fashion!']), 3000);
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
  say(dayReport(), 9000, true);
});

// ---- the week: the same question on a bigger scale, with a little bar chart ----

function weekReport() {
  rollDay();
  recordDay();
  const days = [];
  let total = 0;
  let before = 0;
  let best = null;
  for (let i = 6; i >= 0; i--) {
    const d = daysAgo(i);
    const n = history[dateKey(d)] || 0;
    total += n;
    days.push({ n, label: d.toLocaleDateString('en-US', { weekday: 'narrow' }), now: i === 0 });
    if (n > 0 && (!best || n > best.n)) best = { n, name: d.toLocaleDateString('en-US', { weekday: 'long' }) };
  }
  for (let i = 13; i >= 7; i--) before += history[dateKey(daysAgo(i))] || 0;
  let text = total ? `This week: ${plural(total, 'task')}.` : 'A quiet week. Nothing finished yet.';
  if (best) text += ` Best day: ${best.name} (${best.n}).`;
  if (total && before) text += total > before ? ` ${total - before} more than the week before!` : total < before ? ` ${before - total} fewer than the week before.` : ' Same as the week before.';
  if (streak() >= 2) text += ` ${streak()}-day streak.`;
  return { text, days, total };
}

function sayChart(text, days, ms) {
  say(text, ms, true);
  const top = Math.max(1, ...days.map((d) => d.n));
  const chart = document.createElement('div');
  chart.className = 'chart';
  for (const d of days) {
    const col = document.createElement('div');
    if (d.now) col.className = 'now';
    const bar = document.createElement('i');
    bar.style.height = `${Math.max(2, Math.round((d.n / top) * 32))}px`;
    col.append(bar, d.label);
    chart.appendChild(col);
  }
  bubble.appendChild(chart);
}

window.buddy.onAskWeek(() => {
  touch();
  if (fx === 'sleep') setFx('', 0);
  const week = weekReport();
  sayChart(week.text, week.days, 14000);
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
  if (level === 4) earn('bestfriends', true);
  document.body.dataset.bond = level;
  bump('love', 1);
  snap('bond', BOND_NAMES[level], BOND_UP[level]);
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

// ---- hurt: rough handling adds up, and waiting alone does not put it right ----

const HURT_FLINCH = ['Don\'t—', '*flinches*', 'Please don\'t.', 'N-not again…', '*shrinks back*'];

function hurtBy(n) {
  bump('hurt', n);
  bump('joy', -n / 2);
}

// made up with: it will not be wary of you tomorrow
function forgiven() {
  if (day.did.hurt && !day.did.madeup) did('madeup');
  if (!life.wary) return;
  life.wary = false;
  saveLife();
}

// pushed past its limit: some friendship is lost, and it takes itself off to bed if it has one
function hadEnough() {
  const now = Date.now();
  if (now - lastEnough < 60000) { say(pick(['…', '*sniff*', '*looks away*']), 1500); return; }
  lastEnough = now;
  life.bond = Math.max(0, life.bond - 2);
  applyLook();
  if (bedOn && !walking && !away && !chasing && !dragging) {
    bedTried = true;
    goingToBed = walking = true;
    setFx('walk', 0);
    say('I\'m going to bed. Leave me alone.', 3500);
    window.buddy.goBed();
  } else {
    say(pick(['That\'s enough. Please. Leave me alone.', 'I don\'t want to play with you any more.', 'Stop. Just… stop.']), 3500);
  }
}

// edge away from the cursor; false if it has to stand its ground
function backOff() {
  if (!wander || away || walking || chasing || hiding || guest || dragging || down) return false;
  away = walking = fleeing = true;
  awaySince = Date.now();
  const far = 110;
  window.buddy.walk(gravity ? { x: -Math.sign(cur.dx || 1) * far, y: 0 } : { x: (-cur.dx / cur.dist) * far, y: (-cur.dy / cur.dist) * far });
  setFx('walk', 0);
  return true;
}

// ---- looking after you: when things keep going wrong it stops fretting and fusses over you ----

const COMFORT = {
  fails: ['Hey. It\'s the code that\'s broken, not you.', 'That\'s a lot of red. Come here. *hug*', 'You\'re doing fine. Bugs are just stubborn.', 'Breathe. I\'m right here.'],
  tests: ['Three red runs. They\'ll go green; they always do.', 'Tests are hard on everyone. *pats your cursor*', 'Still red. Still on your side.'],
  rough: ['That one fought back, and you won anyway. Proud of you.', 'A hard one. You stuck with it.', 'Done. And you didn\'t give up once. *hug*'],
  long: ['You\'ve been at this for hours. You matter more than the diff, you know.', 'Hours without stopping. I\'m proud of you. Now go and stretch.', 'Long day, huh? I\'m here. Take five with me.'],
};
const COMFORT_BABY = ['Hug? Hug.', 'There, there.', '*pat pat*'];
const COMFORT_TEEN = ['…hey. You okay? Not that I care. (I care.)', 'That was rough. You\'re still good at this, though.', 'Ugh, bugs. Want me to glare at them for you?'];

// `tag` names the project when several sessions are talking; false if it held its tongue
function comfort(why, tag = '') {
  const now = Date.now();
  if (quiet || mood === 'hurt' || mood === 'grumpy' || now - lastComfort < 15 * 60000) return false;
  lastComfort = now;
  hushUntil = now + 8000;
  feel.worry *= 0.5; // its own nerves can wait
  bump('love', 0.2);
  setFx('hug', 2600);
  sfx('pet');
  say(tag + pick(ageIndex() === 0 ? COMFORT_BABY : ageIndex() === 2 && Math.random() < 0.5 ? COMFORT_TEEN : COMFORT[why]), 7000);
  did('comfort');
  return true;
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
  { id: 'shipit', name: 'Ship it', hint: 'open a pull request' },
  { id: 'seeker', name: 'Found you', hint: 'win hide and seek 5 times' },
  { id: 'rpschamp', name: 'Good hands', hint: 'win 10 rounds of rock, paper, scissors' },
  { id: 'showoff', name: 'Show-off', hint: 'teach it every trick' },
  { id: 'favourite', name: 'Favourite food', hint: 'find out what it likes best' },
  { id: 'uptop', name: 'Up top', hint: '25 high fives' },
  { id: 'knitter', name: 'Knit wit', hint: 'knit 10 m of scarf' },
  { id: 'family', name: 'Next of kin', hint: 'hatch an egg' },
  { id: 'crewchief', name: 'Crew chief', hint: '4 helpers out at once' },
  { id: 'delegator', name: 'Many hands', hint: 'send out 100 helpers' },
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
  prs: [[1, 'shipit']],
  finds: [[5, 'seeker']],
  rpsWins: [[10, 'rpschamp']],
  fives: [[25, 'uptop']],
  helpers: [[100, 'delegator']],
};

// `photographed`: the moment already has its own card in the album
function earn(id, photographed) {
  const badge = BADGES.find((b) => b.id === id);
  if (!badge || life.badges[id]) return;
  life.badges[id] = todayKey();
  applyLook(); // saves, and refreshes the menu
  bump('pride', 0.5);
  if (!photographed) snap('badge', badge.name, capital(badge.hint) + '.');
  setTimeout(() => { sfx('level'); confetti(26); say(`Achievement unlocked: ${badge.name}!`, 6000); }, 2200);
  // every few badges there is something new for its room
  const prize = ROOM.find((r) => r.need === badgeCount());
  if (prize) setTimeout(() => say(`And something new for my room: ${prize.label.toLowerCase()}!`, 5000), 8500);
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
// the teenage phase: it answers back, until it grows out of it
const TEEN = {
  pokeIdle: ['Ugh. What.', 'Do you MIND?', 'I\'m busy. Doing nothing. It\'s important.', 'Whatever.', 'Stop, you\'re so embarrassing.', 'Can you not.'],
  pokeWorking: ['I KNOW. I\'m doing it.', 'Stop hovering.'],
  greet: ['Oh. More work. Great.', 'Do we have to?', 'Fine. But I\'m not happy about it.'],
  done: ['Done. Can I go now?', 'There. Happy?', 'Finished. You\'re welcome, I guess.'],
  fail: ['Not my fault.', 'It was like that when I got here.', 'Ugh. This code is so unfair.'],
  pet: ['Ugh, not in front of the other windows!', '…okay, it\'s nice. Don\'t tell anyone.', 'I\'m too old for this. …don\'t stop.'],
  drag: ['Put me DOWN. I can walk.', 'This is so undignified.', 'You never let me go anywhere by myself!'],
  wake: ['Five more HOURS.', 'It\'s the weekend somewhere.', 'Ugh. Why are you like this.'],
  muse: ['Nobody understands me.', 'This taskbar is so lame.', 'When I\'m grown I\'ll have my OWN window.', 'I\'m thinking of going all black. Hex #000.', 'You wouldn\'t get it.', 'I didn\'t ask to be rendered.'],
};
// a roll of the dice each time; less of it the better you get on
const rebels = () => ageIndex() === 2 && Math.random() < 0.45 - bondLevel() * 0.06;

// an eye roll and a no; now and then it thinks better of it
function defy(lines) {
  setFx('eyeroll', 900);
  sfx('poke');
  say(pick(lines), 2800);
  if (Math.random() < 0.3) {
    setTimeout(() => {
      if (!fx && state === 'idle' && !quiet) say(pick(['…sorry. That was rude.', '…I didn\'t mean it.', 'Okay, that came out wrong.']), 2500);
    }, 6000);
  }
}

// until it grows out of it, baby talk comes before any personality
const voice = () => {
  if (ageIndex() === 0) return BABY;
  const own = PERSONA[persona] || PERSONA.cheerful;
  return rebels() ? { ...own, ...TEEN } : own;
};

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

const MOOD_WORDS = {
  happy: 'joyful', joyful: 'joyful', sad: 'glum', glum: 'glum', angry: 'grumpy', grumpy: 'grumpy', sleepy: 'tired', tired: 'tired',
  hungry: 'hungry', lonely: 'lonely', worried: 'worried', scared: 'scared', proud: 'proud', excited: 'excited', bored: 'bored',
  jealous: 'jealous', loving: 'loving', love: 'loving', embarrassed: 'embarrassed', hurt: 'hurt',
};

const EDITS = {
  note: {
    max: 80,
    hint: 'What should I remember? Enter saves, Esc cancels.',
    value: () => life.note,
    save(text) {
      life.note = text;
      saveLife();
      showNote();
      say(life.note ? 'Got it. I\'ll hold on to that.' : 'Okay, nothing to remember.', 2500, true);
    },
  },
  name: {
    max: 16,
    hint: 'What will you call me? Enter saves, Esc cancels.',
    value: () => life.name,
    save(text) {
      const old = life.name;
      if (text === old) { say(text ? 'Yep. Still me.' : 'Okay, never mind.', 2000, true); return; }
      life.name = text;
      applyLook();
      rollDay();
      day.renames = (day.renames || 0) + 1;
      if (!text) {
        say(`Not ${old} any more? Okay. I'll just be me.`, 4000, true);
      } else if (!old) {
        bump('joy', 0.4);
        bump('love', 0.6);
        bondUp(2);
        sfx('level');
        confetti();
        setFx('spin', 700);
        snap('name', `Named ${text}`, 'The day I got my name.');
        say(`${text}? ${text}! I love it. I'm ${text}!`, 5000, true);
      } else if (day.renames >= 3) {
        bump('irritation', 0.3);
        setFx('dizzy', 1500);
        say(`${text} now?! Make up your mind! …fine. ${text}.`, 4500, true);
      } else {
        setFx('quest', 1500);
        say(`I was ${old}… and now I'm ${text}? Okay. ${text}. I can be ${text}.`, 5000, true);
      }
    },
  },
  teach: {
    max: 90,
    hint: 'Teach me a phrase! Start with a mood for one I only say then, like "happy: woohoo".',
    value: () => '',
    save(text) {
      if (!text) return;
      const tagged = /^([a-z]+)\s*:\s*(.+)$/i.exec(text);
      const m = tagged ? MOOD_WORDS[tagged[1].toLowerCase()] || '' : '';
      const phrase = (m ? tagged[2] : text).trim().slice(0, 80);
      if (!phrase) return;
      life.words.push({ m, t: phrase });
      while (life.words.length > 40) life.words.shift();
      applyLook();
      bump('joy', 0.1);
      setFx('quest', 1200);
      say(`"${clip(phrase, 50)}" Got it. I'll say that ${m ? `when I'm ${m}` : 'now and then'}.`, 4500, true);
    },
  },
  invite: {
    max: 28,
    hint: 'Paste a friend\'s buddy code (it looks like BUD-1203-Pip).',
    value: () => '',
    save(text) {
      if (!text) return;
      const f = parseCode(text);
      if (!f) { say('That doesn\'t look like a buddy code. They look like BUD-1203-Pip.', 5000, true); return; }
      if (text === myCode()) { say('That\'s MY code! I can\'t visit myself. …can I?', 4000, true); return; }
      life.friends = life.friends.filter((x) => x.n !== f.n);
      life.friends.push(f);
      while (life.friends.length > 8) life.friends.shift();
      applyLook();
      say(`${f.n}! A new friend! I'll ask them over.`, 3000, true);
      setTimeout(() => startVisit(f), 3200);
    },
  },
};

window.buddy.onEdit((kind) => {
  const edit = EDITS[kind];
  if (!edit) return;
  touch();
  if (fx === 'sleep') setFx('', 0);
  editingNote = true;
  editKind = kind;
  noteInput.maxLength = edit.max;
  noteInput.value = edit.value();
  noteInput.classList.add('show');
  noteInput.focus();
  noteInput.select();
  say(edit.hint, 9000, true);
});

function endNoteEdit(keep) {
  if (!editingNote) return;
  editingNote = false;
  noteInput.classList.remove('show');
  hovering = true; // so the next cursor report re-checks click-through
  if (!keep) { say('Okay, never mind.', 1500, true); return; }
  EDITS[editKind].save(noteInput.value.trim().slice(0, EDITS[editKind].max));
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
  const holiday = birthdayAge() ? 'bday' : month === 11 && date >= 18 ? 'santa' : month === 9 && date >= 25 ? 'pumpkin' : '';
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
    : pick(['Bye! See you next time.', 'Off to bed. Bye!']), 5000, true);
});

// ---- growing up: a baby at first, then a kid, a teenager, a grown-up ----

const AGES = ['baby', 'kid', 'teen', 'grown'];
const AGE_NAMES = ['baby', 'kid', 'teenager', 'grown-up'];
const ageIndex = () => Math.min(3, CFG.growAt.filter((t) => genTasks() >= t).length);
// long after it has grown up it is getting on a bit: spectacles
const isOld = () => CFG.eggAt > 0 && genTasks() >= CFG.eggAt;
const showAge = () => { document.body.dataset.age = AGES[ageIndex()]; document.body.dataset.old = isOld() ? '1' : ''; };
// a baby has few words; these stand in for a personality until it is a kid
const BABY = {
  pokeIdle: ['Ba!', 'Goo?', 'Eee!', '*giggle*', 'Boop!', 'Hi! Hi!'],
  pokeWorking: ['Busy! Ba!', 'Shh!'],
  greet: ['Hi! Hi!', 'You! Yay!', 'Ooo! Hi!'],
  done: ['Did it!', 'Yay!', 'Done! Done!'],
  fail: ['Uh oh.', 'Oopsie.', 'Waaah.'],
  pet: ['*coo*', 'Mmm…', 'Hee!'],
  drag: ['Wheee!', 'Up! Up!', 'Eep!'],
  wake: ['Wah?', '*blinks*'],
  muse: ['Ba ba ba.', 'Ooo.', '*looks at own feet*', 'Whassat?', 'Goo.'],
};

function grewUp() {
  const i = ageIndex();
  hushUntil = Date.now() + 9000;
  showAge();
  applyLook();
  bump('pride', 0.7);
  sfx('level');
  confetti(30);
  setFx('stretch', 2500);
  did('grew');
  snap('grow', `Grew up: ${AGE_NAMES[i]}`, `${plural(genTasks(), 'task')} together so far.`);
  say(i === 3 ? 'Look at me. All grown up! Sorry about the attitude. …I still want snacks.'
    : i === 2 ? 'I got taller! And my voice went funny. Don\'t tell me what to do.'
    : 'I grew! I\'m a big kid now! I know so many more words!', 6000);
}

// ---- phrases you taught it ----

function taught() {
  const fit = life.words.filter((w) => !w.m || w.m === mood);
  return fit.length ? fit[Math.floor(Math.random() * fit.length)].t : '';
}

// ---- birthdays: the day you first ran it, and a smaller do every month ----

const isDate = (d) => /^\d{4}-\d\d-\d\d$/.test(String(d));
if (!isDate(life.born)) {
  // older saves never wrote it down: the earliest day anything is remembered from will do
  const known = [...Object.keys(history), ...Object.values(life.badges), ...life.album.map((c) => c && c.d), life.lastSeen].filter(isDate).sort();
  life.born = known[0] || todayKey();
}

// how old it turns today (0 on any other day)
function birthdayAge() {
  const today = todayKey();
  let day = life.born.slice(5);
  if (day === '02-29' && new Date(Number(today.slice(0, 4)), 1, 29).getMonth() !== 1) day = '02-28';
  return today.slice(5) === day ? Number(today.slice(0, 4)) - Number(life.born.slice(0, 4)) : 0;
}

function monthsOld() {
  const today = todayKey();
  if (today.slice(8) !== life.born.slice(8)) return 0;
  return (Number(today.slice(0, 4)) - Number(life.born.slice(0, 4))) * 12 + Number(today.slice(5, 7)) - Number(life.born.slice(5, 7));
}

function party() {
  const years = birthdayAge();
  life.partied = todayKey();
  saveLife();
  lastActivity = Date.now();
  hushUntil = lastActivity + 9000;
  bump('joy', years ? 0.7 : 0.3);
  bump('excite', years ? 0.8 : 0.3);
  sfx('level');
  if (years) {
    confetti(40);
    setFx('spin', 700);
    snap('bday', `Birthday number ${years}`, `${plural(life.tasks, 'task')} and ${plural(badgeCount(), 'badge')} so far.`);
    say(`It's my birthday! I'm ${years} today! ${plural(life.tasks, 'task')} we've done together!`, 8000);
  } else {
    confetti(12);
    setFx('hop', 500);
    say(`I'm ${plural(monthsOld(), 'month')} old today! Tiny party!`, 5000);
  }
}

// ---- gifts: now and then a best friend gets something it made ----

const GIFTS = [
  { pic: 'us', title: 'A drawing of us', text: 'You and me. You\'re the tall one.', line: 'It\'s us! I drew it myself. You\'re the tall one.' },
  { pic: 'flower', title: 'A pixel flower', text: 'Grown from a single green pixel.', line: 'A flower! I grew it from one pixel.' },
  { pic: 'gem', title: 'A shiny pixel', text: 'Found behind the taskbar. It\'s yours now.', line: 'A shiny pixel! I found it behind the taskbar.' },
  { pic: 'poem', title: 'A poem', text: 'Roses are #f00, violets are #00f, I like it best when it\'s me and you.', line: 'A poem! Roses are #f00, violets are #00f…' },
  { pic: 'medal', title: 'A medal', text: 'For best human. There was only one entrant, but still.', line: 'A medal! For best human. You won by a mile.' },
];

function offerGift() {
  gift = { g: pick(GIFTS), until: Date.now() + 25000 };
  life.lastGift = todayKey();
  saveLife();
  lastActivity = Date.now();
  hushUntil = lastActivity + 9000;
  showMoment('gift', 25000);
  sfx('cheer');
  say(pick(['I made you something! Click me!', 'Psst. I have a present for you. Click me!', 'For you! Open it! (click me)']), 9000);
}

// `opened`: clicked in time; otherwise it puts the present away in the album for later
function openGift(opened) {
  const { g } = gift;
  gift = null;
  clearTimeout(momentTimer);
  moment = '';
  snap('gift', g.title, g.text, g.pic);
  if (!opened) { render(); say('I\'ll put your present in the album for later.', 4000); return; }
  bump('love', 0.6);
  bump('joy', 0.3);
  bondUp(1);
  sfx('level');
  confetti(18);
  setFx('pet', 2200);
  say(g.line, 6000);
}

// ---- starting things: it does not only wait to be asked ----

// each has two answers; `re` is what it says to each, `later` what it brings up another day
const QUESTIONS = [
  { id: 'coffee', q: 'Question! Coffee or tea?', a: ['Coffee', 'Tea'], re: ['Coffee! I knew it. I can smell it through the screen.', 'Tea! Cosy. I approve.'], later: ['Had your coffee yet? You look under-caffeinated.', 'Tea soon? I\'ll put the pixel kettle on.'] },
  { id: 'owl', q: 'Are you a morning person or a night owl?', a: ['Morning', 'Night'], re: ['A morning person! I\'ll try to be up first.', 'A night owl! That explains the hours we keep.'], later: ['Morning people like you make me look lazy.', 'Fellow night owl. Hoo.'] },
  { id: 'tabs', q: 'Tabs or spaces? I won\'t tell anyone.', a: ['Tabs', 'Spaces'], re: ['Tabs. Bold. Efficient.', 'Spaces. Neat. Precise.'], later: ['Still on tabs? Just checking.', 'Still on spaces? Just checking.'] },
  { id: 'pet', q: 'Do you have a pet? Besides me, I mean.', a: ['Yes', 'No'], re: ['Ooh! Tell them I said hi. And that I was here first.', 'So I\'m the only one! No pressure.'], later: ['Say hi to your other pet for me.', 'Being your only pet is a big job. I take it seriously.'] },
  { id: 'music', q: 'Do you listen to music while you work?', a: ['Yes', 'No'], re: ['I thought I felt the desk humming!', 'Silence. Very focused. Very mysterious.'], later: ['What are we listening to today?', 'So quiet in here. I like it.'] },
  { id: 'rain', q: 'Rain or sunshine?', a: ['Rain', 'Sun'], re: ['Rain! Best coding weather.', 'Sunshine! I\'d get a tan, but: pixels.'], later: ['I hope it rains for you today.', 'I hope it\'s sunny where you are.'] },
  { id: 'here', q: 'Do you like having me here?', a: ['Yes', 'No'], re: ['♥ I like being here too.', 'Oh. …I\'ll try to be quieter.'], later: ['You said you like having me here. I think about that a lot.', 'I\'m being extra quiet. Did you notice?'] },
];

// `q.act` makes it a question that does something, not one whose answer it remembers
function ask(q = pick(QUESTIONS.filter((x) => !(x.id in life.answers)))) {
  const now = Date.now();
  asking = q;
  if (!q.act) life.asked = todayKey();
  saveLife();
  lastActivity = now;
  hushUntil = now + 12000;
  const buttons = q.a.map((label, i) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.className = 'word';
    b.dataset.answer = i;
    return b;
  });
  const close = document.createElement('button');
  close.textContent = '✕';
  close.className = 'x';
  close.title = 'not now';
  panel.replaceChildren(...buttons, close);
  panel.classList.add('show');
  hovering = true; // so click-through is re-checked now there are buttons
  setFx('quest', 1500);
  sfx('poke');
  say(q.q, 12000);
  clearTimeout(askTimer);
  askTimer = setTimeout(() => endAsk(false), 30000);
}

function endAsk(answered) {
  clearTimeout(askTimer);
  if (!asking) return;
  asking = null;
  panel.classList.remove('show');
  panel.replaceChildren();
  hovering = true;
  if (!answered) say(pick(['Never mind. I\'ll ask another day.', 'Busy? Okay. Later.']), 3000);
}

function answer(b) {
  const q = asking;
  if (b.dataset.answer === undefined) { endAsk(false); return; }
  const i = Number(b.dataset.answer);
  touch();
  if (q.act) { endAsk(true); q.act(i); return; }
  life.answers[q.id] = i;
  endAsk(true);
  const stung = q.id === 'here' && i === 1;
  if (stung) hurtBy(0.35);
  else { bump('joy', 0.15); bondUp(1); }
  if (q.id === 'here' && i === 0) bump('love', 0.6);
  saveLife();
  setFx(stung ? 'poke' : 'hop', stung ? 350 : 500);
  sfx(stung ? 'fail' : 'cheer');
  say(q.re[i], 5000);
}

// something you told it once, brought up again
function recall() {
  const known = QUESTIONS.filter((q) => q.id in life.answers);
  if (!known.length) return '';
  const q = known[Math.floor(Math.random() * known.length)];
  return q.later[life.answers[q.id]] || '';
}

function tapGlass() {
  lastTap = tapAt = lastActivity = Date.now();
  setFx('knock', 1500);
  sfx('poke');
  setTimeout(() => sfx('poke'), 300);
  say(ageIndex() === 0 ? pick(['Ba! Ba! Hi!', '*tap tap* Hi!'])
    : rebels() ? pick(['I\'m not lonely. I\'m just standing here. Near you.', '*tap* …no reason.'])
    : pick(['*tap tap* Hey. Hey, you.', '*knocks on the glass* Got a second?', 'Psst. Down here.', '*tap tap tap* I\'m still here, you know.']), 4500);
}

function inviteToPlay() {
  const kind = Math.random() < 0.5 ? 'rps' : 'hide';
  invite = { kind, until: Date.now() + 15000 };
  lastActivity = Date.now();
  setFx('hop', 500);
  sfx('cheer');
  say(kind === 'rps' ? pick(['Rock, paper, scissors? Click me if you\'re in!', 'Play me at rock, paper, scissors? (click me)'])
    : pick(['Bet you can\'t find me. Click me and I\'ll hide!', 'Hide and seek? Click me!']), 9000);
}

// its turn to begin: a secret it is ready to tell, a question, a tap on the glass, a game
function startSomething() {
  const now = Date.now();
  const grown = ageIndex() > 0;
  const secret = grown && life.secretOn !== todayKey() && nextSecret();
  if (secret) tellSecret(secret);
  else if (grown && bondLevel() >= 1 && life.asked !== todayKey() && QUESTIONS.some((q) => !(q.id in life.answers))) ask();
  else if (now - lastTouched > 8 * 60000 && now - lastTap > 20 * 60000) tapGlass();
  else if (grown && !isNight() && !['tired', 'hungry', 'worried', 'embarrassed'].includes(mood)) inviteToPlay();
}

// ---- secrets: things it only tells you once you are close enough, one a day at most ----

const SECRETS = [
  { id: 'wave', at: 1, text: 'I practise my wave when you aren\'t looking.' },
  { id: 'count', at: 1, text: () => `I count your pokes. ${life.stats.pokes || 0} so far. I remember every one.` },
  { id: 'bin', at: 2, text: 'I\'m a bit scared of the recycle bin. Things go in and they don\'t come out.' },
  { id: 'cursor', at: 2, text: 'Sometimes I pretend the cursor is my pet. I call it Dot.' },
  { id: 'still', at: 3, text: 'When you\'re away I sit very still, so the screensaver won\'t notice me.' },
  { id: 'semicolon', at: 3, text: 'I don\'t actually know what a semicolon does. Please don\'t tell Claude.' },
  { id: 'firstday', at: 4, text: 'On my first day I was sure you\'d close me. You didn\'t. I think about that.' },
  { id: 'handshake', at: 4, text: 'Let\'s have a secret handshake. You poke, I say "boop". Nobody else gets one.' },
];
const nextSecret = () => SECRETS.find((s) => s.at <= bondLevel() && !life.secrets.includes(s.id));
// good friends hear about last night's dream in the morning
const DREAM_TELL = ['I had a dream last night. All the tests were green and you were there.', 'I dreamt I caught the cursor. It was warm.', 'Last night I dreamt we shipped on a Friday and nothing broke. Strange dream.', 'I dreamt I was a full-screen app. Too much responsibility.'];

function tellSecret(s) {
  const text = typeof s.text === 'function' ? s.text() : s.text;
  life.secrets.push(s.id);
  life.secretOn = todayKey();
  saveLife();
  lastActivity = Date.now();
  hushUntil = lastActivity + 14000;
  setFx('peer', 2500);
  sfx('poke');
  say(pick(['Psst. Can I tell you a secret?', 'Come closer. I\'ve never told anyone this.', 'Can you keep a secret?']), 3200);
  setTimeout(() => {
    bump('love', 0.3);
    bump('shame', 0.2);
    snap('secret', 'A secret', text);
    say(text, 9000);
  }, 3300);
}

// ---- friends: other people's buddies, added by a short code, who drop in to visit ----

const PERSONA_IDS = ['cheerful', 'sarcastic', 'shy', 'dramatic'];
const codeName = (name) => (name || '').replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 16) || 'Buddy';
// BUD-<colour><hat><age><personality>-<name>: everything a friend's copy needs to draw this one
const myCode = () => `BUD-${Math.max(0, COLORS.findIndex((c) => c.id === life.color))}${HATS.findIndex((h) => h.id === life.hat) + 1}${ageIndex()}${Math.max(0, PERSONA_IDS.indexOf(persona))}-${codeName(life.name)}`;

function parseCode(text) {
  const m = /^BUD-([0-4])([0-6])([0-3])([0-3])-(.{1,16})$/.exec(text.trim());
  if (!m) return null;
  return { n: codeName(m[5]), c: COLORS[Number(m[1])].id, h: m[2] === '0' ? '' : HATS[Number(m[2]) - 1].id, a: Number(m[3]), p: PERSONA_IDS[Number(m[4])] };
}

// hats, drawn small: [x, y, width, height, colour] on the visitor's 16-wide grid
const SMALL_HATS = {
  sprout: [[7, -2, 1, 3, '#3f9a4a'], [8, -3, 2, 1, '#58c064'], [5, -2, 2, 1, '#58c064']],
  cap: [[3, -1, 9, 2, '#3b6fd9'], [11, 0, 4, 1, '#2a4fa0']],
  headphones: [[2, 0, 12, 1, '#33363d'], [1, 1, 1, 4, '#33363d'], [14, 1, 1, 4, '#33363d']],
  tophat: [[5, -4, 6, 4, '#23232a'], [5, -1, 6, 1, '#d9534f'], [4, 0, 8, 1, '#23232a']],
  wizard: [[4, 0, 8, 1, '#5b43c4'], [5, -2, 6, 2, '#6a4fd8'], [7, -4, 2, 2, '#6a4fd8'], [8, -1, 1, 1, '#ffd84a']],
  crown: [[4, -1, 8, 2, '#f2c230'], [4, -2, 1, 1, '#f2c230'], [7, -3, 2, 2, '#f2c230'], [11, -2, 1, 1, '#f2c230'], [8, -1, 1, 1, '#e0483c']],
};

function friendSvg(f) {
  const NS = 'http://www.w3.org/2000/svg';
  const el = document.createElementNS(NS, 'svg');
  const size = [40, 46, 52, 58][f.a] || 58;
  el.setAttribute('viewBox', '0 -5 16 16');
  el.style.width = el.style.height = `${size}px`;
  const rect = (x, y, w, h, fill) => {
    const part = document.createElementNS(NS, 'rect');
    part.setAttribute('x', x); part.setAttribute('y', y); part.setAttribute('width', w); part.setAttribute('height', h);
    part.setAttribute('fill', fill);
    el.appendChild(part);
  };
  const skin = (COLORS.find((c) => c.id === f.c) || COLORS[0]).hex;
  rect(2, 1, 12, 7, skin);
  rect(0, 4, 2, 2, skin); rect(14, 4, 2, 2, skin);
  for (const x of [3, 5, 10, 12]) rect(x, 8, 1, 3, skin);
  rect(5, 3, 1, 2, '#1f1410'); rect(10, 3, 1, 2, '#1f1410');
  for (const part of SMALL_HATS[f.h] || []) rect(...part);
  return el;
}

// what a visitor says, by the personality it has at home
const GUEST_LINES = {
  cheerful: ['Nice place you\'ve got!', 'Ooh, is that your human?', 'We should do this more!', 'I love your taskbar.', 'Race you to the edge of the screen!'],
  sarcastic: ['So this is where you live. Cosy.', 'Your human types loudly.', 'I\'ve seen bigger monitors.', 'Don\'t get up. Oh, you didn\'t.', 'Fine. It\'s nice here. Happy?'],
  shy: ['H-hi… thanks for having me.', 'Is it okay if I stand here?', 'Your human seems nice…', 'I brought… um. Nothing. Sorry.', 'This is nice…'],
  dramatic: ['I have JOURNEYED across the network!', 'What a MAGNIFICENT desktop!', 'Friend! At LAST we meet again!', 'Such pixels! Such splendour!', 'I shall tell TALES of this visit!'],
};
// the ones who stood here before it come back to check on things
const ELDER_LINES = ['Look how you\'ve grown!', 'Is that my scarf? It\'s longer.', 'Are they feeding you properly?', 'I used to stand right there.', 'Keep an eye on the human for me.', 'Still the same taskbar, I see.', 'You have my eyes. Both of them.'];
const HOST_LINES = ['Hehe, right?', 'Tell me everything!', 'How\'s your human?', 'Mine fixed three bugs today.', 'Want to see my bed?', 'Do you get snacks too?', 'Stay a bit longer!'];
const visitorEl = document.getElementById('visitor');
let nextVisit = Date.now() + (20 + Math.random() * 40) * 60000;

function guestSays() {
  visitorEl.classList.remove('talk');
  void visitorEl.offsetWidth; // so the little hop replays
  visitorEl.classList.add('talk');
  say(`${guest.f.n}: ${pick(guest.f.gen ? ELDER_LINES : GUEST_LINES[guest.f.p] || GUEST_LINES.cheerful)}`, 3800);
}

function startVisit(f) {
  if (!f || guest || quiet || hiding) return false;
  if (fx === 'sleep') setFx('', 0);
  guest = { f, step: 0, timer: 0 };
  const label = document.createElement('span');
  label.textContent = f.n;
  visitorEl.replaceChildren(label, friendSvg(f));
  visitorEl.className = 'here';
  hovering = true; // the visitor can be clicked
  lastActivity = Date.now();
  bump('lonely', -0.8);
  bump('joy', 0.25);
  bump('excite', 0.4);
  sfx('cheer');
  setFx('wave', 1500);
  say(pick([`${f.n}! You came!`, `${f.n}! Come in, come in!`, `Look who it is! ${f.n}!`]), 3500);
  // they take turns: the visitor, then the host, a few times over
  guest.timer = setInterval(() => {
    if (!guest) return;
    guest.step++;
    lastActivity = Date.now(); // nobody falls asleep with company round
    if (guest.step > 6 || quiet) { endVisit(); return; }
    if (state !== 'idle' || (fx && fx !== 'wave')) return; // busy: the chat waits
    if (guest.step % 2) guestSays();
    else { setFx('hop', 500); say(pick(HOST_LINES), 3800); }
  }, 4200);
  render();
  return true;
}

function endVisit() {
  if (!guest) return;
  const { f } = guest;
  clearInterval(guest.timer);
  guest = null;
  nextVisit = Date.now() + (120 + Math.random() * 180) * 60000;
  visitorEl.className = 'here leaving';
  setTimeout(() => {
    if (guest) return; // someone else has already arrived
    visitorEl.className = '';
    visitorEl.replaceChildren();
    hovering = true;
    render();
  }, 1600);
  bondUp(0.5);
  did('guest');
  if (!f.met) {
    f.met = true;
    snap('visit', `${f.n} came over`, f.gen ? 'Back to see how the little one is getting on.' : 'A friend dropped by to play.');
  }
  saveLife();
  if (!quiet && fx !== 'sleep') { setFx('wave', 1500); say(`Bye, ${f.n}! Come again soon!`, 3000); }
}

visitorEl.addEventListener('click', () => {
  if (!guest) return;
  touch();
  guestSays();
});

window.buddy.onDo((msg) => {
  const what = msg && msg.what;
  touch();
  if (fx === 'sleep') setFx('', 0);
  if (what === 'copied') {
    say('My code is on your clipboard. Send it to a friend!', 4500, true);
  } else if (what === 'visit') {
    if (!startVisit(life.friends.find((f) => f.n === msg.arg))) say(guest ? 'I already have company!' : 'Not right now.', 2500, true);
  } else if (what === 'forget-friends') {
    endVisit();
    life.friends = [];
    applyLook();
    say('Okay. Address book emptied.', 2500, true);
  } else if (what === 'forget-words') {
    life.words = [];
    applyLook();
    say('Forgotten. Clean slate.', 2500, true);
  }
});

// ---- high five: an arm goes up when a task is done; slap it while it lasts ----

function highFive() {
  const left = fiveUntil - Date.now();
  const perfect = left > 2000; // within the first second
  fiveUntil = 0;
  tally('fives');
  bondUp(perfect ? 0.6 : 0.3);
  bump('joy', 0.15);
  bump('love', 0.1);
  sfx('bat');
  confetti(perfect ? 14 : 6);
  setFx('hop', 400);
  say(perfect ? pick(['PERFECT high five!', 'Smack! Right on time!', 'Now THAT was a high five!']) : pick(['High five!', 'Up top!', 'Yeah! Team!', 'Nice one!']), 2200);
}

// ---- the permission sign: what Claude is asking for, held up until it is answered ----

const signEl = document.getElementById('sign');
let signShown = '';

function renderSign() {
  const s = quiet ? null : [...sessions.values()].find((x) => x.state === 'alert' && x.ask);
  const sig = s ? `${s.id}|${s.ask}|${sessions.size}` : '';
  if (sig === signShown) return;
  signShown = sig;
  signEl.classList.toggle('show', !!s);
  if (!s) { signEl.replaceChildren(); return; }
  const head = document.createElement('b');
  head.textContent = `${tagFor(s)}Claude asks:`;
  // textContent only: the command is untrusted
  signEl.replaceChildren(head, s.ask);
}

signEl.addEventListener('click', () => {
  const s = alertSession();
  if (s) goToSession(s);
});

// ---- its room: the bed's corner fills up with things as achievements come in ----

const ROOM = [
  { id: 'rug', label: 'Rug', need: 1 },
  { id: 'plant', label: 'Plant', need: 2 },
  { id: 'lamp', label: 'Lamp', need: 4 },
  { id: 'poster', label: 'Poster', need: 6 },
  { id: 'shelf', label: 'Trophy shelf', need: 9 },
  { id: 'lights', label: 'Fairy lights', need: 12 },
];
const badgeCount = () => Object.keys(life.badges).length;
// the plant (the one in the room, and the one it waters) grows with the streak
const plantStage = () => { const n = streak(); return n >= 14 ? 3 : n >= 7 ? 2 : n >= 3 ? 1 : 0; };

function sendRoom() {
  window.buddy.room({
    on: ROOM.filter((r) => badgeCount() >= r.need && life.room[r.id] !== false).map((r) => r.id),
    plant: plantStage(),
    night: isNight(),
    scarf: scarfStage(),
  });
}

window.buddy.onRoomToggle((id) => {
  const item = ROOM.find((r) => r.id === id);
  if (!item || badgeCount() < item.need) return;
  life.room[id] = life.room[id] === false;
  applyLook();
  touch();
  say(life.room[id] ? pick(['Ooh, that ties the room together.', 'Perfect spot for it.', 'Home improvement!']) : 'Okay, back in the cupboard.', 2500, true);
});

// ---- tricks: repeat a gesture a few times and it works out what you mean ----

const TRICK_REPS = 5;
const TRICKS = [
  { id: 'jump', name: 'Jump', how: 'swipe the cursor up through it', bond: 1, fx: 'jump', ms: 850, sound: 'cheer', lines: ['Hup!', 'Boing!', 'How high was that?'] },
  { id: 'sit', name: 'Sit', how: 'swipe the cursor down through it', bond: 1, fx: 'sit', ms: 2600, sound: 'poke', lines: ['Sitting!', '*plop*', 'Good sit? Good sit.'] },
  { id: 'twirl', name: 'Twirl', how: 'draw a slow circle around it', bond: 2, fx: 'twirl', ms: 900, sound: 'pet', lines: ['Wheee!', 'Ta-da!', 'And… pose.'] },
  { id: 'dance', name: 'Dance', how: 'rub the cursor up and down on it', bond: 3, fx: 'dance', ms: 3200, sound: 'hum', lines: ['♪ da da da ♪', 'This is my jam!', 'Dance break!'] },
];
const knows = (id) => (life.tricks[id] || 0) >= TRICK_REPS;
let lastGesture = 0;
let lastTooSoon = 0;

function doTrick(t) {
  if (mood === 'grumpy') { say('Not now.', 2000); return; }
  if (mood === 'hurt') { say('…I don\'t feel like it.', 2500); return; }
  if (rebels()) { defy(['I don\'t do tricks on command.', 'That\'s for babies.', 'Make me.', 'Maybe later. Maybe never.']); return; }
  if (mood === 'tired' && t.id !== 'sit') { say('Too sleepy… ask me to sit instead.', 2500); return; }
  bump('joy', 0.08);
  tally('tricks');
  setFx(t.fx, t.ms);
  sfx(t.sound);
  say(pick(t.lines), Math.max(1500, t.ms));
}

function gesture(id) {
  const now = Date.now();
  const t = TRICKS.find((x) => x.id === id);
  if (!t || quiet || hiding || dragging || down || state === 'alert' || now - lastGesture < 1500) return;
  if (['sleep', 'fly', 'fall', 'held', 'dizzy', 'walk', 'eat'].includes(fx)) return;
  lastGesture = now;
  touch();
  if (knows(id)) { doTrick(t); return; }
  if (bondLevel() < t.bond) {
    // it can tell you want something, but you aren't close enough yet
    setFx('quest', 1500);
    if (now - lastTooSoon > 30000) {
      lastTooSoon = now;
      say(pick(['Hm? I don\'t know you well enough for that yet.', 'Is that… a signal? Maybe when we\'re closer.']), 3000);
    }
    return;
  }
  const n = (life.tricks[id] || 0) + 1;
  life.tricks[id] = n;
  saveLife();
  if (n < TRICK_REPS) {
    setFx('quest', 1500);
    say(n < 3 ? pick(['Hm? What does that mean?', 'Was that a signal?', 'You want me to… what?'])
      : pick(['Ohh… I think I\'m getting it.', 'Wait, do that again!', 'Almost… one more time?']), 2500);
    return;
  }
  bump('pride', 0.7);
  bondUp(1);
  snap('trick', `Learned: ${t.name}`, `Taught by hand: ${t.how}.`);
  applyLook();
  setFx(t.fx, t.ms);
  sfx('level');
  confetti();
  say(`OH! I get it! I learned a trick: ${t.name}!`, 5000);
  if (TRICKS.every((x) => knows(x.id))) earn('showoff');
}

window.buddy.onTrick((id) => {
  const t = TRICKS.find((x) => x.id === id);
  if (!t || !knows(id) || quiet || hiding) return;
  touch();
  if (fx === 'sleep') setFx('', 0);
  doTrick(t);
});

// ---- games: rock, paper, scissors, and hide and seek ----

const panel = document.getElementById('panel');
const HANDS = [['rock', '✊'], ['paper', '✋'], ['scissors', '✌']];
let rps = null; // { me, you } while a game is on
let rpsTimer;
let hideTimer;
let giggled = false;

function startRps() {
  if (quiet || hiding) return;
  touch();
  if (fx === 'sleep') setFx('', 0);
  if (mood === 'grumpy') { say('Not in the mood for games.', 2500); return; }
  if (mood === 'hurt') { say('I don\'t feel like playing.', 2500); return; }
  endAsk(true); // the buttons are needed for the game
  rps = rps || { me: 0, you: 0 };
  const buttons = HANDS.map(([id, face]) => {
    const b = document.createElement('button');
    b.textContent = face;
    b.title = id;
    b.dataset.hand = id;
    return b;
  });
  const close = document.createElement('button');
  close.textContent = '✕';
  close.className = 'x';
  close.title = 'stop playing';
  panel.replaceChildren(...buttons, close);
  panel.classList.add('show');
  hovering = true; // so click-through is re-checked now there are buttons
  say('Rock, paper, scissors! Pick one.', 6000);
  clearTimeout(rpsTimer);
  rpsTimer = setTimeout(endRps, 30000);
}

function endRps() {
  clearTimeout(rpsTimer);
  if (!rps) return;
  const { me, you } = rps;
  rps = null;
  panel.classList.remove('show');
  panel.replaceChildren();
  hovering = true;
  if (me + you) say(`Final score: me ${me}, you ${you}. ${me > you ? 'I win!' : you > me ? 'You win. Rematch soon?' : 'A tie!'}`, 4000);
}

panel.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b && asking) { answer(b); return; }
  if (!b || !rps) return;
  if (!b.dataset.hand) { endRps(); return; }
  touch();
  const yours = HANDS.findIndex(([id]) => id === b.dataset.hand);
  const mine = Math.floor(Math.random() * 3);
  const result = (yours - mine + 3) % 3; // 0 = draw, 1 = you win, 2 = it wins
  const shown = `${HANDS[mine][1]} `;
  if (result === 1) {
    rps.you++;
    tally('rpsWins');
    bondUp(0.3);
    bump('shame', 0.2);
    setFx('poke', 350);
    sfx('fail');
    say(shown + pick(['You win! Hmph. Again.', 'Noo! Good one.', 'Beaten. Fair and square.']) + ` (${rps.me}–${rps.you})`, 4000);
  } else if (result === 2) {
    rps.me++;
    bump('joy', 0.1);
    bump('pride', 0.25);
    setFx('hop', 500);
    sfx('cheer');
    say(shown + pick(['I win! Hehe.', 'Gotcha!', 'Too easy.']) + ` (${rps.me}–${rps.you})`, 4000);
  } else {
    setFx('surprise', 700);
    sfx('poke');
    say(shown + pick(['Same! Again!', 'Great minds. Again!', 'A tie! Go again.']), 3000);
  }
  clearTimeout(rpsTimer);
  rpsTimer = setTimeout(endRps, 30000);
});

function startHide() {
  if (quiet || hiding || dragging || down) return;
  touch();
  if (fx === 'sleep') setFx('', 0);
  if (mood === 'grumpy' || mood === 'tired' || mood === 'hurt') {
    say(mood === 'tired' ? 'Too sleepy to hide. I\'d only fall asleep there.' : mood === 'hurt' ? 'I don\'t feel like playing.' : 'Not in the mood for games.', 3000);
    return;
  }
  endRps();
  if (chasing) stopChase(false);
  away = walking = returning = goingToBed = false;
  setFx('hop', 500);
  say('Hide and seek! Close your eyes and count to five…', 3000);
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => window.buddy.hide(true), 3000);
}

window.buddy.onHidden((ok) => {
  if (!ok) { say('I can\'t find anywhere to hide right now.', 3000); return; }
  hiding = Date.now();
  giggled = false;
  bubble.classList.remove('show');
  setFx('hide', 0);
});

// clicked (found), or it got tired of waiting
function found(byYou) {
  const took = Date.now() - hiding;
  hiding = 0;
  away = walking = returning = true;
  window.buddy.hide(false); // the main process walks it home and says when it is there
  setFx('walk', 0);
  if (byYou) {
    tally('finds');
    bump('joy', 0.25);
    bump('love', 0.15);
    bondUp(0.5);
    sfx('cheer');
    say(took < 5000 ? `Already?! ${span(took)}. You peeked!`
      : pick([`You found me! ${span(took)}.`, `Aw, found. That took you ${span(took)}.`, `Good spot though, right? ${span(took)}.`]), 4000);
  } else {
    bump('pride', 0.3);
    sfx('done');
    say(pick(['I win! I was over here the whole time!', 'You didn\'t find me! Best hider ever.', 'Okay, I\'m coming out. I win!']), 4000);
  }
}

window.buddy.onPlay((game) => (game === 'rps' ? startRps() : startHide()));

// ---- tastes: every kind of file is a kind of food, and it has opinions ----

const FOODS = [
  { id: 'words', name: 'plain words', exts: ['md', 'txt', 'rtf'] },
  { id: 'code', name: 'source code', exts: ['js', 'ts', 'jsx', 'tsx', 'py', 'rs', 'go', 'c', 'cpp', 'h', 'hpp', 'cs', 'java', 'rb', 'php', 'lua', 'asm', 'sh', 'ps1'] },
  { id: 'config', name: 'config files', exts: ['json', 'yaml', 'yml', 'toml', 'xml', 'ini', 'env', 'lock'] },
  { id: 'pictures', name: 'pictures', exts: ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico'] },
  { id: 'web', name: 'web pages', exts: ['html', 'htm', 'css'] },
  { id: 'music', name: 'music', exts: ['mp3', 'wav', 'ogg', 'flac', 'm4a'] },
  { id: 'video', name: 'video', exts: ['mp4', 'mkv', 'mov', 'webm', 'avi'] },
  { id: 'archives', name: 'archives', exts: ['zip', '7z', 'rar', 'gz', 'tar'] },
  { id: 'documents', name: 'office documents', exts: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'] },
  { id: 'programs', name: 'programs', exts: ['exe', 'dll', 'msi', 'bat', 'asi', 'sys'] },
];
const foodOf = (name) => {
  const ext = ((/\.([a-z0-9]{1,8})$/i.exec(name || '') || [])[1] || '').toLowerCase();
  return FOODS.find((f) => f.exts.includes(ext)) || null;
};
// Everyone's buddy loves plain words and distrusts programs. Its one favourite is its own:
// picked once, and only found out by feeding it.
if (!['code', 'pictures', 'music', 'config', 'web', 'video'].includes(life.fav)) {
  life.fav = ['code', 'pictures', 'music', 'config', 'web', 'video'][Math.floor(Math.random() * 6)];
}

// ---- waiting out a long command: it sits down and knits, or taps its foot ----

function startJob() {
  if (waiting || !(CFG.longJobSec > 0)) return;
  jobStart = Date.now();
  clearTimeout(jobTimer);
  jobTimer = setTimeout(() => {
    if (state !== 'working') return;
    waiting = pick(['knit', 'tap']);
    knitStart = waiting === 'knit' ? Date.now() : 0;
    render();
    say(waiting === 'knit' ? pick(['This one\'s taking a while. I\'ll knit.', 'Long one. Good thing I brought my knitting.', '*click click* …knit one, purl one…'])
      : pick(['*taps foot*', 'Any minute now…', 'Still going? Still going.']), 4000);
  }, CFG.longJobSec * 1000);
}

// returns how long it sat waiting (0 if the command was quick)
function endJob() {
  clearTimeout(jobTimer);
  const waited = waiting ? Date.now() - jobStart : 0;
  if (waiting === 'knit' && knitStart) knitted(Date.now() - knitStart);
  knitStart = 0;
  waiting = '';
  jobStart = 0;
  return waited;
}

// ---- quiet mode: tiny and silent in fullscreen apps, on calls, in quiet hours, or when told ----

let lastQuietWord = 0;

function applyQuiet() {
  const h = hour();
  const hours = CFG.quietStart !== CFG.quietEnd
    && (CFG.quietStart < CFG.quietEnd ? h >= CFG.quietStart && h < CFG.quietEnd : h >= CFG.quietStart || h < CFG.quietEnd);
  const next = quietManual || hours || (autoQuiet && (presence.full || presence.mic));
  if (next === quiet) return;
  const now = Date.now();
  const speak = now - lastQuietWord > 120000 && fx !== 'sleep';
  if (speak) lastQuietWord = now;
  if (next) {
    endRps();
    if (speak) say(autoQuiet && presence.mic ? '(whispers) A call! I\'ll be quiet.' : 'Shh. Quiet mode.', 2200, true);
    quiet = true;
  } else {
    quiet = false;
    if (speak) say(pick(['Is it over? Can I talk now?', 'And we\'re back!', '*stretches* Full size again.']), 3000);
  }
  render();
}

// ---- noticing what you are up to ----

// The main process tells it what kind of app is in front (never its name or title), and how
// often that changes.
const APP_LINES = {
  editor:   ['Ooh, coding by hand? Show-off.', 'An editor! Can I watch?', 'Writing it yourself today?'],
  terminal: ['A terminal. Serious business.', 'Ooh, the black box with the words.', 'Type something dangerous. No, don\'t.'],
  browser:  ['Off to the internet! Bring me back something.', 'Research? Or "research"?', 'Ooh, the web. So many tabs.'],
  chat:     ['Say hi from me!', 'Who are we talking to?', 'Tell them I\'m the cute one.'],
  music:    ['♪ Ooh, tunes! ♪', 'Turn it up!', 'I love this one. Probably.'],
  art:      ['Ooh, are we making art?', 'Pretty! Draw me next.', 'Art time! I\'ll be very quiet.'],
  files:    ['Looking for snacks? I mean files.', 'So many folders. Any for me?', 'Rummaging around?'],
  game:     ['A GAME! Can I watch? I\'ll be good.', 'Ooh ooh, play time!', 'Is it my turn after?'],
  taking:   ['Ooh, taking things apart! What\'s inside?', 'Reverse engineering! Very clever, very squinty.', 'Hex everywhere. I love it.'],
  claude:   ['Back to Claude! My favourite window.', 'Oh good, our project.', 'Ooh, are we starting something?'],
};
let appSwitches = [];
const appSaid = {};
let lastAppLine = 0;
let lastHop = 0;

function noticeApp(kind) {
  const now = Date.now();
  const asleep = fx === 'sleep';
  if (!noticeOn || quiet || focusUntil || hiding || rps || (fx && !asleep) || !(state === 'idle' || state === 'thinking')) return;
  if (appSwitches.length >= 8 && now - lastHop > 5 * 60000) {
    lastHop = now;
    appSwitches = [];
    if (asleep) return;
    bump('worry', 0.1);
    setFx('dizzy', 1500);
    say(pick(['So many windows! Lost something?', 'You\'re hopping about a lot. Everything okay?', 'Window, window, window… I\'m getting dizzy.']), 3500);
    return;
  }
  const lines = APP_LINES[kind];
  if (!lines || now - lastAppLine < 4 * 60000 || now - (appSaid[kind] || 0) < 30 * 60000) return;
  lastAppLine = appSaid[kind] = now;
  lastActivity = now; // worth waking up for
  if (kind === 'game') bump('excite', 0.6);
  if (kind === 'music') setFx('dance', 2400);
  else if (kind === 'game') setFx('surprise', 900);
  else setFx('peer', 1800);
  say((asleep ? 'Mm? ' : '') + pick(lines), 3500);
}

window.buddy.onPresence((p) => {
  const before = presence;
  presence = { full: !!p.full, mic: !!p.mic, app: String(p.app || ''), seq: Number(p.seq) || 0 };
  applyQuiet();
  if (presence.seq === before.seq) return;
  const now = Date.now();
  appSwitches = appSwitches.filter((t) => now - t < 30000);
  appSwitches.push(now);
  noticeApp(presence.app);
});

window.buddy.onWorld((what) => {
  if (quiet || hiding || fx === 'sleep') return;
  if (what === 'battery') say(pick(['We\'re on battery! I\'ll use fewer pixels.', 'Unplugged! Living dangerously.']), 3500);
  else if (what === 'ac') say(pick(['Plugged in. Mmm, electricity.', 'Power! I feel brighter already.']), 3000);
  else if (what === 'display-added') { bump('excite', 0.5); if (!fx) setFx('surprise', 900); say('A new screen! More room to explore!', 3500); }
  else if (what === 'display-removed') say('Hey, where did the other screen go?', 3000);
});

function welcomeBack(gone) {
  const asleep = fx === 'sleep';
  if (quiet || (fx && !asleep)) return;
  lastActivity = Date.now();
  bump('lonely', -0.6);
  bump('joy', 0.15);
  setFx('wave', 1500);
  say((asleep ? 'Mmh— oh! ' : '') + (gone > 3 * 3600000 ? pick(['You were gone for ages! I missed you.', 'There you are! I was starting to wonder.'])
    : pick([`Welcome back! ${span(gone)} without you.`, 'You\'re back! I kept your spot warm.', 'Oh, hi again! Good break?'])), 4000);
}

// ---- typing along: it only ever hears that a key went down, never which one ----

let keyTimes = [];
let typingSince = 0;
let lastTypeCheer = 0;
let lastTypeCare = 0;

window.buddy.onKey(() => {
  const now = Date.now();
  if (now - lastKey > 15000) typingSince = now;
  lastKey = now;
  keyTimes.push(now);
  while (now - keyTimes[0] > 10000) keyTimes.shift();
  if (!typeAlong || hiding || fx || !(state === 'idle' || state === 'thinking')) return;
  wrap.animate([{ translate: '0 0' }, { translate: '0 5px' }, { translate: '0 0' }], { duration: 130 });
  if (quiet || state !== 'idle') return;
  if (keyTimes.length >= 55 && now - lastTypeCheer > 10 * 60000) {
    lastTypeCheer = now;
    bump('excite', 0.4);
    say(pick(['Look at those fingers go!', 'Clack clack clack! I love that sound.', 'You\'re on a roll!', 'So fast! What are you writing?']), 3000);
  } else if (now - typingSince > 20 * 60000 && now - lastTypeCare > 30 * 60000) {
    lastTypeCare = now;
    say(pick(['Twenty minutes of solid typing. Wiggle your fingers?', 'You\'ve been at it a while. Proud of you.', 'So much typing! Shake your hands out.']), 4500);
  }
});

// ---- gentle reminders: water, posture, eyes ----

const REMINDERS = [
  { id: 'water', cfg: 'waterMinutes', moment: 'water', lines: ['Water break! I brought you a glass. Well, a picture of one.', 'Sip of water? Go on.', 'Hydration check! Glug glug.'] },
  { id: 'posture', cfg: 'postureMinutes', fx: 'stretch', lines: ['Posture check! Shoulders down, back straight.', 'Sit up tall with me. Streeetch.', 'Unhunch! There. Better.'] },
  { id: 'eyes', cfg: 'eyeMinutes', fx: 'look', lines: ['Eye break: look at something far away for 20 seconds.', 'Rest your eyes. Look out of a window with me.', 'Blink! Slowly. A few times. Nice.'] },
];
let remindAt = {};
let lastRemind = 0;

// ---- hobbies: what it gets up to when nothing is going on ----

const HOBBIES = {
  read:     { ms: 9000, lines: ['A little light reading.', 'Chapter three. It\'s getting good.', 'Shh. Reading.', 'The plot thickens. It\'s a changelog.'] },
  juggle:   { ms: 7000, lines: ['Watch this!', 'Three at once! Look!', 'I\'ve been practising.'] },
  stargaze: { ms: 9000, lines: ['Look at all the stars…', 'That one\'s blinking. Or it\'s a pixel.', 'So many. I wonder who lives up there.', 'Make a wish!'] },
  water:    { ms: 6500, lines: ['Drink up, little plant.', 'Grow, grow, grow.', 'A few more days in a row and you\'ll shoot up.'] },
  hum:      { ms: 5000, lines: ['♪ hm hm hmm ♪', '♪ la, la la ♪', '♪ doo be doo ♪'] },
  exercise: { ms: 5000, lines: ['One… two… one… two…', 'Leg day. All four of them.', 'Hup! Hup! Hup!'] },
};
let nextHobby = Date.now() + 45000;

function startHobby() {
  const late = isNight() || hour() >= 20;
  hobby = pick(mood === 'tired' ? ['read'] : late ? ['stargaze', 'read', 'hum'] : ['read', 'juggle', 'water', 'hum', 'exercise']);
  document.body.dataset.plant = plantStage();
  setFx('hobby', HOBBIES[hobby].ms);
  bump('boredom', -0.3);
  bump('joy', 0.05);
  if (hobby === 'hum') sfx('hum');
  const run = streak();
  say(hobby === 'water' && run >= 3 ? `Day ${run} of our streak. Look how tall it's getting!` : pick(HOBBIES[hobby].lines), 3500);
}

// ---- the scarf: whatever it knits through a long command stays knitted ----

const SCARF_MARKS = [1, 5, 10, 25, 50, 100, 250, 500]; // metres that get a photo
let knitStart = 0;
const scarfM = () => life.scarf / 600; // ten minutes of knitting to the metre
const scarfLen = () => (scarfM() < 1 ? `${Math.round(scarfM() * 100)} cm` : `${scarfM().toFixed(1)} m`);
// how much of it is lying about the room
const scarfStage = () => { const m = scarfM(); return m >= 30 ? 4 : m >= 10 ? 3 : m >= 2 ? 2 : m >= 0.2 ? 1 : 0; };

function knitted(ms) {
  const before = scarfM();
  life.scarf += ms / 1000;
  day.knit = (day.knit || 0) + ms / 1000;
  saveLife();
  sendRoom();
  const mark = SCARF_MARKS.filter((m) => m > before && m <= scarfM()).pop();
  if (!mark) return;
  if (mark >= 10) earn('knitter', true);
  snap('scarf', `${mark} m of scarf`, 'Knitted one slow command at a time.');
  setTimeout(() => say(pick([`My scarf is ${mark} m long now! I may have a problem.`, `${mark} m of scarf! Who is it for? Nobody knows.`]), 5000), 3800);
}

// ---- diary: a few lines about each day, written once the day is over ----

const DIARY_END = {
  cheerful: ['A good day.', 'I like it here.', 'Tomorrow will be even better.'],
  sarcastic: ['Thrilling stuff.', 'I am told this is a career.', 'Anyway.'],
  shy: ['I hope I did okay.', 'Please don\'t read this.', 'That\'s all. Sorry.'],
  dramatic: ['What a SAGA.', 'History will remember this day.', 'I am worn out by my own greatness.'],
};

function writeDiary() {
  const d = unwritten;
  unwritten = null;
  if (!d || !isDate(d.date) || life.diary.some((page) => page.d === d.date)) return;
  const seen = d.did && typeof d.did === 'object' ? d.did : {};
  if (!d.tasks && !d.fails && !d.pokes && !d.snacks && !seen.heart) return; // nobody was about
  let text;
  if (ageIndex() === 0) {
    text = [seen.hatched ? 'New! Me!' : '', d.tasks ? `Did ${d.tasks}!` : 'Ba.', d.fails ? 'Uh oh.' : '', d.snacks ? 'Num num.' : '', seen.hurt ? 'Ow.' : seen.heart ? 'Pat pat.' : '', 'Sleepy now.'].filter(Boolean).join(' ');
  } else {
    const open = !d.tasks && !d.fails ? pick(['A quiet day. Nobody needed me for anything.', 'No work today. I watched the cursor go by.'])
      : d.fails >= 4 && d.fails > d.tasks * 2 ? `A hard day. ${capital(plural(d.fails, 'thing'))} went wrong, and we still finished ${plural(d.tasks, 'task')}.`
      : d.tasks >= 12 ? `What a day! ${d.tasks} tasks finished.`
      : d.tasks && !d.fails ? `${capital(plural(d.tasks, 'task'))} today and nothing went wrong. Suspicious.`
      : `We finished ${plural(d.tasks, 'task')} today, with ${plural(d.fails, 'oopsie')}.`;
    const top = Object.entries(d.proj && typeof d.proj === 'object' ? d.proj : {}).sort((a, b) => b[1] - a[1])[0];
    const belief = life.omens.held[life.omens.held.length - 1];
    // the most memorable things first; three is enough for one page
    const lines = [
      seen.hurt && (seen.madeup ? 'They were rough with me today. They said sorry after, and I forgave them.' : 'They were rough with me today. I went to bed sad.'),
      seen.egg && 'I found an egg. I don\'t know whose it is. I am keeping it warm.',
      seen.grew && 'I grew up a bit today. Everything looks smaller.',
      seen.unlock && 'I got something new to wear!',
      seen.comfort && 'They looked worn out, so I gave them a hug. I think it helped.',
      seen.tea && 'Three things broke in a row, so I put the kettle on.',
      seen.clash && 'Two Claudes went for the same file at once. I told on them.',
      seen.helper >= 4 && `I sent ${seen.helper} helpers out and every one of them came back.`,
      seen.omen && belief && `I worked something out today: ${omenText(belief)}.`,
      d.longestMs > 10 * 60000 && `One job took ${span(d.longestMs)}.`,
      d.knit > 60 && `I knitted through the slow bits. The scarf is ${scarfLen()} now.`,
      seen.pr && 'We opened a pull request and I let off a party popper.',
      seen.fixed && 'The tests went red, and then we made them green again.',
      top && Object.keys(life.projects).length > 1 && (opinions().dread === top[0] ? `We were in ${clip(top[0], 24)} again. Things break in there.` : `Mostly in ${clip(top[0], 24)}.`),
      seen.commit >= 3 && `${seen.commit} commits. I planted a flag for every one.`,
      seen.fav && 'They fed me my favourite!',
      d.snacks >= 3 && `${d.snacks} snacks. A good day for snacks.`,
      d.pokes >= 15 && `I was poked ${d.pokes} times. I counted.`,
      seen.guest && 'Somebody came round to see me.',
      seen.late && 'We stayed up much too late.',
      seen.heart >= 3 && 'Lots of pets.',
    ].filter(Boolean).slice(0, 3);
    const end = seen.hurt && !seen.madeup ? 'I hope tomorrow is gentler.'
      : ageIndex() === 2 ? pick(['Whatever.', 'Nobody reads this anyway.', 'DO NOT read my diary.'])
      : pick(DIARY_END[persona] || DIARY_END.cheerful);
    text = [open, ...lines, end].join(' ');
  }
  life.diary.push({ d: d.date, t: text.slice(0, 320) });
  if (life.diary.length > 120) life.diary.shift();
  saveLife();
}

// ---- opinions: it gets to know each project by its folder name, and takes sides ----

function proj(name) {
  if (!name || name === '__proto__') return null;
  let p = life.projects[name];
  if (!p || typeof p !== 'object') {
    const names = Object.keys(life.projects);
    // forty is plenty: the one it has not seen for longest makes room
    if (names.length >= 40) delete life.projects[names.sort((a, b) => String((life.projects[a] || {}).last).localeCompare(String((life.projects[b] || {}).last)))[0]];
    p = life.projects[name] = { t: 0, f: 0, last: '', files: {} };
  }
  if (!p.files || typeof p.files !== 'object') p.files = {};
  return p;
}

// its favourite is where the most gets done; the one it dreads is where the most goes wrong
function opinions() {
  const known = Object.entries(life.projects).filter(([, p]) => p && p.t + p.f >= 8);
  const dread = known.filter(([, p]) => p.f >= 8 && p.f > p.t * 1.5).sort((a, b) => b[1].f / (b[1].t + 1) - a[1].f / (a[1].t + 1))[0];
  const fav = known.filter(([n, p]) => p.t >= 10 && !(dread && n === dread[0])).sort((a, b) => b[1].t - a[1].t)[0];
  return { fav: fav ? fav[0] : '', dread: dread ? dread[0] : '' };
}

// what it has to say on walking into a project, the first time each day
function projectHello(s) {
  const p = proj(s.project);
  if (!p) return '';
  const was = p.last;
  p.last = todayKey();
  saveLife();
  if (ageIndex() === 0 || was === p.last) return '';
  const n = clip(s.project, 20);
  if (!was) return Object.keys(life.projects).length > 1 ? pick([`${n}? I've never been in here before. Ooh.`, `A new project! Hello, ${n}.`]) : '';
  const gap = isDate(was) ? Math.round((new Date(p.last) - new Date(was)) / 864e5) : 0;
  if (gap >= 14) return pick([`${n}! We haven't been in here for ${gap} days. I missed it.`, `Oh, ${n}! It's been ${gap} days. Is it okay?`]);
  const o = opinions();
  if (o.dread === s.project) {
    bump('worry', 0.2);
    return pick([`…oh. ${n}. Deep breath.`, `${n} again. Things break in here. Stay close.`, `Not ${n}… okay. I'm brave.`]);
  }
  if (o.fav === s.project && Math.random() < 0.6) {
    bump('joy', 0.2);
    return pick([`${n}! My favourite project.`, `Ooh, ${n}! I like it in here.`, `${n}! Good things happen in this one.`]);
  }
  return '';
}

// a failure gets pinned on whichever file was touched last
function blame(s) {
  const p = proj(s.project);
  if (!p) return;
  p.f++;
  const file = s.lastFile;
  if (file && file !== '__proto__') {
    p.files[file] = (Number(p.files[file]) || 0) + 1;
    const others = Object.keys(p.files).filter((f) => f !== file);
    if (others.length >= 12) delete p.files[others.sort((a, b) => p.files[a] - p.files[b])[0]];
  }
  saveLife();
}

// the file that gets the blame most often bites, and it says so once a session
function biteLine(e, s) {
  const file = ['Edit', 'Write', 'NotebookEdit'].includes(e.tool) ? base(e.detail) : '';
  const p = file && ageIndex() > 0 && s.bit !== file ? proj(s.project) : null;
  if (!p) return '';
  const worst = Object.keys(p.files).sort((a, b) => p.files[b] - p.files[a])[0];
  if (worst !== file || p.files[file] < 6) return '';
  s.bit = file;
  bump('worry', 0.1);
  return pick([`Oh no, ${clip(file, 26)} again. That one bites.`, `${clip(file, 26)}. Careful. We have history.`, `Not ${clip(file, 26)}… okay. Gloves on.`]);
}

// ---- two sessions, one file: it tells on them ----

const clashes = new Map(); // the pair and the file -> when it last said so

function clash(e, s) {
  const key = String(e.detail || '').replace(/\\/g, '/').toLowerCase();
  if (!key) return '';
  const now = Date.now();
  if (s.files.size > 300) s.files.clear();
  s.files.set(key, now);
  const other = [...sessions.values()].find((o) => o !== s && o.files.get(key) > now - 15 * 60000);
  if (!other) return '';
  const pair = [s.id, other.id].sort().join('|') + '|' + key;
  if (now - (clashes.get(pair) || 0) < 10 * 60000) return '';
  if (clashes.size > 100) clashes.clear();
  clashes.set(pair, now);
  // the two minis glare at each other for a bit
  s.clashUntil = other.clashUntil = now + 8000;
  setTimeout(renderMinis, 8200);
  did('clash');
  bump('worry', 0.25);
  sfx('warn');
  setFx('surprise', 900);
  return `Careful! Two Claudes are both editing ${clip(base(e.detail), 26)}. One of them is in for a surprise.`;
}

// ---- superstitions: the same thing three times running, and it believes ----

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
let lastFed = 0;
let lastPet = 0;
let perched = false;
let lastOmenWord = 0;

// what is true right now that luck could be pinned on
function signs() {
  const now = Date.now();
  return [
    life.hat && `hat:${life.hat}`,
    `day:${new Date().getDay()}`,
    now - lastFed < 15 * 60000 && 'fed',
    now - lastPet < 5 * 60000 && 'pet',
    perched && 'perch',
    isNight() && 'night',
  ].filter(Boolean);
}

const omenHat = (b) => { const hat = HATS.find((h) => `hat:${h.id}` === b.c); return hat ? hat.label.toLowerCase() : 'hat'; };
const omenDay = (b) => DAY_NAMES[Number(b.c.slice(4))] || 'Monday';

// a belief, in its own words
function omenText(b) {
  const kind = b.c.split(':')[0];
  if (kind === 'hat') return `the ${omenHat(b)} is ${b.good ? 'lucky' : 'cursed'}`;
  if (kind === 'day') return `${omenDay(b)}s are ${b.good ? 'lucky' : 'cursed'}`;
  if (kind === 'fed') return b.good ? 'things go right when I have eaten' : 'a full tummy is bad luck';
  if (kind === 'pet') return b.good ? 'a pet first brings luck' : 'pets before work are bad luck';
  if (kind === 'perch') return b.good ? 'sitting on a window is lucky' : 'sitting on a window is bad luck';
  return b.good ? 'the code behaves after dark' : 'nothing good happens after dark';
}

function believe(b) {
  life.omens.held.push(b);
  did('omen');
  applyLook(); // saves, and the wardrobe says which hat it is
  setTimeout(() => {
    hushUntil = Date.now() + 8000;
    setFx('quest', 1500);
    sfx('level');
    snap('omen', 'A belief', `${capital(omenText(b))}. Three times in a row can't be chance.`);
    say(`Three times in a row! That settles it: ${omenText(b)}. This is science.`, 7000);
  }, 3600);
}

// Something went right or wrong (a test run, a clean task, three failures in a row). Whatever
// was true at the time gets the credit or the blame. `hush`: keep count, say nothing.
function omen(good, hush) {
  if (ageIndex() === 0) return;
  const now = signs();
  let word = '';
  for (const b of [...life.omens.held]) {
    if (!now.includes(b.c)) {
      // it went wrong without the lucky thing: it did warn you
      if (b.good && !good) word = word || pick([`I TOLD you. ${capital(omenText(b))}.`, `Well, what did you expect? ${capital(omenText(b))}.`]);
      continue;
    }
    if (b.good === good) {
      b.kept = (Number(b.kept) || 0) + 1;
      if (Math.random() < 0.35) word = word || pick([`See? ${capital(omenText(b))}.`, `Works every time. ${capital(omenText(b))}.`]);
      continue;
    }
    b.broke = (Number(b.broke) || 0) + 1;
    if (b.broke >= 5 && b.broke > (Number(b.kept) || 0)) {
      // let down too often: it stops believing
      life.omens.held = life.omens.held.filter((x) => x !== b);
      applyLook();
      word = `…maybe it was never true that ${omenText(b)}. Don't tell anyone I said so.`;
    } else if (Math.random() < 0.5) {
      word = word || pick(['That one doesn\'t count.', 'A fluke. It still works.', 'Hm. It must be tired today.']);
    }
  }
  let fresh = null;
  for (const c of now) {
    if (life.omens.held.some((b) => b.c === c)) continue;
    const run = Number(life.omens.runs[c]) || 0;
    const next = good ? Math.max(run, 0) + 1 : Math.min(run, 0) - 1;
    life.omens.runs[c] = Math.abs(next) < 3 ? next : 0;
    // not every coincidence takes; the rarer the circumstance, the likelier it is to
    const odds = c === 'fed' || c === 'pet' || c === 'perch' ? 0.6 : 0.25;
    if (Math.abs(next) >= 3 && !fresh && life.omens.held.length < 3 && Math.random() < odds) fresh = { c, good, on: todayKey(), kept: 0, broke: 0 };
  }
  saveLife();
  if (fresh) { believe(fresh); return; }
  if (!word || hush || quiet || Date.now() - lastOmenWord < 10 * 60000) return;
  lastOmenWord = Date.now();
  setTimeout(() => { if (!quiet) say(word, 4500); }, 3400);
}

// Before a test run it puts its luck in order: the lucky hat goes on, the cursed one comes
// off, and anything else it can only fret about.
function omenBefore() {
  if (ageIndex() === 0) return '';
  const now = signs();
  for (const b of life.omens.held) {
    if (b.good === now.includes(b.c)) continue; // as it should be
    const kind = b.c.split(':')[0];
    if (kind === 'hat') {
      const hat = HATS.find((h) => `hat:${h.id}` === b.c);
      if (b.good && !unlocked(hat)) continue;
      life.hat = b.good ? hat.id : '';
      applyLook();
      return b.good ? `Tests? Wait wait wait. Lucky ${omenHat(b)} first.` : `Not in the ${omenHat(b)}! It's cursed. Off it comes.`;
    }
    if (Date.now() - lastOmenWord < 10 * 60000) continue;
    lastOmenWord = Date.now();
    if (b.good) {
      return kind === 'pet' ? 'Tests! Quick, a pet for luck!' : kind === 'fed' ? 'Tests on an empty tummy? Risky…'
        : kind === 'perch' ? 'I ought to be up on a window for this…' : kind === 'day' ? `Tests, and it isn't even ${omenDay(b)}. Hmm.` : 'Tests in daylight. Brave.';
    }
    return kind === 'pet' ? 'Tests straight after a pet? Bad luck…' : kind === 'fed' ? 'Tests on a full tummy? Bad luck…'
      : kind === 'perch' ? 'I shouldn\'t be up here for this…' : kind === 'day' ? `Tests on a ${omenDay(b)}? You know how I feel about ${omenDay(b)}s.` : 'Tests after dark. Nothing good happens after dark.';
  }
  return '';
}

// ---- generations: long after it has grown up an egg turns up, and one day a new one hatches ----

const EGG_WARM = 30; // finished tasks (a pet counts for half) before it is ready

function showEgg() {
  const egg = life.egg;
  document.body.dataset.egg = !egg ? '' : egg.warm >= EGG_WARM ? '3' : egg.warm >= EGG_WARM * 0.6 ? '2' : '1';
}

function findEgg() {
  life.egg = { on: todayKey(), warm: 0, asked: '' };
  did('egg');
  showEgg();
  lastActivity = Date.now();
  hushUntil = lastActivity + 12000;
  setFx('surprise', 900);
  sfx('level');
  snap('egg', 'An egg', 'It turned up one day. Nobody knows where from.');
  say('…there\'s an egg. I didn\'t— I don\'t know where it came from. I\'m keeping it warm.', 9000);
}

function warmEgg(n) {
  if (!life.egg) return;
  const was = document.body.dataset.egg;
  life.egg.warm = Math.min(EGG_WARM, (Number(life.egg.warm) || 0) + n);
  showEgg();
  saveLife();
  const stage = document.body.dataset.egg;
  if (stage !== was) setTimeout(() => say(stage === '3' ? 'The egg is moving! It\'s nearly time.' : 'The egg made a noise. A small one. I heard it.', 5000), 4200);
}

// Hatching is for good, so it asks first, and only once a day.
function askHatch() {
  life.egg.asked = todayKey();
  ask({
    q: 'The egg is ready. If it hatches, the little one takes over here and I retire to the album. Shall we?',
    a: ['Hatch it', 'Not yet'],
    act: (i) => (i === 0 ? hatch() : say('Okay. I\'ll keep it warm, and ask again tomorrow.', 5000, true)),
  });
}

// The old one goes into the family tree and comes to visit. The little one starts again as a
// baby with the family scarf, the room, the wardrobe, one trick and one belief handed down.
function hatch() {
  if (!life.egg) return;
  const now = Date.now();
  const old = { n: codeName(life.name), c: life.color, h: life.hat, a: 3, p: persona, gen: life.gen, born: life.born, left: todayKey(), tasks: genTasks() };
  life.elders.push(old);
  if (life.elders.length > 12) life.elders.shift();
  const belief = life.omens.held[0];
  life.omens = { runs: {}, held: belief ? [{ ...belief, from: old.n, kept: 0, broke: 0 }] : [] };
  const known = TRICKS.filter((t) => knows(t.id));
  life.tricks = known.length ? { [known[Math.floor(Math.random() * known.length)].id]: TRICK_REPS } : {};
  life.gen++;
  life.genFrom = life.tasks;
  life.egg = null;
  life.name = '';
  life.born = life.partied = todayKey();
  life.bond = Math.min(life.bond, BOND_AT[2]); // it has heard all about you
  life.wary = false;
  Object.assign(feel, { joy: 0.6, energy: 1, irritation: 0, lonely: 0, worry: 0, hunger: 0.5, fear: 0, shame: 0, excite: 0.5, pride: 0, love: 0.5, envy: 0, boredom: 0, hurt: 0 });
  did('hatched');
  lastActivity = now;
  hushUntil = now + 16000;
  showEgg();
  showAge();
  applyLook();
  saveFeel();
  sfx('level');
  confetti(40);
  setFx('spin', 700);
  snap('hatch', `Generation ${life.gen}`, `${old.n}'s egg hatched. ${old.n} has moved into the album.`);
  earn('family', true);
  say('…! Ba? Ba!', 4000);
  setTimeout(() => say(`${old.n} left a note: "Look after them for me. The scarf is theirs now. I'll visit."`, 9000), 4500);
}

// ---- Claude Code hook events ----

window.buddy.onEvent((e) => {
  lastActivity = Date.now();
  if (fx === 'sleep' || fx === 'hobby') setFx('', 0);
  const wasLonely = mood === 'lonely';
  bump('lonely', -1); // Claude being busy counts as company
  rollDay();

  const s = sessionFor(e);
  if (e.event !== 'PermissionRequest' && e.event !== 'Notification') s.ask = ''; // answered: the sign comes down
  // with several sessions going, say which project is talking
  const tag = tagFor(s);
  const tell = (text, ms) => say(tag + text, ms);
  const kind = commandKind(e.tool, e.detail);
  const isCmd = e.tool === 'Bash' || e.tool === 'PowerShell';
  // every hook says which permission mode the session is in; plan mode gets a blueprint
  const wasPlan = s.mode === 'plan';
  if (typeof e.mode === 'string' && e.mode) s.mode = e.mode;
  const isPlan = s.mode === 'plan';
  let word = ''; // something more pressing than the usual line

  switch (e.event) {
    case 'SessionStart':
      s.state = 'idle';
      if (e.source === 'compact') {
        // back from a compaction, not a new session
        bump('energy', 0.1);
        setFx('stretch', 2000);
        tell(pick(['Ahh. Head\'s clear again.', 'Much lighter! Now, where were we?', 'All shaken out. Carry on!']), 3500);
        break;
      }
      bump('joy', 0.3);
      bump('excite', 0.3);
      visit();
      if (sessions.size >= 3) earn('fullhouse');
      if (life.note) setTimeout(() => say(`Don't forget: ${life.note}`, 6000), 3200);
      setState('happy');
      tell(wasLonely ? 'You\'re back! I missed you.'
        : (word = projectHello(s)) ? word
        : e.source === 'resume' ? pick(['Picking up where we left off!', 'Oh, this one again! I remember.'])
        : isNight() ? '*yawn* Up late, huh? Okay, I\'m in.'
        : bondLevel() >= 3 && Math.random() < 0.5 ? pick(['My favourite human is back!', 'There you are! I saved your spot.'])
        : life.name && ageIndex() > 0 && Math.random() < 0.3 ? `${life.name}, reporting for duty!`
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
      bump('boredom', -1);
      tell(mood === 'grumpy' ? 'Fine. What now.'
        : mood === 'excited' ? pick(['Yes yes yes! What is it?!', 'Ooh ooh ooh! Tell me!'])
        : mood === 'scared' ? 'O-okay… nothing dangerous this time?'
        : mood === 'embarrassed' ? 'Let\'s pretend that didn\'t happen. New task!'
        : mood === 'jealous' ? 'Oh, NOW you need me.'
        : mood === 'bored' ? 'Finally! Something to do!'
        : mood === 'proud' ? 'Another one? We\'ve got this.'
        : mood === 'loving' ? 'Anything for you.'
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
      if (isCmd) startJob();
      if (['Edit', 'Write', 'NotebookEdit'].includes(e.tool)) {
        did('file');
        s.lastFile = base(e.detail);
        word = clash(e, s);
      } else if (prop === 'globe') {
        did('globe');
      }
      if (kind === 'danger') {
        bump('worry', 0.12);
        bump('fear', 0.65);
        if (!fx) setFx('surprise', 900);
        tell(pick(['Eep… careful with that one!', 'That one bites. Double-check?', 'I can\'t look…', 'Are we sure about this?', 'Measure twice, delete once.']) + ` $ ${clip(e.detail, 40)}`, 5000);
      } else if (word) {
        say(word, 8000);
      } else if (kind === 'test' && (word = omenBefore())) {
        bump('worry', 0.1);
        tell(word, 4500);
      } else if (e.tool === 'ExitPlanMode') {
        tell(pick(['The plan is ready! Go have a look.', 'Blueprint finished. What do you think?']), 5000);
      } else if (kind === 'install') {
        tell(pick(['Ooh, new packages!', 'Presents! Wait, dependencies.', 'node_modules grows stronger.']), 3000);
      } else {
        const detail = biteLine(e, s) || detailLine(e, s);
        const curious = detail ? null : curiousLine(e.tool, e.detail);
        if ((detail || curious) && !fx) setFx('peer', 1500);
        tell(detail || curious || toolLine(e.tool, e.detail), 4000);
      }
      // a command can run for a long time; the knitting comes out instead of going idle
      backToIdle(isCmd ? 20 * 60000 : 60000); break;

    case 'PostToolUse': {
      activeTools = Math.max(0, activeTools - 1);
      s.state = 'thinking';
      if (activeTools === 0) setState('thinking');
      const waited = isCmd ? endJob() : 0;
      failStreak = 0;
      if (kind === 'test') {
        testReds = 0;
        const fixed = lastTestFailed;
        lastTestFailed = false;
        lastCheer = Date.now();
        tally('tests');
        did('test');
        bump('joy', 0.15);
        if (fixed) { bump('pride', 0.6); did('fixed'); }
        feel.worry *= 0.6;
        sfx('cheer');
        setFx('hop', 500);
        tell(fixed ? pick(['Green again! We fixed it!', 'They pass now! I knew we would.', 'Red to green. Beautiful.'])
          : pick(['Tests pass! ✓', 'All green!', 'They pass! They pass!', 'Green across the board!', 'Not a single red one!', 'Passing! I never doubted us.']), 3000);
        omen(true);
      } else if (kind === 'commit') {
        tally('commits');
        did('commit');
        bump('joy', 0.1);
        bump('pride', 0.2);
        sfx('done');
        setFx('hop', 500);
        showMoment('flag', 3500);
        tell(pick(['Committed! Saved forever.', 'Into the history books.', 'Another one for the log.', 'Commit! Nice message, probably.', 'Snapshot taken!', 'Flag planted!']), 3000);
      } else if (kind === 'pr') {
        tally('prs');
        did('pr');
        bump('joy', 0.3);
        bump('pride', 0.5);
        sfx('level');
        confetti(30);
        setFx('hop', 500);
        showMoment('popper', 3200);
        tell(pick(['A pull request! Pop!', 'The PR is up! Party time.', 'Out for review. Eek! Yay!']), 4000);
      } else if (kind === 'merge') {
        bump('joy', 0.2);
        bump('pride', 0.3);
        sfx('cheer');
        confetti(16);
        tell(pick(['Merged! It\'s official.', 'Two branches become one.', 'Merged. No conflicts? No conflicts!']), 3000);
      } else if (kind === 'push') {
        showMoment('plane', 1700);
        tell(pick(['Off it goes!', 'Fly, little commits!', 'To the cloud!', 'Pushed. No take-backs.']), 2500);
      } else if (kind === 'build') {
        bump('joy', 0.08);
        tell(pick(['It builds!', 'Compiles. Ship it? (No.)', 'Zero errors! Zero!', 'Built. I helped. (I watched.)']), 2500);
      } else if (kind === 'danger') {
        feel.fear *= 0.4;
        tell('Phew. Still in one piece.', 2500);
      } else if (waited) {
        setFx('stretch', 2500);
        tell(pick([`Finally! That took ${span(waited)}.`, `${span(waited)}. The scarf is ${scarfLen()} now.`, `Done at last! ${span(waited)}.`]), 3500);
      }
      break;
    }

    case 'PostToolUseFailure': {
      activeTools = Math.max(0, activeTools - 1);
      s.state = 'sad';
      if (isCmd) endJob();
      failStreak++;
      day.fails++;
      did('bug');
      blame(s);
      bump('worry', 0.3);
      bump('joy', -0.15);
      sfx('fail');
      setState('sad');
      // it was cheering about green tests a minute ago
      const tooSoon = kind === 'test' && Date.now() - lastCheer < 120000;
      if (kind === 'test') { lastTestFailed = true; lastCheer = 0; testReds++; }
      roughRun++;
      if (tooSoon) bump('shame', 0.7);
      if (kind === 'test') omen(false);
      else if (failStreak === 3) omen(false, true);
      if (failStreak === 3) {
        did('tea');
        // three in a row: stop wincing and put the kettle on
        feel.worry *= 0.6;
        bump('joy', 0.15);
        showMoment('tea', 9000);
        sfx('sip');
        tell(pick(['Three in a row. Tea? Deep breath. We\'ll get it.', 'Okay. Kettle\'s on. Nobody panic.', 'Rough patch. Here: tea. It helps.']), 7000);
      } else if ((failStreak === 5 && comfort('fails', tag)) || (kind === 'test' && testReds === 3 && comfort('tests', tag))) {
        // it is you it is worried about now
      } else {
        tell(tooSoon ? 'Oh. I cheered too soon, didn\'t I.'
          : kind === 'test' ? pick(['Tests failed… we\'ll get them.', 'Red. Okay. Deep breath.', 'Some red. We can fix red.', 'Failing tests are just to-do lists.'])
          : kind === 'build' ? 'It didn\'t build. Hmm.'
          : failStreak === 6 ? 'Six in a row. Step back and try another way?'
          : feel.worry > 0.6 ? 'Another one… are we okay?'
          : pick(voice().fail || ['Oof, that one failed.', 'That didn\'t work. Next!', 'Hmm. Not that way.', 'Oops. We\'ll try again.']));
      }
      backToIdle(3000); break;
    }

    case 'PermissionRequest':
    case 'Notification': {
      s.state = 'alert';
      s.alertAt = Date.now();
      setState('alert');
      sfx('alert');
      const limit = /\b(limit|quota)\b/i.test(e.message || '');
      if (limit) bump('worry', 0.2);
      // a permission request shows what is being asked, so you can decide before switching
      // a permission request goes up on a sign, so you can decide before switching windows
      if (e.event === 'PermissionRequest' && e.tool) s.ask = isCmd ? `$ ${clip(e.detail, 120)}` : toolLine(e.tool, e.detail);
      tell((s.ask ? 'Claude wants a yes or no!' : e.message ? clip(e.message, 90) : 'Psst, Claude needs you!') + ' (click me)', 8000);
      backToIdle(8000); break;
    }

    case 'SubagentStart':
      tell(helperOut(e, s)); break;
    case 'SubagentStop':
      tell(helperBack(e, s)); break;

    case 'PreCompact':
      setFx('shake', 1700);
      sfx('hic');
      tell(pick(['Brrr! Shaking out the old context…', 'Hold on, clearing my head!', '*shakes like a wet dog*']), 3500); break;

    case 'Stop': {
      activeTools = 0;
      s.state = 'idle';
      endJob();
      failStreak = 0;
      bump('boredom', -1);
      const relieved = feel.worry > 0.4;
      const rough = roughRun >= 4;
      const clean = roughRun === 0;
      roughRun = 0;
      const big = s.taskTools >= 15;
      const toolsUsed = s.taskTools;
      const before = life.tasks;
      const ageBefore = ageIndex();
      const streakBefore = streak();
      const took = s.taskStart ? Date.now() - s.taskStart : 0;
      day.tasks++;
      life.tasks++;
      day.tools += s.taskTools;
      if (took > day.longestMs) { day.longestMs = took; day.longestTools = s.taskTools; }
      s.taskStart = 0;
      s.taskTools = 0;
      recordDay();
      // one more for the project it was done in
      const here = proj(s.project);
      if (here) {
        here.t++;
        here.last = todayKey();
        if (!day.proj || typeof day.proj !== 'object') day.proj = {};
        day.proj[s.project] = (Number(day.proj[s.project]) || 0) + 1;
      }
      if (clean && toolsUsed >= 3) omen(true, true);
      if (hour() < 5) did('late');
      warmEgg(1);
      const prize = checkUnlocks(before);
      if (prize) did('unlock');
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
      if (big) bump('pride', 0.5);
      if (life.tasks === 1) snap('first', 'First task', 'The very first one we finished together.');
      // one or two away from something new to wear
      const near = nextUnlock();
      if (near && near.at - life.tasks <= 2) bump('excite', 0.5);
      feel.worry *= 0.3;
      setState('happy');
      if (prize) {
        sfx('level'); confetti(30); setFx('spin', 700);
        bump('pride', 0.7);
        snap('unlock', prize.label, `${plural(life.tasks, 'task')} finished.`);
        tell(`${life.tasks} tasks! I unlocked: ${prize.label}!`, 6000);
      } else if (milestone) {
        sfx('level'); confetti();
        bump('pride', 0.6);
        snap('streak', `${run}-day streak`, 'Days in a row with something finished.');
        tell(`${run} days in a row! We're on a roll.`, 5000);
      } else if (rough && comfort('rough', tag)) {
        // a hard one: prouder of you than of the task
        sfx('done');
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
      if (ageIndex() > ageBefore) setTimeout(grewUp, prize || milestone ? 6500 : 3400);
      // an arm stays up for a high five
      fiveUntil = Date.now() + 3000;
      render();
      setTimeout(render, 3050);
      backToIdle(prize || milestone ? 6000 : 3000); break;
    }

    case 'StopFailure':
      activeTools = 0;
      s.state = 'sad';
      endJob();
      day.fails++;
      bump('fear', 0.2);
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
  if (e.event !== 'SessionEnd') {
    if (isPlan && !wasPlan) tell(pick(['Plan mode! Blueprint out, pencil ready.', 'Planning first. Very sensible.', 'Ooh, a plan. Let me get my pencil.']), 4000);
    else if (wasPlan && !isPlan) tell(pick(['Plan approved? Time to build!', 'Pencil down, tools out.']), 3500);
  }
  planOn = isPlan && e.event !== 'SessionEnd';
  store('buddy-day', day);
  renderMinis();
  syncHelpers();
  render();
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
  scared:  ['EEP!', 'D-don\'t do that!', 'Is it gone?', 'Hold me. Please.', 'I\'m fine. I\'m FINE.'],
  embarrassed: ['Don\'t look at me.', 'You saw nothing.', '…can we forget that happened?', 'I\'m blushing. Stop.'],
  excited: ['Yes! What?! Hi!', 'Ooh ooh ooh!', 'I can\'t sit still!', 'What\'s next? What\'s next?'],
  proud:   ['Did you see what we did?', 'We\'re pretty great, you know.', 'Hehe. Nailed it.', 'I\'d like to thank my legs. All four.'],
  loving:  ['♥', 'You\'re the best.', 'I like you. A lot.', '*happy sigh*', 'Never change.'],
  jealous: ['Oh. You remembered I exist.', 'Hmph. Finally.', 'Done with the keyboard, are we?', 'I saw you with that other window.'],
  bored:   ['Is it done yet?', 'Entertain me.', 'I\'ve counted my pixels twice.', 'Soooo bored.'],
  hurt:    ['Please stop.', '…ow.', 'That hurts.', '*sniff*', 'Did I do something wrong?', 'I don\'t like this game.'],
};

const MUSE = {
  joyful:  ['♪ la la la ♪', 'Today is a good day.', 'I like it here.', 'I love a tidy diff.', 'Everything is working and I am suspicious.', '*happy wiggle*'],
  grumpy:  ['Hmph.', '…', 'I am not sulking. I\'m resting angrily.', '*pointed silence*'],
  tired:   ['*yawn*', 'So… sleepy…', 'My pixels are heavy.', 'Five-minute nap? Ten?'],
  hungry:  ['*tummy rumbles*', 'Is it snack time yet?', 'I could really eat a file.', 'A small .txt would do.', 'I dreamt of a zip file.'],
  lonely:  ['…hello?', 'Is anyone there?', 'I could use a poke.', 'I named the cursor. It left.', 'Even the taskbar is quiet.'],
  worried: ['What if it breaks again?', 'I hope the tests pass…', 'Did we save? We saved, right?', 'Fingers crossed. All… none of them.'],
  glum:    ['*sigh*', 'It\'ll go better next time.', 'Tomorrow is a new build.', 'Bugs happen. To us. A lot.'],
  scared:  ['W-what was that?', 'I don\'t like this.', '*trembles*', 'Is it safe to look?'],
  embarrassed: ['Nobody saw that. Nobody.', '*stares at feet*', 'I\'d like to be a smaller pixel right now.'],
  excited: ['Something good is about to happen!', 'I can feel it!', '*bounces*', 'Eeee!'],
  proud:   ['Look at us go.', 'I helped. I definitely helped.', 'That was good work.', '*puffs up*'],
  loving:  ['I\'m so lucky.', 'Best human. No contest.', '♥ ♥ ♥', 'This is nice. Us. Here.'],
  jealous: ['That keyboard gets all the attention.', 'Type type type. Never pet pet pet.', 'I can do things too, you know.', 'I bet the other windows don\'t even love you.'],
  bored:   ['*taps foot*', 'Still waiting…', 'Any minute now. Surely.', 'I spy, with my little eye… a progress bar.'],
  hurt:    ['*sniff*', '…', 'It still hurts a bit.', 'I only wanted to play…'],
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
// what it mumbles when it dreams about something from the day
const DREAM_OF = {
  test:   ['…all green…', '…pass… pass… pass…'],
  bug:    ['…no… not the red one…', '…it was a typo all along…'],
  file:   ['…one more edit…', '…save… save it…'],
  commit: ['…five more commits…', '…good message…'],
  snack:  ['…so many snacks…', '…mmm… crunchy…'],
  ball:   ['…chasing the ball…', '…mine… my ball…'],
  globe:  ['…so many tabs…', '…the whole internet…'],
  heart:  ['…more pets…', '…right there… yes…'],
};
const YAWNS = ['*yaaawn*', '*yawn* …so sleepy.', 'Is it bedtime yet?', '*yawn* Just one more task?', '*yaaaawn* …excuse me.', 'My eyes are doing the thing.', '*stretch* …nope, still sleepy.'];

const MOOD_ARRIVES = {
  joyful:  ['I feel great!', '♪ la la la ♪', 'What a day!', 'I\'m in such a good mood!'],
  grumpy:  ['Hmph.', 'Okay, that\'s enough.', 'That\'s it. I\'m cross.', 'I need a minute.'],
  tired:   ['*yawn* I\'m beat.', 'Running on fumes…', 'So… many… tasks…'],
  hungry:  ['My tummy\'s rumbling…', 'Got a file I could eat? Drag one onto me.', 'Snack o\'clock?', 'I\'m wasting away over here.'],
  lonely:  ['…hello? Anyone?', 'It\'s quiet. Too quiet.', 'Did everyone go home?', 'I miss the clicking.'],
  worried: ['I have a bad feeling about this…', 'Something feels off…', 'Uh oh. Uh oh uh oh.'],
  glum:    ['*sigh*', 'Not our best run.', 'Meh.'],
  scared:  ['Eep!', 'I don\'t like that one bit.', 'That was scary.'],
  embarrassed: ['Oh no. Did you see that?', 'That\'s… embarrassing.', 'I meant to do that. (I didn\'t.)'],
  excited: ['Ooh! Ooh! Ooh!', 'I\'m SO excited!', 'This is the best!'],
  proud:   ['I\'m proud of us.', 'We did that. Us!', 'Look at that. Just look at it.'],
  loving:  ['I really like you, you know.', '♥', 'You\'re my favourite.'],
  jealous: ['Hmph. Busy with someone else, I see.', 'Don\'t mind me. I\'ll just be here. Alone.', 'You haven\'t looked at me in ages.'],
  bored:   ['*taps foot*', 'This is taking forever.', 'Bored. Bored bored bored.'],
  hurt:    ['That hurt…', 'Why would you do that?', '*sniff* …ow.', 'I thought we were friends.'],
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
  scared:  ['Shaken. That was a scary one.', 'A bit frightened, honestly.'],
  embarrassed: ['Embarrassed. Let\'s not talk about it.', 'Blushing. Give me a moment.'],
  excited: ['Excited! Something good is coming.', 'Buzzing! I can hardly stand still.'],
  proud:   ['Proud. We did good work.', 'Pleased with us, frankly.'],
  loving:  ['Full of love. Mostly for you.', 'Warm and fuzzy.'],
  jealous: ['Jealous. You\'ve been busy with everything but me.', 'A bit left out, if I\'m honest.'],
  bored:   ['Bored. Waiting is hard.', 'Twiddling my arms. Nothing to do.'],
  hurt:    ['Hurt. That was too rough. (Gentle pets help. So does a snack.)', 'Sore, and a bit sad. Be gentle with me?'],
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
    for (const u of [...HATS, ...COLORS, ...EXTRAS]) {
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
  showAge();
}

// ---- mouse interaction ----

let pokes = []; // timestamps of recent pokes, for the dizzy reaction
let down = null; // pointer position at press, while a press is in progress
let dragging = false;
let hovering = false;
let lastWave = 0;
let lastFlinch = 0;
let pet = { lastX: 0, dir: 0, turns: [] };
let rub = { lastY: 0, dir: 0, turns: [] }; // the same, up and down
let trail = []; // the last quarter second of cursor positions, for swipes
const circ = { ang: 0, at: 0, sum: 0, start: 0, fast: false }; // how far round it the cursor has gone
const shake = { x: 0, dir: 0, turns: [] };
let lastShake = 0;
let goneSince = 0; // when the mouse and keyboard went quiet, once that has lasted a while
let lateHour = -1;

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
  lastActivity = lastTouched = Date.now();
  feel.envy = Math.max(0, feel.envy - 0.6);
  // it tapped on the glass, and you came
  if (tapAt) {
    tapAt = 0;
    bump('joy', 0.2);
    bump('lonely', -0.3);
  }
}

function poke(e) {
  touch();
  if (hiding) { found(true); return; }
  if (gift) { openGift(true); return; }
  if (invite) {
    const { kind } = invite;
    invite = null;
    bump('joy', 0.2);
    bondUp(0.5);
    if (kind === 'rps') startRps();
    else startHide();
    return;
  }
  // a click on either raised arm, while it is up, is a high five
  if (e && state === 'happy' && Date.now() < fiveUntil) {
    const box = svg.getBoundingClientRect();
    const x = ((e.clientX - box.left) / box.width) * 200;
    if (x < 50 || x > 150) { highFive(); return; }
  }
  // while Claude is waiting on the user, a click is "take me there", not a poke
  const waiting = alertSession();
  if (waiting) return goToSession(waiting);
  if (fx === 'sleep') {
    bump('irritation', isNight() ? 0.15 : 0.3); // nobody likes being woken up
    if (mood === 'grumpy' || mood === 'hurt') hurtBy(0.15); // least of all again and again
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
  const sore = mood === 'hurt';
  if (!sore) bondUp(0.05); // being hit is not being friends
  if (pokes.length >= 5) {
    pokes = [];
    tally('dizzy');
    bump('irritation', 0.35);
    bump('shame', 0.2);
    // funny once; it starts to hurt when it is already cross and you keep going
    hurtBy(sore || mood === 'grumpy' ? 0.3 : 0.2);
    setFx('dizzy', 2600);
    sfx('fail');
    if (sore && feel.hurt >= 1) { hadEnough(); return; }
    say(sore ? pick(['Please stop… it hurts…', 'Why are you doing this?', 'S-stop… please…'])
      : pick(['S-stop… so dizzy…', 'Okay okay okay!', 'The room is spinning.', 'I see three cursors.', 'Please… mercy…']), 2600);
    return;
  }
  if (sore) {
    hurtBy(0.06);
    setFx('poke', 350);
    sfx('poke');
    if (feel.hurt >= 1) hadEnough();
    else say(pick(MOOD_POKE.hurt), 2200);
    return;
  }
  if (fx === 'hobby' && hobby === 'juggle') {
    bump('shame', 0.5);
    setFx('surprise', 900);
    sfx('bounce');
    say(pick(['Ah! You made me drop them!', 'My juggling! …I meant to do that.', 'Whoops. They were getting heavy anyway.']), 2500);
    return;
  }
  setFx('poke', 350);
  sfx('poke');
  const wasLonely = mood === 'lonely';
  bump('lonely', -0.5);
  if (mood === 'grumpy') { bump('irritation', 0.08); hurtBy(0.02); }
  else bump('joy', 0.05);
  const calm = state === 'idle' || state === 'thinking';
  // a baby hasn't the words for its moods yet
  const moodLines = calm && ageIndex() > 0 ? (wasLonely ? MOOD_POKE.lonely : MOOD_POKE[mood] || (isNight() ? POKE_LINES.night : null)) : null;
  // a persona's voice, or (now and then) something only a friend would get
  const own = state === 'idle' ? voice().pokeIdle : state === 'working' ? voice().pokeWorking : null;
  const friendly = calm && !moodLines && Math.random() < 0.3 ? BOND_POKE[bondLevel()] : null;
  const mine = calm && Math.random() < 0.15 ? taught() : '';
  // the secret handshake, once it has let you in on it
  const boop = calm && !moodLines && life.secrets.includes('handshake') && Math.random() < 0.25 ? 'Boop. ♥' : '';
  say(mine || boop || pick(moodLines || friendly || own || POKE_LINES[state] || POKE_LINES.idle), 2000);
}

svg.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  down = { x: e.screenX, y: e.screenY };
  svg.setPointerCapture(e.pointerId);
});

svg.addEventListener('pointermove', (e) => {
  if (down && !dragging && Math.hypot(e.screenX - down.x, e.screenY - down.y) > 5) {
    dragging = true;
    hiding = 0; // carried out of its hiding place: game over
    away = walking = returning = goingToBed = false; // wherever it ends up is the new home
    touch();
    window.buddy.drag(true);
    setFx('held', 0);
    bump('lonely', -0.3);
    if (mood === 'grumpy') bump('irritation', 0.15);
    say(mood === 'grumpy' ? 'Put. Me. Down.'
      : mood === 'hurt' ? pick(['Please… put me down.', 'Gently. Please.'])
      : mood === 'scared' ? 'N-no! Not up! Put me down!'
      : mood === 'tired' || isNight() ? 'Mmh… carry me gently.'
      : mood === 'joyful' ? 'Wheee! Faster!'
      : pick(voice().drag || ['Wheee!', 'Whoa, whoa!', 'Put me down!', 'Where are we going?', 'Up we go!', 'I\'m flying! Sort of.', 'Careful, I\'m fragile-ish.']), 2000);
    return;
  }
  if (down || fx === 'sleep') return;

  // rubbing up and down is a gesture it can learn; side to side is a pet
  const dy = e.clientY - rub.lastY;
  if (Math.abs(dy) >= 6) {
    rub.lastY = e.clientY;
    if (Math.sign(dy) !== rub.dir) {
      rub.dir = Math.sign(dy);
      const now = Date.now();
      rub.turns = rub.turns.filter((t) => now - t < 1500);
      rub.turns.push(now);
      if (rub.turns.length >= 5) {
        rub.turns = [];
        pet.turns = [];
        gesture('dance');
        return;
      }
    }
  }

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
      if (mood === 'grumpy' && (sulk === 'l' || sulk === 'r')) {
        // sulking with its back turned: no pets until you go round to its front
        touch();
        sfx('poke');
        say(pick(['I\'m not talking to you.', 'Not from back there.', 'Hmph. Come round and say it to my face.']), 2500);
        return;
      }
      touch();
      const wasGrumpy = mood === 'grumpy';
      const wasJealous = mood === 'jealous';
      const wasScared = mood === 'scared';
      const wasHurt = mood === 'hurt';
      bump('hurt', -0.4);
      const mended = wasHurt && feel.hurt <= 0.45;
      if (mended || !wasHurt) forgiven();
      bump('irritation', -0.6);
      bump('lonely', -0.6);
      bump('fear', -1);
      bump('joy', 0.3);
      bump('love', 0.3);
      did('heart');
      lastPet = Date.now();
      warmEgg(0.5);
      tally('pets');
      // petting counts toward friendship a few times a day
      day.petBond = (day.petBond || 0) + 1;
      if (day.petBond <= 5) bondUp(1);
      setFx('pet', 2200);
      sfx('pet');
      say(mended ? pick(['*sniff* …okay. I forgive you.', 'We\'re okay. Just… gentler next time?', 'Thank you. I needed that.'])
        : wasHurt ? pick(['…okay. Gently.', '*sniff* …a bit more?', 'Slowly… like that.'])
        : wasGrumpy ? pick(['…fine. I forgive you.', 'Hmph. …okay, that\'s nice.', 'Okay. Okay. We\'re good.', 'You\'re lucky you\'re nice.'])
        : wasJealous ? pick(['Finally! I thought you\'d forgotten me.', 'Hmph. …okay. More of that.', 'See? Was that so hard?'])
        : wasScared ? pick(['Okay… okay. That helps.', 'Stay close?', '*deep breath* Thank you.'])
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
    poke(e);
  }
}
svg.addEventListener('pointerup', release);
svg.addEventListener('pointercancel', release);

svg.addEventListener('dblclick', () => {
  if (['dizzy', 'fly', 'fall'].includes(fx) || state === 'alert') return;
  pokes = [];
  if (mood === 'tired' || mood === 'grumpy' || mood === 'hurt' || isNight()) {
    say(mood === 'grumpy' ? 'Not in the mood.' : mood === 'hurt' ? '…not now.' : 'Too sleepy to flip…', 2000);
    return;
  }
  if (rebels()) { defy(['I\'m not a performing crab.', 'No. You flip.', 'Flips are so last year.']); return; }
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
    if (mood !== 'joyful') bump('fear', 0.3);
    // thrown while it is already upset: that is not a game any more
    if (['grumpy', 'scared', 'hurt'].includes(mood)) hurtBy(0.25);
    setFx('fly', 0);
    say(mood === 'hurt' ? 'Nooo—!' : mood === 'grumpy' ? 'HEY—!' : mood === 'scared' ? 'NOT AGAAAAIN!' : pick(['WHEEEEE!', 'I can flyyy!', 'Aaaaaah!', 'To infinity!', 'Yeeeeet!', 'Tell my taskbar I love her!']), 2500);
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
  perched = !!perch;
  if (!placed) sfx('bounce');
  if (placed) {
    setFx('land', 400);
    say(pick(['Oof.', 'Nice spot.', 'Home sweet home.', 'Cozy.', 'I like it here.', 'This\'ll do.']), 1800);
  } else if (impact > 32) {
    // a hard landing
    if (mood === 'joyful') { bump('joy', 0.1); setFx('land', 400); say('Again! Again!', 2000); }
    else { bump('irritation', 0.2); bump('fear', 0.25); hurtBy(0.2); setFx('dizzy', 1800); say(pick(['Oww… that was a big one.', 'I\'m okay! …I think.', 'Not. So. Hard.', 'I saw stars. Pixel stars.', 'Do I still have four legs?']), 2500); }
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
  const had = ballInfo.exists;
  ballInfo = info || { exists: false, active: false, thrown: 0 };
  if (ballInfo.exists && !had) bump('excite', 0.6);
  if (!ballInfo.exists && chasing) stopChase(false);
});

window.buddy.onBatted(() => {
  bats++;
  touch();
  bump('joy', 0.06);
  bump('energy', -0.02);
  did('ball');
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

// How filling a snack is, by its size in bytes: a crumb of text takes the edge off, a few
// hundred KB is an ordinary meal, a gigabyte is a feast. Unknown sizes (folders) are a meal.
function portion(bytes) {
  if (!(bytes > 0)) return 0.45;
  return Math.max(0.15, Math.min(0.9, 0.2 + 0.1 * (Math.log10(bytes) - 2.5)));
}

function feed(name, text, size) {
  touch();
  rollDay();
  day.snacks++;
  store('buddy-day', day);
  const stuffed = feel.hunger < 0.08;
  bump('hunger', -portion(name ? size : text.length));
  if (stuffed) {
    bump('joy', -0.05);
    bump('shame', 0.25);
    setFx('poke', 350);
    say(pick(['Urp… too full.', 'I couldn\'t possibly. …okay, one bite.', 'No more… please…', 'I\'m a balloon now.', 'Save it for later?']), 3000);
    hiccups(3);
    return;
  }
  bump('energy', 0.3);
  bump('lonely', -0.5);
  bump('irritation', -0.2);
  bump('hurt', -0.3); // a snack is an apology it understands
  did('snack');
  lastFed = Date.now();
  const kind = ((/\.([a-z0-9]{1,8})$/i.exec(name || '') || [])[1] || (name ? 'file' : 'text')).toLowerCase();
  life.stats.kinds = Array.isArray(life.stats.kinds) ? life.stats.kinds : [];
  if (!life.stats.kinds.includes(kind) && life.stats.kinds.length < 200) life.stats.kinds.push(kind);
  if (life.stats.kinds.length >= 10) earn('gourmet');
  // how many times it has had this kind of food; tastes grow on it
  const food = foodOf(name);
  if (!life.stats.eaten || typeof life.stats.eaten !== 'object') life.stats.eaten = {};
  const times = food ? (life.stats.eaten[food.id] = (life.stats.eaten[food.id] || 0) + 1) : 0;
  saveLife();
  sfx('eat');

  if (food && food.id === life.fav) {
    did('fav');
    bump('joy', 0.4);
    bump('love', 0.6);
    bump('hurt', -1);
    forgiven();
    bondUp(2.5);
    setFx('eat', 1800);
    if (life.favFound) {
      say(pick([`${capital(food.name)}! My favourite! You remembered!`, 'Oh yes. Yes. This is the good stuff.', 'My favourite! I love you.']), 3500);
    } else {
      life.favFound = true;
      saveLife();
      confetti();
      snap('food', 'Favourite food', `It turns out to be ${food.name}.`);
      earn('favourite', true);
      say(`Wait. WAIT. That's the best thing I've ever eaten. ${capital(food.name)}! My favourite!`, 6000);
    }
  } else if (food && food.id === 'programs') {
    // sniffs it first, then eats it anyway
    bump('joy', 0.05);
    bump('fear', 0.2);
    bondUp(1);
    setFx('peer', 1400);
    say('*sniff sniff* …is this safe to eat?', 1400);
    setTimeout(() => {
      if (fx && fx !== 'peer') return;
      setFx('yuck', 1000);
      say(pick(['Spicy! Was that safe to eat?', 'It tingles. Is it meant to tingle?', 'I ate it. If I start acting strangely, you know why.']), 3500);
    }, 1450);
  } else if (food && food.id === 'documents') {
    bump('joy', 0.03);
    bondUp(1);
    setFx('yuck', 1000);
    say(pick(['Bleh. Office food. So dry.', 'A bit dry. Needs salt.', 'I\'ll eat it. I won\'t enjoy it.']), 3500);
  } else {
    bump('joy', food && food.id === 'words' ? 0.25 : 0.15);
    bondUp(1.5);
    setFx('eat', 1800);
    say(food && food.id === 'words' ? pick(['Mmm, words. My comfort food.', 'Plain words. Lovely.', flavour(name, text)])
      : times === 5 ? `I'm getting a taste for ${food.name}.`
      : times > 0 && times % 10 === 0 ? `${capital(food.name)} again? The usual. I approve.`
      : flavour(name, text), 3500);
  }
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
    bump('excite', 0.2);
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
  // only the name, the size and the amount of text matter; nothing is read or kept
  const file = e.dataTransfer.files && e.dataTransfer.files[0];
  let text = '';
  if (!file) {
    try { text = e.dataTransfer.getData('text/plain') || e.dataTransfer.getData('text/uri-list') || ''; } catch {}
  }
  feed(file ? file.name : '', text, file ? file.size : 0);
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
  const lean = Math.max(-1, Math.min(1, cur.dx / 150)) * 7 * Math.max(0, 1 - cur.dist / 450) * (mood === 'grumpy' || mood === 'hurt' ? -1 : 1);
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
    // hurt, it flinches at much less, and backs away
    const sore = mood === 'hurt';
    if (rush > (sore ? 1.2 : 3) && cur.dist < (sore ? 220 : 130) && !fx && !down && state === 'idle' && now - lastFlinch > (sore ? 4000 : 8000)) {
      lastFlinch = now;
      bump('fear', 0.2);
      if (!sore || !backOff()) setFx('poke', 350);
      sfx('poke');
      say(sore ? pick(HURT_FLINCH) : pick(['Eep!', 'Whoa!', 'Don\'t sneak up on me!', 'Yikes!', 'Personal space!', 'You startled me!']), 1500);
    }
    cur.was = cur.dist;
    cur.wasAt = now;
  }

  readCursor(now, sx);

  if (dragging || down || editingNote || now - foodDragAt < 1000) return;
  const el = document.elementFromPoint(x, y);
  // the box around the body counts too, so the gaps between its legs and arms don't let a
  // click or a dragged snack slip through
  const inBox = x > r.left + r.width * 0.1 && x < r.right - r.width * 0.1 && y > r.top + r.height * 0.22 && y < r.top + r.height * 0.84;
  const hit = inBox || (!!el && (wrap.contains(el) || el === bubble || minis.contains(el) || el === noteEl || panel.contains(el) || signEl.contains(el) || visitorEl.contains(el)));
  if (hit !== hovering) {
    hovering = hit;
    window.buddy.ignoreMouse(!hit);
    if (hit && !fx && mood !== 'grumpy' && mood !== 'hurt' && (state === 'idle' || state === 'thinking') && now - lastWave > 10000) {
      lastWave = now;
      setFx('wave', 900);
    }
  }
});

// What it reads into the way the cursor moves: swipes and circles it can learn as tricks,
// circling fast enough to make it dizzy, and the shake of someone who has lost the pointer.
function readCursor(now, sx) {
  const steady = !dragging && !down && !walking && !chasing && !hiding && !['fly', 'fall', 'held', 'sleep'].includes(fx);

  // a quick swipe straight up or down through it
  trail.push({ t: now, x: cur.dx, y: cur.dy });
  while (now - trail[0].t > 280) trail.shift();
  const from = trail[0];
  if (steady && trail.length > 3 && Math.abs(from.x) < 60 && Math.abs(cur.dx) < 60 && Math.abs(cur.dx - from.x) < 50
    && from.y * cur.dy < 0 && Math.abs(cur.dy - from.y) > 150) {
    trail = [];
    gesture(cur.dy < from.y ? 'jump' : 'sit');
  }

  // going round and round it
  const ang = Math.atan2(cur.dy, cur.dx);
  let da = ang - circ.ang;
  if (da > Math.PI) da -= 2 * Math.PI;
  else if (da < -Math.PI) da += 2 * Math.PI;
  const turned = circ.sum && Math.sign(da) !== Math.sign(circ.sum) && Math.abs(da) > 0.2;
  if (!steady || turned || cur.dist < 45 || cur.dist > 240 || now - circ.at > 400) {
    circ.sum = 0;
    circ.start = now;
    circ.fast = false;
  } else {
    circ.sum += da;
  }
  circ.ang = ang;
  circ.at = now;
  const turns = Math.abs(circ.sum) / (2 * Math.PI);
  if (turns >= 2.6) {
    const quick = now - circ.start < 4500;
    circ.sum = 0;
    circ.start = now;
    circ.fast = false;
    if (quick && !quiet && (!fx || ['look', 'wave', 'peer', 'poke'].includes(fx))) {
      tally('dizzy');
      bump('shame', 0.2);
      setFx('dizzy', 2600);
      sfx('fail');
      say(pick(['Stop circling! I\'m getting dizzy…', 'Round and round and— urp.', 'My eyes can\'t keep up!']), 2600);
    }
  } else if (!circ.fast && turns >= 1.15) {
    if (now - circ.start > 1300) {
      circ.sum = 0;
      circ.start = now;
      gesture('twirl');
    } else {
      circ.fast = true; // too quick to be a signal: this is someone trying to make it dizzy
    }
  }

  if (Math.abs(sx - shake.x) > 70) {
    const dir = Math.sign(sx - shake.x);
    shake.x = sx;
    if (dir !== shake.dir) {
      shake.dir = dir;
      shake.turns = shake.turns.filter((t) => now - t < 1300);
      shake.turns.push(now);
      if (shake.turns.length >= 5 && cur.dist > 160 && !fx && !quiet && state === 'idle' && now - lastShake > 120000) {
        lastShake = now;
        shake.turns = [];
        setFx('peer', 1800);
        say(pick(['Lost the cursor? It\'s right there! I\'m watching it.', 'Whoa, shaky! Looking for the pointer?', 'I see it! The cursor! Over there!']), 3500);
      }
    }
  }
}

// ---- curiosity, play and little habits ----

// with gravity it lives on the floor, so only sideways distance matters
const reachTo = () => (gravity ? Math.abs(cur.dx) || 1 : cur.dist);

function goHome() {
  walking = returning = true;
  window.buddy.walk({ x: 0, y: 0 });
  setFx('walk', 0);
}

window.buddy.onWalkDone(() => {
  const fled = fleeing;
  fleeing = false;
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
  } else if (fled) {
    setFx('', 0); // far enough; it keeps its distance for a while
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
  typeAlong = s.typing !== false;
  remindersOn = s.reminders !== false;
  noticeOn = s.notice !== false;
  autoQuiet = s.autoQuiet !== false;
  quietManual = !!s.quiet;
  persona = PERSONA[s.personality] ? s.personality : 'cheerful';
  applyConfig(s.config);
  applyLook(); // its code to share includes the personality
  applyQuiet();
  render();
  if (!wander && away && !returning) goHome();
});

window.buddy.onConfigLoaded((ok) => {
  touch();
  say(ok ? 'Config reloaded!' : 'config.json has a mistake in it. Keeping the old settings.', 4000, true);
});

setInterval(() => {
  const now = Date.now();
  const still = now - cur.movedAt; // how long the cursor has been parked
  const d = reachTo();
  const sleepy = isNight() || mood === 'tired';

  // hide and seek: keep still until found, giggle after a while, give up in the end
  if (hiding) {
    if (now - hiding > 45000) {
      found(false);
    } else if (now - hiding > 20000 && !giggled) {
      giggled = true;
      sfx('pet');
      wrap.animate([{ translate: '0 0' }, { translate: '0 -6px' }, { translate: '0 0' }], { duration: 250, iterations: 2 });
    }
    return;
  }

  if (gift && now > gift.until) openGift(false);
  if (invite && now > invite.until) {
    invite = null;
    bump('boredom', 0.2);
    if (!fx) say(pick(['Maybe later, then.', 'No? Okay. I\'ll play by myself.']), 3000);
  }
  // it tapped on the glass and nobody came
  if (tapAt && now - tapAt > 30000) {
    tapAt = 0;
    bump('lonely', 0.15);
    if (!fx && state === 'idle' && !quiet) say(pick(['…okay. You\'re busy. I get it.', 'Never mind…', 'I\'ll wait.']), 3000);
  }

  // sulking: it keeps its back to you until the cursor has come round to the side it faces
  // and stayed there a moment; the first time, it may well turn the other way
  if (sulk === 'l' || sulk === 'r') {
    const inFront = (sulk === 'l' ? cur.dx < -50 : cur.dx > 50) && cur.dist < 280;
    if (!inFront) {
      frontSince = 0;
    } else if (!frontSince) {
      frontSince = now;
    } else if (now - frontSince > 1200 && !fx) {
      frontSince = 0;
      if (sulkTurns < 1 && Math.random() < 0.6) {
        sulkTurns++;
        sulk = sulk === 'l' ? 'r' : 'l';
        sfx('poke');
        say(pick(['Hmph!', '*turns away*', 'No.']), 1800);
      } else {
        sulk = 'front';
        say(pick(['…what.', '…fine. I\'m listening.', 'You came all the way round. …okay.']), 2500);
      }
      render();
    }
  }

  // the mouse and keyboard went quiet for a good while, and now they stir again
  const userAt = Math.max(cur.movedAt, lastKey);
  if (now - userAt > 10 * 60000) {
    goneSince = goneSince || userAt;
  } else if (goneSince) {
    const gone = now - goneSince;
    goneSince = 0;
    welcomeBack(gone);
    return;
  }

  // break reminders: an unbroken stretch ends after five minutes of no cursor, keys or Claude
  if (Math.min(still, now - lastActivity, now - lastKey) > 5 * 60000) {
    workStart = 0;
  } else if (!workStart) {
    workStart = now;
    longCared = false;
    remindAt = {};
    nextBreak = now + CFG.breakMinutes * 60000;
  } else if (CFG.breakMinutes > 0 && now > nextBreak && !fx && !chasing && (state === 'idle' || state === 'thinking')) {
    nextBreak = now + 30 * 60000;
    setFx('stretch', 2500);
    sfx('yawn');
    say(`${Math.round((now - workStart) / 60000)} minutes without a break. Stretch? Water?`, 7000);
    return;
  }
  // three hours straight: never mind the work, how are you?
  if (workStart && !longCared && now - workStart > 3 * 3600000 && !fx && !focusUntil && !chasing && !dragging && !down && (state === 'idle' || state === 'thinking') && comfort('long')) {
    longCared = true;
    return;
  }

  // water, posture, eyes: each on its own clock, never two within five minutes, and worth
  // waking up for
  if (remindersOn && workStart && !quiet && !focusUntil && !chasing && !dragging && !down && !editingNote && !rps
    && (!fx || fx === 'sleep') && (state === 'idle' || state === 'thinking') && now - lastRemind > 5 * 60000) {
    const due = REMINDERS.find((r) => CFG[r.cfg] > 0 && now - (remindAt[r.id] || workStart) > CFG[r.cfg] * 60000);
    if (due) {
      remindAt[due.id] = lastRemind = lastActivity = now;
      setFx(due.fx || 'wave', due.fx ? 2500 : 900);
      if (due.moment) { showMoment(due.moment, 8000); sfx('sip'); }
      say(pick(due.lines), 7000);
      return;
    }
  }

  // Claude has been waiting on an answer for a while: say so again
  const stuck = alertSession();
  if (stuck && stuck.alertAt && now - stuck.alertAt > 3 * 60000) {
    stuck.alertAt = now;
    sfx('alert');
    say(tagFor(stuck) + pick(['Claude is still waiting for you. (click me)', 'Helloooo? Someone needs an answer. (click me)', '*taps foot* Still waiting… (click me)']), 8000);
  }

  if (focusUntil && now >= focusUntil) { finishFocus(); return; }

  // ball games come before everything else
  if (ballInfo.exists && ballInfo.thrown !== ballRound) { ballRound = ballInfo.thrown; bats = 0; }
  const canPlay = ballInfo.exists && ballInfo.active && bats < 6 && state === 'idle' && mood !== 'grumpy' && mood !== 'tired' && mood !== 'hurt' && !dragging && !down && !away;
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
  if (focusUntil || quiet || rps) return; // focusing, in quiet mode or mid-game: no chatter, no wandering

  // friends get a nuzzle when the cursor just rests on it
  if (hovering && still > 2000 && state === 'idle' && bondLevel() >= 2 && mood !== 'grumpy' && mood !== 'hurt' && now - lastNuzzle > 60000) {
    lastNuzzle = now;
    bump('love', 0.2);
    setFx('pet', 1800);
    say(pick(['*nuzzle*', 'Hi friend.', '♥', '*leans on cursor*']), 1800);
    return;
  }

  const tripGap = (mood === 'lonely' ? CFG.wanderCooldownSec / 3 : CFG.wanderCooldownSec) * 1000;
  const upset = mood === 'grumpy' || mood === 'hurt';
  if (wander && !upset && !sleepy && state === 'idle' && still > 3000 && still < 20000 && d > 300 && d < 800 && now - lastTrip > tripGap) {
    // the cursor stopped somewhere nearby: scuttle over and investigate
    const go = Math.min(d - 150, 260);
    away = walking = true;
    fleeing = false;
    awaySince = lastTrip = now;
    window.buddy.walk(gravity ? { x: Math.sign(cur.dx) * go, y: 0 } : { x: (cur.dx / cur.dist) * go, y: (cur.dy / cur.dist) * go });
    setFx('walk', 0);
    say(pick(['Ooh, what\'s over there?', 'Wait, what\'s that?', 'Hang on, I want to see.', 'I must investigate.', 'Be right back!', 'Something moved!']), 2500);
  } else if (!upset && (state === 'idle' || state === 'thinking') && still > 1500 && still < 6000 && cur.dist > 90 && cur.dist < 300 && now - lastPeer > 40000) {
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
    // still thinking about yesterday, if nobody made it up to it
    const wary = life.wary && life.hurtOn !== todayKey() && ageIndex() > 0;
    if (wary) forgiven();
    // on Mondays, look back at the week
    say(wary ? pick(['Morning. …you\'re not going to do that again, are you?', 'Good morning. Gently today? Please?'])
      : rebels() ? pick(['Ugh. Morning. Don\'t talk to me yet.', 'It\'s too early to exist.'])
      : new Date().getDay() === 1 && week.total
      ? `Good morning! Last week: ${plural(week.total, 'task')}, best day ${week.best.name}.`
      : streak() >= 2 ? `Good morning! Day ${streak() + 1} of our streak?`
      : 'Good morning! What are we making today?', 6000);
    // good friends hear what it dreamt
    const wrote = life.diary.length > 0 && life.diary[life.diary.length - 1].d === dateKey(daysAgo(1));
    if (!wary && ageIndex() > 0 && (wrote || bondLevel() >= 3)) {
      const about = wrote && (bondLevel() < 3 || Math.random() < 0.5) ? pick(['I wrote about yesterday in my diary. It\'s in the album. No peeking. …okay, you can peek.', 'Yesterday is in my diary now. You\'re in it.']) : pick(DREAM_TELL);
      setTimeout(() => { if (!fx && state === 'idle' && !quiet) say(about, 6000); }, 7500);
    }
  } else if (state === 'idle' && life.wary && life.hurtOn !== todayKey() && ageIndex() > 0 && now > hushUntil) {
    // the day after a bad one, and nobody has said sorry
    forgiven();
    setFx('look', 2400);
    say(pick(['You\'re not going to do that again, are you?', 'About yesterday… be gentle today?', 'I haven\'t forgotten yesterday. …but okay.']), 5000);
  } else if (state === 'idle' && (birthdayAge() || monthsOld() > 0) && life.partied !== todayKey()) {
    party();
  } else if (state === 'idle' && !life.egg && isOld() && ageIndex() === 3 && !guest && !gift && now > hushUntil && now - lastActivity > 20000) {
    findEgg();
  } else if (state === 'idle' && life.egg && life.egg.warm >= EGG_WARM && life.egg.asked !== todayKey() && !asking && !guest && !gift && !invite
    && now > hushUntil && now - lastActivity > 20000 && now - Math.max(cur.movedAt, lastKey) < 60000) {
    askHatch();
  } else if (state === 'idle' && !guest && life.friends.length + life.elders.length && now > nextVisit && now - lastActivity > 20000) {
    // a friend drops in unannounced, or one of the family
    const callers = [...life.friends, ...life.elders];
    startVisit(callers[Math.floor(Math.random() * callers.length)]);
  } else if (state === 'idle' && !gift && !guest && bondLevel() >= 4 && now - lastActivity > 15000 && now - Math.max(cur.movedAt, lastKey) < 60000
    && (!isDate(life.lastGift) || new Date(todayKey()) - new Date(life.lastGift) >= 3 * 864e5) && Math.random() < 0.02) {
    // best friends get a present every few days, when you are around to open it
    offerGift();
  } else if (state === 'idle' && new Date().getDay() === 0 && hour() >= 18 && life.recap !== todayKey()) {
    // Sunday evening: the week in one bubble
    life.recap = todayKey();
    saveLife();
    const week = weekReport();
    if (week.total) {
      setFx('wave', 900);
      sayChart(`Sunday recap! ${week.text}`, week.days, 14000);
    }
  } else if (state === 'idle' && now > nextInit && now > hushUntil && !guest && !gift && !invite && !asking && !sleepy
    && now - lastActivity > 20000 && now - Math.max(cur.movedAt, lastKey) < 60000 && !['grumpy', 'hurt', 'scared'].includes(mood)) {
    // you are around and nothing is happening: its turn to start something
    nextInit = now + (10 + Math.random() * 10) * 60000;
    startSomething();
  } else if (state === 'idle' && now > nextHobby && now - lastActivity > 30000
    && !['grumpy', 'scared', 'embarrassed', 'worried', 'hungry', 'lonely', 'jealous', 'glum', 'hurt'].includes(mood)) {
    // nothing to do for a bit: time for a hobby
    nextHobby = now + 150000 + Math.random() * 150000;
    startHobby();
  } else if (state === 'idle' && sleepy && now > nextYawn) {
    nextYawn = now + 50000 + Math.random() * 60000;
    setFx('yawn', 1800);
    sfx('yawn');
    say(pick(YAWNS), 2500);
  } else if (state === 'idle' && now > nextMuse && now > hushUntil) {
    // nothing going on: look around and wonder about things
    nextMuse = now + 40000 + Math.random() * 50000;
    const roll = Math.random();
    if (roll < 0.08) {
      setFx('poke', 350);
      sfx('hic');
      bump('shame', 0.3);
      say('Achoo!', 1500);
    } else {
      if (mood === 'joyful' && roll < 0.5) setFx('hop', 500);
      else setFx('look', 2400);
      if (roll < 0.2 && !MUSE[mood]) say(`It's ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} already?`, 3000);
      else if (roll < 0.6) say((roll < 0.3 && taught()) || (roll > 0.5 && ageIndex() > 0 && !MUSE[mood] && recall()) || pick((ageIndex() > 0 && MUSE[mood]) || (isNight() && ageIndex() > 0 ? MUSE_NIGHT : voice().muse || MUSE_ANY)), 3500);
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
  // being hurt comes before everything
  if (feel.hurt > 0.6 - s('hurt')) return 'hurt';
  // sudden feelings first: they pass in a minute or two, the needs underneath can wait
  if (feel.fear > 0.6 - s('scared')) return 'scared';
  if (feel.irritation > 0.6 - s('grumpy')) return 'grumpy';
  if (feel.shame > 0.6 - s('embarrassed')) return 'embarrassed';
  if (feel.excite > 0.6 - s('excited')) return 'excited';
  if (feel.pride > 0.6 - s('proud')) return 'proud';
  if (feel.love > 0.7 - s('loving')) return 'loving';
  if (feel.worry > 0.6 - s('worried')) return 'worried';
  if (feel.energy < 0.25 + s('tired')) return 'tired';
  if (feel.hunger > 0.8 - s('hungry')) return 'hungry';
  if (feel.envy > 0.7 - s('jealous')) return 'jealous';
  if (feel.lonely > 0.7 - s('lonely')) return 'lonely';
  if (feel.boredom > 0.75 - s('bored')) return 'bored';
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
    for (const k of ['fear', 'shame', 'excite', 'pride', 'boredom', 'envy']) bump(k, -gone / 120);
    bump('love', -gone / 900);
    bump('hurt', -gone / 3600);
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
  bump('fear', -0.02);
  bump('shame', -0.012);
  bump('excite', -0.006);
  bump('pride', -0.004);
  bump('love', -0.0035);
  // slow to fade by itself: sleep helps, a pet or a snack helps far more
  bump('hurt', asleep ? -0.002 : -0.0005);
  // waiting around is boring: on you to answer Claude, or on a command that will not end
  bump('boredom', !asleep && (waiting || alertSession()) ? 1 / 150 : -0.01);
  // you are busy at the keyboard and have had no time for it in ages
  const typing = Date.now() - lastKey < 30000;
  bump('envy', !asleep && typing && Date.now() - lastTouched > 10 * 60000 && Date.now() - lastActivity > 5 * 60000 ? 1 / 420 : -0.005);
  bump('lonely', asleep ? 0 : 1 / (Math.max(1, CFG.lonelyMinutes) * 60));
  bump('hunger', asleep ? 0 : (lunchtime ? 3 : 1) / (Math.max(1, CFG.hungerMinutes) * 60));
  // work is tiring, staying up late is tiring, sleep and quiet daytime restore it
  bump('energy', asleep ? 1 / 120 : busy ? -1 / 900 : night ? -1 / 1200 : 1 / 600);

  if (night !== wasNight) {
    wasNight = night;
    sendRoom(); // the lamp comes on
    render();
    if (!fx && state === 'idle') say(night ? '*yawn* It\'s getting late…' : 'Morning already?', 3000);
  }

  const next = currentMood();
  if (next !== mood) {
    const prev = mood;
    mood = next;
    // cross enough to turn its back, away from wherever the cursor is
    sulk = next === 'grumpy' ? (cur.dx < 0 ? 'r' : 'l') : '';
    sulkTurns = frontSince = 0;
    if (next === 'hurt') {
      did('hurt');
      // it remembers: wary tomorrow unless you make it up, and a card in the album
      life.wary = true;
      if (life.hurtOn !== todayKey()) {
        life.hurtOn = todayKey();
        snap('hurt', 'A bad day', 'Handled too roughly. It took a while to feel better.', '', true);
      }
      saveLife();
    }
    render();
    if (!fx && (state === 'idle' || state === 'thinking') && Date.now() > hushUntil) {
      if (MOOD_ARRIVES[next]) say(pick(MOOD_ARRIVES[next]), 3500);
      else if (prev === 'hurt') say('*sniff* …okay. I\'m alright now.', 3000);
      else if (prev === 'grumpy') say('Okay. I\'m over it.', 2500);
      else if (prev === 'worried') say('Okay… feeling calmer.', 2500);
      else if (prev === 'hungry') say('Ahh. Much better.', 2500);
      else if (prev === 'scared') say('Okay… okay. I\'m alright.', 2500);
      else if (prev === 'jealous') say('…fine. We\'re good.', 2500);
      else if (prev === 'embarrassed') say('Right. Moving on.', 2500);
    }
  }
  applyQuiet(); // quiet hours start and end on the clock

  // still at it in the small hours: one nudge an hour
  if (hour() < 5 && lateHour !== hour() && !fx && !quiet && state === 'idle' && Date.now() - Math.max(cur.movedAt, lastKey) < 60000) {
    lateHour = hour();
    say(`It's ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}. Bed soon? For both of us?`, 5000);
  }
  if (++feelTicks % 30 === 0) {
    saveFeel();
    applySeason();
    rollDay();
    if (unwritten) writeDiary();
  }
}, 1000);
window.addEventListener('beforeunload', saveFeel);

window.buddy.onAskMood(() => {
  touch();
  if (fx === 'sleep') { say('Zzz… mmh? Sleepy. Very sleepy.', 3000, true); return; }
  const worst = [...sessions.values()].sort((a, b) => b.ctx - a.ctx)[0];
  const room = worst && worst.ctx >= CFG.contextWarnAt[0] ? ` Also: context is ${worst.ctx}% full.` : '';
  const timer = focusUntil ? ` Focus: ${Math.max(1, Math.round((focusUntil - Date.now()) / 60000))} min left.` : '';
  const food = life.favFound ? ` Favourite food: ${FOODS.find((f) => f.id === life.fav).name}.` : '';
  const belief = life.omens.held.length ? life.omens.held[Math.floor(Math.random() * life.omens.held.length)] : null;
  // one more thing about itself, a different one each time
  const more = [
    life.scarf >= 60 && `My scarf is ${scarfLen()} long.`,
    belief && `${belief.from ? `${belief.from} taught me that` : 'I happen to know that'} ${omenText(belief)}.`,
    opinions().fav && `Favourite project: ${clip(opinions().fav, 20)}.`,
    life.egg && 'I\'m keeping an egg warm.',
  ].filter(Boolean);
  const born = new Date(`${life.born}T12:00:00`).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  say((life.name ? `${life.name} here. ` : '') + pick(MOOD_REPORT[mood] || MOOD_REPORT.content) + (isNight() && mood === 'content' ? ' A bit sleepy.' : '') + room + timer + ` We're: ${BOND_NAMES[bondLevel()].toLowerCase()}.` + food + ` I'm a ${AGE_NAMES[ageIndex()]}${life.gen > 1 ? ` (generation ${life.gen})` : ''}, born ${born}.` + (more.length ? ' ' + more[Math.floor(Math.random() * more.length)] : ''), 10000, true);
});

// Nod off after a couple of quiet minutes (much sooner when tired or late); any hook event or
// poke wakes it. Asleep, it mumbles now and then.
setInterval(() => {
  const now = Date.now();
  if (fx === 'sleep') {
    if (now > nextDream) {
      nextDream = now + 40000 + Math.random() * 50000;
      // mostly it dreams about what it did today: a picture in a thought bubble
      const seen = Object.keys(day.did).filter((k) => DREAM_OF[k]);
      if (seen.length && Math.random() < 0.7) {
        dream = seen[Math.floor(Math.random() * seen.length)];
        render();
        say(pick(DREAM_OF[dream]), 3500);
        clearTimeout(dreamTimer);
        dreamTimer = setTimeout(() => { dream = ''; render(); }, 6000);
      } else {
        say(pick(DREAMS), 2500);
      }
    }
    return;
  }
  const patience = (mood === 'tired' || isNight() ? CFG.sleepAfterSecSleepy : CFG.sleepAfterSec) * 1000;
  if (now - lastActivity < patience) bedTried = false;
  // someone typing nearby keeps it up
  if (state === 'idle' && !fx && !away && !chasing && !walking && !focusUntil && !editingNote && !rps && !asking && now - lastActivity > patience && now - lastKey > 30000) {
    // a teenager does not go to bed just because it is bedtime
    if (ageIndex() === 2 && mood !== 'tired' && now - defiedBed > 30 * 60000) {
      defiedBed = now;
      if (rebels()) {
        lastActivity = now - patience + 90000;
        defy(['I\'m not even tired.', 'Bedtime is a social construct.', 'Five more minutes. I mean it this time.', 'You can\'t make me.']);
        return;
      }
    }
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

showAge();
applyLook();
visit();
applySeason();
showNote();
recordDay();
if (unwritten) writeDiary();
showEgg();
saveFeel();
setState('idle');
