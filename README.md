# claude-buddy

A tiny always-on-top desktop companion that reacts to what Claude Code is doing, via Claude Code hooks.

> **Unofficial fan project.** Not affiliated with, endorsed by, or sponsored by Anthropic.
> "Claude" and "Claude Code" are trademarks of Anthropic. The character is a fan-made pixel
> drawing inspired by Claude Code's mascot; it is not official artwork.

## What it looks like

<table>
  <tr>
    <td align="center"><img src="screenshots/hello.png" width="180" alt="Says good morning"><br><sub>Says good morning</sub></td>
    <td align="center"><img src="screenshots/working.png" width="180" alt="Works alongside Claude"><br><sub>Works alongside Claude</sub></td>
    <td align="center"><img src="screenshots/done.png" width="180" alt="Cheers a finished task"><br><sub>Cheers a finished task</sub></td>
    <td align="center"><img src="screenshots/wardrobe.png" width="180" alt="Unlocks hats and colours"><br><sub>Unlocks hats and colours</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="screenshots/hurt.png" width="180" alt="Gets hurt if you are rough"><br><sub>Gets hurt if you are rough</sub></td>
    <td align="center"><img src="screenshots/comfort.png" width="180" alt="Comforts you on a bad run"><br><sub>Comforts you on a bad run</sub></td>
    <td align="center"><img src="screenshots/sulk.png" width="180" alt="Sulks with its back turned"><br><sub>Sulks with its back turned</sub></td>
    <td align="center"><img src="screenshots/sleep.png" width="180" alt="Sleeps, and dreams"><br><sub>Sleeps, and dreams</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="screenshots/baby.png" width="180" alt="Starts out as a baby"><br><sub>Starts out as a baby</sub></td>
    <td align="center"><img src="screenshots/teen.png" width="180" alt="Has a teenage phase"><br><sub>Has a teenage phase</sub></td>
    <td align="center"><img src="screenshots/question.png" width="180" alt="Asks you things"><br><sub>Asks you things</sub></td>
    <td align="center"><img src="screenshots/secret.png" width="180" alt="Tells friends its secrets"><br><sub>Tells friends its secrets</sub></td>
  </tr>
</table>

On the desktop its window is transparent; these are drawn on a plain background.

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

If you set the hooks up before `PreCompact` was in that file, add that one line too; it is what
lets the buddy shake its head when the context is compacted.

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
- **Moods:** joyful, grumpy, worried, tired, hungry, lonely, glum, and the quicker feelings on
  top: scared (dangerous commands, hard throws), embarrassed (sneezes, cheering too soon), excited,
  proud, loving, jealous (you typing away for ages without a glance at it) and bored (waiting).
  Each has its own face. Sleepy at night; it cries when things go really badly.
- **Snacks:** drag a file or selected text onto it. Only the file name is looked at. It loves
  plain words, sniffs programs suspiciously, finds office documents dry, and has one favourite
  food of its own that you have to discover by feeding it.
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
- **Achievements:** 24 badges, listed in the menu.
- **Focus timer:** 25 quiet minutes with an hourglass, then it insists on a break.
- **Seasons:** scarf in winter, flower in spring, sunglasses in summer, a leaf in autumn, plus
  a Santa hat and a pumpkin on their dates. Set `southern` in the config for the other hemisphere.
- **Bed:** turn on "Bed" (under Room) and drag it where you like; it walks there to sleep.
- **Sticky note:** "Leave a note…" gives it one thing to remember; click the note to clear it.
- **Helpers:** every subagent Claude starts pops out as a tiny helper on the right, and hops
  back in when it finishes.
- **Git moments:** plants a flag on a commit, throws a paper plane on a push, sets off a party
  popper when a PR is opened.
- **Long commands:** after a minute it sits down and knits, or taps its foot, then stretches when
  the command ends. Three failures in a row and it puts the kettle on instead of wincing.
- **Plan mode:** a pencil behind its ear and a blueprint in its hands.
- **Compaction:** shakes its head like a wet dog when the context is compacted.
- **Hobbies:** left alone it reads, juggles (poke it and it drops them), hums, exercises,
  stargazes in the evening, or waters a plant that grows with your streak.
- **Dreams:** asleep, a thought bubble shows something from the day: a green tick, a bug, a
  file, a commit, a snack, the ball.
- **Cursor:** circle it quickly and it gets dizzy; shake the mouse and it helps you find the
  pointer.
- **Tricks:** repeat a gesture five times and it learns what you mean. Swipe up through it
  (jump), swipe down (sit), draw a slow circle round it (twirl), rub up and down (dance). Each
  needs a certain friendship level; the Tricks menu lists them.
- **Games:** "Play" in the menu has rock, paper, scissors and hide and seek (it tucks itself
  behind an edge of the screen; click it when you spot it).
- **Room:** the bed's corner fills up as achievements come in: rug, plant, lamp, poster, trophy
  shelf, fairy lights. Put things away from the Room menu.
- **Photo album:** a card for every milestone (unlocks, streaks, friendship levels, badges,
  tricks), with what it was wearing that day.
- **Looks:** it brightens a little at each friendship level, blushes from "good friend", and
  sparkles at "best friend".
- **The week:** "How was this week?" shows a bar chart; it also offers it on Sunday evenings.
- **Reminders:** water, posture and eye breaks, each on its own timer in `config.json`
  (`waterMinutes`, `postureMinutes`, `eyeMinutes`; 0 turns one off).
- **Quiet mode:** small and silent. Turn it on from the menu, set `quietStart`/`quietEnd` hours
  in the config, or let it happen by itself in fullscreen apps and on calls (Windows only).
- **Typing along (Windows only):** it bobs when keys go down, cheers a fast burst, and stays up
  while you type. It is told only *that* something was pressed, never what.
- **Noticing things (Windows only):** remarks when you switch to an editor, browser, game, music
  and so on, when you hop between windows a lot, when you come back after a while, when a
  screen is plugged in, when it is 2am.
- **Growing up:** it starts as a baby (small, round, big-eyed, baby talk), and becomes a kid, a
  teenager and a grown-up at 25, 150 and 500 finished tasks (`growAt` in the config).
- **A name:** "Give it a name…" in the menu. It uses it, and has opinions if you keep changing it.
- **Teaching it:** "Teach it → A new phrase…" adds something to what it says. Start with a mood
  ("happy: woohoo", "grumpy: bah") for a phrase it only uses in that mood.
- **High fives:** when a task finishes an arm stays up for three seconds. Click the arm; the
  first second is a perfect one.
- **Sulking:** when it is grumpy it turns its back, and pets from behind are refused. Bring the
  cursor round to the side it is facing and wait a moment. It may turn away once first.
- **Permission sign:** when Claude asks permission it holds up a sign with the command or file,
  until the request is answered. Click the sign to jump to that session. It never answers for you.
- **Birthdays:** it remembers the day you first ran it: a party every year, and a small one each
  month.
- **Gifts:** a best friend gets a present every few days (a drawing, a poem, a shiny pixel).
  Click to open it; it is kept in the album either way.
- **Friends:** "Friends → Copy my code" puts a short code like `BUD-2413-Pip` on the clipboard.
  It holds only the colour, hat, age, personality and name. Paste a friend's code with "Add a
  friend's code…" and their buddy drops by to chat now and then. Nothing goes over the network;
  the code is all there is.
- **Hurt:** poke it dizzy over and over, throw it while it is upset or slam it into the floor
  and it stops being grumpy and gets hurt: small, drooping, in tears. It flinches and backs
  away from a fast cursor, pokes no longer count as friendship, and if you keep going it loses
  some and takes itself off to bed. It barely fades by itself; gentle pets or a snack (its
  favourite, best of all) put it right. Left unmended, it is wary the next day, and the album
  gets a "bad day" card.
- **Teenage phase:** as a teenager it answers back: eye rolls, "whatever", tricks and flips
  refused, bedtime ignored. Less of it the better friends you are, and it sometimes says sorry.
- **Starting things:** every so often, when you are around, it begins: a tap on the glass if you
  have ignored it, an invitation to a game (click it to accept), or a question with two buttons.
  It remembers your answers and brings them up later.
- **Comforting you:** five failures in a row, three red test runs, a task that fought back, or
  three hours without stopping: it stops fretting about the code and gives you a hug instead.
- **Secrets:** each friendship level unlocks things it will only tell a friend, one a day at
  most, kept in the album. Good friends also hear what it dreamt about in the morning.
- **Menu toggles:** sound, quiet mode, reminders, typing along, noticing, curious wandering,
  gravity, sit on windows, start with Windows, hide/show.
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
- On Windows a small PowerShell helper runs alongside. Besides window positions it reports three
  things: the moment a key, click or scroll happens (not which), whether the window in front
  fills the screen, and the program name of that window, which is turned into a category such
  as "browser" before the buddy sees it. It also checks the registry flag Windows keeps for "a
  microphone is in use". Window titles, keystrokes and file contents are never read, and nothing
  leaves the machine. "Bob along when I type" and "Notice what I'm doing" in the menu turn the
  reactions off.

## License

MIT. See `LICENSE`.
