# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Clawd (package name `claude-buddy`): an Electron desktop pet (transparent, always-on-top window) that reacts to Claude Code hook events POSTed to a local HTTP server. Plain JavaScript, HTML and CSS; Electron is the only dependency. There is no build step, bundler, linter, type checker or test suite.

## Commands

```bash
npm install
npm start          # electron .
```

- The app holds a single-instance lock and the hook port. A second `npm start` only un-hides the running copy, so quit the running one (tray → Quit Buddy) before starting again to see changes to `main.js` or a preload. If the user has the buddy running to watch their own Claude Code sessions, this is the same instance.
- `BUDDY_PORT` changes the port (default 8787). The URLs in `claude-settings-hooks.json` are hardcoded to 8787.
- `config.json` is re-read from the tray menu ("Reload config.json") without a restart.

Driving it by hand, without Claude Code:

```bash
curl http://127.0.0.1:8787/health
curl -X POST http://127.0.0.1:8787/event -H 'content-type: application/json' -d '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"npm test"},"session_id":"t1"}'
curl -X POST http://127.0.0.1:8787/event -H 'content-type: application/json' -d '{"hook_event_name":"Stop","session_id":"t1"}'
```

Electron install trouble on Windows is covered in the README ("Run it").

## Architecture

Two processes with a strict split: **main owns the desktop, the renderer owns the character.**

### `main.js` (main process)

- **Hook server**: `POST /event` on 127.0.0.1 → `slim()` picks a handful of fields → `claude-event` IPC to the renderer. It always answers 2xx with an empty body so a hook can never block or alter Claude Code. A hook payload field the renderer needs must be added to `slim()` first; nothing else is forwarded.
- **Window position and physics**: `trackCursor()` is a 16 ms tick that moves the windows for dragging, falling (`stepFall`), walking (`stepWalk`), ball chasing and the ball itself, and sends the cursor position to the renderer. The renderer never positions the window; it asks (`buddy-walk`, `buddy-drag`, `buddy-go-bed`, `buddy-hide`, `buddy-chase`, `buddy-corner`, `buddy-meddle`, `buddy-roam`) and is told the outcome (`buddy-walk-done`, `buddy-fly`, `buddy-bounce`, `buddy-landed`, `buddy-meddling`, `buddy-meddled`). `home` is where it lives, `perch` the foreign window it is standing on.
- **Windows-only helper**: `WATCH_CS` is C# compiled by a long-lived PowerShell child via `Add-Type`. It prints `W` lines (window rects, for perching), `A` (the handle of the window in front, so main can find it among those rects), `K` (some key went down), `C` (the clipboard sequence number changed) and `F` (fullscreen / mic / foreground process name, reduced to a category by `APP_KINDS`). It is sent on stdin as one single-quoted line, so the C# must contain no single quotes and no `//` comments. While the `music` setting is on, `MUSIC_PS` (plain PowerShell, same process) polls the Windows media session and prints `M` lines (base64 app / title / artist); switching the setting restarts the helper. While `pages` is on, a second C# thread (`Pages`) reads the foreground browser's address bar through UI Automation and prints `P` lines carrying only the host name, which `onPage` reduces to a category with `SITE_KINDS`. While `meddle` is on, a third thread (`Hands`) reads orders from stdin (`D shake|shove|tug|back <hwnd> <dx> <dy>`, plus `tow`, `grab` and the unanswered `pull`; written by `act()` once `stalkWindow` / `stalkPointer` / `leap` have walked or jumped him over to the target; a `walk` or `fall` can carry a `then` callback for this, and a `fall` with `jump` lands dead on a window instead of bouncing) and answers `D <order> 0|1`: it is the only part of the helper that acts, it only ever moves a window or the pointer, and it remembers where shoved windows were so `back` (or stdin closing) can return them. `FOCUS_PS` plus `findPeerPid` (netstat on the hook connection) map a session id to a window for "Go to Claude".
- **Persistence**, both in Electron's `userData` directory, not the repo:
  - `buddy-settings.json`: the menu toggles in `settings`. A new key needs a default there; loading only accepts keys whose type matches the default.
  - `buddy-memory.json` (+ `.bak`, written atomically): the renderer's state under the four keys in `MEMORY_KEYS` (`buddy-day`, `buddy-life`, `buddy-history`, `buddy-feel`). The renderer reads it once, synchronously, in the preload (`window.buddy.saved`) and writes through `store()`.
- **Native menu and tray**: `buildMenu()` is rebuilt on every open. Anything it shows that the renderer owns (wardrobe, badges, room items, tricks, name, friend code) is pushed up by the renderer via `buddy-wardrobe`, sanitised, and cached in module variables. Menu clicks go back down as IPC (`buddy-wear`, `buddy-do`, `buddy-play`, `buddy-edit`, …).
- **Downloads**: `watchDownloads` (`fs.watch`, any platform) tells the renderer the extension and size of a new file, gated on the `notice` setting.
- **Other windows**: ball (`ball.*`), bed/room (`bed.*`, shaped with `setShape` from `ROOM_BOXES`), photo album (`album.*`). Each has its own minimal preload. While he has the pointer (`holding`) or is in a tug of war (`war`) main drives it with `pull` orders on a timer and reports `letgo` / `warover`. `awayFrom` remembers his perch while he sits on what you are reading (`block`) or roams the idle screen (`buddy-roam`); `comeBack()` returns him. The footprints (`prints.*`, part of meddling) are a click-through window with no preload at all; main passes the two end points in the URL hash.
- **Context usage**: `checkContext` reads the tail of the session transcript (only under `~/.claude`) and forwards a token count.

### `preload.js`

The complete IPC surface, exposed as `window.buddy`. Every window is sandboxed with context isolation, so a new channel means three edits: `main.js`, `preload.js`, `renderer.js`.

### `renderer.js` + `index.html`

`renderer.js` is one ~3600-line classic script (no modules; everything is a top-level global) divided by `// ---- section ----` banners. Search for the banner rather than reading the file through.

- **How it looks is entirely CSS.** `render()` sets `document.body.className` to `state` + ` fx-<name>` + ` mood-<name>` + flags (`night`, `quiet`, `cry`, `sulk`) and a set of `body.dataset` values (`prop`, `moment`, `wait`, `plan`, `hobby`, `dream`, `age`, `hat`, `season`, `holiday`, …). The SVG character and every selector that reacts to those live in `index.html`. A new visual is usually an SVG group hidden by default plus a `body[...]` rule, then a line in `render()`.
- **Three layers decide the face**: `state` (hook-driven: `idle thinking working happy sad alert`, set with `setState`, decays through `backToIdle`), `fx` (a short reaction on top, `setFx(name, ms)`), and `mood`. Mood is suppressed while a state or fx listed in `MOODLESS_STATES` / `MOODLESS_FX` is showing; a new fx with its own face belongs in that list.
- **Personality is more than lines.** `PERSONA` holds each one's voice, `TEMPER` scales how strongly it feels things (applied in `bump()`), `manner()` is its idle habit, and `render()` sets `data-persona` (always) and `data-manner` (only while no fx or mood has the face) for the body-language rules in `index.html`. A new personality also goes in `PERSONA_IDS` (append only: the index is in friend codes) and `PERSONALITIES` in `main.js`.
- **Mood is derived, not set.** `feel` is a set of 0..1 levels (`joy` is -1..1) changed with `bump()`, decayed by the 1 s interval in the emotions section, and `currentMood()` picks the dominant one in a fixed priority order with hysteresis.
- **Hook handling** is the single `switch` in `window.buddy.onEvent`. `commandKind()` (from the `COMMANDS` regex table) classifies shell commands as danger / test / commit / pr / merge / push / build / install (first match wins, so order matters). `sessions` tracks each Claude Code session for the minis, the permission sign and the helpers.
- **Lasting state**: `day` (today's tally, reset by `rollDay`), `life` (everything permanent: tasks, bond, badges, album, tricks, name, friends…) and history. A new `life` field needs a default in its initialiser; older saves are merged over it. `life.tasks` counts every generation and drives unlocks (`HATS`, `COLORS`); age comes from `genTasks()` (tasks since `life.genFrom`, which `hatch()` moves) against `CFG.growAt`.
- **The day's story**: `did(key)` notes that something happened today. Dreams use the keys in `DREAM_OF`; the diary (`writeDiary`, run on the day `rollDay` has just closed) reads the rest. A new event worth a diary line needs a `did()` call and a line there.
- **Load order**: the file runs top to bottom once, so a `const`/`let` is not usable by top-level code above it. `rollDay()` runs early for that reason and only parks the old day in `unwritten`; the diary page is written at the bottom of the file.
- **Speech**: `say(text, ms, force)`; `pick()` avoids recent repeats; `voice()` swaps in persona / baby / teen lines.
- **Config**: `CFG` holds the defaults; `applyConfig()` overlays `config.json` (numbers, `unlocks`, `lines`, `personas`). The `LINES` map defines which phrase lists are overridable, and `config.json` ships copies of them, so changing a built-in list in `renderer.js` has no visible effect while `config.json` still carries the old one.

### `dev/` (gitignored, optional)

`main.js` loads `dev/index.js` if it exists and gives it a small API; it adds a "Dev" menu (inspector panel, simulated hook events, forced moods and fx, a sandbox that holds saves, Reload buddy). It works from outside via `executeJavaScript`, relying on the renderer's globals; the app itself carries no debug code. Keep it that way: nothing committed may depend on `dev/`.

## Invariants

These are promises the README makes to users:

- The server binds to loopback only, caps bodies at 256 KB, and never returns a hook decision.
- Text from hooks, files and friend codes is untrusted: rendered with `textContent`, never as HTML; everything crossing IPC into main is type-checked and length-clipped.
- The Windows helper reports only *that* input happened (keys, and clipboard changes by sequence number), window rectangles, and the foreground process name (reduced to a category; the one exception is an unknown fullscreen program, taken to be a game, whose tidied name reaches the renderer and the save as `life.games`). Never window titles (it looks at a browser's title only for a private-window marker), key identities or file contents. Two opt-in exceptions, both off by default: with "Listen to my music" on it reads the title, artist and source app of what is playing (only per-artist counts are saved, never titles); with "Notice which sites I'm on" on it reads the foreground browser's address bar and reports the host name only, which main reduces to a category and drops (the host never reaches the renderer or the save). Dropped snacks are judged by file name and size only. The helper acts on the desktop only while "Let him mess with my desktop" is on (off by default), and then only by moving a window sideways or the pointer: never clicking, typing, resizing, focusing, minimising or closing, never a maximised or fullscreen window, never while a mouse button is held, and every shoved window is put back when he calms down, the setting goes off or the app quits.
- Nothing leaves the machine. Friend codes are clipboard text.
- Windows-only features (perching, focus, typing along, noticing, auto-quiet, the window and pointer side of meddling) are gated on `process.platform === 'win32'` and their menu items are disabled elsewhere.

## Conventions

- The README (the sections from "While Claude works" to "Keeping track") documents every user-visible feature and config key; feature commits update it alongside the code (and `config.json` / `claude-settings-hooks.json` when a setting or hook event is added).
- The character is called Clawd and is a "he": use that in everything a user reads (README, menu labels, badge hints, anything said about him). Many older code comments still say "it" or "the buddy"; write new ones with "he" and "Clawd". Comments are short and lower-case; match the existing density.
- Internal names keep "buddy" on purpose: `window.buddy`, the `buddy-*` IPC channels and memory keys, `BUDDY_PORT`, the `BUD-` friend codes and the package name. Renaming the package or the save files would move the userData folder and lose everyone's save.
- The character is a fan-made drawing; the README's "unofficial fan project" disclaimer stays.
