// The photo album: one card per milestone, newest first. Each card remembers what Clawd
// was wearing that day. Two more pages hold its diary and the family tree.
const COLORS = { classic: '#d97757', mint: '#5fbf9a', sky: '#5aa7e0', grape: '#9b6fd6', gold: '#e0b030' };
const STAMPS = { first: '🌱', unlock: '🎁', streak: '🔥', bond: '♥', badge: '★', trick: '✦', food: '🍪', grow: '🌿', name: '✎', visit: '👋', bday: '🎂', gift: '💝', secret: '🤫', hurt: '🩹', scarf: '🧶', omen: '🔮', egg: '🥚', hatch: '🐣' };
// what a gift looks like, drawn to the left of the portrait: [x, y, width, height, colour]
const PICS = {
  us: [[-8, -3, 4, 4, '#f2c9a0'], [-8, 1, 4, 6, '#4a60bd'], [-8, 7, 1, 4, '#33363d'], [-5, 7, 1, 4, '#33363d'], [-3, -4, 1, 1, '#ff5a7a'], [-1, -4, 1, 1, '#ff5a7a'], [-3, -3, 3, 1, '#ff5a7a'], [-2, -2, 1, 1, '#ff5a7a']],
  flower: [[-6, 2, 1, 9, '#3f9a4a'], [-8, -2, 5, 4, '#ff8ac0'], [-7, -1, 3, 2, '#ffd84a'], [-5, 5, 2, 1, '#58c064']],
  gem: [[-8, 4, 6, 5, '#4ad0e0'], [-7, 3, 4, 1, '#4ad0e0'], [-7, 5, 2, 2, '#e0fbff'], [-7, 9, 4, 1, '#2fa7b8']],
  poem: [[-9, -2, 7, 11, '#fffdf5'], [-8, 0, 5, 1, '#8a8f99'], [-8, 2, 5, 1, '#8a8f99'], [-8, 4, 4, 1, '#8a8f99'], [-8, 6, 5, 1, '#8a8f99']],
  medal: [[-7, -3, 1, 5, '#d9423a'], [-4, -3, 1, 5, '#4a60bd'], [-8, 2, 6, 6, '#f2c230'], [-6, 4, 2, 2, '#fff3b0']],
};
// hats, drawn small: [x, y, width, height, colour] on the portrait's grid
const HATS = {
  sprout: [[7, -2, 1, 3, '#3f9a4a'], [8, -3, 2, 1, '#58c064'], [5, -2, 2, 1, '#58c064']],
  cap: [[3, -1, 9, 2, '#3b6fd9'], [11, 0, 4, 1, '#2a4fa0']],
  headphones: [[2, 0, 12, 1, '#33363d'], [1, 1, 1, 4, '#33363d'], [14, 1, 1, 4, '#33363d']],
  tophat: [[5, -4, 6, 4, '#23232a'], [5, -1, 6, 1, '#d9534f'], [4, 0, 8, 1, '#23232a']],
  wizard: [[4, 0, 8, 1, '#5b43c4'], [5, -2, 6, 2, '#6a4fd8'], [7, -4, 2, 2, '#6a4fd8'], [8, -1, 1, 1, '#ffd84a']],
  crown: [[4, -1, 8, 2, '#f2c230'], [4, -2, 1, 1, '#f2c230'], [7, -3, 2, 2, '#f2c230'], [11, -2, 1, 1, '#f2c230'], [8, -1, 1, 1, '#e0483c']],
};

function portrait(card) {
  const NS = 'http://www.w3.org/2000/svg';
  const el = document.createElementNS(NS, 'svg');
  const pic = PICS[card.p];
  el.setAttribute('viewBox', pic ? '-10 -5 27 16' : '0 -5 16 16');
  if (pic) el.style.width = '150px';
  const rect = (x, y, w, h, fill) => {
    const r = document.createElementNS(NS, 'rect');
    r.setAttribute('x', x); r.setAttribute('y', y); r.setAttribute('width', w); r.setAttribute('height', h);
    r.setAttribute('fill', fill);
    el.appendChild(r);
  };
  const skin = COLORS[card.color] || COLORS.classic;
  rect(2, 1, 12, 7, skin);
  rect(0, 4, 2, 2, skin); rect(14, 4, 2, 2, skin);
  for (const x of [3, 5, 10, 12]) rect(x, 8, 1, 3, skin);
  // every photo is a happy one
  for (const x of [4, 9]) { rect(x, 4, 1, 1, '#1f1410'); rect(x + 1, 3, 1, 1, '#1f1410'); rect(x + 2, 4, 1, 1, '#1f1410'); }
  for (const part of HATS[card.hat] || []) rect(...part);
  for (const part of pic || []) rect(...part);
  return el;
}

const loaded = window.album.load();
const cards = Array.isArray(loaded) ? loaded : [];
const box = document.getElementById('cards');
document.getElementById('count').textContent = cards.length === 1 ? '1 memory so far' : `${cards.length} memories so far`;

for (const card of [...cards].reverse()) {
  if (!card || typeof card !== 'object') continue;
  const el = document.createElement('div');
  el.className = 'card k-' + String(card.k).replace(/[^a-z]/g, '');
  const photo = document.createElement('div');
  photo.className = 'photo';
  const stamp = document.createElement('span');
  stamp.textContent = STAMPS[card.k] || '★';
  photo.append(portrait(card), stamp);
  const title = document.createElement('b');
  title.textContent = String(card.t || '');
  const text = document.createElement('p');
  text.textContent = String(card.x || '');
  const when = document.createElement('time');
  const d = new Date(String(card.d) + 'T12:00:00');
  when.textContent = Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  el.append(photo, title, text, when);
  box.appendChild(el);
}

if (!cards.length) {
  const empty = document.createElement('div');
  empty.id = 'empty';
  empty.textContent = 'No photos yet. Finish a task, make friends, teach it a trick, find its favourite food: every first gets a picture.';
  box.replaceWith(empty);
}

// ---- the other pages ----

const more = window.album.more() || {};
const longDate = (text) => {
  const d = new Date(String(text) + 'T12:00:00');
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
};
const add = (parent, tag, text, cls) => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text) el.textContent = text; // textContent only: names and pages are stored text
  parent.appendChild(el);
  return el;
};

// the diary, newest page first
const diary = document.getElementById('diary');
const pages = Array.isArray(more.diary) ? more.diary.filter((p) => p && typeof p === 'object') : [];
for (const page of [...pages].reverse()) {
  const el = add(diary, 'div', '', 'entry');
  add(el, 'time', new Date(String(page.d) + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }).replace('Invalid Date', ''));
  add(el, 'p', String(page.t || ''));
}
if (!pages.length) add(diary, 'div', 'Nothing written yet. It writes a few lines about each day once the day is over.', 'blank');

// the family: whoever stood here before, oldest first, down to the one here now
const family = document.getElementById('family');
const elders = Array.isArray(more.elders) ? more.elders.filter((f) => f && typeof f === 'object') : [];
const now = more.now && typeof more.now === 'object' ? more.now : {};
for (const f of [...elders, { ...now, here: true }]) {
  if (f !== elders[0] && !(f.here && !elders.length)) add(family, 'div', '↓', 'down');
  const el = add(family, 'div', '', f.here ? 'kin now' : 'kin');
  el.appendChild(portrait({ color: f.c, hat: f.h }));
  const words = add(el, 'div');
  add(words, 'b', `${String(f.n || '') || (f.here ? 'No name yet' : 'Clawd')} · generation ${Number(f.gen) || 1}`);
  add(words, 'span', f.here ? `Born ${longDate(f.born)}. Here now.` : `${longDate(f.born)} to ${longDate(f.left)}. ${Number(f.tasks) || 0} tasks together.`);
}
const metres = (Number(more.scarf) || 0) / 600;
if (metres >= 0.01) add(family, 'div', `The family scarf is ${metres < 1 ? `${Math.round(metres * 100)} cm` : `${metres.toFixed(1)} m`} long.`, 'blank');

// tabs; the menu can ask for a page with #diary or #family
function show(tab) {
  const id = ['diary', 'family'].includes(tab) ? tab : 'photos';
  for (const page of document.querySelectorAll('.page')) page.classList.toggle('on', page.id === id);
  for (const b of document.querySelectorAll('#tabs button')) b.classList.toggle('on', b.dataset.tab === id);
}
document.getElementById('tabs').addEventListener('click', (e) => {
  if (e.target.dataset.tab) show(e.target.dataset.tab);
});
window.addEventListener('hashchange', () => show(location.hash.slice(1)));
show(location.hash.slice(1));
