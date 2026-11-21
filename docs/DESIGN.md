# Atelier interface design (the rules every view follows)

Written 2026-11-04 by the architect after the first interface review. The studio is a tool
you spend hours in: it should read like a well-set page, not like a dashboard of boxes.
When a rule here and an existing screen disagree, the screen changes.

## 1. What "good" looks like

- **Quiet surfaces, strong hierarchy.** One page title, one primary action, everything else
  recedes. Whitespace and hairlines separate groups; bordered cards are reserved for things
  you pick from (sessions, versions, projects). Never nest a card in a card.
- **Say it once.** An explanation lives where the choice is made (a dialog, a tooltip, an
  empty state), never repeated in headers, cards and footers.
- **Words over badges.** Kinds, backends and modes are plain text. A chip is only for a
  state that changes over time (Working, Ready to try, Needs your input, Paused, unsaved).
- **Numbers belong in one place.** Per-turn and per-version metadata is one muted line in
  a fixed order, not a scattering of tags.
- **Nothing decorative.** No icon without a job, no gradient, no emoji, no "✨". Motion ≤ 160 ms
  and only for appearing/disappearing elements.

## 2. Type and spacing

- Font: Inter / Segoe UI; mono (Cascadia, Consolas) only for paths, ids, commands, code.
- Scale (px / weight): page title 18/600 · section heading 14/600 · body 14/400 · meta 12.5/400
  · overline 11/600 uppercase, letter-spacing 0.06em, muted (use at most once per column).
- Line length: prose ≤ 72ch. Body line-height 1.5; meta 1.4.
- Spacing on an 8px grid: 8 inside controls, 12 between related items, 16 between groups,
  24 between sections, 32 under the page title. Panels pad 16; dialogs pad 20.
- Color: `--ink` for content, `--ink-2` for secondary labels, `--muted` for meta. Accent only on
  the primary action, links, focus and the selected item. State colors (ok/warn/danger) only on
  the chip or line that carries the state. Backgrounds: `--bg` page, `--panel` for the rail,
  dialogs and the terminal/transcript surface; `--panel-2` for hover and selected rows.
- Hairlines: `--line` 1px; never two hairlines in a row (a header border next to a card border).

## 3. Components (one style each)

- **Button**: primary (accent fill) once per view; secondary (hairline, transparent); quiet
  (text only, used in rows and toolbars). Height 32, padding 0 12, radius 6. Icon only when it
  replaces a word everyone knows (close, search, more).
- **Chip**: 11/600, 20px tall, radius 10, soft background; states only (see §1).
- **Row** (list item): 36–44px tall, title in `--ink`, meta line in `--muted`, selected row uses
  `--panel-2` and a 2px accent bar on the left; hover `--panel-2`.
- **Field**: label 12.5 `--ink-2` above the control, help text below in `--muted`, 32px controls,
  radius 6; one column by default, two columns only for short related fields.
- **Segmented control** for 2–4 mutually exclusive modes (Chat | Terminal; This project |
  Studio | All).
- **Dialog**: title 16/600, body, actions right-aligned (Cancel quiet, confirm primary);
  width 480 (forms) or 720 (compare); the side-by-side overlay is not a dialog.
- **Empty state**: one sentence, one action, no illustration.
- **Toast**: one line, 4 s, bottom-left; errors stay until dismissed.
- **Transcript turn**: a 64px label column (You / Claude Code / API / Command, `--ink-2`) and the
  content column; no bubbles; the meta line sits under the content in `--muted`:
  `claude-opus-5-5 · 4.1 s · 2 in / 251 out · covered by your Claude Code plan`.
- **Terminal**: fills its pane edge to edge on `--code-bg`; tabs above in the row style;
  toolbar: New terminal · Start Claude Code · Task list, quiet buttons.

## 4. Structure and names (human first)

Top navigation, in this order, with keys 1–8:
`Workbench · Learning · Inspiration · Claude Code · Tasks · Memory · Budget · Settings`
(Learning, added 2026-11-08, is section 9: the Companion's lessons beside the same conversation. Inspiration, added
2026-11-13, is section 10: the project's board of design references; its second part, Fixed rules, is section 11,
its third, References, section 13, and its fourth, the Visualizer, section 14.)
("Claude Code" is the former Console: Chat and Terminal modes. "Memory" is the former
Knowledge. "Budget" is the former Usage.)

Left rail (always): the project switcher as a list (name, kind as plain text, last opened),
"New project", and nothing else. The current piece, next release, unresolved questions and
project identity move to the Workbench's right panel as a segmented view:
`Task | Focus` (Task = the composer that hands work to Claude Code; Focus = current piece,
next release, unresolved, identity, each editable in place). The panel collapses as before.

Workbench toolbar: Try · Keep version · Compare · Side by side · Restore · Build/Export, as
quiet buttons with the version pill on the left; the dock tabs read Play · Tuning · Audio.

Claude Code section: a segmented `Chat | Terminal` at the top left, the scope segmented
control next to it, then the list (sessions or terminals) on the left (280px) and the
transcript/terminal on the right. Backend choice happens in "New session" (with the one-line
account statement per backend), not as three cards on every visit. The header above the
transcript is one line: `Atelier (studio) · Claude Code · claude-opus-5-5 · plan`.

Tasks: a plain list grouped by state (Needs your input, Working, Ready to try, Ready for
Claude Code, Done), each row: title, project, when; details open in place.

Memory: one list with a search field, a kind filter and the explicit/verified/inferred
state as a chip; the edit form in a dialog.

Budget: the three numbers that matter at the top (spent this cycle, live ceiling, observed
balance and when it was observed), then the ledger as a table.

Settings: sections with overlines: Connected accounts · Appearance · Layout · API key · Console ·
Devices · This machine · Data locations; each a short form. (Appearance, since 2026-11-13, is the person's
own look, section 12; the layout preferences it used to hold are Layout.)

## 5. Checklist before a screen is done

1. Only one primary button visible.
2. No sentence appears twice on the screen.
3. No chip that is not a state.
4. Tab order follows reading order; every control has a visible focus ring.
5. Looks right at 1280×720 and at 1000×700; light and dark.
6. Nothing in the screen depends on a sentence the person must read to understand a control.

## 6. Decisions made while applying this (interface pass t_l3c31t9u3c)

Where the screens needed a choice the rules above did not make, or a rule did not fit:

- **Transcript label column is 80px, not 64px.** "Claude Code" at 12.5px does not fit in 64px
  without wrapping; 80px keeps every label on one line.
- **Small buttons are 28px** (`.btn.sm`) inside rows, panel bars and table cells; every other
  button is 32px.
- **Workbench toolbar**: text-only quiet buttons in the order Try · Keep version · Compare ·
  Side by side · Restore · Build/Export; the version pill shows `#n label` (its state is in the
  tooltip and the Versions drawer) and shrinks with an ellipsis so the toolbar stays one line;
  "N files changed" appears only when the tree is dirty.
- **The top bar has no project select**: the left rail is the project switcher. The status
  chip is hidden when nothing is waiting ("idle" is the absence of a state, not a state).
- **New project is a dialog** (New | Import a folder) opened from the rail; Settings no longer
  carries project creation.
- **Memory** has three segments, Records · Decisions · Resources, and a Briefing button in the
  page head. Add memory, Record a decision and Correct are dialogs.
- **Settings** uses one overline per section (the Settings rule wins over "once per column").
  The model-participation evidence moved under Console as a "Models seen in local Claude Code
  logs" disclosure.
- **Tasks** groups also include Interrupted and Draft when present; Done and Cancelled are
  collapsed by default (open state kept for the session).
- **States that got a chip**: task status, Working (a session answering), Exited (terminal),
  unsaved / applied / ignored (tuning), Connected / Not reporting (preview link), Verified
  (version), Paused and Not configured (budget, utility), memory and resource states, and
  "runs anything" when a session uses bypassPermissions.
- **Destructive confirms** use a filled red button inside dialogs (quiet red elsewhere); the
  dismiss button says what it keeps ("Keep it") when "Cancel" would be ambiguous.
- **Dock tabs**: Play (game), Tuning (action), Audio (audio), Devices (web-app).
- **Claude Code list** shows sessions of every backend; the backend is plain text in each row's
  meta line (the old backend filter cards are gone).
- **Per-turn meta line** keeps the list price in parentheses after "covered by your Claude Code
  plan", since it is the only cost evidence a plan turn has.
- **Side by side** has no footer Close button: the overlay closes with its × or Esc.
- **Version states** keep their record ids; people see labels with one-line meanings
  (experiment = trying something, kept (`selected`) = worth keeping, integrated = part of the
  main line, released = given to people). The star is "Preferred: the version you would ship
  today"; a second star beside the version pill names the preferred version when it is not
  the current one.
- **Versions drawer** uses a fixed table layout: origin and age sit under the label, row
  actions wrap rather than widen the table, so it never scrolls sideways at 1280×720.
- **Side by side** collapses the dock while open (restored on close) and starts with
  "File differences" closed, so both previews get the height.
- **Build/Export** asks first: "Readiness checklist: n of m met" and its items; the confirm reads
  "Export anyway" while items are open.

## 7. Reference: the studio concept the person gave (2026-11-06)

`docs/design/inspiration/2026-11-06-gather-studio-concept.png` is a concept screen the person
handed over with "make it look less AI, like this". It draws on Claude's agent view (attention and
session navigation), Linear's agent lifecycle (explicit states) and LangSmith's trajectories
(readable activity with deeper inspection). What the Workbench takes from it, and what it does not:

- **A page list with numbers and an "On this screen" tree.** Pages read `Welcome 01`, `Home 02`;
  under the open page its parts (Header, Categories, Event grid, Navigation) are a tree, and the
  selected part is outlined on the preview with a small label ("Event grid selected"). This is the
  Page panel: parts come from the page's real elements, selection is Point mode made persistent.
- **A device frame with an honest line.** The preview sits in a device frame with a picker, Select and
  Focus tools, and a footer that says "Preview draft / not yet verified". Our footer says what the
  studio knows: the version, the width, verified or not.
- **A task inspector with a trajectory.** The right column shows the running task, who runs it, one
  sentence of intent, then an Activity list: time, verb, file (`00:19 Matched the existing spacing ·
  Read · theme.ts`). Every row opens the full tool result. This is the Task tab fed by the session's
  events; the verbs are the session's own notes, never invented.
- **A run timeline.** Agents or tasks as rows, bars across time, dependencies written as words
  ("Waiting for Interface + Data"), a Latest action column. This is the Working now strip, drawn from
  real sessions, builds and devices; "Play example / Step" are for simulated runs and are not built.
- **Claude Code at the bottom with Split.** Chat on the left with the selected part attached as a chip
  (`Home / Event grid / iPhone`) and "Refine the selected part…" as the prompt; the agent's output on
  the right. This is the companion dock tab: pins attach to the message, the split shows the session.
- **The look.** Warm dark surfaces, one serif display face for the product's own words, small-caps
  section labels, numbers as counters, no coloured chips except a dot for live. Status lines in plain
  words ("Example data / no agents connected"). Keep sections 1 to 4 above; this is how they look when
  they are done well.
- **Explicit states, named.** Working, Queued, Waiting for X, Done, Needs you: one word each, the
  reason beside it, following Linear's agent lifecycle rather than spinners.

## 8. The Workbench after the reference (2026-11-07)

The person put the reference beside the studio and said it did not look like it: the pieces were there, the
composition and the look were not. This section is the composition now, in the reference's terms; where it and
sections 1 to 6 disagree, this section wins on the Workbench.

**The look.** Warm charcoal surfaces (`--bg` the canvas, `--panel` a step up, hairlines a step above), warm
off-white ink, amber as the one accent (the primary button, the selected row's bar, focus). A serif display face
(`--serif`) for a task's title in the inspector and for the product's own words; everything else in the sans. A state
is a word with a dot in the state's colour (`.chip`), never a filled badge. Numbers as muted counters (`01`, `11
pages`), small grey overlines for section names, thin separators, no coloured chips, the live dot the one colour that
means "now".

**The shell.** The top bar: the mark and "Atelier", the project picker (a select of every project with its kind in
plain words beside it and the live dot before a working project), the status words, the theme and help buttons. The
view row under it: Workbench · Learning · Inspiration · Claude Code · Tasks · Memory · Budget · Settings as tabs (the current one on a soft
panel), and at the right the version pill (`#n label`, the changed-files count, the preferred star). The left rail is
out of the layout (still rendered, never shown: scripts read it); `[` focuses the picker.

**The Workbench**, top to bottom, left to right:
- *The left column* (`aside.wb-left`): "Project · n pages", then the Page panel in a dock of its own with no tab row
  (pages numbered, the shown one marked; "On this screen" with the parts and Point; the aura), then "Last version":
  the newest version as a line with a check and **Compare with the files on disk**.
- *The stage* (`section.wb-stage`): a head row with the device (Desktop · Mobile; Phone only with the studio setting
  `ui.phonePanel`, since development happens in the Mobile frame and the emulator is for the test before a launch), **Select** (Point on the
  page), **Expand** (only the preview; `f`; the reference's Focus, named apart from the panel's Focus view), and at the right **Try** and **More** (Keep version, Compare, Side by
  side, Restore, Build/Export); a line above the frame, `<page> / <device>` left and the version right (`#94 · 3
  files changed`, `Viewing #4`, `Not at a kept version`); the preview in a rounded frame on a dotted canvas (a bezel
  at a device width; with the device set to Phone the phone's own screen stands in the middle and the page's frame
  steps out of sight); a line under it: what the preview shows and whether it is verified, and the selected part.
- *The task inspector* (the right panel, `components/task-inspector.js`): "Task inspector" with the task's state as a
  word and a dot; `<project> / task <id>` and the elapsed time while it runs; the title in the serif; who runs it;
  the intent; Activity | Output; **Follow run** · **Ask Claude**. The task in focus is the one a session runs now,
  else the one whose row was opened, else the newest. Under it "Tasks · n" as rows, and the composer behind **New
  task**. **Focus** (the current piece, the release, unresolved, identity) is a button in the head.
- *The timeline* (`components/working-now.js`): `<project> / current run · 2 working, 1 ended this hour`, an axis
  row (Run · the last hour's ticks · Latest action), one row per run with its number, its name and the live dot, a
  bar, and the state over the latest action; a footer sentence. Hidden by default so the preview has the height; More · Show runs under the
  preview brings it back (a studio layout pref), and then it stays on screen, saying so when nothing runs.
- *The band* (the dock): Claude Code · Source · Terminal · the kind's panels · Phone as text tabs, the current one on
  a soft panel, the active panel's words at the right ("Session / <title>"); the grip pulls it tall. The Claude Code
  tab is the thread with the pins and the composer left, the trajectory right, as the reference's split.
- *The version strip* and *the status line* ("Nothing runs now", or the working runs; the studio's version).

**Resizing.** The pages column (its right edge), the task inspector (its left edge) and the timeline (its top edge)
drag, as the band's grip does; the arrow keys move them too; the sizes are layout prefs (Settings · Layout), the
studio default by a drag.

**What was given up.** The project rail (the picker replaces it), the Page tab in the band (it is the left column),
the Phone tab and the phone beside the preview unless `ui.phonePanel` is set (the person works in the Mobile frame),
the toolbar of six buttons (Try and More), the Task | Focus segmented control (Focus is a button), the Working now
row that came and went (the timeline stays). The twenty answers of 2026-11-06 stand where the reference does not say
otherwise: the phone beside the preview on wide windows stays as the default (Phone in the device picker puts it in
the middle), the version strip stays, panels still drag to arrange.

## 9. Learning (2026-11-08, t_3b4zpsazku)

The person's words: "a separate tab called learning and this same claude session persists over there just the main
display changes to a learning display where you can teach me in a visual way what we are going to be implementing".

**Where.** The second tab, right after the Workbench (key 2). The main area holds the shelf and the display, with
the Companion in a dock under the display; the right panel stays beside it all, as on the Workbench. (Until
t_391f0z2rhl the Companion was a right-hand column and the right panel was hidden here; the person asked for the
Processes tab back and the Companion "to the bottom as the dock style like we had before".)

- *The shelf* (216 px, 172 px under 1100 px): the overline `Lessons` with the count, then one row per lesson, the
  latest written first: the title (two lines at most) and `topic · when`. The open one sits on a soft panel with
  the accent edge, as a selected pin card. Delete is a quiet trash button that shows on hover or keyboard focus and
  asks first.
- *The display*: a one-line head (the title in the serif, then `topic · written <when>`, and at the right the right
  panel's button when that panel is hidden: the sidebar icon, or `Panel` under 1100 px, as on the Workbench's
  toolbar), the lesson filling the rest, and, when the lesson has steps, a footer row: `Step n of N`, one dot per step
  (the current one filled with the accent; each a button), Back and Next at the right (Next is the view's one primary
  button). The footer sits above the dock, so paging never hides under it; the lesson keeps at least 120 px.
- *The dock* under the display: the Workbench's dock itself with one tab, `Claude Code`, the session's words at the
  right of the tab row, the chevron that hides it, and the grip on its top edge (drag, Up and Down arrows; double-click
  for the default). Inside, the Workbench's own Claude Code panel, not a copy, on the same session: thread and pins on
  the left, trajectory on the right, stacked under 760 px. No Page, Source or Terminal tab, no dragging tabs here. Its
  height is its own (pulling it here does not move the Workbench's dock, whose stage is the preview).
- *The right panel* (Task inspector, Processes, Skills, Focus) exactly as on the Workbench: the same tabs, the same
  width, `]` hides and shows it, and under 1100 px it opens over the page from the top with its own close.
- *Empty*: one line, "Lessons appear here when you ask the Companion to teach you something."

**The lesson's look.** A lesson renders on the studio's canvas with the studio's tokens (read from the window, so
the theme follows): text at 15/1.6 in 76 characters at most, h1 in the serif, code on the code background. Built-in
styles a lesson uses by class (documented in client/components/lesson-frame.js and in atelier_show_lesson's
description):

- `ol.steps > li.step` — steps on panels, paged one at a time once the page has any; each is headed
  `STEP n OF N` as an overline.
- `figure.diagram` with an inline SVG and a `figcaption` — a panel with the caption muted under the drawing;
  SVG text without its own fill takes the ink.
- `aside.callout` — a note with the accent edge on the soft accent; `warn` (danger edge) and `ok` (ok edge).
- `dl.terms` — terms in the ink, meanings in ink-2, in two columns.
- `div.flow` of `div.box` and `span.arrow` — boxes on panel-2 with a hairline, arrows as a line with a head; an
  arrow's `data-label` sits on the line and the arrow is as wide as its words; `box accent` marks one box,
  `<small>` in a box is its second line (a file name, say); `flow down` stacks it.

**Ask about this.** Selecting text in a lesson, or pressing a figure (Enter on a focused figure too), shows one small
accent button under the selection or in the figure's corner; pressing it puts `About "<quote>" in the lesson
"<title>": ` in the Companion box in the dock (a hidden dock opens first), after anything already typed, with the
focus there. Nothing is sent. Motion stays
under 160 ms (a step comes in with a 140 ms rise; none with reduced motion).

## 10. Inspiration (2026-11-13, t_dfs23bojle)

The person is shaping the studio for people who build by feel, and the first piece is a place to collect what they
like: each project has a board of references that briefs and the Companion read (ARCHITECTURE.md section 22).

**Where.** The third tab, after Learning (key 3). The whole main area, no right panel: a board wants the width.

- *The head*: the page title `Inspiration`, then `<project> · n cards` in the meta style (with a filter:
  `<project> · 2 of 6 cards · layout`), and at the right the one field that adds. Its placeholder says what it takes
  (`Paste a link, a hex color or a few words…`) and the primary button says what it would make: `Add`, `Add link`,
  `Add color`, `Add note`. Beside it **Choose images**, a secondary button. Add is the view's one primary button.
- *The bar* under it, always there so the board never jumps: at the left the tags in use as plain words with their
  counts, `All` first, the chosen one on a soft panel as the view tabs are (tags are words, never chips); at the right,
  in the meta style, the words of the moment: what is on its way (`Fetching the preview of linear.app…` with the
  spinner), where a drop would go, how the eyedropper is used.
- *The board*: cards packed by height in columns of at least 280 px (4 at 1280 px, 6 at 1920 px), 16 px between
  columns and 14 to 18 px under a card, in board order, which is also the tab order. A new card comes first.
- *Empty*: one sentence in the middle, "Nothing collected yet. Drop or paste an image, a link, a hex color or a few
  words anywhere here." No second button: the head's controls are in sight.

**A card** is one style for the four kinds: the panel surface, a hairline, radius 8, 12 px inside. Three levels of
words: what it is in the ink (a link's title at 14/500 in two lines at most, a note's text, a color's hex in the
mono), why the person likes it in ink-2, and the tags and a link's site in the muted meta style, tags joined by a
middle dot.
- An image runs to the card's edges at its own ratio (the frame is sized from the recorded size, so nothing jumps
  when it loads); with no why and no tags the picture is the whole card.
- A link has its preview image on top when the page gave one; when it gave none the meta line says why
  (`linear.app · No preview: the page answered 403`). The title is a real link that opens in a new tab.
- A color is a 96 px swatch over its hex (press to copy) and its name; a hairline inside the swatch keeps a color
  close to the surface visible.
- The actions wait until the card is pointed at or holds the focus (always shown where nothing can hover): a small
  bar in the top right corner on panel-3 with **Pick color** (a word, on a card with an image), Edit and Remove as the
  pencil and the bin with their titles.

**Hands.** A drop or a paste works anywhere on the view. While a file or a link is dragged over it, the board gets a
2 px accent outline and the bar says `Drop to add to <project>'s board`. A card is dragged onto another to move it: the
dragged card dims to 40%, and a 2 px accent line stands in the gap on the side it would land. By keyboard the focused
card moves with Alt and an arrow, with the move said in a live region; Enter edits; Delete removes. Remove asks once,
with the red confirm and `Keep it`.

**The eyedropper.** Pick color puts the image under a crosshair: a white ring edged in black marks the point and a
small readout beside it shows the swatch and the hex, flipping sides near an edge. A click or Enter adds the color as
a card behind the image and the picking goes on; the button reads `Done`; Esc or a press elsewhere stops. The arrow
keys move the point (Shift for bigger steps), so it works without a pointer.

**Motion.** Only what appears or changes state moves, within the token (140 ms, none with reduced motion): the
actions' opacity, a card's border colour, the filter's and the tag buttons' background. Hover styles sit behind a
hover media query. Nothing that follows the hand is animated (the eyedropper's mark and readout, the drop line), and
a move by keyboard is instant.

**Edit** is a 480 dialog titled by the kind (`Edit note`): the card's own words first, then `Why I like it`, then
Tags as toggle buttons (the default five, the board's own, this card's) with a field for a new one and a line saying
how many fit. A refusal stays in the dialog as the server's sentence.

## 11. Fixed rules (2026-11-13, t_coydia7ucq)

The person's words: "some things that must stay the same". Beside what they like (the board), each project keeps what
may not change: a short list of rules that every worker gets (ARCHITECTURE.md section 23). Everything else stays free.

**Where.** A second part of the Inspiration view, not a tab of its own: a segmented control beside the page title,
`Board | Fixed rules 12` (section 3: two exclusive modes; the number is a muted counter). What you like and what must
stay are the two sides of one look, so they share a page and a key, and the view row does not grow by a tab for each
of the pieces still to come. The part has its own address (`#/inspiration/rules`), so a reload stays on it; key 3 and
the tab open the board.

- *The head*: the page title, the switch, then `<project> · 12 rules · 4 locked tokens` in the meta style, and at the
  right **Add rule**, the one primary button while the rules are shown. The board's field, its Add and Choose images
  are out of sight then, and so is the bar of tags; coming back to the board brings them back.
- *The list*: the rules by kind, in the kinds' order (Color, Type, Layout, Motion, Tone, Behaviour). Each kind is an
  overline with its count, a hairline, then its rules with a hairline between them: no cards, since a rule is read,
  not picked from. Columns of at least 420 px keep a rule's line near 72 characters: two columns at 1280 px, three at
  1920 px, never more; 48 px between columns, 32 px under a kind. A kind is never cut between two columns.
- *A rule* is three levels of words. The sentence in the ink at 14/500. Under it, when it locks a token, one line in
  the meta size: the word `Locks`, a 12 px swatch when the value is a color (with a hairline, so a value close to the
  surface still shows), and the declaration in the mono, `--accent: #d6a455`. Then why, in ink-2 at the meta size.
  The kind and the lock are words, never chips: neither is a state that changes over time.
- *Its actions* are Edit and Remove as the pencil and the bin with their titles, at the right of the row. They keep
  their place (nothing shifts) and wait until the rule is pointed at or holds the focus; always shown where nothing
  can hover.
- *Empty*: "No fixed rules yet. A rule is one thing that must stay the same while everything else changes; Claude is
  told to keep it in every task." No second button: Add rule is in sight.

**Hands.** A rule takes the focus itself, with the ring 4 px off its words: Enter or a double click edits, Delete
removes. Remove asks once, with the red confirm and `Keep it`, in words that say what stops: "Claude will no longer be
told to keep it", and that the lock on its token goes with it. After a removal the focus goes to the next rule.

**The dialog** (480, `Add rule` / `Edit rule`), one column: Rule (two lines; Enter saves), Kind (a select; a new rule
starts on `Choose a kind…`, so none is chosen for the person), Why (optional), then the two short related fields side
by side, Locked token and Its value, both in the mono, with one hint under the pair saying what a lock does. A value
that is a color shows as a swatch inside its field while it is typed. The confirm says what it does (`Add rule`,
`Save`). A refusal stays in the dialog as the server's sentence and the focus goes to the field it is about.

**Motion.** One transition: the actions' opacity, on the token (140 ms, none with reduced motion). Hover styles sit
behind a hover media query.

## 12. Appearance (2026-11-13, t_8ijmo5ji11)

The studio is becoming a station each person makes their own. Sections 1 to 11 say what the studio looks like; this
section says what a person may move, and by how much, without leaving that look (ARCHITECTURE.md section 24). The
fixed rules (section 11) bind the studio's source; the person's look is a layer on top for them only, so a lock never
takes a choice away here (decision row 186, section 15). One line says when the look differs from a locked default.

**What can be chosen, and the scales.** Each choice writes tokens of client/styles.css and nothing else.

| Choice | Steps | What moves |
|---|---|---|
| Accent | any colour that passes AA on the canvas; six presets (Amber, Clay, Rose, Lilac, Sky, Teal) | the primary button, links, the selected item's bar, the focus ring |
| Density | Comfortable (the default) · Compact | button and field 32 → 28, small button and tab 28 → 24, row 40 → 32, top bar 44 → 40, view row 40 → 36, table cell 6 → 3 |
| Text size | Small · Default · Large · Larger | body 13 · 14 · 15 · 16; every other size one step with it; the overline never under 11 |
| Corners | Sharp · Soft (the default) · Round | controls 2 · 6 · 10, cards and panels 3 · 8 · 14, dialogs 4 · 10 · 18 |
| Motion | Normal (the default) · Reduced | 140 ms, or none |

- *The spacing grid does not move.* Compact makes the boxes lower, not the gaps smaller: 8 inside controls, 12, 16,
  24 and 32 stay as section 2 has them (a fixed rule). A dense studio comes from lower rows and bars.
- *One accent, two shades.* A colour is picked in the theme on screen; the other theme gets the nearest shade of the
  same hue that passes on its canvas, as amber has its darker shade in the light theme. The accent stays the one
  accent: state colours (ok, warn, danger) do not follow it.
- *Readable or refused.* An accent needs 4.5:1 against the canvas for text and 3:1 for the focus ring (WCAG AA). A
  colour under that is not taken: the section says the ratio, what it misses, and offers the nearest shade that
  passes. The focus ring is the accent a quarter of the way toward the ink, so it is never the weaker of the two.
- *Motion is on or off.* Section 1's bound (160 ms, only what appears or changes state) is not a choice. Reduced is
  the same as the system's reduced motion, which is honoured whatever is chosen.
- *Not chosen here*: the canvas, the panel, the ink and the display face come from the Studio look (section 15);
  the theme is the top bar's button and Layout. Code in the
  terminal and the lessons' own text keep their sizes.

**The section** is the first in Settings, under the overline `Appearance`, with one muted sentence saying where the
choices live. Each choice is a field in the one field style: its name in the secondary ink at the meta size, the
control, one muted line. The names and the options are plain words, never chips.

- *Accent*: the colour input (44 px wide, as tall as a field), the hex in the mono (11 characters wide), then the
  presets as 24 px swatches 8 px apart with a hairline inside, so a colour close to the surface still shows. The
  chosen one has a 2 px ring in the secondary ink, 2 px off the swatch. Under them `From your Studio look board` with
  the colour cards of the person's Studio look board as the same swatches (never a project's app board). Then one line in the meta size with tabular
  numbers: `#79b3dc is 7.0:1 against the dark canvas (text in the accent needs 4.5:1). The light theme shows #2b73a6.`
- *A refused colour* turns that line into the warning note (section 3: callouts for warnings only) with the
  sentence and one small button, `Use #…`. Nothing on the page changes until a colour passes.
- *Density, Text size, Corners, Motion*: the segmented control, with the default named `Default` only where the
  steps are sizes. No Apply button: a press is the choice.
- *A locked default* disables nothing. Under the intro, in the secondary ink at the meta size, one line when the look
  differs: `Your look sets --accent away from Atelier (studio)'s locked default. Those locks bind the studio's source
  code; your look is a layer on top, for you only.` When the Studio look set the surfaces or the face, a second line
  says so with the quiet button `Open Studio look`.
- *Reset to defaults* is a secondary button under the fields, disabled while every choice is at its default. It
  does not ask: the toast offers Undo.

**Hands.** A press shows on the page at once and keeps the focus where it was. A colour dragged in the picker shows
on the page while it is dragged, as soon as it passes, and is saved when it is let go. A typed hex is taken on
Enter or on leaving the field. Every swatch has its name and hex as its title and its label.

**Motion.** One transition of its own: a swatch's press (transform, on the token). Nothing is added to animate a
change of look: it is a choice being made, and the page should simply be the new look (a control that already eases
its colour, such as a button, eases to the new accent within the token). Hover styles sit behind a hover media query.

## 13. References (2026-11-13, t_yrm68pllr3)

The board holds how things should look and feel; the rules hold what must stay. The reference place holds what to
build from: a docs link, a code snippet or a component pattern to reuse, a prompt that worked, a note
(ARCHITECTURE.md section 25). It is read and copied from, so it is a list, not a board.

**Where.** A third part of the Inspiration view, on the same switch beside the page title: `Board | Fixed rules 12 |
References 5` (section 3 allows two to four exclusive modes; the numbers are muted counters). Its address is
`#/inspiration/references`, so a reload stays on it. The view row does not grow by a tab (section 11's reason).

- *The head*: the page title, the switch, then `<project> · 5 references` in the meta style (filtered: `<project> · 2
  of 5 references · storage · “debounce”`), and at the right **Add reference**, the one primary button while the
  references are shown.
- *The bar* under it: the search field (320 px, placeholder `Search titles, text and tags…`) and, beside it, the tags
  in use as plain words with their counts, `All` first, the chosen one on a soft panel as on the board. The bar is
  absent while there is nothing to search.
- *The list*: the entries by kind in the kinds' order (Links, Snippets, Prompts, Notes). Each kind is an overline
  with its count, then its entries with a hairline over each: no cards. Columns of at least 440 px keep a line of
  code near 60 characters and a line of words near 72: two columns at 1280 px, three at 1920 px; 48 px between
  columns, 32 px under a kind, 12 px above and below an entry. An entry is never cut between two columns.
- *Empty*: "No references yet. A reference is something to build from: a docs link, a code snippet, a prompt that
  worked or a note. Claude gets the ones that match a task in its brief." No second button: Add reference is in sight.
  A search or a tag that leaves nothing says so and offers **Show all references**.

**An entry** is three levels of words (the size, the weight and the ink do the work; there is no colour in it but
the link's).
- *Its name* in the ink at 14/500: a link's title, which is the link itself and opens in a new tab, with its site
  under it in the muted meta style (and why, when the page gave no title: `example.com · No preview: the page answered
  403`); a snippet's, a prompt's or a note's title. A note with no title has its own words there, in the ink at 14/400.
- *What it holds*: a snippet's code on the code surface in the mono, 12.5 px at 1.5, with a hairline and radius 6,
  as typed; a long line scrolls inside the box, never the page. Twelve lines show, then a quiet small button, `Show
  all 30 lines` / `Show less`. A prompt's and a note's words in the secondary ink, wrapped as typed, eight lines and
  then `Show all`.
- *The facts* in the meta size, 8 px apart: `Use it for` (the label muted, the words in the secondary ink), then one
  muted line joined by middle dots: a snippet's language and length, the tags, `from <where it came from>`. The kind,
  the language and the tags are words, never chips: none is a state.
- *Its actions* at the right of the name. **Copy** (the copy icon and the word, a small secondary button) stands on
  every prompt and snippet at the row's right edge, always in sight: it is what a prompt is kept for. Edit and Remove
  are the pencil and the bin with their titles, to its left; they keep their place and wait until the entry is
  pointed at or holds the focus (always shown where nothing can hover). After a copy a toast says what was copied.

**Hands.** An entry takes the focus itself, with the ring 4 px off its words: Enter or a double click edits, Delete
removes. Remove asks once, with the red confirm and `Keep it`: "Claude will no longer get it in a brief." After a
removal the focus goes to the next entry. A code box that scrolls sideways takes the focus too, so the arrow keys
move it. Esc in the search clears it; typing there never moves the focus.

**The dialog** (`Add reference` / `Edit snippet`), one column. A new entry first says what it is, on a segmented
control of the four kinds with Link chosen (the kind decides the fields, so one is always chosen; an existing entry
keeps its kind and shows no switch). Then the fields of the kind, the first one holding the focus: Address and
Title (optional; its placeholder says the page's own title is used) for a link; Title and Language side by side and
Code in the mono, ten lines, unwrapped, for a snippet, in the 720 dialog; Title and the words for a prompt and a
note in the 480 dialog. Then, for every kind, Use it for (one hint under it saying that these words bring the entry
into a brief), Tags (one field, comma separated, with the project's tags in use under it as toggle buttons, so a tag
has one spelling) and Where it came from. The confirm says what it does (`Add link`, `Add snippet`, `Save`; `Fetching
the title…` while a link's page is asked). A refusal is the server's sentence in the danger note directly over the
buttons, outside the part of the dialog that scrolls, and the focus goes to the field it is about.

**Motion.** One transition: the opacity of Edit and Remove, on the token (140 ms, none with reduced motion). Opening
a long text is instant. Hover styles sit behind a hover media query.

## 14. Visualizer (2026-11-13, t_6kbrrw0jz1)

The board holds what the person likes, the rules what must stay, the references what to build from. The Visualizer
shows what the project's files really hold, beside the first two, so the look that is can be read against the look
that is wanted (ARCHITECTURE.md section 26). It reads; it changes nothing.

**Where.** The fourth part of the Inspiration view, on the same switch: `Board | Fixed rules 12 | References 5 |
Visualizer` (four is the most section 3 gives a segmented control). Its address is `#/inspiration/visualizer`.

- *The head*: the page title, the switch, then `<project> · 5 stylesheets · 36 colours · 22 drifting` in the meta
  style, with `· 1 lock broken` when one is. At the right the refresh icon (**Read the stylesheets again**) and
  **Make it a task**, a secondary button. This part has no primary button: nothing here is the one thing to do, and
  a view that only reads should not shout an action.
- *Two columns that scroll by themselves*, a hairline between them: at the left what the files hold, at the right, 340
  px wide, what the person wants (**Board colours**, then **Fixed rules**), so a rule stays in sight while the values
  scroll. Below 1100 px they are one column and the whole part scrolls.
- *The files line* over the sections: `Read from client/index.html → styles.css views.css …`, each a button into the
  Source tab, then anything not read with why, then one muted line saying what the two drift words mean.
- *A section* is an overline with its count (`COLOUR 36`), 32 px from the next; inside it rows under hairlines or
  plain tiles. No cards: nothing here is picked from.

**A value** is drawn as what it is, then named in three levels of words: its name in the ink (the mono, since it is
code: `--accent`, `12px`, `ease-out`), its value or its custom property in the secondary and muted ink, then its
facts in the meta size: one `file:line` button (`styles.css:16`, in the mono, weight 400, the secondary ink: a link
without a link's colour) and, when it stands in more than one place, a count button (`49 uses` for a custom
property, `28 places` for a written-out value) that opens the list of places.

- *Colour*: swatches 48 px tall with a hairline border (a swatch close to the canvas would otherwise read as nothing),
  in a grid of tiles at least 152 px wide, grouped by use under small subheads: Surfaces, Text, Lines, Effects, Not
  used. A custom property's other values (another theme, a media query) are 12 px chips after its value, not a split
  swatch: on a dark palette a quarter of every swatch in the light theme's white made the palette unreadable. A
  written-out colour that equals a custom property says `same as --bg`.
- *Type*: each family as one line of sample text at 22 px in its own stack, the stack under it in the mono; then the
  scale, one row a size, largest first, the same sample drawn at that size in the page's own family. A size over 48
  px is drawn at 48 and says so; em and % are drawn against the root size and say so; a sum that cannot be worked
  out is listed, not drawn. Web fonts are not loaded here, and one line says so when the page uses any.
- *Spacing*: one row a value, smallest first, a 10 px bar drawn at the value's real width (12px is 12 px wide; cut
  at 160 with a break mark). The length is the datum, so the bar is the value itself, not a share of the largest.
- *Radii*: a 48 px square with that corner. *Motion*: durations as bars on one linear axis ending at the longest
  (a 140 ms transition beside a 2.4 s spinner is as short as it looks), easings as their curve in a 48 px square
  with two hairline axes, a 2 px line.
- Bars and curves are one colour, the secondary ink. Colour here belongs to the project's own swatches and to the
  state dots; marks carry no meaning by colour.

**States are words with a dot** (section 8), never a chip and never colour alone.
- A lock, in the side column and beside the value it locks: `Kept` (the ok dot), `Kept, with another value
  elsewhere` (the warn dot, with what sets the other value: `[data-theme="light"] sets #a86f17`), `Broken` (the
  danger dot: `style.css:21 sets 10px, not 12px`), `Not set in these stylesheets` (the muted dot). Beside a value
  the word is short: `kept`, `broken`.
- Drift is told gently: a hollow dot and the muted ink, `once` and `far`, each with a tooltip saying why. A page of
  warning colours would say the design is wrong; drift is only what to look at.
- A board colour: `In the stylesheets as --accent` (ok), `Closest is --panel, 3.2 away` (muted), `Not in the
  stylesheets; the closest is …` (warn).
- A rule in words is listed under `In words, not checked here` in the meta size: it is beside the values, not judged.

**The dialogs.** A count opens a 720 dialog titled with the value: `Set` (every definition with a 12 px chip, its
scope and declaration in the mono), the lock's sentence, then `Read` or `Written` with every place as `file:line`
and `selector { property }`; a press closes the dialog and opens the Source tab at the line. **Make it a task**
opens a 720 dialog with one hint and the request in a text area, read from its first line; Cancel is quiet, **Create
task** is the dialog's confirm. Nothing is made before it, and the toast that follows offers **Open it**.

**Empty and refusals.** No web entry, or an entry that loads no stylesheet of the project, is one sentence with what
was left out and why. No colour card: one sentence and **Open the board**. No rule: one sentence and **Open Fixed
rules**. A record that cannot be read says so instead of reading as none.

**Motion.** None: this part has no transition and no animation. The project's motion is drawn, not played.

## 15. Studio look (2026-11-15, t_bh07hvllso)

Two kinds of inspiration, never mixed (ARCHITECTURE.md section 27). A project's board is for its app: its workers read
it. The Studio look is the person's own board for the studio itself: it restyles the studio for them, on this
computer, and nobody else reads it.

**The scopes are said before anything else.** The Inspiration head reads `Inspiration`, then a muted label
`<Project>'s app` before the segmented control Board · Fixed rules · References · Visualizer, then a muted label
`For you` before its own control with one part, Studio look. Two controls with two labels, not one control of five:
the parts of one scope sit together, and the gap between the groups (24 px) is the line between the scopes. The count
names the board on screen (`Studio look · 7 cards`), and the field's placeholder says it adds for the studio's look.

**The board** is the same board, cards and hands as section 10, with its own empty sentence that ends `Then Make a
look.` Beside it, a 400 px column under a hairline (no card around it), at the reading measure:

- `Studio look` in the display face at the title size, then one sentence in the secondary ink: `Restyles the studio
  for you, on this computer. It is not <Project>'s app board, and no worker reads it.` For the studio project, one
  more: its own board is for workers changing the studio's source; this one is only the person's.
- *A proposal*, when one is open, comes next under a hairline: `A look from your board` in the display face, one
  meta line (`For the dark theme, the one on screen, and shown over the studio now. Nothing is kept until Apply.`),
  then one row per choice: the label in the muted ink (96 px), a 16 px swatch with a hairline inside and the value in
  the mono (a face's name set in that face), and under it in the secondary ink where it came from: `from “Color
  #173b3a deep teal”`, `a step up from the canvas`, `made darker from #2f7f79 to pass`, `“garamond” in “Note: …”`.
  A choice the board does not give says so and stays as it is. Then one meta line: `Every text and surface pair
  passes AA: 19 pairs, the lowest muted ink on the selected control at 4.5:1.` Then Apply (primary) and Discard.
- Then the look in effect in one meta line, the lock line when the look differs from a locked default, and Undo
  (only when there is something to undo) and Reset to defaults as secondary buttons.

**One primary action in sight.** On the Studio look, Add is a secondary button and Make a look (in the head) is the
primary; once a proposal is open it reads Make again and Apply is the primary.

**Colour stays readable.** Every text colour (ink, second ink, muted ink, accent) passes 4.5:1 on every surface it
sits on (canvas, panel, raised panel, field, selected control). A board colour that does not is moved in lightness
only as far as it must, and the row says from what. The state colours keep their meaning and move the same way. A
dark theme's canvas stays dark and a light theme's light; a look is made for the theme on screen, and each theme keeps
its own.

**Hands and motion.** The proposal shows over the whole studio the moment it is made, and again when the board or
the theme changes; Discard, leaving the part or the view puts the kept look back. Apply, Undo and Reset each say so
in a toast, and Apply's and Reset's toasts offer Undo; Undo also stays in the column after a reload. No transition of
its own: the page simply becomes the look (controls that already ease their colour do so within the token).

