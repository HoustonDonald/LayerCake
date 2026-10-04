# CLAUDE.md

Project rules for `C:\dev\LayerCake`. Inherits `C:\dev\CLAUDE.md`; this file wins where they overlap.

## What this is

LayerCake: a local tool for visualizing and managing the Claude Code configuration inheritance
lineage for a project directory. It answers what is inherited, from where, and in what order, and it
lets you edit those files and snapshot/restore them.

Two surfaces, deliberately split by job:

- **Browser UI** (Express on 127.0.0.1 plus a React SPA) for anything you scan with your eyes: the
  level tree, the flattened views, editing, and restore-with-diff.
- **CLI** (`cli/`, imports the server modules directly, never the HTTP API) for one-shot answers and
  scriptable operations. `layercake here` is the headline command, for switching projects.

A TUI was considered and rejected: the level tree and the provenance tables are wide, high density
comparison surfaces that degrade badly at 80 columns.

No test framework and no linter. Verification is manual and must happen at the consumer boundary,
which for the API means HTTP, for the UI means a browser, and for the exe means launching it the way
a double-click does. `README.md` is the
user-facing spec and is unusually complete, so read it before changing scan or write behavior, and
update it in the same change.

`HANDOFF.md` holds transient working state: what was just built, what is open, and what to do next.
It is disposable and goes stale; this file and `README.md` win where they disagree.

**Every problem found is filed as a GitHub issue in `HoustonDonald/LayerCake`. Mandatory unless the
owner says otherwise** (Donald, 2026-09-26). That covers bugs, review findings, gaps, unverified
claims and owner decisions, including ones found while doing something else. Say whether it was
reproduced or reasoned, and classify reachability (a) or (b) as in `C:\dev\CLAUDE.md` 3c. A fix
commit closes its issue (`Fixes #n`). Issues are the list of what is open; `HANDOFF.md` points at
them rather than restating them. Pass bodies with `--body-file`, never as a shell argument.

## Commands

```
npm start          # build client if stale, then serve http://127.0.0.1:5178
npm run app        # same, then open a chromeless app-mode browser window
npm run cli -- here    # effective environment for the current directory
npm run cli -- session # the current Claude Code session here (no Claude usage)
npm run dev:server # API only on 5178
npm run dev:client # Vite HMR on 5179, proxying /api/ to 5178; needs dev:server and a built client
npm run smoke      # end to end over the real HTTP API
npm run castle-sim -- stress   # the Castle under a synthetic workload, in a window of its own
npm run castle-sim -- replay   # your recent sessions here, replayed at 10x (options: top of scripts/castle-sim.mjs)
npm run build:exe  # dist\LayerCake.exe, the single executable (Windows only)
```

**Run `npm run smoke` before calling any change to `server/` done.** It is the only regression net.
It builds its own fixture, port and snapshot store, and cleans up after itself, so it is safe to run
while you are working. The fixture sits under the drive root (`C:\layercake-smoke-*`), not in `%TEMP%`,
and the server gets a home folder of its own, so no part of the machine's own config is read,
watched or copied into a snapshot (#78); a killed run can leave that folder behind. A green run is necessary and not sufficient: it cannot see the UI, and the
one bug it missed was found by opening a browser. Its mapped-drive checks (#57) are skipped, visibly,
unless `SMOKE_MAPPED_DRIVE=1`: they map a free drive letter to the admin share with `net use` for the
run, which changes the machine's drive letters, so they are opt-in. Run them after touching drive
detection or polling.

**`castle-sim` never touches the real app or data.** It starts its own LayerCake (port 5190) with
every data folder in a scratch folder and launches in dry run, spends no Claude usage, and drives
its own app window through a DevTools port on 127.0.0.1 (open the Castle, close at the end).
`replay` reads your real transcripts, read only, and copies them into the scratch folder as they
happen again. It is a viewing and measuring tool, not a check: it asserts nothing.

**Smoke never runs the exe.** It starts `server/index.js`, which serves `public/` from disk; the exe
serves an embedded copy through `desktop/main.js`. After touching `server/app.js`, `desktop/` or
`client/`, rebuild and launch the exe the way Explorer does (`Start-Process`, not from a console,
which would lend it one), then check that a window opens, the UI loads, and closing the window ends
`LayerCake.exe`. The exe prints nothing, so a failure there shows as an error window or as silence.

Env knobs: `PORT` (default 5178), `CLAUDE_EXPLORER_DIR_TIMEOUT_MS` (default 3000),
`LAYERCAKE_SNAPSHOT_DIR` (default `%LOCALAPPDATA%\LayerCake\snapshots`), `LAYERCAKE_APPDATA_DIR`
(default `%LOCALAPPDATA%\LayerCake\data`) and `LAYERCAKE_CLAUDE_DATA_DIR` (default: Claude Code's
configuration home, read for session data only; smoke points it at a synthetic folder so real
sessions are never read). Claude Code's own `CLAUDE_CONFIG_DIR` is honoured the way Claude Code
reads it (#7): every `~/.claude` path, and `.claude.json` inside it, come from `claudeHome()` and
`globalConfigFile()` in paths.js, never from `homeDir()` directly. So does a `CLAUDE_CONFIG_DIR` in
the env block of the default home's `settings.json` (#64): `resolveConfigHome` in scan.js reads it
before every scan, at server start and in the CLI, and `claudeHome()` returns the moved home to
every caller; `.claude.json` stays put (measured). Smoke sets `CLAUDE_CONFIG_DIR` to a synthetic
config home, so its user level is never the real one; the #64 checks run a server of their own
without it (`smoke-confighome.mjs`). More exist for smoke only:
`LAYERCAKE_LAUNCH_DRY_RUN=1` (launch builds its argv and settings but starts nothing),
`LAYERCAKE_CLAUDE_CMD` (a JSON array replacing `claude` for AI summaries, pointed at
`scripts/smoke-claude-stub.mjs`, so no usage is ever spent testing),
`LAYERCAKE_REPORT_WINDOW_MS` (how long a launched session counts as running after its last report;
45 s in use, a few seconds in smoke so "stopped reporting" can be tested),
`LAYERCAKE_CASTLE_TIME_SCALE` (the Castle's windows, 1/20 in smoke so a 60 s window lapses in 3 s;
clamped to 0.01 to 1), and two for managed policy (#147): `LAYERCAKE_MANAGED_DIR` replaces this
platform's managed folder (`C:\Program Files\ClaudeCode`, which needs elevation to write), and
`LAYERCAKE_POLICY_KEYS` (JSON
`{"hklm": key, "hkcu": key}`) names registry keys to read in place of the two policy keys, refused
unless both sit under `HKCU\Software\LayerCakeSmoke`. Smoke sets both, and `ProgramData`, in its
own environment before it starts anything, so what it starts inherits them rather than reading the
machine's policy; its managed checks write a throwaway `HKCU\Software\LayerCakeSmoke-<pid>-<random>`
key and delete it at the end.
`LAYERCAKE_BROWSER_PROFILE_DIR` (default `%LOCALAPPDATA%\LayerCake\browser`) moves the app window's
Edge profile (#59). Every exe test sets it, beside the three data folders above: without it the
test's Edge writes into the real profile, and a real LayerCake window already open takes the test's
window and decides when the test's exe stops. A test of an exe built before it existed has to
redirect `LOCALAPPDATA` for that process instead.

`npm start`, `npm run app` and `npm run smoke` build the client only when `public/index.html` is
older than the newest of `client/`, `vite.config.js` and `desktop/layercake.ico`
(`scripts/build-if-stale.js`, the one copy of that rule, #94), so a change to `server/` alone does
not trigger a rebuild and does not need one. A rebuild empties `public/` first, so on Windows the
check and the build hold a lock (a named pipe keyed by the tree), and runs started together on a
stale tree build once (#95). A client change made while a smoke run is serving still rebuilds under
it, and `npm run build:exe` builds without the lock.

## Architecture

```
server/paths.js     platform paths, the scan manifest, snapshot root
server/safety.js    denylists, editable categories, size cap, timeout, errors
server/sharegate.js one filesystem call per network share at a time, process-wide; scan and watch use it
server/scan.js      lineage resolver -> ordered levels
server/policy.js    the registry policy values (reg.exe), kept off the served lineage
server/plugins.js   which installed plugins load for a project (measured rules, #122); marks the rest
server/readfile.js  the ONLY producer of a file body
server/flatten.js   the four flattened views
server/watch.js     directory watches over a scanned lineage, polling on a share (UNC or mapped drive); never opens a body
server/snapshot.js  capture, compare, restore, and the atomic write primitive
server/writefile.js the ONLY edit path; depends on snapshot.js by design
server/security.js  localhost CSRF guard and session token
server/app.js       express app, 127.0.0.1 bind, per-scan allowlist; builds, never listens on import
server/index.js     terminal entry: app.js serving public/ from disk, listens on load
server/transcript.js the ONLY reader of Claude Code session transcripts -> normalized session model
server/jsonl.js     follows an append-only JSON Lines file by byte offset (transcripts, history)
server/sessions.js  session discovery (the allowlist for session routes), running sessions, retention
server/history.js   history.jsonl prompts; pastedContents never leaves it
server/health.js    session health state + reasons, rules shipped in the payload
server/summaries.js free summary cards; the opt-in AI summary via stripped-down claude -p
server/appdata.js   LayerCake's own data (cards, AI summaries, usage ledger), via atomicWrite
server/session-routes.js /api/sessions, /api/session/:id[/turn/:n|/stream|/summarize], /api/history, /api/usage
server/launch.js    "Start Claude here": wt.exe + claude --session-id --settings <file>; fixed argv; console window without wt
server/powershell.js Windows PowerShell 5.1's path and the quoting for starting it; no imports, nothing at load
server/ingest.js    /ingest/<launch>/<secret>/{statusline,hook} from launched sessions; state per session
server/castle.js    the Castle (#159, #160): picks sessions, merges hook and transcript events, the fold, the state
server/castlemap.js the Castle's rooms (castle.json v2, read only, else the built-in typed map), room types, the glob matcher, command rules, git/gh recognition
server/gitstate.js  the Sept's branch and unpushed count from .git, read as files (#186); never runs git
server/castle-routes.js /api/castle/stream, /room, /reload: a scan id in, never a path
client/             React 18 + Vite, two-pane explorer plus editor, snapshots and watch bar
cli/                layercake CLI, imports server modules directly
scripts/launch.js   build, serve, then open an app-mode browser window
scripts/build-if-stale.js the client build rule, shared by start.js, launch.js and smoke
desktop/window.js   the app window (browser, profile, isolation flags, profile lock), shared by launch.js and main.js
desktop/main.js     single-executable entry: embedded client, exits when no browser holds the window's profile
desktop/inflight.js counts running handlers so the exe's shutdown can wait for them
desktop/build.mjs   vite + esbuild + SEA blob + icon/version (resedit) + postject + GUI subsystem -> dist\LayerCake.exe
```

The lineage is an ordered array of levels, weakest precedence first: `managed`, `user`, `plugins`,
`project-memory`, then one `directory` level per ancestor from filesystem root down to the project
directory. Each level carries `entries` / `absent` / `errors` / `redacted` / `other` and a derived
`status` of `found` / `partial` / `empty` / `error`.

## Invariants

These are the product, not implementation details. Breaking one silently is the worst outcome here.

**Writes are confined to two modules.** `server/snapshot.js` and `server/writefile.js` are the only
places a mutating `fs` call may appear. Everything else in `server/` stays on `readFile`, `readdir`,
`stat`, `lstat`, and `fs.open(path, 'r')`. Audit with the command in README "Write posture", and
note it also matches the identifier `truncated`, so read the hits rather than counting them. The exe
adds no write site: `desktop/main.js` and `desktop/window.js` write nothing, and only the build tool
`desktop/build.mjs` writes, to `public/` and `dist/`. `server/appdata.js` writes LayerCake's own data
through `snapshot.js`'s `atomicWrite`, so it adds a caller, not a mutating call site; it is policy
like `writefile.js`, confined to `appDataRoot()`, and refuses a root inside `~/.claude` or the
Claude data folder.

**Every write that replaces or removes bytes snapshots first, and that is structural.** `writefile.js`
imports `snapshot.js`, not the reverse, so a new route cannot skip the snapshot by forgetting to call
it. Keep that direction. That automatic snapshot holds only the files the operation replaces or
removes (`paths` in `createSnapshot`; owner decision 2026-09-27); a snapshot taken on request is the
whole lineage. Every edit, delete and restore then checks, per file, that the snapshot
holds the file it is about to replace or remove (`assertHeld`, and the same test in `restoreFiles`),
and refuses that file if not, so a file over the 2 MB cap is never replaced or removed with no copy
left (#96; delete had it first, #15). The snapshot records the hash of its stored copy, and the
replace or unlink happens only while the file still has that hash, checked before EVERY attempt of
the Windows lock retry, not once before it: a write landing while the file was locked used to be
deleted unseen (#100). A window of a few milliseconds between that check and the rename or unlink
remains; closing it would need OS-level locking (#110). The snapshot's own copy is retried on a
lock like the rename, so another program's brief exclusive lock delays a save rather than failing
it (#107). A create is the one write with no snapshot, by design: `createExclusive` claims the
name with an exclusive create, which refuses an existing file, then renames its temp file over that
empty placeholder, so it never replaces bytes and has nothing to back up; its undo is a delete. It
must not publish with a hard link: on Windows, removing the temp name while another program (most
likely antivirus; not identified) still held it left the new file unreplaceable for up to a minute,
so a save moments after a create failed (#150).
Anything that could replace a file stays on `atomicWrite` behind a snapshot.
Writes land via temp file plus rename in the same directory, so a crash leaves the old file or the
new one, never a half-written config that breaks every future session. On Windows the rename is
retried for up to 5 s on EPERM/EACCES/EBUSY, because a rename over a file another process has open
fails: without it, 99 of 300 writes failed with a reader polling the target (#49). A read-only
target gives the same EPERM, so it is checked and fails at once instead of after the window. Save,
delete and restore all refuse a read-only file before writing (#141), save and delete before their
snapshot too, as they do a file over the 2 MB cap (#139): the unlink clears the attribute, so a
delete used to succeed, and elsewhere a rename over a read-only file succeeds.

**The snapshot store must never live under `~/.claude`.** That tree is a restore target, and a
backup the restore can overwrite is not a backup. See `snapshotRoot()`.

**Snapshots are deleted after 30 days, and only by `pruneExpired`** (#138, owner decision
2026-09-27; `RETENTION_DAYS`, served with the snapshot list). It runs after each new snapshot, reads
a snapshot's age from its folder name (never from the editable manifest), and touches only real
folders whose names are snapshot ids: a junction in the store is skipped, not followed. Any other
code that deletes a snapshot needs the owner, because it removes backups.

**A snapshot manifest is checked, not trusted.** It is a plain file in LayerCake's own folder, and an
edited `stored` path of `../../../x` once read any file on disk (#101). `storedPathOf` requires the
copy to sit inside that snapshot's `files/` folder, by its real path as well as lexically, and to be a
plain file with one name: a junction there read any folder, and a hard link there, under a harmless
name, read a credential file (#106). It also refuses a credential file either as the copy or as the
file it stands for.

**Absence is data.** Every probed-but-missing path is recorded in `level.absent` and rendered. Never
"optimize" a probe away because it is usually missing; the point of the tool is showing what was
looked for.

**Credential files are never opened.** `.credentials.json`, `credentials.json`, `.env`, `.env.local`,
matched on lowercased basename, excluded at scan time (`probeFile`, `walkTree`) and refused again in
`readForDisplay` and in `/api/file`. Both layers stay; the second is not redundant.

**The scan result is the allowlist.** `/api/file` and `/api/write` touch only paths a prior scan
discovered, keyed by `scanId`, with keys lowercased on win32 because NTFS is case-insensitive. The
scan store holds the full entry, not just the path, so a write takes its **category** from the scan
rather than from the request body. That is what stops a caller relabelling a hook as a note to dodge
the executable acknowledgement. Adding an endpoint that reads or writes an arbitrary path turns this
into a general-purpose file tool on localhost. Do not.

Three routes extend it without breaking it (#15, #92):
- **`/api/create` takes an option id**, from the `creatable` list the scan built with `createOptions`,
  plus a name that is one lowercase segment. The server builds the path. Options exist only at user
  and directory levels, from the create tables in `safety.js`; at load `writefile.js` checks that
  every name in those tables is a scan manifest target, so a created file is one the next scan lists.
- **`/api/delete` takes a scan entry**, like a write.
- **Every restore goes through `restoreSnapshotFiles` in writefile.js**, the HTTP route and the CLI
  alike; never call `snapshot.js`'s `restoreFiles` directly (the CLI once did, with no fence, #105).
  It may put back a file the current scan did not find only when it is in the snapshot and
  `restorableWhenAbsent` says the current scan would list it there: a probed FILE it recorded
  absent (never a folder record), a manifest shape under a `.claude` folder or the config home,
  project memory as the scan walks it, the plugins folder's own manifests (never its cache,
  #126), or a managed drop-in by Claude Code's name rule (`isDropInName`, #147). The tree rules are the
  scan's own (`treeSkipsDir`, `treeTakesFile` in safety.js), so the two cannot drift apart. That
  covers everything delete allows, so a delete is always undoable (#97). It is then created, never written over, because the restore's own snapshot comes from the scan and cannot hold
  a file that appeared since.

**The plugin cache is read only** (#126, owner decision 2026-09-28). Claude Code replaces a
plugin's version folder when it updates, so nothing under `<config home>/plugins/cache` is edited,
deleted, created or restored. `readOnlyReason` in safety.js decides by PATH, whatever the category
or the level that listed the file; the write paths (`assertWritable`, `createOptions`,
`restoreSnapshotFiles`) ask it themselves. The `readOnly` field on scan entries and compare rows is
for the page and the CLI to show, never what a write trusts.

**Watch events carry paths and verbs, never content.** `/api/watch` streams from whole directories,
so it necessarily sees files no scan entry covers. The moment a body rides along in that payload it
becomes a second file reader that skips both the allowlist and the credential refusal. Keep it a
notifier; reading stays on `/api/file`. The filter deciding which events reach the client is
likewise read from the scan result and the manifest rather than kept as its own list, for the same
reason the write policy is: a hand-maintained copy drifts and quietly stops matching what the scan
actually treats as config. The watched set is derived the same way: the parent of every entry and
absence, every folder from a `.claude/` subtree's root down to each entry in it, and a subtree the
scan marked `dirExists` (present, no config yet), because a new skill is a new folder and only the
folder above it can see it arrive (#56).

**A mute never reaches the server** (#13). Muting a file in the watch bar is a per-viewer preference
kept in the browser's `localStorage` (keyed by path, lowercased on win32). The server stream keeps
reporting every event for that file; the bar counts and lists it, marked muted, and only declines to
light up or notify for it. Filtering on the server would make the stream lie, and would make one
viewer's mute everyone's.

**Session ids come from discovery, the way file paths come from a scan.** Every `/api/session*`
route resolves its id through `sessions.js`, which only knows ids it found as
`<claudeDataDir>/projects/*/<uuid>.jsonl`; nothing accepts a path, and no path is ever built from a
field inside a transcript record (subagent file names are pattern-checked agent ids). These routes
carry content (prompts and replies), which is why they are separate from `/api/watch`, which stays
paths and verbs only.

**`transcript.js` is the only place that knows the transcript format.** Anthropic documents it as
internal and liable to change in any release. Unrecognised record types are counted and shown in
the UI ("Transcript read"); never silence that counter, because it is how a format change becomes
visible instead of becoming empty panels. It keeps prompts and replies and drops CLAUDE.md bodies
from instruction attachments, the system prompt snapshot, the account email and tool I/O bodies.
A tool call keeps a one-line summary: its description, or for a shell call with none (151 of 3,866
here), the first 160 characters of the command line, which can therefore reach the page. For the
Castle it also keeps the file paths the call names and the first four words of each segment of a
shell command ("command heads", `toolTargets`), which are matched against test and build rules and
never sent to the page; smoke plants a command word and searches every castle frame for it. The
path-like words of a shell command (`shellPaths`, `commandPaths`, #176) only choose the rooms a plain
shell call works in, and are never listed among a room's files; smoke plants one too.
Subagent transcripts are read for their tool calls only (`SubagentReader`), found by listing the
folder and pattern-checking each name, never from a record field.

**Secrets beside the session data are never read or sent.** `history.jsonl`'s `pastedContents`
never leaves `history.js`; `sessions/<pid>.<hash>.key` files are never opened (only `<digits>.json`
matches). Smoke plants sentinels in both and searches every response for them.

**A hook answer is an empty 204, always.** `ingest.js` answers every hook post with no body,
which Claude Code treats as "success, no output". A JSON body could add context to Claude or block
an action, which turns an observer into a participant. Smoke asserts every hook answer is empty and
a mutant returning `{}` is caught; the zero-token claim was also measured end to end (the same
prompt with and without a launch's settings: identical input, full cache hit). The status line's
answer is the line to print and is never sent to the model.

**The Castle is a viewer: it reads, it never writes or starts anything** (#159, #160). Its hook
records are a bounded ring per session inside ingest.js (`keepForCastle`), appended after the post
is applied, in a try/catch, with no matching or await, so the empty 204 is unaffected; the ring is
read by castle.js only and never served whole. Castle state exists only while a stream is open for
that project, and castle routes take a scan id, never a path. `<project>/castle.json` is read, never
written (the page's "Copy prompt for Claude" has the user's own session draft it), at a path the
server builds from the scan store, through `readForDisplay`. The Sept's git facts (#186) are read
the same way by `gitstate.js`, never by running git: HEAD, the branch's ref and `packed-refs`, the
config's `[branch]` section, the upstream's ref and the branch's reflog, each re-read only when its
stat changes, every other castle tick. Only a clipped branch name, a short detached commit and a
count are served, never a commit message, a remote URL or a path, and smoke plants a message and a
URL as sentinels; anything missing or unreadable is a value (`repo: false` with a reason), never a
throw. castle.json can come from a cloned repository,
so it is data only: **the glob matcher in castlemap.js is hand-written and must stay free of
backtracking**. picomatch 4.0.7 ran over a minute on `'*a'` twelve times plus `'b'` against forty
`a`s (review, 2026-09-29), `path.matchesGlob` is super-linear too; this one agreed with picomatch on
200,000 random cases (scratch `diff-glob.mjs`) and smoke asserts its hostile/benign time RATIO.
Command rules are word prefixes, never regular expressions. The rooms are the project's own sections
(#167, owner decision 2026-09-30), each with a type from `ROOM_TYPES`, shipped with the map like the
state rules; a room id must stay out of the names the castle uses for places (gate, village, wilds,
outside, perch...: `RESERVED_IDS` in castlemap.js), because the fold and the page share that
namespace. Files no room claims are Hollowmere's, id `village` (#172); `wilds` is the forest beyond
the Frostwall; the Citadel keeps the id `outside`. **The fold is the specification**: room
states are recomputed from all events under the current map each time (no incremental path to drift
from it), and smoke's fold oracle closes every stream, reopens, and requires the fresh fold to equal
the long-running one. That includes each Mason's and Knight's `trail` (#161), its last 12 room
changes keyed by the call that caused each, which the page walks: a key must be the same from either
source and on every refold, because the page walks what follows the last key it saw, and a key it
cannot find sends it through the whole trail again. It caught a real defect on its first run (a session joining later never had its
subagent files listed). Denied, rejected, interrupted and refused calls have no verdict and never
raise an Alarm (`toolVerdict`): a hook's PostToolUseFailure fires only for a tool that ran, but a
transcript also records as an error a call Claude Code refused before running it, so a transcript
error is a failure only with an exit code or a system error code (#164, found by the real-session
probe), and a run with no exit code has no verdict. Its rules ship with its data (`ROOM_STATES`, `UNIT_KINDS`, `CASTLE_RULES`), as health.js does.

**Ingest is outside `/api` and guards itself.** Callers are Claude Code processes, so there is no
page token: a per-launch secret in the path (constant-time compare), no `Origin` header allowed,
and the global Host guard. Launch records, secret included, are kept in app data so a session keeps
reporting across a LayerCake restart; the settings file that Claude Code reads holds the same
secret under the same user ACL. The secret is also on `curl.exe`'s command line at every
status-line refresh, because the status-line command embeds the ingest URL. Only same-user
processes can read that, and they can already read the file (#21).

**Ingest state is per session, not per launch** (#22). One terminal carries several session ids
(`/clear`, `/resume`), and launch-wide state once showed the new session's context, labelled
exact, on the old one. A status line counts as exact only for its own session and only while that
session is reporting. A session in two launches belongs to the one that heard from it last, or,
before either has heard from it since a restart, the one that took it on last (a persisted `since`).
What the hooks report is memory only; the launch record is rewritten when a session id is first
seen or ends, so a restart remembers them. A failed write is retried and shown, never silent. A
post without a valid session id is answered and changes nothing, and only a status line or a
prompt/tool event revives an ended session, because Notification and InstructionsLoaded are async
and can land after the end (#35, #36, #37).

**A launched session's liveness is evidence, never memory.** Claude Code's own pid file decides
when there is one. Without one, the session's reports decide: its status line re-runs every 15 s
(`refreshInterval`, `STATUS_REFRESH_S` in ingest.js), EXCEPT while a dialog such as a permission
prompt is open, when Claude Code hides the status line and its timer stops (docs; #41). So it
counts as running while it reported in the last 45 s, or while a wait or a tool it reported is
still open. Silence past that reads as "most likely stopped" (a crash, a closed tab, or not heard
from since a LayerCake restart), and a launch that never reported at all reads as "channels
blocked" (#31, #4, #42). Never infer "running" from memory or from the absence of an end, and
never claim a silent session "is not running": the evidence supports "most likely".

**Ingest bodies are untrusted even with the secret: errors are values here too.** Only strings are
read as text (`str()`), because `String()` on an object whose `toString` is not a function throws,
and Express 4 does not catch a rejected async handler, so a throw exits the server (#33). The
handler also catches and still answers with an empty 204.

**`launch.js` starts a process with a fixed argv.** The directory comes from the scan store, never
the request; screen numbers are validated; the settings go in a file because Windows Terminal
splits its arguments on `;`, even inside a quoted argument. For the same reason a project path
containing `;` is refused before anything is written (#20): the directory reaches `wt` as `-d` and
inside `--title`, and a folder's name is chosen by whoever made it. Any new argument to `wt` that
carries outside text needs the same check. Where `wt.exe` is not found, the same program and
arguments start in a console window instead (#157, `consoleStart`): Windows PowerShell 5.1 runs
`Start-Process` from `-EncodedCommand`, so no command line parses the values, each value is a
single-quoted literal (`psQuote`), the working directory's wildcard characters are escaped, and
the argument string follows the Windows rules (`winArgQuote`, which refuses a `"` rather than
escape one). Not `cmd /c start` (it re-parses `&`, `%`, `^`), not a detached spawn (a console
program gets no console), not `conhost.exe` (lost a program path with a space), and not .NET's
`Process.Start` (refused under Constrained Language Mode). Claude's own edits in a launched session
bypass LayerCake's snapshot-first rule, since they are Claude Code's writes, not LayerCake's.

**The processes LayerCake starts are few and fixed.** `launch.js` (wt.exe, or where it is missing
Windows PowerShell 5.1 from its absolute System32 path running one encoded `Start-Process`, hidden,
a 60 s timeout, #157), `summaries.js`
(`claude -p`), `desktop/window.js` (the app window: Edge or Chrome with `APP_FLAGS`, falling back to
`cmd /c start`, `open` or `xdg-open` with the URL alone), and `sessions.js`, which asks PowerShell
for process start times so a reused PID cannot pass for a running session (#1). The last runs one
`Get-Process` query from its absolute System32 path, pids validated as integers, a 5 s timeout, and
the output parsed as numbers only. The query returns each start time in both forms Claude Code
writes as `procStart` (a FILETIME from native claude.exe, .NET ticks from an npm install, told apart
at 3e17), matched within 1 ms (#82). Answers are cached per pid for 60 s, so a pid reused within
that minute still reads live until its entry refreshes (#83), and concurrent callers share the one
query in flight (#86). `policy.js` runs `reg.exe query <key> /v Settings` on the two
`Policies\ClaudeCode` keys during a scan, on Windows only (#147, owner decision 17): its absolute
System32 path, a fixed argv, both keys at once, a 5 s timeout, output capped at 2 MiB, read only,
the value parsed as JSON data. A smoke-only override may name other keys, and only keys under
`HKCU\Software\LayerCakeSmoke`. Any new spawn needs the same shape and a line here.

**Nothing may need a tool beyond Claude Code, LayerCake and what Windows itself ships** (owner,
2026-10-02: "I just don't want to assume anything about someone else's session. The castle should
work, along with the rest of the product, without any additional tools outside of Claude Code and
LC"). So no feature may need git, gh, Git Bash, PowerShell 7, a Node on PATH or anything else on
another person's machine: read files rather than run a tool (the scan reads `.git` as files; the
Sept, #186, reads `.git/HEAD` and refs the same way and never runs git), recognise a tool's use from
what Claude Code records rather than by calling it, and treat anything missing or unreadable as a
value that shows less, never as a failure. What Windows ships (Edge, Windows PowerShell 5.1,
`reg.exe`) is in bounds, and every spawn above has a fallback where it can be missing.

**Only `summaries.js` may spend Claude usage, and only on an explicit request.** Everything else
reads files. `claude` means `claude.exe` from PATH, or, for an npm install that provides only the
`claude.cmd` shim, node plus the script the shim names, started with no shell in between so the argv
is not re-parsed by cmd.exe (`resolveClaudeCommand`, #6; launch.js uses it too). The AI summary runs
`claude -p` with a fixed argv (Haiku, `--safe-mode`, `--tools ""`,
own system prompt, no session persistence, a budget cap), the digest on stdin, one run at a time
(the lock is taken before the first await), from a POST the UI sends only on a click. Every run that
finishes, succeeded or failed, is written to the usage ledger. The entry is written as "running"
before `claude` starts and replaced by the result, so a run the exe's shutdown cuts off (its drain
waits 30 s, a run may take up to 180 s) is left as "running", and `/api/usage` reports it as
interrupted, usage unknown (#3).
A `claude` that exits without reading stdin must not take the server down: `child.stdin` has an
error listener for exactly that, and smoke proves it with a stand-in claude (`LAYERCAKE_CLAUDE_CMD`).
Nothing automatic may call it; adding anything that does breaks the promise the README makes.

**The CSRF guard belongs on `/api` only, never on the HTML routes.** A top-level navigation carries
`Sec-Fetch-Site: cross-site` whenever the user arrives from a bookmark, a link, or the new tab page.
Guarding the HTML refuses the app itself; this was shipped once and broke the whole UI while an HTTP
test suite stayed green, because Node's `fetch` sends no `Sec-Fetch-*` headers. The session token is
what actually gates state change, and a hostile page cannot read our HTML to steal it.

**The Host guard is the opposite: every route, the HTML included, and first** (`hostGuard` in
`security.js`). A DNS rebinding page is same-origin with us as far as the browser knows, so it can
read the HTML and the token unless the server refuses a Host that is not `127.0.0.1:<port>` or
`localhost:<port>`. It does not repeat the CSRF-guard mistake, because a bookmark or link to this
server carries our own Host however the user arrived. Anything that calls the server must address it
by one of those two names. The CLI imports modules and never calls the API; the dev-only token read
of `/` and `/api/` proxy in `vite.config.js` use `127.0.0.1`, the proxy through `changeOrigin`,
without which the Host guard refuses it.

**Localhost only.** `HOST` is hardcoded `127.0.0.1`. No outbound requests exist anywhere; keep it
that way, including in the client.

**The app window runs with `--disable-extensions --disable-sync`** (`APP_FLAGS` in
`desktop/window.js`). The session token sits in our DOM, and the CSRF design rests on "a hostile page
cannot read our HTML". An extension is not a page, and a separate `--user-data-dir` profile does NOT
keep extensions out: Edge signs a new profile in to the Windows Microsoft account, turns sync on, and
sync installs the user's extensions. That was measured on this machine, including a shopping extension
with access to every URL. Removing either flag reopens it silently: nothing breaks, the UI works, and
a third party can read the token. `APP_FLAGS` also carries `--disable-features=msEdgeStartupBoost`
(#58), for a different reason: without it every close started a background Edge for the user's
default profile. Chromium honours only the last `--disable-features` on a command line, so another
feature goes into that same flag, comma separated, never into a second one.

**Errors are values, never throws.** `readForDisplay` and the scan functions return an error object
so one unreadable level degrades to a badge and the rest of the scan completes. A dead UNC share must
not hang a scan: every filesystem call goes through `withTimeout`. That is why `watch.js` polls a UNC
folder instead of binding `fs.watch` to it (#14): `fs.watch` opens its handle inside a synchronous
call with no timeout, and on a share at an unroutable address that blocked the event loop for 21 s.
A timed-out call is abandoned, not cancelled, and keeps a threadpool thread until the OS gives up, so
the scan and the watcher make their calls through `timedFsCall` in `sharegate.js`, one gate for the
whole process: a UNC share gets one call at a time, and none while an earlier one is still out (#55).
Before that, one scan of a project four folders deep on a dead share stranded all four threads, took
21 s, and left local calls waiting 11.8 s and failing as timeouts. Use it for any new call that can
reach a share, never a bare `withTimeout`. Raising `UV_THREADPOOL_SIZE` instead only moves the cliff:
every further level, and every scan running alongside, strands one more thread.

The gate is keyed by SERVER (`\\server`), not share, since a dead server with several shares in use
held one thread per share (#68). A mapped drive shares its server's key once the scan has resolved
it. Each call has one budget counted from when it is queued, and a call whose turn comes after its
budget is not made at all (#69). The file reader, the CLI's directory check, and the READS before
every write (the snapshot's stat and copy, the hash re-check, the conflict stat) go through it too
(#66), via `shareGatedCall`: gated on a share, made as-is locally. The writes themselves are not
gated. A timed-out write is abandoned, not cancelled, and could land after being reported as failed;
the gated reads before it are what make a dead share fail before any write starts.

A drive letter mapped to a share is polled the same way (#57), and the scan marks its root as a
share for the gate (`markNetworkRoot`), so its calls are gated too once it is known; the first
scan's own calls on it go ungated, because the drive is classified at the end. The scan detects it with Node's native
`realpath` of the drive root, which resolves a mapped drive to its `\\server\share` and spawns no
process; it records the result as `lineage.networkDrives`, and `watch.js` reads that rather than
asking again. A root that fails with anything but ENOENT counts as a network drive, because polling
is the side that fails safe (reasoned; a dead mapping was not produced to test it). Network verdicts are cached per drive letter for the life of the
process; local ones are re-asked on every scan, since a stale "local" is the dangerous one.

**A deleted folder must close its native watch at once.** On Windows, Node reports a watched
folder's own deletion by its full `\\?\` path and keeps reporting it, about 130,000 events a second
until the handle closes: 3.3 s of server CPU in 3 s, measured, from deleting one skill folder. `watch.js`
treats an absolute filename as that report and closes the watcher, except the one-separator form
`\ProgramData`, which is how Node names a child of a drive root: taking that for the root's own deletion
closed the watch on `C:\` at the first change inside it (#127). Smoke checks both the silence and
the server's CPU share after a deletion, because a watcher left open and silenced would pass the first,
and checks that a change inside the drive root leaves it watched. A folder renamed or moved sends no
such report and its watch follows it, naming its children under the old path (#76), so every event
from a folder's own watch waits for a check that the folder is still at its path with the file
identity (dev and ino) read when the watch started, and a watched parent's rename of it runs the
same check at once. Keep both routes: 31 of 78 watched folders on the owner's machine have no
watched parent.

**Merge rules are stated, not implied.** The settings precedence model is this tool's own, not
something read back from Claude Code. Any view that computes an effective value must ship the rule
that produced it in the same payload, and the UI must show it.

**Policy is derived and served, never copied.** `/api/manifest` exposes the write policy by reading
the same sets the guards consult (`writePolicy()` in safety.js), and the client reads it from there.
Do not hand-maintain a second list of editable categories in the client, in the manifest, or in the
README: `/api/manifest` exists so the tool's claims can be checked against its behavior, and a copy
makes that check meaningless the first time it drifts.

**A backup must never truncate.** Files over the 2 MB cap are skipped and recorded, not stored
partially. A truncated file restored is silent data loss.

## Conventions

- ESM throughout (`"type": "module"`), `node:` prefixed builtins. Node `^20.19.0 || >=22.12.0`, the
  floor Vite 7 sets for building the client; the exe embeds whatever Node built it.
- Comments explain *why*, especially for platform quirks. Match that density; it is deliberate.
  Windows-specific behavior (case folding, `UNKNOWN` errno on a dead share, ProgramData variants)
  gets a comment naming the quirk.
- Dependencies are deliberately few: express, js-yaml, react, react-markdown, and `diff` (jsdiff,
  the editor's review-before-save view, #16: Myers' diff is a solved problem, BSD-3, no dependencies
  of its own, client bundle only). Adding one needs a
  reason, and anything that could reach the network needs a strong one. Build-only dev dependencies
  follow the same rule; `resedit` (the exe's icon and version resource) was admitted because it and
  its one dependency import no Node builtin (no filesystem, no network), run no install script, and
  stay out of the exe's bundle.
- Windows is the first-class target; POSIX paths are handled but secondary. Nothing may assume a
  drive letter or a backslash.

## Known limits, stated rather than papered over

- **The executable acknowledgement is a speed bump, not a boundary.** It covers hook scripts, and
  settings or `.mcp.json` edits that add or change a key Claude Code runs (`COMMAND_KEYS` in
  safety.js, served in the manifest; #19, owner decision). It does not cover `env`, which can
  arrange execution indirectly (`NODE_OPTIONS`, `PATH`) but is edited routinely. It stops an
  absent-minded edit, not a determined one. A restore puts a hook back without it: it is the
  undo of an earlier state, not a new edit.
- **On a dead share the CLI answers in 3 s but its process lives about 21 s.** Windows does not finish
  a process while one of its threads is inside an SMB connect, and `process.exit` cannot shorten
  that (measured: exit called at 1 s, the process ended at 21.2 s). The message is on screen at
  3.2 s, not 21.3 s as before #66; the prompt returns when Windows gives up.
- **Paths are fenced lexically; junctions and symlinks are followed.** If `.claude/agents` (or
  `.claude` itself) is a junction, a create or save lands in its target, the way Claude Code reads
  it (#102). Whoever can plant a junction in a config folder can already write there. A link inside
  a tree (a skill folder that is a junction) is walked too, since Claude Code loads through it
  (measured, #144), and each file behind it names the link and says edits land in the target.
- **Case twins in a case-sensitive folder cannot be edited or deleted.** With `a.md` and `A.md` in a
  folder WSL or `fsutil` made case-sensitive, a snapshot keeps one of them (paths are folded on
  Windows), so a save or delete of either is refused rather than risk the other (#110).
- **An unreadable config home is exercised on Linux only.** Windows reports every local stand-in
  for a non-ENOENT stat error as ENOENT, so smoke skips that check there; a dead share was measured
  by hand (#108).
- **Hashing the stored copy (#100) is not observable in smoke.** It differs from hashing the source
  only if the source changes during the copy; a mutant that hashes the source again survives.
- **Snapshots contain files that can hold OAuth tokens** (`~/.claude.json`, `settings.local.json`,
  `.mcp.json`). They are flagged `sensitive` in the manifest rather than excluded, because dropping
  them would make a restore quietly incomplete. In place a snapshot inherits the same user ACL as
  the original; the exposure begins when someone copies it to a share or another machine.
- **A file can legitimately appear at two levels** when the project sits under the home directory,
  which on Windows is most of them. The lineage view shows both, which is correct; everything that
  reasons about distinct files must dedupe with `samePathKey` from paths.js. Getting this wrong
  produced a definition that shadowed itself, an instruction chain that printed the same file twice,
  and an MCP server (`context7`) reported as shadowing itself. All three were the same bug in the
  same file, and fixing two of them did not fix the third. **If you add a view, ask which of the two
  it needs, and check the others while you are there.** The fourth time it was a consumer: flatten
  kept every sighting for its clients to collapse, the CLI did and the page did not (#117). So the
  definitions and MCP views now collapse in flatten.js (`collapseRoutes`, the other routes in
  `alsoReachedFrom`), as the chain view already did, and a client renders what it is given rather
  than deduping again. The settings view lists such a file once too, and merges only the files
  Claude Code reads (#118, #119).

  Note the MCP key is `samePathKey(path)` **plus scope**, not path alone: `~/.claude.json` defines a
  server in both its global block and its per-project block, and that is a genuine shadow. Deduping
  on path alone there would hide a real one.
- **A local folder that is a symbolic link to a share is watched natively.** Network detection is
  per drive letter (#57), so `C:\proj\.claude\skills` linked to `\\server\skills` keeps the blocking
  risk polling exists to avoid (reasoned, not measured). A native `realpath` per watched folder would
  catch it, at one call per folder per stream. A link INSIDE a tree whose target is a UNC path is
  listed and not walked (#144; its target read with `readlink`, which never touches the share), so
  this limit is now only a tree's own root being such a link. That branch is reasoned: this user
  cannot make a directory symlink on Windows without Developer Mode, and Linux has no UNC.
- **The app window's profile is still signed in to the Windows Microsoft account.** The isolation
  flags stop sync and extensions; no flag found stops Edge attaching the account identity.
- **The exe follows the browser profile, through Chromium's `lockfile`** (#10). It stops when its
  own browser has exited AND no browser holds `<profile>\lockfile` (`profileInUse` in
  `desktop/window.js`), so a hand-off (an Edge already running on the profile takes the window, and
  ours exits within 5 s, `HANDOFF_MS`) now ends when that browser does, instead of never. Measured
  before and after: exe still up 12 s after the last window closed, then exiting about 0.7 s after it.
  This rests on an undocumented Chromium file that disappears when its browser process ends, a
  kill included (measured on Edge 154). If a Chromium stops keeping it, a hand-off falls back to the
  old behaviour, staying up, which is the safe side; an ordinary close is unaffected. It also means
  any browser on the profile keeps the exe up, an `npm run app` window on another port included.
- **A relaunch just as the last window closes used to open a window with no server** (4 of 4
  relaunches 0 to 0.3 s after the close, measured). Three parts, each exercised by an exe test that
  fails when that part is made a no-op (hand-off, takeover, dropped hand-off; the harness is not in
  the repository): the closing exe waits while the relaunch's browser holds the profile; a launch that
  attached to a running server keeps probing it for 5 s (`REATTACH_MS`) and takes over the port if
  it goes away, after which Edge's own retry reloads the window; and if the taking-over launch's
  window had been handed to a browser that has since exited (no browser holds the profile), it
  opens the window again. The third was found as 1 of 9 relaunches ending with a server and no
  window. On the final build, 18 of 18 relaunches 0 to 0.9 s after the close ended with a served
  window, and every process ended once that window closed.
- **A second launch that attaches to a running server lingers for `REATTACH_MS` (5 s)**, invisibly,
  before exiting. That is the cost of the fix above.
- **A browser exit within 5 s of launch is told apart by the lockfile** (#93). The exe looks for
  `<profile>\lockfile` while its browser starts (`watchForLock`, every 100 ms until the first
  sighting or `HANDOFF_MS`). Seen, and nothing holds the profile at the exit: the window was closed,
  and the exe stops. Never seen: this may be a Chromium that does not keep the file, where a hand-off
  also leaves the profile looking empty, so it keeps the old safe side and waits for a browser to
  appear, which may be never. Measured with the browser living 3.2 to 3.5 s: the exe exited 0.1 s
  after it, 2 of 2; with the sighting discarded (a mutant), still running 8 s later, 2 of 2. Before
  the fix a close 3.7 s after launch left the exe running. Under heavy load Edge can take over 5 s
  to close, and then the exit is past `HANDOFF_MS` and counts as a close anyway.
- **With no Edge or Chrome installed, the window falls back to the default browser**, in the user's
  own profile, so the `APP_FLAGS` invariant cannot hold there and the exe never sees the window
  close. Stated in the README rather than refused, because the alternative is no app at all.
- **The exe's shutdown waits for handlers, not connections** (`desktop/inflight.js`). `server.close()`
  alone returned while a snapshot was still running, because the browser's sockets die with it; a
  save, snapshot or multi-file restore was then cut off. The wait is capped at 30 s (`DRAIN_MS`).
- **The session view lags during a long reply.** Claude Code writes a main-thread transcript record
  when each API response completes, not while it streams (subagent files do stream). Context and
  the prompt rail catch up when the reply finishes.
- **"Waiting for you" exists only for sessions LayerCake launched.** A pending permission prompt is
  not in the transcript, and `sessions/<pid>.json` has only been seen reporting `busy`; the signal
  comes from the `Notification`/`PermissionRequest` hooks a launch installs. Answering a permission
  prompt fires no hook, so an approved long-running tool still reads as waiting until it finishes;
  the banner says so. The wait also ends when the transcript records that tool's result (#23).
- **A launched session's liveness comes from its reports.** Claude Code writes `sessions/<pid>.json`
  lazily (none 30 s after a launch, before any prompt; sessions with prompts on this machine had
  one), so without a pid file a launched session counts as running only while it reports, or has
  a wait or tool open. A crash while a prompt is open therefore reads as waiting until LayerCake
  restarts. Sessions launched before the refresh existed report only on activity and read as
  most likely stopped while idle.
- **Closing LayerCake under a launched session makes its hooks fail**, visibly: a "hook error" notice
  per event in that terminal. Claude does not see non-blocking hook errors, so it costs no tokens.
- **Plain Windows is checked in Windows Sandbox** (enabled on this machine; no Git Bash, no
  PowerShell 7, no Windows Terminal; README "Requirements"). There Claude Code 2.1.284 ran the
  launched status line's command under Windows PowerShell 5.1, its own choice (#11), and the console
  fallback opened it (#157). Map only scratch folders in, never a config or credential. A Claude Code
  that was never signed in exits at once without a network, even started directly, so a test of a
  launch needs the Sandbox's networking on.
- **The Castle sees less for a session LayerCake did not launch.** It reads that session's
  transcript, which Claude Code writes when each model response completes, so it has no "waiting
  for you" (no Herald) and runs a measured few seconds behind (shown per session). A compaction
  reaches it only once it is over (the transcript's boundary record), so that session's Scribe
  comes afterwards, for 2 s. A skill typed as
  `/name` fires no PreToolUse (docs), so it brings no Wizard. A file a shell command changes is not
  seen, only the files a tool call names. Searches light rooms by their `path` only; the matched
  files are not read. Each castle folds its latest 20,000 events (a refold of that many measured a
  median 18 ms under load) and says when older ones are left out. A unit walks only the room changes
  the page saw in its trail: more than 12 inside one push leaves the oldest out, and a subagent or
  session ending in the same push as its last calls walks out without them (README "Things to know").
- **The context window is inferred from the model id** (`contextWindow` in `health.js`, rule shipped
  with the payload): `[1m]` or a documented native-1M family is 1M, else 200K. A new model family
  needs adding there.
- **Session history is bounded by Claude Code's retention**, `cleanupPeriodDays`, default 30 days
  (the owner chose to keep it). Deleted sessions survive only as LayerCake's kept card or as
  prompts in `history.jsonl`.
- **Cards are written from a GET.** `/api/sessions` persists changed cards as a side effect, at most
  once a minute per session, so the index outlives the transcripts. It is a cache write, not a
  state change anyone requested, and a failure is reported in the payload rather than failing the
  list.

## When adding scan coverage

Add the target to the manifest in `server/paths.js`, not inline in `scan.js`. `GET /api/manifest`
serves that manifest to the UI so the tool's claims can be checked against its behavior, and a target
hardcoded elsewhere breaks that correspondence. Then update the README table for the level.
