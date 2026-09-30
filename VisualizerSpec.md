# The Castle: Soul Document

Sep 29, 2026 · @Donald Murphy

## Purpose

The Castle is a passive, live view of a Claude Code project, drawn as a castle whose rooms are the project's functional areas and whose workers are Claude's agents moving between them. Every worker and every lit room reflects a real event from Claude Code. Nothing is invented for show.

It exists for people who direct Claude Code without reading the files it touches. They need to know, at a glance from across the desk: where is Claude working, is it one worker or several, and is anything in trouble. A file tree answers none of that quickly. A castle with lit rooms and busy workers does.

The second goal is that it is pleasant to leave running. It should reward watching the way an idle strategy game or an aquarium does, without demanding attention when nothing important is happening.

## Core principles

When two principles conflict, the one higher on this list wins.

1. **Nothing lies.** Every movement, glow and unit traces back to a real Claude Code event. Idle workers look idle. No fake busywork, no scripted activity to fill silence. If the data is missing, the Castle shows less, not more.
2. **Readable in two seconds.** A glance answers three questions: where is work happening, how many workers, is anything wrong. Anything that needs study to understand belongs in a detail panel, not on the main view.
3. **The map never moves.** Rooms keep fixed positions for the life of a project. People learn the layout once, the way they learn their own house. New rooms are added at the edges, never by reshuffling.
4. **Calm by default, loud only for trouble.** Motion scales with real activity. When Claude is idle the Castle is quiet: dim torches, workers resting. Only trouble and requests for the user's attention are allowed to flash.
5. **Charm is earned, not added.** Personality comes from how real events are shown (a scout leaving the gate for a web fetch, scribes busy in the Scriptorium when logs change), not from decoration layered on top.
6. **Plain first, pretty later.** Every feature ships first as labeled boxes and dots. Art replaces the boxes only after the behavior is proven correct.

## What it is not

- **Not a control panel.** Version 1 only watches. It never approves permissions, stops agents or sends prompts.
- **Not a code viewer.** It does not show file contents or diffs. Clicking a room may list recent files, and nothing deeper.
- **Not a cost or token dashboard.** Existing tools already do that well.
- **Not a scored game.** No points, levels or achievements. Rewarding activity would reward churn, and a retry loop would look like a high score.
- **Not a copy of any existing game.** The feel is inspired by classic real-time strategy games. All art, unit designs, names and sounds are original. No Command & Conquer assets, names or likenesses.

## The Castle map

Each functional area is one room with a castle name that hints at its job, and every room keeps its position for the life of the project. The front of the Castle is where outside requests arrive (Gate, Gatehouse, Steward's Hall); storage and core machinery sit toward the back.

&#91;embedded content: Castle floor plan · 12 rooms, 1 gate, the Wilds outside\]

Phase 2 draws exactly this: labeled boxes, no art. Watchtower, Library, Proving Grounds and Workshop are additions to the original area list, because auth, docs, tests and configuration are where agent sessions spend much of their time. A project's `castle.json` may drop or rename rooms it doesn't need; existing rooms never move.

## The inhabitants

Each kind of Claude Code actor is a distinct unit type, recognizable by silhouette alone so it reads even at small size. A unit's job is shown by where it stands and what it is doing there.

| Unit | Represents | Arrives when | Leaves when | Look |
| --- | --- | --- | --- | --- |
| Mason | The main session | Session starts | Session ends | Sturdy builder, one per session, carries a hammer |
| Knight | A subagent | SubagentStart | SubagentStop | Banner in a color unique to its agent id; enters and exits through the gate |
| Wizard | A skill in use | A skill is invoked | The work that skill drove moves on | Robed specialist; stands beside the unit that called it |
| Raven | An MCP tool or external connector call | The call starts | The result returns | Flies from the Rookery over the wall and back |
| Scout | A web search or web fetch | The request starts | The result returns | Leaves by the gate on foot or horseback |
| Herald | Claude is waiting on the user | A permission prompt or idle notification | The user responds | Stands at the gate ringing a bell; the only unit allowed to demand attention |

Rules for units:

- One Mason per session. Several concurrent sessions in the same project show several Masons, each with a session color.
- A unit walks to the room for its current tool call and stays there, working, until its next call sends it elsewhere.
- A unit that has made no call for about 60 seconds sits down and rests where it is. It does not wander.
- When a subagent finishes, its Knight walks out of the gate. Completed work leaves the scene.

## Room status

Each room is always in exactly one lighting state, chosen by fixed priority from three signals the Castle tracks per room: recent activity (heat), what kind of work it was (reading or changing), and health (failures, retries, test results). The highest-priority state whose trigger is true wins.

| Priority | State | Lighting | Trigger | Clears when |
| --- | --- | --- | --- | --- |
| 1 | Alarm | Red, slow pulse | A tool call on a file in this room failed, a test or build run failed after this room was changed, or the thrash rule fired | A later tool call or test run in this room succeeds |
| 2 | Construction | Bright warm amber, sparks | A file in this room was edited or created in the last 60 s | 60 s pass with no change |
| 3 | Survey | Cool blue lantern light | Only reads or searches in this room in the last 60 s | 60 s pass with no activity |
| 4 | Proven | Soft gold, brief banner raise | This room was changed, then a test or build run passed | The room is changed again, or the session ends |
| 5 | Embers | Dim orange, brightness follows heat | The room was touched this session but is now quiet | The session ends |
| 6 | Dark | Stone gray, moonlight only | Untouched this session | Any activity |

**Scaffolding.** A room that was changed this session but has not had a passing test or build since keeps scaffolding on its walls, whatever its lighting. A passing run takes the scaffolding down. This shows unverified work at a glance, which matters most for someone who does not read the diffs.

**Siege waves.** Each test run is a wave of attackers marching on the walls from the Wilds.

- **Size.** Wave size follows the number of tests on a log scale, capped at about 60 figures, so 50 tests and 5,000 tests both read at a glance without flooding the screen.
- **Timing.** The wave reaches the wall in a few seconds however long the real run takes, then holds there until the result arrives.
- **Pass.** Passing tests are repelled at the wall. A fully passing run ends with the wave retreating and scaffolding coming down on every room changed since the last run.
- **Fail.** Failing tests breach the wall at the room whose code they cover, and that room goes to Alarm. Coverage comes from test patterns listed on each room in `castle.json` (for example `tests/db/**` under the Vault). A failing test that maps to no room breaches at the Proving Grounds.

### How the signals are computed

- **Heat.** Each event adds weight to its room: read 1, search 1, shell command 2, edit 3, create 4. Heat decays with a 45 s half-life. Heat sets brightness within a state, never the state itself.
- **Kind of work.** The Castle keeps the time of the last read and the last change per room. Those two times decide Construction versus Survey.
- **Failure.** A failed tool call on a file maps to that file's room.
- **Test and build results.** A shell command is recognized as a test or build by pattern (for example `npm test`, `pytest`, `dotnet build`). When it finishes, every room changed since the previous test or build run is marked Proven (pass) or Alarm (fail). This is a heuristic: a failing test may have nothing to do with a given room. The detail panel says which run caused the state.
- **Thrash.** The same file edited 4 or more times within 10 minutes, with no passing test or build in between, puts its room in Alarm. This catches retry loops, the most common silent failure in agent sessions.

### Anti-flicker rules

- A room must hold a state for at least 3 s before changing, except Alarm, which shows at once.
- Light changes fade over 1 to 2 s, never snap.
- The Wilds (unmapped files) have no states. Activity there briefly lifts the fog where it happens.

## Motion and behavior

- **Walk, never teleport.** Units travel between rooms along fixed corridors in about 1 s. Travel shows the path of the work, which is half the story.
- **Queue, don't blur.** If events arrive faster than units can walk (parallel tool calls), the unit takes the shortest route through each room in order. Speed rises to keep up; it never skips a room it actually visited.
- **Actions match verbs.** Reading: a unit holds a scroll. Searching: it walks the room's edges with a lantern. Editing: it hammers. Creating: it lays a new stone. Shell commands: it works a crank or bellows in the Workshop.
- **Crowds mean parallel work.** Three Knights in the Vault means three subagents in the database code at once. Crowding is information, not decoration.
- **Session rhythm.** Session start: gate opens, Mason walks in, torches light. Claude stops and waits for the user: workers set down tools and the Herald rings. Context compaction: scribes in the Scriptorium bind a book. Session end: the gate closes and lights dim to Embers.
- **Sound off by default.** Optional, quiet, and limited to three cues: gate open, alarm, Herald bell.

## How it listens

Claude Code hooks are the only live source. They are documented, fire on every tool call, carry the file path for file tools and an agent id for subagents, and can be sent as an HTTP POST to a local server. A local server turns each hook event into a room event and pushes it to the browser over a WebSocket.

- **Hooks used:** SessionStart, SessionEnd, PreToolUse, PostToolUse, PostToolUseFailure, SubagentStart, SubagentStop, Stop, Notification, PreCompact.
- **Never block Claude.** The hook handler returns immediately. If the Castle is not running, Claude Code works exactly as before.
- **File watcher as backup.** A watcher on the project folder catches changes made by shell commands, which hooks do not report as file paths. These show as changes with no unit attached.
- **Transcripts are for replay only.** They can lag behind live activity, so they never drive the live view.

### Mapping files to rooms

The map lives in a file in the project, `castle.json`, listing each room and the file patterns that belong to it.

1. On first run, Claude drafts `castle.json` by reading the project layout.
2. The user reviews it once and adjusts it.
3. At runtime, matching is pure pattern lookup: fast, free, and the same answer every time. No AI call per event.
4. A file that matches no pattern falls into the Wilds. Activity in the Wilds is the signal that the map needs updating.
5. A file may belong to more than one room (a route handler that also queries the database). Its events light every room it belongs to.
6. Shell commands map by command text, for example test runners to the Proving Grounds and migration commands to the Vault.

## Build phases

Each phase ships something usable, and no phase adds art before the behavior under it is proven correct.

1. **Wiring.** Hook to local server to browser. Raw event log on screen. Done when every tool call in a real session appears within 1 s.
2. **Plain Castle.** Rooms as labeled boxes in their fixed layout, units as colored dots with a letter (M, K, W, R, S, H). All six lighting states and scaffolding working. Done when the view is correct for a full real session, checked against the transcript.
3. **Movement.** Dots walk corridors, queue for parallel calls, rest when idle.
4. **Art.** Replace boxes with drawn rooms and dots with unit sprites. Behavior does not change.
5. **Polish.** Verb-specific actions, session rhythm moments, optional sound, replay from transcripts.

## Open questions and unverified assumptions

These are not yet checked against the current Claude Code hooks reference and must be confirmed in Phase 1 before anything depends on them.

- [ ] **Skill detection.** Is a skill invocation visible as its own tool call in PreToolUse, and with what `tool_name`? If not, Wizards may need to be inferred from a skill's file being read, which is weaker.
- [ ] **Shell exit codes.** Does PostToolUse for shell commands include the exit code in `tool_response`? Test pass and fail detection depends on it. Siege waves also need per-test counts and failing test file paths, which likely means reading the test runner's JSON report rather than the hook payload.
- [ ] **Search tool fields.** Search tools carry a pattern and optional path, not a list of files. Confirm whether matched files can be read from `tool_response` so searches light the right rooms.
- [ ] **Hook names.** Confirm Notification and PreCompact exist and carry what the Herald and scribe moments need.
- [ ] **Projects with no tests.** Many vibe-coded projects have no test runner. Scaffolding would then never come down. This project has large suites, so only a passing test run counts here. Decide whether a successful build or run command counts as proof in that case.
- [ ] **Multiple sessions.** Decide whether two sessions in the same project share one Castle or get side-by-side views.
- [ ] **Working title.** "The Castle" is a placeholder name.
