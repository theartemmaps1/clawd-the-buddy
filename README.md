# Clawd

Clawd is a small pixel creature who lives on your desktop and watches Claude Code work. He
holds a laptop while Claude edits, winces when the tests go red, knits through the slow
commands and wiggles at you when Claude needs an answer. The rest of the time he is just a
pet: you can poke him, feed him files, throw him across the screen, and he remembers how you
treated him.

> **Unofficial fan project.** Not affiliated with, endorsed by, or sponsored by Anthropic.
> "Claude" and "Claude Code" are trademarks of Anthropic. The character is a fan-made pixel
> drawing inspired by Claude Code's mascot; it is not official artwork.

<table>
  <tr>
    <td align="center"><img src="screenshots/hello.png" width="180" alt="Says good morning"><br><sub>Says good morning</sub></td>
    <td align="center"><img src="screenshots/working.png" width="180" alt="Works alongside Claude"><br><sub>Works alongside Claude</sub></td>
    <td align="center"><img src="screenshots/done.png" width="180" alt="Cheers a finished task"><br><sub>Cheers a finished task</sub></td>
    <td align="center"><img src="screenshots/knit.png" width="180" alt="Knits through slow commands"><br><sub>Knits through slow commands</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="screenshots/helpers.png" width="180" alt="Sends a helper out for every subagent"><br><sub>A helper for every subagent</sub></td>
    <td align="center"><img src="screenshots/lucky.png" width="180" alt="Has a lucky hat"><br><sub>Has a lucky hat</sub></td>
    <td align="center"><img src="screenshots/wardrobe.png" width="180" alt="Unlocks hats and colours"><br><sub>Unlocks hats and colours</sub></td>
    <td align="center"><img src="screenshots/question.png" width="180" alt="Asks you things"><br><sub>Asks you things</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="screenshots/hurt.png" width="180" alt="Gets hurt if you are rough"><br><sub>Gets hurt if you are rough</sub></td>
    <td align="center"><img src="screenshots/comfort.png" width="180" alt="Comforts you on a bad run"><br><sub>Comforts you on a bad run</sub></td>
    <td align="center"><img src="screenshots/sulk.png" width="180" alt="Sulks with his back turned"><br><sub>Sulks with his back turned</sub></td>
    <td align="center"><img src="screenshots/sleep.png" width="180" alt="Sleeps, and dreams"><br><sub>Sleeps, and dreams</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="screenshots/baby.png" width="180" alt="Starts out as a baby"><br><sub>Starts out as a baby</sub></td>
    <td align="center"><img src="screenshots/teen.png" width="180" alt="Has a teenage phase"><br><sub>Has a teenage phase</sub></td>
    <td align="center"><img src="screenshots/secret.png" width="180" alt="Tells friends his secrets"><br><sub>Tells friends his secrets</sub></td>
    <td align="center"><img src="screenshots/egg.png" width="180" alt="One day, keeps an egg warm"><br><sub>One day, keeps an egg warm</sub></td>
  </tr>
</table>

On the desktop his window is transparent; these are drawn on a plain background.

## Run it

```bash
npm install
npm start
```

Clawd appears in the bottom-right corner. Drag him wherever you like. Right-click him, or
click the tray icon, for the menu.

Windows note: if `npm start` says Electron failed to install, run
`node node_modules/electron/install.js`. On very new Node versions that script can stop
part-way through unpacking; in that case unzip the downloaded Electron zip from
`%LOCALAPPDATA%\electron\Cache` into `node_modules\electron\dist` and create
`node_modules\electron\path.txt` containing `electron.exe`.

## Connect him to Claude Code

Merge the `"hooks"` block from `claude-settings-hooks.json` into `~/.claude/settings.json`
(or a project's `.claude/settings.json`). If you already have a `"hooks"` section, add the
events to it rather than replacing it. Then start a new Claude Code session.

If you set the hooks up before `PreCompact` was in that file, add that one line too; it is what
lets Clawd shake his head when the context is compacted.

Hooks are HTTP POSTs to `http://127.0.0.1:8787/event`. If Clawd isn't running, the hook fails
quietly and Claude Code carries on. Clawd never returns a decision, so he can't block or
change anything Claude does.

To try him without Claude Code:

```bash
curl -X POST http://127.0.0.1:8787/event -H 'content-type: application/json' \
  -d '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"npm test"}}'

curl -X POST http://127.0.0.1:8787/event -H 'content-type: application/json' \
  -d '{"hook_event_name":"Stop"}'
```

## While Claude works

He picks up whatever suits the job: a laptop while Claude edits, a book while it reads, a
magnifier for searches, a hard hat for commands, a globe for the web. In plan mode there is a
pencil behind his ear and a blueprint in his hands.

He follows the commands too. He cheers when tests pass and winces when they fail, gets nervous
at `rm -rf`, force pushes and the like, plants a flag on a commit, throws a paper plane on a
push and sets off a party popper when a PR is opened. Three failures in a row and he stops
wincing and puts the kettle on.

- **When Claude needs you** he wiggles and chirps. Click him to bring that Claude window to
  the front (Windows only); "Go to Claude" in the menu does the same at any time. A permission
  request goes up on a little sign showing the command or file, so you can decide before you
  switch windows. He never answers for you.
- **Slow commands.** After a minute he sits down and knits, or taps his foot, and stretches
  when the command ends. The knitting is real: ten minutes makes a metre of scarf, and the
  scarf is kept for good. It spills across his room as it grows.
- **Helpers.** Every subagent Claude starts pops out as a tiny helper and hops back in when it
  finishes. Each kind has its own shade and kit: a magnifier for explorers, a pencil for
  planners, a green tick for reviewers and testers, a hard hat for the rest. He says who is
  back and how long they were gone, frets about one that has been out for eight minutes, and
  with three or four out at once he appoints himself management.
- **Several sessions.** With more than one Claude Code session running, each gets a mini on
  the left showing its state; click one to jump to it. If two sessions edit the same file
  within a quarter of an hour he tells you, and their minis glare at each other.
- **Context.** He says when a session's context window is 70%, 85% and 95% full, and shakes
  like a wet dog when the context is compacted. The number comes from the tail of the session
  transcript under `~/.claude`; nothing else is read. He assumes a 200k window, so set
  `contextWindow` to `1000000` in the config if you use a 1M-context model.
- **High fives.** When a task finishes an arm stays up for three seconds. Click the arm; the
  first second is a perfect one.
- **Opinions.** He gets to know each project by its folder name: a favourite where the most
  gets done, one he dreads where the most goes wrong, a welcome back after two weeks away, and
  a wary word for the one file that keeps getting the blame when something fails.
- **Superstitions.** When the same thing is true three times running while tests pass or fail
  (the hat he has on, the day of the week, having just eaten or been petted, sitting on a
  window, the hour), he may decide that is the reason. He holds up to three beliefs. Before a
  test run he puts the lucky hat on by himself, or takes the cursed one off, and the Wardrobe
  menu says which is which. A belief that lets him down five times is quietly dropped.

## Handling him

Click to poke, double-click for a flip, rub to pet, drag to carry, flick to throw. Circle him
quickly with the cursor and he gets dizzy; shake the mouse and he helps you find the pointer.

- **Snacks.** Drag a file or some selected text onto him. Only the file name and size are
  looked at; bigger files are more filling. He loves plain words, sniffs programs
  suspiciously, finds office documents dry, and has one favourite food that you have to
  discover by feeding him.
- **Gravity.** With gravity on he falls, bounces, and lands on the top edges of other windows,
  where he rides along (Windows only).
- **Play.** "Throw a ball" gives you a ball to fling, and he chases it. There is also rock,
  paper, scissors, and hide and seek, where he tucks himself behind an edge of the screen and
  you click him when you spot him.
- **Tricks.** Repeat a gesture five times and he works out what you mean: swipe up through him
  (jump), swipe down (sit), draw a slow circle round him (twirl), rub up and down (dance).
  Each needs a certain friendship level; the Tricks menu lists them.
- **Being rough.** Poke him dizzy over and over, throw him while he is upset or slam him into
  the floor and he stops being grumpy and gets hurt: small, drooping, in tears. He flinches
  from a fast cursor, pokes stop counting as friendship, and if you keep going he loses some
  and takes himself off to bed. It barely fades by itself; gentle pets or a snack (his
  favourite, best of all) put it right. Left unmended, he is wary the next day and the album
  gets a "bad day" card.
- **Sulking.** When he is grumpy he turns his back, and pets from behind are refused. Bring
  the cursor round to the side he is facing and wait a moment. He may turn away once first.

## A mind of his own

He has moods: joyful, grumpy, worried, tired, hungry, lonely and glum, with quicker feelings
on top. He gets scared by dangerous commands and hard throws, embarrassed when he sneezes or
cheers too soon, jealous when you type for ages without a glance at him, bored when he is kept
waiting, and excited, proud and loving when things go well. Each has its own face. He is
sleepy at night, and he cries when things go really badly.

Left alone he reads, juggles (poke him and he drops them), hums, exercises, stargazes in the
evening, or waters a plant that grows with your streak. Asleep, a thought bubble shows
something from the day: a green tick, a bug, a file, a commit, a snack, the ball.

- **He starts things.** Every so often, when you are around, he begins: a tap on the glass if
  you have ignored him, an invitation to a game, or a question with two buttons. He remembers
  your answers and brings them up later.
- **He looks after you.** Five failures in a row, three red test runs, a task that fought
  back, or three hours without stopping: he stops fretting about the code and gives you a hug.
  He also suggests a break after an hour, and gently reminds you about water, posture and your
  eyes (`waterMinutes`, `postureMinutes`, `eyeMinutes` in the config; 0 turns one off).
- **Secrets.** Each friendship level unlocks things he will only tell a friend, one a day at
  most. Good friends also hear what he dreamt about in the morning.
- **Personality.** Cheerful, sarcastic, shy or dramatic, picked from the menu.
- **Noticing things (Windows only).** He remarks when you switch to an editor, a browser, a
  game or some music, when you hop between windows a lot, when you come back after a while,
  when a screen is plugged in, when it is 2am. He also bobs along while you type and cheers a
  fast burst. He is told only *that* a key went down, never which.

## Growing up together

- **Friendship** grows with pets, snacks, play and finished tasks, and cools after days away.
  There are five levels, from stranger to best friend. He brightens a little at each one,
  blushes from "good friend" and sparkles at "best friend". A best friend gets a present every
  few days: a drawing, a poem, a shiny pixel.
- **Growing up.** He starts as a baby (small, round, big-eyed, baby talk) and becomes a kid, a
  teenager and a grown-up at 25, 150 and 500 finished tasks (`growAt` in the config). As a
  teenager he answers back: eye rolls, "whatever", tricks refused, bedtime ignored. Less of
  that the better friends you are, and he sometimes says sorry.
- **A name and a voice.** He is Clawd until you say otherwise: "Give him a name…" in the menu.
  He uses it, and has opinions if you keep changing it. "Teach him → A new phrase…" adds to
  what he says. Start with a mood ("happy: woohoo", "grumpy: bah") for a phrase he only uses
  in that mood.
- **Birthdays.** He remembers the day you first ran him: a party every year, a small one each
  month.
- **Friends.** "Friends → Copy my code" puts a short code like `BUD-2413-Pip` on the
  clipboard. It holds only the colour, hat, age, personality and name. Paste a friend's code
  with "Add a friend's code…" and their Clawd drops by to chat now and then. Nothing goes over
  the network; the code is all there is.
- **Generations.** Long after he has grown up (1500 finished tasks, `eggAt` in the config, 0
  for never) he gets spectacles and an egg turns up. Finished tasks and pets keep the egg
  warm. When it is ready he asks, once a day, whether to hatch it, and nothing happens unless
  you say yes. The little one starts again as a baby without a name. He keeps the scarf, the
  room, the wardrobe, the badges and the album, one trick and one belief, and starts out as a
  friend. The old one goes into the family tree and drops by to visit.

## His things

- **Wardrobe.** Hats and colours unlock at 10, 50, 100, 150, 300, 400, 700, 1000, 1500 and
  2500 finished tasks, and glasses (worn with any hat) at 200. The seasons dress him too: a
  scarf in winter, a flower in spring, sunglasses in summer, a leaf in autumn, plus a Santa
  hat and a pumpkin on their dates. Set `southern` in the config for the other hemisphere.
- **A room.** Turn on "Bed" under Room and drag it where you like; he walks there to sleep.
  The corner fills up as achievements come in: rug, plant, lamp, poster, trophy shelf, fairy
  lights. You can put things away from the Room menu.
- **Photo album.** A card for every milestone (unlocks, streaks, friendship levels, badges,
  tricks, gifts, secrets), with what he was wearing that day.
- **Diary.** Once a day is over he writes a few lines about it in his own voice: what got
  done, what went wrong, whether you were kind to him. "Diary" in the menu opens it. The
  family tree is on the next page.
- **Achievements.** 28 badges, listed in the menu.
- **Sticky note.** "Leave a note…" gives him one thing to remember; click the note to clear
  it.

## Keeping track

- **Today and this week.** "How was today?" reports the day's tasks, failures and longest job.
  "How was this week?" shows a bar chart, and he offers one on Sunday evenings. He counts days
  in a row with something finished.
- **Focus timer.** 25 quiet minutes with an hourglass, then he insists on a break.
- **Quiet mode.** Small and silent. Turn it on from the menu, set `quietStart`/`quietEnd`
  hours in the config, or let it happen by itself in fullscreen apps and on calls (Windows
  only).
- **Sound.** Small chirps for pokes, finished tasks, failures and "Claude needs you".

The menu also has switches for sound, quiet mode, reminders, typing along, noticing, curious
wandering, gravity, sitting on windows, starting with Windows, and hiding him.

## Make him yours

- **`config.json`** holds the timings, thresholds, unlock counts and the main phrase lists.
  Edit it and pick "Reload config.json" from the menu.
- **Look.** The character is plain SVG and CSS in `index.html`. Swap in your own art; states
  are CSS classes on `<body>`: `idle thinking working happy sad alert`.
- **Behaviour.** Event-to-state mapping lives in `renderer.js`.
- **Port.** Set `BUDDY_PORT` (and update the URLs in your hooks).

## Privacy

- The server binds to 127.0.0.1 only. Payloads are capped at 256 KB and only a few fields are
  forwarded to the UI; text is rendered with `textContent`, never as HTML.
- Hook payloads can include commands and file paths, so don't expose this port anywhere else.
- Everything he remembers, including the diary and the names of your project folders, is kept
  in one save file in the app's data folder. Nothing leaves the machine.
- On Windows a small PowerShell helper runs alongside. Besides window positions it reports
  three things: the moment a key, click or scroll happens (not which), whether the window in
  front fills the screen, and the program name of that window, which is turned into a category
  such as "browser" before Clawd sees it. It also checks the registry flag Windows keeps for
  "a microphone is in use". Window titles, keystrokes and file contents are never read.
  "Bob along when I type" and "Notice what I'm doing" in the menu turn the reactions off.

## License

MIT. See `LICENSE`.
