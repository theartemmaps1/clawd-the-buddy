# claude-buddy

A tiny always-on-top desktop companion that reacts to what Claude Code is doing, via Claude Code hooks.

> **Unofficial fan project.** Not affiliated with, endorsed by, or sponsored by Anthropic.
> "Claude" and "Claude Code" are trademarks of Anthropic. The character is a fan-made pixel
> drawing inspired by Claude Code's mascot; it is not official artwork.

## Run it

```bash
npm install
npm start
```

A small pixel-art character appears bottom-right. Drag it anywhere.

Windows note: if `npm start` says Electron failed to install, run
`node node_modules/electron/install.js`. On very new Node versions that script can stop
part-way through unpacking; in that case unzip the downloaded Electron zip from
`%LOCALAPPDATA%\electron\Cache` into `node_modules\electron\dist` and create
`node_modules\electron\path.txt` containing `electron.exe`.

## Connect it to Claude Code

Merge the `"hooks"` block from `claude-settings-hooks.json` into `~/.claude/settings.json`
(or a project's `.claude/settings.json`). If you already have a `"hooks"` section, add the
events to it rather than replacing it. Then start a new Claude Code session.

Hooks are HTTP POSTs to `http://127.0.0.1:8787/event`. If the buddy isn't running, the hook
fails quietly (non-blocking) and Claude Code carries on. The buddy never returns a decision,
so it can't block or change anything Claude does.

## Test without Claude Code

```bash
curl -X POST http://127.0.0.1:8787/event -H 'content-type: application/json' \
  -d '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"npm test"}}'

curl -X POST http://127.0.0.1:8787/event -H 'content-type: application/json' \
  -d '{"hook_event_name":"Stop"}'
```

## What it does

- **Mouse:** click to poke, double-click for a flip, rub to pet, drag to carry, flick to throw.
  Right-click (or the tray icon) for the menu.
- **Needs you:** when Claude is waiting on you it wiggles; click it to bring that Claude window
  to the front (Windows only). "Go to Claude" in the menu does the same at any time.
- **Sessions:** with more than one Claude Code session, each gets a mini on the left showing
  its state. Click a mini to jump to that session.
- **Props:** laptop while editing, book while reading, magnifier while searching, hard hat
  while running commands, globe while browsing.
- **Moods:** joyful, grumpy, worried, tired, hungry, lonely, glum. Sleepy at night.
- **Snacks:** drag a file or selected text onto it. Only the file name is looked at.
- **Memory:** "How was today?" reports the day's tasks, failures and longest job.
- **Wardrobe:** hats and colours unlock at 10, 50, 100, 150, 300, 400, 700, 1000, 1500 and
  2500 finished tasks.
- **Sound:** small chirps for pokes, finished tasks, failures and "Claude needs you".
- **Commands:** cheers when tests pass, winces when they fail, gets nervous at `rm -rf`,
  force pushes and the like.
- **Context warnings:** says when a session's context window is 70%, 85% and 95% full. The
  number comes from the tail of the session transcript under `~/.claude`; nothing else is read.
- **Sit on windows:** with gravity on, it lands on other windows' top edges and rides along
  (Windows only; runs a small PowerShell helper that lists window positions).
- **Ball:** "Throw a ball" in the menu. Drag and fling it; with gravity on, the buddy chases it.
- **Breaks, streaks, night:** suggests a break after an hour, counts days in a row, and gets
  sleepy at night.
- **Friendship:** a bond that grows with pets, snacks, play and finished tasks, and cools after
  days away. Five levels, from stranger to best friend.
- **Personality:** cheerful, sarcastic, shy or dramatic, picked from the menu.
- **Achievements:** 18 badges, listed in the menu.
- **Focus timer:** 25 quiet minutes with an hourglass, then it insists on a break.
- **Seasons:** scarf in winter, flower in spring, sunglasses in summer, a leaf in autumn, plus
  a Santa hat and a pumpkin on their dates. Set `southern` in the config for the other hemisphere.
- **Bed:** turn on "Bed" and drag the bed where you like; it walks there to sleep.
- **Sticky note:** "Leave a note…" gives it one thing to remember; click the note to clear it.
- **Menu toggles:** sound, curious wandering, gravity, sit on windows, start with Windows,
  hide/show.
- **`config.json`:** timings, thresholds, unlock counts and the main phrase lists. Edit it and
  pick "Reload config.json" from the menu.

## Make it yours

- **Look:** the character is plain SVG + CSS in `index.html`. Swap in your own art; states are
  CSS classes on `<body>`: `idle thinking working happy sad alert`.
- **Behavior:** event-to-state mapping lives in `renderer.js`.
- **Port:** set `BUDDY_PORT` (and update the URLs in your hooks).

## Notes

- Server binds to 127.0.0.1 only. Payloads are capped at 256 KB and only a few fields are
  forwarded to the UI; text is rendered with `textContent`, never as HTML.
- Hook payloads can include commands and file paths, so don't expose this port anywhere else.
- The art is plain SVG in `index.html`; swap in your own character if you prefer.

## License

MIT. See `LICENSE`.
