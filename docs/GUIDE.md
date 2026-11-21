# Using Atelier

Atelier is your studio for making apps, sites, games and audio together with Claude. You
shape the result; Claude does the routine engineering; every change is a real file in a real
git repository that you can try, compare, keep or throw away.

## The loop

1. **Start from an inspiration** and name the smallest piece that would make it real.
2. **Make that piece** yourself in the Workbench, or hand it to Claude Code as a task.
3. **Try it** (the preview is the actual project running).
4. **Compare** it with the last version, side by side if it is about feel, and **keep** the
   one you prefer as a version with a note on why.
5. **Add the next piece** and check the combined result.
6. **Build/Export** when a version is worth giving to someone.

Everything else in the studio exists to make one of these steps easier.

## The screen

- **Left: Projects.** One line per product. Click to switch. "New project" starts from a
  template (a one-room game, a notes app, Sound Sketch: four short sound cues to play, tune and render) in its own folder with its own history, or imports
  a folder you already have (a `CLAUDE.md` and a `.studio` folder are added to it). The
  studio itself is listed too, as "Atelier (studio)": you improve the studio through the
  same loop as any product.
- **Top: eight sections**, also on keys 1–8: Workbench · Learning · Inspiration · Claude Code · Tasks · Memory ·
  Budget · Settings. Learning shows the lessons the Companion makes when you ask it to teach you
  something, with the same conversation in the dock under the lesson and the right panel (Tasks, Processes, Skills, Focus) beside it.
  Inspiration is the open project's board of things you like: drop or paste an image anywhere on it, or type a link,
  a hex color or a few words into the field and press Add. Give a card a few tags and a line on why you like it
  (Edit, or Enter on the card), pick colors out of an image with **Pick color**, drag cards into the order you want,
  and filter by tag. Claude Code gets the board with every task (tagged cards first), and the Companion can read it.
  The board is kept in the project's `.studio` folder; it is not part of a version, so Restore never changes it.
  Beside the board, **Fixed rules** (the switch next to the page title) holds what must stay the same in the project's
  design while everything else changes: press **Add rule**, write one sentence, choose its kind (color, type, layout,
  motion, tone, behaviour) and, if you like, why. A rule can also lock a design token: a CSS custom property and the
  value it keeps, such as `--accent` and `#d6a455`. Enter on a rule edits it, Delete removes it after one question.
  Claude Code is told to keep every rule in each task (the brief's "Must stay the same" section) and to ask you rather
  than break one; the Companion reads them too. The studio's own rules started from what docs/DESIGN.md already fixes,
  and they are yours to edit. Like the board, the rules are kept in `.studio` and are not part of a version.
  The third part, **References**, holds what to build from: press **Add reference** and choose a link (paste the
  address; the studio fetches the page's title, and refuses a private or local address), a snippet (a title, a
  language and the code), a prompt (words that worked with Claude, with one **Copy** button) or a note. Give an entry
  a few tags, a line saying what to use it for and, if you like, where it came from. Search reads titles, text and
  tags; the tags in use filter the list. A task whose request names a tag or uses an entry's words gets that entry
  in its brief (tag matches first, at most eight, a short snippet with its code); the Companion searches all of them.
  Enter on an entry edits it, Delete removes it after one question. They are kept in `.studio` too.
  The fourth part, **Visualizer**, draws the design the project really has: it reads the stylesheets the project's
  web entry loads and shows every colour as a swatch (custom properties and written-out colours, grouped by what they
  are used for, with how often), the font families and the sizes as a scale in the real fonts, spacing as bars at
  their real size, radii as corners, durations and easings. Beside them stand the board's colour cards and the fixed
  rules: a rule that locks a token says **Kept**, **Kept, with another value elsewhere** (another theme sets its
  own), **Broken** or **Not set in these stylesheets**. Two quiet marks point at drift: `far` on a colour far from
  every colour on the board, `once` on a value written out in one place only. Every value has a `file:line` button
  that opens the Source tab there, and a count that lists every place. It changes no file; **Make it a task** writes
  a task that tidies the drift, which you read and edit before it is made. After you edit a stylesheet by hand,
  press the refresh button beside it (or come back to the window) to read the files again. At the right: a status chip when something waits for you (for example "API
  paused"), the sun/moon button that switches between dark and light for this browser session
  only (Settings › Layout makes it last), and `?` for Help.
- **Middle: the section you are in.**
- **Right (Workbench only): Task | Focus.** Task hands work to Claude Code. Focus holds what
  you are working on now: the current piece, the next release and the open questions.
  Under Unresolved, what you typed comes first and what Claude Code could not settle is grouped
  by the task that left it; a group of two or more has its own **Resolve all**.
  Focus › Identity › **Remove from studio** takes a project off the list; its folder and
  files stay on disk (Import a folder brings it back, with its name, kind, records, versions and tasks).
  For a project made from a template, Identity also says whether its files still match that
  template: "src and manifest up to date", or which files differ. Only the files under src/ and
  the manifest's cue and readiness lists are compared, so README and your tuning values are not.
  A file that differs may be your own change: press its path to read the diff first.
  **Catch up with the template** creates a task and hands it to Claude Code with the template
  folder readable. Nothing runs until you click it. A project with no record (made before the
  studio recorded this, imported, or blank) reads "Template: not recorded", and a record whose
  template has gone reads "no longer in the studio". Both offer **Set** when the studio has a
  template of the project's kind: pick the one it was made from or the nearest, so Focus can
  compare, or Cancel to leave it as it is.
- **Narrow windows (below 1100 px wide)**: the Task | Focus panel starts closed so the toolbar
  and the Versions drawer keep the whole width. **Panel** at the right of the toolbar (or `]`)
  opens it over the preview; its × or Esc closes it. A one-line hint under the toolbar says so.

## Help

`?` (or the ? button at the top right) opens Help: **Getting started** (the loop in three
sentences and what to do first), **Read the guide** (this page, shown in the studio) and the
keyboard shortcuts.

## Workbench

The preview shows the project as it is on disk right now. Versions and exports contain
files only: notes or data you type into a running app live in the browser, not in the
project, so keeping a version after typing a note records nothing new. A product's own
buttons (for example the notes app's Export/Import) act on that app's data, not on the
project.

- **Try** reloads the preview.
- **Keep version** records the files on disk as a numbered version with a label, a note and a
  state: experiment (trying something), kept (worth keeping), integrated (part of the main
  line), user-tested (other people have tried it), released (given to people), recheck (needs
  another look). When nothing changed on disk since the current version
  the dialog says so and keeps nothing. Versions are git commits with tags; nothing is lost
  when you restore an older one.
- **Compare** shows the file differences between two versions. In a changed line the words
  that differ are highlighted in both the old and the new line.
- **Side by side** runs two versions next to each other with your keys and clicks mirrored to
  both. Use it for movement, timing and feel.
- **Restore** puts a version back on disk. When you have changes on disk that are not kept as
  a version, a safety version "Safety copy before restoring to #n" is kept first.
- **Build/Export** first shows the Readiness checklist ("Readiness checklist: n of m met"; the
  button reads "Export anyway" while items are open), then produces a zip another person can
  run and records the release with its checksum and that count. An export builds the files on
  disk, not the preview: while you try another version the dialog says so and offers
  **Restore #n and export it**, and nothing is restored until you press it. For an audio project the renders
  travel with the export: every `dist/audio/*.wav` goes to `audio/` in the zip, and the Contents
  line says how many ("static copy + 4 rendered files"). They go as they are, whichever tuning
  made them, so render again before exporting if the tuning changed. Other kinds carry no renders.
  The dialog also drafts release notes for you to edit. They follow the exported version's ancestry:
  only versions it descends from since the last release are listed. Explore options made from
  2026-11-04 on branch from their base, so an option not chosen is not an ancestor and is not listed;
  options made before sit in one line (Sound Sketch #5–#10) and are listed when they are ancestors.
  Exporting another option of the explore task that made the last release lists that option alone,
  as a sibling of the release. Exporting the last released version again drafts one line saying so. What you leave there goes
  into the zip as `RELEASE-NOTES.md`, with a heading `# <project>: #n label` and a last line with the
  date and the version sha, and onto the release record. The Focus panel's releases list shows the
  notes on hover.
- **Versions** (key `v` opens it and moves focus into it, Esc closes) lists every version. The star means "preferred: the
  version you would ship today"; when another version than the current one is starred, a star
  beside the version pill says which. **Verify** marks that you tried a version and it works.

### The version strip

Along the bottom of the Workbench, right of the **Versions · n** button, every version is a small
numbered mark, oldest at the left and newest at the right. Marks are spaced by order, not by time:
two versions a minute apart sit as close as two a week apart. The filled mark is the current
version (what the files on disk were kept as); a ring marks the version in the preview when you
are trying another one; a small flag marks a released version and a star the preferred one. Hover
a mark for "#n label · when · state". When the files on disk changed since the current version, a
short dashed stub follows its mark ("the files on disk · changed since #n").

Above the marks, a thin lane of bars: each task that made versions has one bar from its first
version to its last, named by the task. A task that is working or waiting for your answer has a bar
from its base (the last version before it started) to the right edge with a live dot. A task with
no version that is not running has no bar. Bars over the same versions stack, three lanes at most;
the rest are counted as "+n more" at the right, and the Task tab lists them all.

Press a mark (or Enter or Space on it) to open the Versions drawer at that row; the arrow keys
move between marks, Home and End go to the ends. Press a bar to open the Task tab at that task.
With many versions the strip scrolls sideways: the mouse wheel or a drag; a project opens with its
newest versions in view.

### Working now

The runs strip under the preview is hidden, so the preview has that height. To see it, open
**More** in the preview's toolbar and tick **Show runs under the preview**; untick it to hide the
strip again. The choice is kept in the studio's settings, for every project (Settings ·
Layout lists it as "Runs shown under the preview"). With the strip hidden the same runs are
still in the **Processes** tab of the right panel (each run of the last hour as a node, with its
state and latest action), the status line at the bottom says "n working now: <names>", the
project picker shows a dot while something runs, and a task's row in Tasks shows its session's
Activity.

When shown, the strip reads `<project> / current run · n working`, with the names of what runs,
each with its live dot. What counts as running is what the studio
itself started and reports: a Claude Code turn in a Chat or Companion session (named by its task, or
by the session's title), a phone build ("Build and install"), an emulator boot (the AVD's name), a
terminal (the shell's name) and an API utility run (the utility's name). Nothing is guessed.

Each run is a row with its number, the name, the state in a word with its reason
(Working, Waiting for you · the question's first words, Done, Failed · the step that failed,
Stopped · closed or the exit code), a bar from its start to now (or to its end) on the last hour,
and the latest thing it did with how long ago ("Read copy.mjs · 2 min ago", "2 of 3 · gradlew",
"serial up, waiting for boot_completed", "open 4 min"). The hour axis above the bars is the only
clock on the strip; a run that started earlier begins at its left edge. A run that ends stays
listed until the hour passes. With nothing running the strip says so in one line. Drag its top
edge to change its height.

### Who is working where

While a Claude Code session of the open project is working, a faint label sits in the preview's
bottom-right corner with a small live dot: who, what and when, from the session's own tool calls —
"Claude Code · editing welcome.css · 4 s ago", or "Claude Code · running npm run check" for a call
that is not a file edit. When the edited file is one the page in the preview uses (the page itself,
its scripts and styles), the label adds "on this page" and a quiet **Reload the preview** button
appears; the preview never reloads by itself, so you choose when to see the change. When a pin or the
Page or Phone readout on screen links a part of the page to that file, the part gets a soft outline on
the preview. In the Page tab, a page whose file was edited carries a faint dot ("edited by Claude Code
· 10 s ago") until the preview loads again. On the Phone tab the same words sit over the screen's top
edge, and while a build runs they read "Building and installing · step 2 of 3 · gradlew". The label
goes 30 seconds after the last call; a page's dot stays while the run goes on and 30 seconds after it
ends. Only this project's sessions show here, and a project switch clears it all.

The project list on the left shows the same live dot beside a project's name while it has a
working run; hover it to see which. When any run ends, in any project, the status chip in the app
bar names it ("Quick Notes: pwsh Stopped") until you press it or another run ends; pressing it opens
that project's Workbench at the Task tab, or the Phone tab for a build or a boot. The studio
remembers finished runs for 24 hours while it keeps running; after a restart it knows only the
runs since it started.

### Live: the project's own server

Some projects have their own local server that can do more than the preview (save files, open a
terminal). When the project's `atelier.json` declares one under `live`, a **Live** switch sits in the
preview's toolbar with its state: Off, Starting, Running, Failed or Invalid. The first time you
switch it on, the studio shows the exact command and folder it would run and asks you to allow
it; it asks again whenever the command or the folder changes. While it runs, the preview shows the
project's server instead of the files on disk, the line above it says "Live · <label>", and
**Log** shows what the server printed, with its secret token masked. Page, Select, Phone and side
by side still read the files on disk (the Log says so, and Select is greyed out with a tooltip that
says why); there is no line under the preview while Live runs, so the preview has that height. Switch Live off to
go back. It also stops when you open another project, remove the project or quit the studio; it
never restarts by itself. Failed and Invalid say why in the line under the preview.

The contract for a project (docs/ARCHITECTURE.md section 20):
`"live": { "label": "…", "command": ["node", "server.js", "--atelier"], "cwd": "." }`, run without a
shell inside the project; when ready the server prints
`{"atelierLive":1,"url":"http://127.0.0.1:<port>/#k=<token>"}` and should allow the origin in
`ATELIER_FRAME_ORIGIN` as `frame-ancestors`.

Under the preview, the dock:

- **Companion** (every project, the first tab): a Claude Code session on your own login that sees
  the studio through its tools, beside the work instead of in another view. **Start** begins it (the
  model beside it: Opus 5.5, Fable 5.2, Fable 5.1, Sonnet 5.5 or Haiku 5.5); the line above says who answers ("Claude Code · Opus 5.5 ·
  your login"). The thread is on the left, the composer under it: Enter sends, Shift+Enter adds a
  line. Your first message carries a short context block (the project's purpose and direction, the
  page and the files it loads, your pins, the phone in one line); later messages do not, and the
  answer's last line says "with the studio context" when it went. On the right, the trajectory: the
  state in one word with its reason (Idle · no session yet, Working · 00:48 · Edit welcome.mjs,
  Needs you · a question is waiting, Done · 2 min ago) and the run's tool calls as time · what ·
  file; press a result line to read it in full. The companion asks before changing anything, or
  makes a task; it edits files only when you say so in that message. **Make it a task** asks it to
  write the thread up as a studio task (atelier_create_task) and tell you the id; the task waits as
  Ready for you to start, nothing is handed over. **New session** starts over; the old session stays
  in the Claude Code view. **Pins** come from the Phone panel's Point mode (**Pin** under the
  readout) and are listed under the thread as numbered cards; press one to select it, and the next
  message carries it (the chip above the composer names it, and the composer reads "Refine the
  selected part…"). **Remove** drops a pin. When the companion's answer ends on a question, the app
  bar chip reads "needs you" until you answer. On a narrow dock the trajectory sits under the
  thread, folded to its state line; press the line to open it.
- **Codex** (every project, the second tab): a second opinion from the Codex CLI on this computer,
  on the login you saved with `codex login`. The line above says who answers ("Codex · GPT-6-Astra ·
  your ChatGPT login"; it says so if Codex is signed in with an API key instead). Beside it are
  three choices: the model and the effort (they start as your `~/.codex/config.toml` says, and your
  change is kept for the project), and the sandbox. **Sandbox: read-only** is how every session
  starts: Codex reads files and runs commands that change nothing. **Sandbox: may edit files** lets
  it change files in this project's folder; the choice turns amber while it is on, and
  **New session** goes back to read-only. The studio never runs Codex without a sandbox. **Start** begins
  the session; the thread, the composer, **Stop**, the pins and the trajectory work as in the
  Companion tab, and Codex has the same studio tools (it can read the briefing, files and diffs,
  look at the phone and the page, and create tasks). A second message continues the same Codex
  conversation, and the session is there again after a reload. If something stands in the way, one
  sentence says what to do: the Codex CLI was not found (install it, or set *Codex path* in
  Settings › Console), Codex is signed out (run `codex login` in a terminal, then **Check again**),
  or Codex refused the model (choose another and send again).
  **Codex as a worker.** The tasks the Companion hands over run in workers: each is a Claude Code
  session by default, and can be a Codex session instead, so that work is spent from your Codex
  login. Choose it in Focus › Identity › **Edit**: **Worker model** (this project) and
  **Studio default** (every project that names none) list the Claude Code models and then Codex's
  ("Codex · GPT-6-Astra"); a Codex model shows a second choice for its effort, where "Effort Codex is
  configured with" leaves what your `~/.codex/config.toml` says. Or ask the Companion ("run this
  task on Codex astra at extra high"): it sets the task's, the project's or the studio's worker
  model to `codex:gpt-6-astra@xhigh` and says what the next worker starts on. Nothing switches by
  itself, and a running worker keeps what it started on. A Codex worker gets the same brief and
  reports through the same commands, and its result is a version to try like any other; the task
  row says "handed to Codex (gpt-6-astra, xhigh effort)" and the version's origin reads Codex.
  Five things are different, and worth knowing before you rely on it. It runs in Codex's own
  sandbox ("may edit files", never wider, and the studio adds no flag that removes it): on this
  computer it could change files in the project's folder, could not write anywhere else, had no
  internet and could not commit, so the studio keeps its version at the moment its turn ends (the
  task row reads "finish recorded" until then). Its commands run under a separate Windows account
  of Codex's, so a tool that needs your own account does not work there: Unity in batch mode found
  no licence, and a Codex worker cannot compile or test a Unity project; it then stops and asks,
  as any worker that is stuck. So for such a project it changes the code, and the checks are run
  afterwards outside the sandbox, by you or by a Claude Code worker on a follow-up task; the
  Companion is told this, and its report on a Codex worker's result says what could not have been
  checked there. It cannot take an explore task (options are versions it could not
  keep); the studio refuses that start and says so. It is not pointed at the skills of the task's
  department, because skills are Claude Code's. And Codex reports no cost, so the usage the
  Companion can read counts Codex's sessions, turns and tokens apart and shows no cost for them. A
  turn is stopped after 90 minutes, like a Claude Code worker's; whatever ends it, the Companion
  gets a report that says so.
- **Page** (every project but audio sketches, right after Companion): the preview's page read in place. On the left,
  the **pages**, numbered ("Home 01", "Events 02"), taken from the page itself: screens marked with `data-screen` or
  `data-page`, else top-level sections with an id, else the one page; other `.html` files beside the entry come after.
  The page on the preview is marked; press another to open it (by its `#name`; a page that does not answer to it says
  "Cannot be opened from here"). Under the pages, **Aura**: one short note on the feel the visible page should give
  (calm, playful, careful); **Save** keeps it for that page, and the companion's first message and a task made from a
  preview pin on that page carry it as "Aura of <page>: <note>". On the right, **On this screen**: the visible page's
  parts (headers, sections, navigation, headings, named groups), two levels deep. Press one to outline it on the
  preview with "<name> selected"; press it again to clear. **Point** turns a click on the preview into a question: the
  click does not reach the page, and the readout shows the element, its text, the page and the files that likely hold
  it (press one to open it at that line in the **Source** tab; **Copy** beside them copies them as `file:line`), with **Pin** (listed in the Companion tab like a phone pin) and
  **Copy for a task**. Esc leaves Point; the Phone's Point mode and this one are never on together. The line at the bottom says what
  you are looking at: "Preview · #4 · 390 px · not verified" (or "files on disk" when they differ from a version).
  When the preview cannot be read (not loaded, or from elsewhere), the tab says so and lists nothing.
- **Source** (every project, right after Page): the project's files, to read beside the preview; nothing here edits
  them. On the left, the folder as a tree (folders open when you press them; `dist` is listed like any other); on the
  right, the chosen file with line numbers, its path above with **Copy path**. A file the Page or Phone readout, an
  Activity row or the companion points at opens here at its line, with that line marked and scrolled into view. A dot
  marks the files (and the folders holding them) changed since the current version, "changed since #n"; when a shown
  file changes on disk the text follows and keeps your place (the tab checks every few seconds while you look at it,
  and when you come back to the window). A file over 400 KB is cut with a line saying so; an image or other binary
  file reads "Not a text file". Keys: the arrows walk the tree (Right opens a folder, Left closes it), Enter opens,
  Tab goes to the text.
- **Terminal** (every project, after Source): this project's real shells, the same ones the Claude Code view's Terminal
  mode lists, under the stage. **Open terminal** starts your shell in the project's folder; the tabs row lists this
  project's terminals only (the studio's own shells stay in the Claude Code view), and the tab counts the ones still
  running. The line above the pane names the folder, the shell and its pid; whatever runs there runs as you. The quick
  actions (Start Claude Code, Task list, Show task) only type into the shell. The pane fits the dock: pull the grip and
  it reflows. When the same shell is open in the Claude Code view too, both show its output and both can type; the line
  says "also open in the Claude Code view", and the pane you resized or opened last sets the shell's size. An exited
  shell keeps its output with Close on its tab; leaving the project closes the pane, not the shell.
- **Play**: what happened while you played (events, jumps, time) and the Readiness checklist
  for the next release.
- **Tuning**: the numbers that shape how the project feels (each field is named after its
  parameter for screen readers too). Change one, **Apply live** to
  see it in the running preview, **Save to file** when it is right, then Keep version. Unsaved
  edits are kept for you as a draft until you Reset or Save. The panel says "applied" only
  when the project confirms it.
- **Audio**: the project's sound cues; trigger one to hear it in the preview. The panel says
  "played" only when the project confirms it, and "sent · no acknowledgement" when the
  project does not confirm cues (older projects need the cue handler). **Render to file** asks
  the running preview, with whatever tuning is applied in it, for that cue as a WAV and saves it
  to `dist/audio/<cue>.wav` in the project, replacing the last render; the row then shows its
  length, peak and size. "sent · no render handler" means the project did not answer (older
  games cannot render). These files are not part of a version and stay through Restore and
  restarts. Build/Export of an audio project puts them in the zip (see Build/Export above).
  Renders on disk are listed whenever the panel opens, so they are still there after a visit to
  another view; a render made at values other than those in the tuning file says "rendered at
  other values than the saved tuning", and pressing Save to file at the values you rendered does
  not. A render with no record of its values (from an older project) says "tuning at render
  unknown". A played cue reports its length and level, whether you used Trigger, a key or a
  button, and the row counts them together; when the project says how it was played, the line
  ends with that word. The render is a little longer than the play, because the file carries a
  50 ms tail. The waveform under a render is drawn to the cue's own peak, so a quiet cue still
  fills its height, and its label says so: "0.29 s · drawn to its peak, -19 dB". Height there is
  not loudness; read the number. While Side by side is open, Trigger plays the cue in the main
  preview and in both frames, and the row names every one that answered: "played in main, A, B".
  An audio project's Readiness checklist is here too, below the cue rows.
- **Devices** (web apps): the preview at phone, tablet and desktop widths, and the Readiness
  checklist.
- **Phone** (projects with `android/`, `ios/`, a `capacitor.config.json` or `devices` in atelier.json):
  a real Android emulator or phone driven over adb, never a drawing of one. The chips say what the
  studio found: the tools (adb and the emulator, with the path it looked at when one is missing), the
  device (none, booting, booted with its AVD name), the app (not installed, installed, running) and the
  last build (idle, running, failed or done, with the time). **Boot**, **Build and install**, **Launch**
  and **Stop** are greyed out when the state says they cannot apply; hover one for the reason. While a
  build runs, **Build log** follows it line by line (the last 400 lines) and names the failing step
  and its exit code. The screen beside the controls is a screenshot taken again 300 ms after each one
  arrives, so about 3 frames a second at best and fewer on a slow device; the line under it says
  the rate it measured. It is a series of stills, not video. Click it to tap, drag to swipe; with
  the screen focused, Esc is Back, and Enter, Backspace and the arrow keys go to the phone; the
  field under it types text (plain ASCII). Nothing polls or reloads while the tab is hidden.
  On a window 1440 px or wider the screen moves to the right of the preview, at the preview's full
  height, and stays there whichever tab the dock shows; the Phone tab keeps the buttons, the readout
  and the line "The screen is beside the preview". Taps, keys and Point mode work on it there as in
  the tab. Narrower than about 1416 px it comes back into the tab (the gap keeps a window on the edge
  from flipping). Untick **Beside the preview** in the Phone tab to keep the screen in the tab at
  every width; the choice is kept per project.
  **Point mode** turns a tap into a question instead: the panel shows the element under it (tag,
  id, classes), its text, the page address and the project lines that likely hold it; pressing a
  file opens it at that line in the **Source** tab, **Copy** beside them copies them all as `file:line`, and **Copy for a task** copies the point, the element and the first three
  files as one block to paste into a task; **Pin** keeps the point for the Companion tab, where it is
  listed under the thread and can ride a message. A native screen, or an app with no debuggable WebView,
  answers "Nothing found" in those words. Esc leaves Point mode. When the project is set up for
  iOS, one line gives the iPhone simulator's status and why it cannot run here (it needs a Mac);
  there is no iPhone screen and no buttons for it.

The chevron at the right of the dock tabs hides and shows the dock; clicking the tab that is
already open keeps it open. The dock opens on the tab you last used in that project. Drag the top
edge of the tab row (the short bar) to make the dock taller or shorter, from 180 px up to all of the
stage but 120 px of preview; the arrow keys do the same with the bar focused, the height is kept
for the project, and a double-click on the bar gives the default back. Side by side folds away the panel under the dock tabs while it is
open: the tab strip and the Versions bar stay, and clicking a tab opens its panel again. Closing
Side by side puts the dock back as it was.

### Arranging the dock

Drag a dock tab along the tab row to put it where you want it: it lifts once the pointer has moved
a few pixels (a plain click still just opens the tab), a thin line shows where it will land, and
letting go keeps the order for the project. With a tab focused, **Alt+Left** and **Alt+Right** move
it one place and a screen reader hears where it went ("Page moved before Companion").

Drag a tab up onto the preview to put that panel beside it: the strip at the preview's right shows
"Beside the preview" while you are over it, and letting go puts the whole panel there (for the Phone,
its screen, as the **Beside the preview** switch does). The tab gets a small mark, and its place in
the dock says "Page is beside the preview." One panel sits there at a time: a second one dropped on
the preview sends the first back to the dock, and while another panel is there the phone's screen
stays in its tab. To put it back, drag its tab, or the name at the top of the strip, down onto the
dock's tabs, or press **Back to the dock**; **Alt+Up** and **Alt+Down** on a focused tab do the
same. The strip is there on windows 1440 px or wider; on a narrower window the panel goes back into
the dock and returns when the window is wide again, unless you dragged it out yourself.

**Reset arrangement**, at the end of the tab row once something is arranged, puts the default tab
order back and takes the panel you dragged off the preview, with one notice saying so. The Phone
tab's switch is left as you set it, so on a phone project with the switch on the phone's screen
keeps its place beside the preview. Nothing is remounted by any of this: a panel keeps what you
typed, its scroll and its running shells wherever it sits.

In the Task panel, "How to work with you" tells Claude Code which mode you want: teach me
(explain as it goes), explore alternatives with me (options before changes), or handle the
implementation (just do it and report). **Create task on** and the project's name only writes the task down, on the project the button
names; nothing runs until you press Run with Claude Code here on its row. Switching projects puts the mode back on
handle, unless a request you typed is still in the field: then the whole form stays as you left it.

An explore task leaves one version per option and the tradeoffs in the task notes; the choice
stays yours. Each option is made from the version the task started on, and the files on disk are
back on that version when it finishes, so nothing has changed until you try one. Its base is the
version the files are on when you hand the task over, not when you wrote it down, and if those files
have no version yet the studio keeps one first ("Base for …"), which is never counted as an option.
Its row names them all ("produced #5, #6, #7"). If the session left edits on disk when it finished,
they are kept too and named apart ("produced #5, #6 · and a leftover #7"). **Compare side by side**
opens the first and the last option in two live previews, and the A and B menus reach any other
version. **Try it** opens the last option. Star the one you would ship.

## Claude Code

Two modes, one place.

- **Chat** talks to a model about the project or the studio. Choose the backend when you
  start a session:
  - *Claude Code*: runs the `claude` command installed on this machine with your own login.
    Turns count against your Claude Code plan. It reads the project's `CLAUDE.md` and
    briefing itself. Pick the model (Fable or Opus) and the permission mode (plan = read
    only, acceptEdits = may edit files, bypassPermissions = runs anything; use with care).
    **Allow node commands** lets it run the studio's `node … atelier.mjs task …` commands, so
    it can report task progress; without it those calls are refused. A refused call shows as
    an amber "denied" line in the answer, a tool that failed as a red "failed" line. A tool
    result line with ▸ expands (click or Enter) to the full result text; again to collapse.
  - *API*: one bounded turn on your API key, within the budget ceiling. Cheaper, no tools.
  - *Command*: any command line you set in Settings, for example a local model. It runs on
    this computer.
  Every answer ends with a line that says which model answered and what it cost or covered.
- **Terminal** is a real shell on this machine in the project folder. **Start Claude Code**
  composes the command (model, permission mode, continue or resume a session, extra folders,
  optionally a task to work on) and types it for you. The first time Claude Code runs in a
  folder it asks whether to trust it; answer that yourself. Whatever you run here runs as
  you. Terminals are not kept across a studio restart: a terminal open during a restart shows
  that it ended and offers New terminal here. Sessions in Chat are kept.

A Chat session reads the project's briefing when it starts, so a memory change reaches the
next session, not one that is already open.

**Studio tools**, the checkbox beside Allow node commands in New session, gives a Claude Code
session the studio's own tools: it can read the briefing, memory, files, versions and diffs,
look at the project's phone (status, a screenshot, what is under a point), bring this window to
a view, a Workbench panel, Point mode or a file and line (opened in the Source tab, the line
marked), and record work as a new task, an unresolved item, a memory record or a kept
version. Those tools run without asking; none of them pushes, deletes, restores, exports or
spends on the API, and the session is asked to change files through a task or a kept version
unless you asked for an edit. The studio must stay running while the session uses them. A
session with them shows the chip **tools** in its header.

## Tasks

A task is a piece of work handed to Claude Code with everything it needs: your request, the
project, the version it starts from, your preferences, the accepted decisions, the scope and
what "done" means. Its state always comes from evidence, never from a claim:

- **Ready for Claude Code**: written, not started. **Run with Claude Code here** starts a
  headless Claude Code session in Chat (acceptEdits; node, `npm run`, `npm test` and git read
  commands run without asking) that works on the
  task and reports back through the studio; the task shows "Running in Chat" with a link to
  the session. That list is not a sandbox: node is unrestricted, so the session can do anything
  a program you run can, including reading files outside the project. What protects you is that
  it never gets your API key or Claude Code session variables in its environment, that you can
  see every call in the transcript, and that the prompt asks it to stay in the project and not
  commit. **Open in Claude Code** instead opens your own terminal window in the project
  folder with the prompt on the clipboard. Copy command gives the same line to paste anywhere.
- **Working**: Claude Code reported it started. If nothing is heard for 30 minutes it shows
  as interrupted.
- **Needs your input**: Claude Code asked a question. Answer it in the task. If a session had
  already started the task, it shows **Working** again while that session continues with your
  answer; otherwise it is ready for Claude Code again.
- **Ready to try**: finished and checkpointed as a version. **Try it** previews that version
  (when it is exactly what is on disk, the banner says so); **Record the result** records the
  commits, files and decisions and marks the task done, which also closes that banner.
- **Record the result**: finished, but no file changed, so there is no version and nothing to
  try. **Record the result** closes the task.
- **Done** / **Cancelled**. A done task keeps a quiet **Try it** for its version.

**Activity.** A task handed to a Chat session (Run with Claude Code here) has an **Activity** line
on its row, in the Workbench's Task tab and on the Tasks page alike. It is closed until you open it,
except that it opens by itself the first time its session is seen running. Inside: who runs it
("Claude Code · Opus 5.5 · your login"), the task's own title as its intent, the session's state
in one word with its reason (Working · 00:23 · Read copy.mjs, Done · 3 min ago, Needs you · the
question's first words, Failed, Stopped, Idle · not started), then the session's own tool calls,
one row each as time · verb · file; press a result to read it in full, and a file name (on a
row that read or edited a file of the project you have open) to open it in the Source tab. The
time is when in the run the call came. Rows are added as the session works and the line settles when it ends. The
chip on the row stays the task's state; the Activity line is the session's. A task opened in your
own terminal (Open in Claude Code) says the studio does not see that session's tool calls, and a
task no session has run shows no Activity at all.

At the top, **This project | All projects** chooses the scope (kept while the tab is open).
All projects lists the tasks of every registered project, grouped the same way, each row
starting with its project's name. A row of another project offers **Switch to** that project
and Copy command; its other actions appear once that project is the active one.

**New task** (Tasks) opens the Workbench's Task panel with the cursor in Request. The optional
**Acceptance** field takes one condition per line; they become the task's acceptance
conditions in the brief Claude Code reads.

## Memory

What the studio knows about how you like to work: preferences, methods, constraints, decisions,
lessons. Each record says where it came from (your brief, a conversation, an inference) and
whether it is explicit, verified or inferred. Correct a record and the old one is superseded
everywhere, including what Claude Code reads. Delete it and it is gone from both sides.
Nothing here is invented: a new installation starts with no records, and the first ones are
those you add with **Add memory**.

## Budget

Three numbers: what the API utilities spent this cycle, the live ceiling, and the balance you
last observed in the Claude Console (with the date you entered). The studio pauses API
utilities at the ceiling; Claude Code, versions, tasks and memory keep working. Development
never moves to the API by itself.

- **Pause / Resume** (top right) stops or allows API utility runs by hand. While paused the
  page reads "Paused by you" (or "Paused: ceiling reached" when the studio paused at the
  ceiling) and the header chip reads "API paused"; nothing else stops.
- **Run a utility** runs one bounded task (its input as JSON) with a checked JSON result; the
  chip beside it reads "No API key" until a key is saved in Settings.
- **Cycle and balance**: the cycle dates; *In flight* (reserved for running calls); *Active
  allocation* (at most $180 per cycle, lower when the observed balance is lower); *Grant / kept
  back as reserve*. The forms below save the observed balance with its date, and the cycle
  dates with the live ceiling.

## Settings

Open **Connected accounts** and choose **Sign in with Claude Code** or **Sign in with ChatGPT**.
Confirm on the local sign-in page, finish in your provider’s browser window, then return and choose
**Check accounts**. Claude Code supplies the Companion and workers. ChatGPT supplies the Codex tab.
Each CLI saves its own credentials. If a browser does not open, run the command shown on the
confirmation page in your own terminal. An old studio-saved Claude token can be removed here.
Budget utilities still use their separately configured API key.


- **Appearance**: the studio's look for you, on this computer. *Accent* (the colour picker, a hex,
  six presets, or a colour card from the open project's Inspiration board), *Density* (comfortable
  or compact), *Text size* (four steps), *Corners* (sharp, soft or round) and *Motion* (normal or
  reduced; your system's reduced-motion setting is honoured either way). A press shows at once and
  is kept in your studio settings, never in a project. An accent that would be hard to read on the
  canvas is not taken: the line under it says why and offers the nearest shade that passes. A
  choice is greyed out when a fixed rule of the studio project locks one of its design tokens; the
  sentence beside it names the rule, and **Show the rule** opens it. **Reset to defaults** puts
  everything back and offers Undo.
- **Layout**: theme and panel preferences, each applied at a scope: this session, this
  project or the studio default (the most specific wins); Undo puts the previous value back.
- **API key**: stored on this machine, never shown again; **Remove saved key** asks first.
  **Utility model**: the model the Budget utilities use.
- **Console**: *Claude path* (path to the claude command; empty uses the one on PATH),
  *Codex path* (the same for the codex command the Workbench's Codex tab runs),
  *Command* (for the Command backend), *Command mode* (how the message is passed: on standard
  input, or in place of `{prompt}`), *Timeout*, *Terminal font* (empty uses Cascadia Code, then
  Consolas; prompt glyphs need a Nerd Font), and the models that answered in Claude Code on
  this machine, from its logs.
- **This machine** (CPU, memory, GPUs) and **Data locations**.

## A typical hour

Open Room One. Try it. Open Tuning, lower the jump, Apply live, play. Open Side by side against
the last version, play both, decide. Save to file, Keep version "lower jump, feels heavier".
In Task, write "add a dust puff when landing", send it to Claude Code; or open Terminal, Start
Claude Code and ask for it there. When it is ready, Try it, Record the result, Keep. Build/Export when the
release checklist is green.

## Keys

`?` Help · `1`–`6` sections · `t` Try · `k` Keep version · `c` Compare · `s` Side by side
· `v` Versions · `[` `]` collapse the panels · `Esc` closes dialogs and overlays. Tab from the
toolbar reaches a "Skip past the preview" link first, which moves focus to the dock tabs.
Keys typed into a preview belong to the product once you click it; click outside the preview, or
press the Panel button, to get the studio's keys back; a preview that loads never takes the
keyboard by itself.

## What never happens without you

Publishing, posting, store submission, outreach, new paid services, API spending past the
ceiling, any change to how Claude Code is logged in, and starting a project's own live server.
