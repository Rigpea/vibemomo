# Element inventory (the iteration ledger)

One row per element a person meets in the studio. "A person must understand" is the test:
if the element does not make that clear on its own, it is not done. "Status" is the last
verified state; "Next" is the concrete improvement queued or done. Updated as use-case runs
(`docs/evidence/USE-CASES.md`) surface friction.

| Element | Where | A person must understand | Status (2026-11-04, v0.2.0) | Next |
|---------|-------|--------------------------|-----------------------------|------|
| Project list | left rail | which product I am in; how to switch; how to add one | quiet list, kind + last opened, New project dialog | — |
| New project dialog | rail › New project | template vs import; where the folder goes | UC1/UC2/UC11 run 1: works; project kept the template's name; import has no name/kind fields and adds files silently | task t_9xm7i7h57j (name and slug substitution, storage key per project), task t_d7g694x32c (import fields, note, folder picker in the app) |
| Top navigation | top bar | the six places and what each is for | Workbench · Claude Code · Tasks · Memory · Budget · Settings, keys 1–6 | first-run hint (UC16) |
| Version pill | workbench toolbar | which version the working tree is at and whether it changed | `#n label`, state in tooltip, "N files changed" when dirty | — |
| Try | toolbar | reloads the actual project | quiet button, key t | — |
| Keep version | toolbar | records a numbered version; what label and note are for; files only | UC1 run 1: works; UC2: on a clean tree it produced a 409 with no explanation; "selected" state vs the star confused | task t_d7g694x32c (explain a clean tree, disable confirm; state labels with meanings) |
| Compare | toolbar | which files differ between two versions | UC3 run 1: correct, but raw git headers (index, ---/+++) | task t_su1cpknxif (file rows, hidden headers) |
| Side by side | toolbar | two versions playable at once with mirrored input; Esc closes | UC8 run 1: mirroring and Esc work; cramped at 1280×720 with the dock open (games ~200 px) | task t_d7g694x32c (collapse the dock while open) |
| Restore | toolbar | puts a version back; a safety version is kept first | UC7 run 1: OK (safety version created, values back and forth); wording "uncommitted"/"working tree"; long safety label | task t_d7g694x32c (plain words, short safety label) |
| Build/Export | toolbar | produces a runnable zip and a release record; readiness state | UC1/UC2 run 1: zip works (served and used); the dialog never showed the checklist (0/5 met) | task t_d7g694x32c (checklist in the dialog, "Export anyway") |
| Preview | workbench | the project as it is on disk | iframe, head or a version | — |
| Dock: Play | under preview | what happened while playing; readiness checklist | events, jumps, checklist | — |
| Dock: Tuning | under preview | change a number, see it live, save, keep; drafts are kept | UC1 run 1: works; "applied · 1 changed" stayed after Save; clicking the open tab collapsed the dock | task t_d7g694x32c |
| Dock: Audio | under preview | the project's cues; trigger one | UC12 run 1: Broken: the game ignored atelier:cue; panel said "no response"; tooltip was developer text | tasks t_e1tdumr72q (Room One plays and acknowledges cues), t_9xm7i7h57j (template), t_d7g694x32c (panel wording: played / not played / no acknowledgement) |
| Versions drawer | key v | every version, star the preferred; what states and Verify mean | UC8 run 1: star works but shows nowhere else; sideways scrolling to reach Restore; Esc does not close; "integrated"/Verify unexplained | task t_d7g694x32c |
| Right panel: Task | workbench | how to hand work to Claude Code and what happens next | composer with mode select, task rows | UC3 |
| Right panel: Focus | workbench | what I am working on now | current piece, next release, unresolved, identity | — |
| Tasks view | nav | every task and its state; what to do at each state | UC3 run 1: a task could not be handed to Claude Code from the studio alone (CLI calls denied in a Chat session, no way to approve); Ready to try had no Try; two separate routes to Claude Code; brief listed no relevant files; labels cut mid-word | tasks t_e0nyqcrqec (server: allowed node commands, denials visible, Run with Claude Code here route, labels, files) and t_su1cpknxif (client: Run here / Open outside, Try it / Record the result); later: all projects with a scope control |
| Memory view | nav | what the studio knows and where it came from; correct/retract/delete; when Claude Code sees it | UC5 run 1: OK (correction reached the briefing and a fresh Chat answer); Briefing opens slowly with no feedback; bare ids in toasts; nothing says an open session keeps the old briefing | task t_su1cpknxif |
| Budget view | nav | what the API spent, the ceiling, the observed balance; pause; what "paused" stops | UC6 run 1: the three numbers match the guide and the pause stops only utilities; the observed date shifted a day (UTC), the refusal text ran sentences together, labels like "reserved in flight", "active allocation", "Not configured" and a header chip that read as if the studio were paused | tasks t_eht6x904qb (date as entered, one humane refusal) and t_hvr6qh9w48 (plain labels, "API paused" chip) |
| Settings | nav | appearance, key, console command, this machine, data locations; what each field is for | UC13 run 1: This machine and Data locations correct; a command session ignored the briefing context it offered (Broken); Remove saved key had no confirm; Claude path / Command mode / model evidence unexplained | tasks t_eht6x904qb (command backend sends the briefing) and t_hvr6qh9w48 (confirm, help texts) |
| Claude Code: Chat | nav › Chat | who answers, who pays, which model; resume; stop; what was refused | UC3 run 1: refused tool calls looked like ones that ran; markdown tables and code blocks rendered badly; "2 turns" for one exchange; permission option text cut | tasks t_e0nyqcrqec (tool-result and denied events), t_su1cpknxif (chips, markdown, labels) |
| Claude Code: Terminal | nav › Terminal | a real shell as me; start Claude Code with model and mode; not kept across restarts | UC4 run 1: shell OK; launcher did not warn about the trust prompt; toolbar overlapped at 1000 px; prompt glyphs as boxes. UC10: a terminal vanished on restart without a word | task t_su1cpknxif (trust line, task option, restart message, font setting, toolbar) |
| New session dialog | Chat › New session | backend choice with cost statement; model; permission mode | dialog | UC3 |
| Help (?) | top bar | what to do first, where the guide is, the keys | UC16 run 1: only a shortcut list; no pointer to the guide; "working tree" wording | task t_hvr6qh9w48 (Getting started + Read the guide from /api/guide) |
| Narrow window | any | everything still reachable at 1000×700 | UC15 run 1: Broken on the Workbench (the panel covered the toolbar and drawer columns); other sections fine | task t_hvr6qh9w48 (panel collapsed below 1100 px, overlay with close, hint) |
| Keyboard | any | reach everything without a mouse | UC14 run 1: all reachable with focus rings; v did not move focus into the drawer; Tuning fields unnamed; Tab sinks into the preview | task t_hvr6qh9w48 (focus, aria names, skip link) |
| Toasts and errors | everywhere | what happened and what to do | one line; errors stay | collect unclear texts in runs |
| Desktop app | `npm run app` | the same studio as a window; this machine | UC9 run 1: OK (own companion started and stopped, attached run, GPU names); left a pid file behind; logged "exited (code 1)" after a clean stop; listed the software render driver as a GPU | task t_eht6x904qb |

## Status after the overnight rounds (2026-11-04, studio v0.3.0)

Verified by a tester or the architect with real clicks unless noted. "Open" items are in `docs/CONTINUATION.md` next work.

| Element | Run result | Fixed in | Open |
|---------|-----------|----------|------|
| Project list, New project dialog | run 2 OK: named projects, isolated storage, import with name/kind/note | #12, #13 | folder picker only in the desktop app (never clicked) |
| Top navigation, Help | run 4 OK: Getting started, Read the guide, Keyboard | #17 | — |
| Version pill, Keep, Compare, Restore, Build/Export | run 2 OK: clean-tree explanation, readiness in Export, plain Restore wording, safety label | #13, #15 | intra-line diff highlight |
| Side by side | run 2 OK: dock collapses, Esc, star by the pill | #13 | game canvas keeps its fixed size (template layout) |
| Preview, dock tabs | run 2 OK | #13 | — |
| Dock: Play, Tuning, Audio | run 2 OK: applied/ignored/played states, drafts kept, hint to click in the game | #7, #12, #13, #15, Room One #3/#4 | — |
| Versions drawer | run 2 OK: fits, Esc, meanings, v focuses it | #13, #17 | — |
| Right panel: Task / Focus | run 3 OK: Run with Claude Code here, Try it, Record the result, Acceptance field, Remove from studio | #14, #15, #16, #17 | all-projects task list |
| Tasks view | run 3 OK | #15 | scope across projects |
| Memory view | run 1 OK; ids in tooltips, briefing loading | #15 | — |
| Budget view | run 1 Friction → plain labels, date as typed, humane refusal, "API paused" chip | #16, #17 | "observed balance below allocation" wording |
| Settings | run 1 Friction + command briefing Broken → fixed, confirm on key removal, help texts, Terminal font | #16, #17 | — |
| Claude Code: Chat | run 3 OK: task round trip, denials visible, results under calls, markdown | #14, #15, #16, #17 | expandable results |
| Claude Code: Terminal | run 3 OK: launcher with task and trust line, ended-on-restart notice (run 4) | #15, #17 | trust prompt is the person's; Start with task not exercised |
| Narrow window (1000×700) | run 1 Broken on the Workbench → overlay panel, hint (engineer's DOM checks) | #17 | — |
| Keyboard | run 1 Friction → drawer focus, Tuning names, skip link | #17 | — |
| Desktop app | run 1 OK; pid file and log fixed | #10, #16 | tray and picker never clicked; packaged icon |

## Addendum after runs 5 and 6 (studio v0.3.1)

| Element | What changed | Verified |
|---------|--------------|----------|
| Tasks view | This project \| All projects scope; rows of other projects offer Switch to / Copy command; an answered started task shows Working; old questions hidden on Done rows | run 6 + browser |
| Claude Code: Chat | task-bound sessions may read named sibling folders (addDirs) and run `npm run` / `npm test`; result lines expand to the full text | tests; seeded detail in the browser |
| Compare | changed words highlighted inside changed lines; scrolls to the first mark | browser, Room One #6→#7 |
| Budget | the observed-balance warning is a sentence (fixed by the studio's own Chat session) | studio #18 |
| Room One / game template | canvas scales to the frame, HUD wraps once; template byte-identical to Room One again | measured in the studio; `cmp` |
| Room Two | named Room Two everywhere visible (its own task, question answered in the studio) | grep |

## Addendum after run 8 (studio #23–#26)

| Element | What changed | Verified |
|---------|--------------|----------|
| Claude Code: Chat (task-bound) | the prepared prompt asks for one simple command per call; git read commands (`status`, `diff`, `log`, `show`) run without asking, as typed; not a sandbox, node is unrestricted (decision 31) | two sessions after #24 with no command-check refusals; `git diff --stat` passed |
| Desktop app | 256 px window/exe icon and 32 px tray icon rendered by `app/make-icon.cjs` | icons viewed; exe rebuild pending |
| Room One / game template | mute flag keyed `atelier.<slug>.muted`; template byte-identical to Room One (#8) | Side by side #7 vs #8 with one mirrored M; `cmp` |
| Room Two, Room Three | on the current template (canvas scaling, cue acknowledgement, own mute key) | previews at 1366 px |
| Quick Notes | reads `data-storage-key` like the template | in the page |

## Addendum after run 8, tester round (studio #27–#31)

| Element | What changed | Verified |
|---------|--------------|----------|
| Claude Code: Chat transcript | every result under its own call, by tool_use id; refused calls keep their amber chip | replay of the tester's record; 11 tests |
| Task rows (panel and Tasks view) | refresh after a CLI write; versions named "#n label" in every project; unresolved items from `task finish` reach Focus › Unresolved | API; the studio's own Focus list after #29 |
| Task panel composer | Request + How to work + Send; More: inspiration, acceptance; capped at 55%; Send disabled while empty; placeholders by project kind | 800×600 and 1000×700 screenshots |
| Narrow windows | the panel starts under the toolbar and the hint; closes on a project switch | 1000×700 screenshot |
| Side by side | opening it closes the versions drawer | 1366 px screenshot |
| Guide | wrapped list items stay whole | 800×600 screenshot; tests |
| Compare | a non-current row compares with the current version; the current row with the working tree or its parent | tests |
| Titles | end on a word with …; task sessions titled "Task · …" | API |

## Addendum after run 9 (studio #33–#37)

| Element | What changed | Verified |
|---------|--------------|----------|
| Versions drawer | one preferred star per project; the note and "n files" on the row; closes on a project switch; `v` returns focus | session harness + tests |
| Keep version | names Tuning › Save to file when a tuning draft is unsaved | tests |
| Tasks | a task that changed nothing has no version and says so; no "nullnull" | tests; CLI output `"version": null` |
| Claude Code: Chat | a refusal (no key, paused budget) is an error turn with no cost line; the dialog cannot create a session on an unavailable backend; the Command dialog names the command; free session titles end on a word | tests; a live plan-mode session |
| Budget | sentences name the observed balance and the reserve; no contradiction | tests |
| Focus | lists the project's releases | tests |
| Guide | explains user-tested and recheck; keys typed into a preview belong to the product | read |
| Room One / game template | the intro card fits a 390×220 frame (#9); template identical again | `cmp`; not by eye |
