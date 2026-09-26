# LayerCake

A local tool for seeing and managing the Claude Code configuration inheritance lineage: what is
inherited, from where, and in what order. Browse every level, edit the files, and snapshot or
restore the whole environment. Useful mostly when moving between projects, when the answer to "which
CLAUDE.md is actually winning here" is not obvious.

Built and verified against **Claude Code 2.1.229 on Windows 11**. POSIX paths are handled, but
Windows is the first-class target.

```
npm install
npm run app        # build if stale, serve, and open a chromeless app window
npm start          # same without the window: http://127.0.0.1:5178
npm run build:exe  # one-file Windows app, no Node needed to run it: dist\LayerCake.exe
```

Open the app, type a project directory, press Scan.

Two surfaces, split by the job they do:

| | For |
|---|---|
| **Browser UI** | Anything you read with your eyes: the level tree, the flattened chains, editing, restore with a per-file diff. |
| **CLI** (`layercake`) | One-shot answers and scriptable operations. `layercake here` prints the effective environment for a directory in about 20 lines. |

The CLI imports the server modules directly rather than calling the HTTP API, so it works with no
server running.

```
layercake here [dir]              effective environment, the switching-projects command
layercake tree [dir] [--all]      full lineage; --all also shows probed-but-absent paths
layercake show <view> [dir]       claude-md | settings | definitions | mcp
layercake backup [dir] [--label]  take a snapshot
layercake snapshots               list them, newest first
layercake diff <id> [dir]         compare a snapshot against disk
layercake restore <id> [dir]      dry run by default; --yes to write, --only to filter
layercake session [dir] [--list]  the current Claude Code session here: state, context, memory loaded
```

A terminal UI was considered and rejected. The level tree and the provenance tables are wide,
high-density comparison surfaces, and they degrade badly at 80 columns.

---

## What it scans

Levels are numbered from `00` (weakest precedence) downward to the project directory (strongest).
Every level is rendered even when empty, and every probed-but-absent path is recorded, so you can
see what was looked for and did not exist.

### 00 Managed / enterprise settings

Existence-probed on all three platforms, never assumed:

```
%ProgramData%\ClaudeCode\managed-settings.json
%ProgramData%\Claude Code\managed-settings.json
%ProgramFiles%\ClaudeCode\managed-settings.json
/Library/Application Support/ClaudeCode/managed-settings.json    (macOS)
/etc/claude-code/managed-settings.json                           (Linux)
```

### 01 User / home

```
~\.claude\settings.json
~\.claude\settings.local.json
~\.claude\CLAUDE.md
~\.claude\CLAUDE.local.md
~\.claude\.mcp.json
~\.claude\keybindings.json
~\.claude\agents\**\*.md          (depth 2)
~\.claude\skills\**               (depth 3, .md .json .yaml .yml)
~\.claude\commands\**\*.md        (depth 3)
~\.claude\hooks\**                (depth 2, any extension)
~\.claude\rules\**\*.md           (depth 2)
~\.claude\memory\**\*.md          (depth 2)
~\.claude.json                    flagged sensitive
~\CLAUDE.md                       flagged: only inherited when the project sits under home
```

### 02 Plugins

```
~\.claude\plugins\installed_plugins.json
~\.claude\plugins\known_marketplaces.json
~\.claude\plugins\blocklist.json
~\.claude\plugins\cache\<marketplace>\<plugin>\<version>\{agents,skills,commands,hooks,rules,memory}
~\.claude\plugins\cache\<marketplace>\<plugin>\<version>\.claude-plugin\plugin.json
```

### 03 Project memory (home-stored)

```
~\.claude\projects\<mangled-path>\memory\**\*.md
```

The slug is the absolute path with `\`, `/` and `:` replaced by `-`, so `C:\dev\LayerCake` becomes
`C--dev-LayerCake`. This is context injection rather than a settings-precedence level, and the UI
says so.

### 04+ The directory walk

Every directory from the filesystem root down to the project directory. For each one:

```
<dir>\CLAUDE.md
<dir>\CLAUDE.local.md
<dir>\AGENTS.md
<dir>\.mcp.json
<dir>\.claude\settings.json
<dir>\.claude\settings.local.json
<dir>\.claude\CLAUDE.md
<dir>\.claude\CLAUDE.local.md
<dir>\.claude\.mcp.json
<dir>\.claude\keybindings.json
<dir>\.claude\agents\**\*.md
<dir>\.claude\skills\**
<dir>\.claude\commands\**\*.md
<dir>\.claude\hooks\**
<dir>\.claude\rules\**\*.md
<dir>\.claude\memory\**\*.md
<dir>\.claude\<anything else>      listed under "other", never parsed, never recursed
```

The walk terminates at a drive root, a UNC share root (`\\server\share`), or 64 hops.

### Never touched

```
.credentials.json    credentials.json    .env    .env.local
```

Excluded at scan time by basename and refused again at read time. They cannot be opened through the
API even by direct request.

Runtime-state directories are listed but never recursed into, because they are large and hold no
config: `worktrees`, `sessions`, `projects`, `shell-snapshots`, `cache`, `debug`, `file-history`,
`backups`, `paste-cache`, `session-env`, `tasks`, `jobs`, `ide`, `daemon`, `chrome`, `statsig`,
`todos`, `logs`, `node_modules`, `.git`.

---

## Flattened views

Four chains, each stating its own merge rule in the UI rather than leaving it implied.

| View | What it shows |
|---|---|
| **CLAUDE.md chain** | `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`, `MEMORY.md` concatenated top to bottom with per-level headers. Individual per-project memory files are excluded: they are recalled on demand, not loaded every session, and sweeping in 60+ of them would bury the actual instruction set. |
| **settings.json chain** | Every settings file in precedence order, plus a computed effective merge and a table naming the level that won each key. |
| **Agents & skills** | Definitions grouped by declared name (frontmatter `name`, else filename or skill folder), showing which level's version shadows the others. |
| **MCP servers** | Every `.mcp.json` on the chain, plus the global and per-project `mcpServers` blocks in `~/.claude.json`, with shadowed definitions flagged. |

The settings merge is **this tool's model**, not something read back out of Claude Code: applied
weakest to strongest (user, then root down to project, `settings.json` before `settings.local.json`),
with managed settings applied last so they win. `permissions.allow` / `deny` / `ask` /
`additionalDirectories` are unioned; everything else is overridden. The UI states this above the
result so a wrong assumption is visible rather than silent.

---

## Write posture

The app reads the whole lineage and can edit the files it found. Writes are narrow and guarded.

- **Every mutating filesystem call lives in `server/snapshot.js`.** `server/writefile.js` is the
  policy layer (what may be written, validated how) and delegates the actual write to
  `snapshot.js#atomicWrite`; it contains no `fs` mutation of its own. Everything else in `server/`
  stays on `readFile`, `readdir`, `stat`, `lstat` and `fs.open(path, 'r')`. Audit it:
  ```
  rg -n "fs\.(writeFile|appendFile|mkdir|rm|rmdir|unlink|rename|copyFile|chmod|chown|utimes|createWriteStream)" server/
  ```
  At the time of writing every hit is in `snapshot.js`. `writefile.js` is the only other module
  permitted to appear there.
- **Only files the current scan discovered can be written.** The scan result is the allowlist, and
  it supplies the file's category, so a request cannot relabel a hook to dodge a guard.
- **Every write is preceded by an automatic snapshot**, and the response carries that snapshot id so
  the change can be undone. This is enforced by the import graph: `writefile.js` depends on
  `snapshot.js`, so a new route cannot skip it by forgetting.
- **Writes land atomically**, via a temp file in the same directory followed by a rename. A crash
  leaves either the old file or the new one, never a half-written config.
- **Structural validation before the write, with a deliberate severity split.** Invalid JSON or YAML
  is refused outright, because a malformed settings file degrades every future session. Malformed
  markdown frontmatter is a warning and the write proceeds, because it breaks one definition and
  leaves the rest working.
- **Concurrent edits are detected.** The editor sends the mtime it loaded; a mismatch returns 409
  rather than silently winning the race against your other editor.
- **Credential files can be neither read nor written**, refused at scan time, at read time and at
  write time.
- **Executable config requires acknowledgement.** Hook files are executed by Claude Code rather than
  read, so saving one needs an explicit confirmation. Be clear about what this is worth: it is a
  speed bump, not a boundary, because `settings.json` can define hooks inline and is an ordinary
  editable file.

Claude Code loads memory and settings at session start, so an edit does not reach a session that is
already running. The UI says so after every save rather than leaving you to wonder.

### What is editable

Categories `memory`, `settings`, `mcp`, `agent`, `skill`, `command` and `hook`. The `other` category
is excluded on purpose: it is the bucket for files the scan lists but does not understand, and
editing an unclassified file is how you corrupt something structured.

This list is served by `GET /api/manifest`, derived from the same sets the guards consult, and the
UI reads it from there. There is no second copy to drift.

## Snapshots

A snapshot is a mirrored directory tree plus a `manifest.json`, not an archive format. If this tool
is broken or gone, recovery is File Explorer and copy/paste.

```
%LOCALAPPDATA%\LayerCake\snapshots\<id>\manifest.json
%LOCALAPPDATA%\LayerCake\snapshots\<id>\files\C\Users\you\.claude\settings.json
```

Override the location with `LAYERCAKE_SNAPSHOT_DIR`. It is deliberately **not** under `~/.claude`:
that tree is a restore target, and a backup the restore can overwrite is not a backup.

- Captures every file the scan found, deduplicated by path. A file can legitimately appear at two
  levels when the project sits under your home directory; the lineage shows both, the snapshot
  stores one.
- Runtime-state directories and credential files are excluded, as they are from the scan itself.
- **Files over the 2 MB cap are skipped and recorded, never truncated.** A truncated file restored
  is silent data loss.
- Restore is selective: pick a snapshot, see a per-file comparison against disk right now
  (`same` / `changed` / `missing` / `error`), then choose what to put back. Changed files are
  preselected; identical ones are not, because restoring them is a write with no effect.
- **A restore takes its own snapshot first**, so it is itself undoable.

> **Snapshots can contain secrets.** `~/.claude.json`, `settings.local.json` and `.mcp.json` are part
> of the lineage and can hold OAuth tokens. They are flagged `sensitive` in the manifest rather than
> excluded, because dropping them would make a restore quietly incomplete. In place a snapshot
> inherits the same permissions as the originals. The exposure starts when you copy one to a share,
> a USB stick, or another machine.

## Watching for changes

Once a scan has run, LayerCake watches the directories that scan touched and tells you when
something changes underneath you. A thin bar under the header carries the state at all times:

| Bar | Meaning |
|---|---|
| `Watching 65 folders` | Live. The count is directories, not files. |
| `Watching 65 folders (6 not watched)` | Live with gaps. Hover for the list and the reason. |
| `4 files changed on disk` | Something changed. Offers **Rescan** and **Dismiss**. |
| `Not watching for changes` | The stream is down, with the reason. |

The idle state is deliberate. A watcher that only appears when something happens cannot tell you it
is working, so a blank bar would be ambiguous between "nothing changed" and "nothing is watching".
The gap count is there for the same reason: silently skipping an ancestor would turn "no events"
into false reassurance.

**Nothing re-scans on its own.** A scan replaces the lineage, which would swap the file under an
open editor and discard whatever was typed into it. The bar reports and you decide; if the editor
has unsaved work, Rescan asks again before discarding it.

**What raises an event.** A path the scan already knows about, present or absent, plus any new file
inside one of the `.claude/` subtrees (`agents/`, `skills/`, `commands/`, `hooks/`, `rules/`,
`memory/`), where the set of valid names is open-ended. A `CLAUDE.md` that does not exist yet is
still a path the scan probed, so its creation is reported.

**What does not.** Runtime state living beside the config, which is most of `~/.claude`:
`history.jsonl`, `daemon.log`, `backups/`, `sessions/`, `projects/`. Claude Code rewrites these
continuously while a session is running, and an unfiltered bar is lit permanently and says nothing.
Lock files and atomic-write temporaries are dropped for the same reason; the rename that publishes
such a write still raises an event naming the real file. The filter is read from the scan result and
the manifest rather than kept as a second list, so a target added to `paths.js` starts being watched
with no other change.

LayerCake's own saves and restores are suppressed for two seconds, so the bar stays a report of what
happened *outside* this window.

**Desktop notifications** are opt-in behind the **Notify me** button, and fire only when the window
is in the background. `127.0.0.1` counts as a secure context, so this needs no HTTPS. The toast is
attributed to the browser rather than to LayerCake, because app identity requires a registered
application.

Implementation notes that matter if you change this:

- **Directories are watched, not files.** A per-file watch binds to the inode behind the file, and
  an atomic save replaces that inode, so it would go deaf on exactly the event it exists to catch.
- **Non-recursive.** The scan already reports every directory that holds something, so a recursive
  watch would only subscribe to the runtime state the scan is careful to skip.
- **UNC paths are not watched.** `fs.watch` opens its handle eagerly and takes no timeout, so
  binding one against a dead share can block the event loop. Every other filesystem call here is
  wrapped in `withTimeout`; this one cannot be, so it declines and says so in the gap list.
- Events carry a path and a verb, never file content. Reading a body still goes through `/api/file`
  and its allowlist check.
- The client reads the stream with `fetch` and a stream reader, not `EventSource`, because
  `EventSource` cannot set a request header and the session token is not going in a query string.

Known: `~/.claude.json` is a real member of the lineage and Claude Code rewrites it every few
seconds during a session, so it appears in the bar often. It is reported rather than filtered
because it genuinely is config the tool tracks, and hiding a tracked file would be the worse lie.

## Sessions

The **Sessions** tab shows Claude Code sessions: every one still on disk for the scanned project
(or for all projects), newest first, with the running ones marked. For the selected session:

- **Summary card:** its title (yours, else the one Claude Code generated, else the first prompt),
  Claude Code's own "while you were away" recaps, and counts: prompts, tool calls and failures,
  files edited, subagents, compactions, API errors, tokens.
- **Prompt rail:** every prompt, slash command and `!` shell line, filterable; pick one to read the
  prompt, the reply (rendered as markdown), its tool calls and its subagents.
- **Context gauge:** tokens in use against the model's window, estimated from the last API call.
  The window comes from the model id, and the rule saying how is shown on hover.
- **Memory this session loaded:** the CLAUDE.md and auto-memory files Claude Code recorded loading,
  at start or later on entering a folder. The Explorer tree shows the same thing as a badge on each
  memory file (loaded, loaded later, not loaded), from the running session in the scanned
  directory, else the latest one, and names any file loaded that the lineage did not predict.
- **Health glow:** the session pane's border glows by state (working, idle, context high, error,
  not running), always with a text label as well. The rules are served with the data and shown on
  hover. A running session is followed live.
- **Other sections:** subagents with status and tokens, skills invoked, compactions, errors and
  model fallbacks, files edited, and how the transcript was read (see below).

Where it comes from, and what that means:

- **Transcripts** under `~/.claude/projects/<project>/<session>.jsonl`, which Claude Code writes as
  it runs. Anthropic documents their format as internal and liable to change in any release, so
  every record type this build does not recognise is counted and listed under "Transcript read"
  rather than dropped. A new Claude Code version that changes the format shows up there first.
- The main transcript is written when each API response completes, so during a long reply the
  view lags until it finishes. Subagent files are written as they stream.
- **Retention:** Claude Code deletes a transcript after `cleanupPeriodDays` (default 30) without
  activity. LayerCake keeps a small summary card for every session it has listed, so a deleted
  session stays in the list ("Kept after deletion"), with its card but no prompts or replies.
- **Prompt history only:** `~/.claude/history.jsonl` keeps every submitted prompt, across projects,
  long after transcripts are gone. Sessions known only from there are listed with their prompts and
  nothing else. Anything you pasted into a prompt is stored there too, and never leaves the server.
- **Running sessions** come from `~/.claude/sessions/<pid>.json`. Each has a sibling `.key` file,
  which is a secret and is never opened.

**Usage.** Everything above reads files and spends no Claude usage. The one exception is the
**Summarize with AI** button: on a click, and only then, it runs `claude -p` on Claude Haiku 4.5
over the session's prompts and visible replies, stripped of Claude Code's own context (no tools,
MCP servers, CLAUDE.md or plugins) so the call carries little besides the session. An estimate is
shown before; the actual usage Claude Code reports is recorded after. Measured: a small session cost
$0.004 at list price (1,091 tokens in, 583 out), and summarizing all 42 sessions on this machine once
was estimated at under a dollar. On a subscription this draws on your plan limits, not a bill. Every
run is listed in "LayerCake's own Claude usage", kept apart from the sessions it summarizes.

### Starting Claude from LayerCake

**Start Claude here** (Sessions tab, after a scan) opens a Windows Terminal tab running Claude Code in
the scanned directory, beside the LayerCake window:

```
wt -w LayerCake --pos <right half> new-tab --title "Claude: <project>" -d <project>
   claude --session-id <new id> --settings <per-session settings file>
```

The settings file applies to that one session only (Claude Code documents `--settings` as a level
that "lasts one session and doesn't write to any file"); your own settings are never touched. It
adds two things:

- **A status line** that forwards Claude Code's status JSON to LayerCake with `curl.exe` and prints
  the line LayerCake sends back (`LayerCake · ctx 42% · $1.23 · 5h 12% · cache warm`) under the
  prompt. This is the only source of exact context use, cost, the 5-hour and weekly plan limits
  (Pro and Max) and prompt-cache warmth.
- **HTTP hooks** for the documented events (prompt submitted, tool start and finish, permission
  requests, notifications, subagents, compaction, instructions loaded, session end). These make
  **"Waiting for you"** possible: a permission prompt or an idle prompt turns the session's glow
  amber until Claude moves again. They also show tools running right now, and why each memory
  file loaded (at start, a path-glob match, an include, a nested folder, after compaction).

**Zero tokens, measured.** A status line is displayed, never sent to the model, and every hook is
answered with an empty 204, which Claude Code treats as "success, no output". The same one-line
prompt run with and without the settings file used exactly the same input (44,007 tokens each),
and the second run read its whole prompt from cache, which a single changed byte would have
prevented. The session view also shows "Context added by hooks this session", which should stay 0.

Things to know:

- The launched session appears in the list after its first prompt, when Claude Code first writes
  its transcript.
- If LayerCake is closed while that session keeps running, each hook shows a "hook error" notice in
  the terminal. Claude does not see those notices (they are non-blocking errors), and the session
  works normally. A restarted LayerCake picks the reporting back up.
- The status line runs through Git Bash when installed, as Claude Code does it; `curl.exe` ships
  with Windows 10 and later.
- The window placement is approximate: Windows Terminal sizes in character cells, not pixels.
- Workspace trust not yet accepted, `--safe-mode`, or a managed hook policy silence both channels;
  the session view says so rather than showing stale numbers.

LayerCake's own data (summary cards, AI summaries, the usage ledger) lives in
`%LOCALAPPDATA%\LayerCake\data`, never under `~/.claude`. Override it with `LAYERCAKE_APPDATA_DIR`,
and the Claude data folder read for sessions with `LAYERCAKE_CLAUDE_DATA_DIR`.

## Network posture

- Binds `127.0.0.1` only, never `0.0.0.0`.
- No outbound requests. Nothing is sent anywhere. LayerCake starts two kinds of process, both on
  your click: `claude -p` for an AI summary, and Windows Terminal running `claude` for **Start
  Claude here** (see [Sessions](#sessions)).
- `/ingest/<launch>/<secret>/…` accepts the status line and hooks of a session LayerCake launched.
  It is outside `/api` because its callers are Claude Code processes, not the page: instead of the
  page token it needs that launch's secret (compared in constant time), refuses any request
  carrying an `Origin` header (a browser always sends one; Claude Code does not), and is behind the
  Host guard like everything else. What arrives is kept in memory, reduced to tool names and
  one-line summaries.
- Session routes serve prompts and replies, so they accept only a session id the server itself
  discovered on disk, never a path, the same way file routes accept only what a scan found.
- `/api/file` and `/api/write` only touch a path the preceding scan discovered. The scan result *is*
  the allowlist, so neither is a general-purpose file reader or writer even though the scan input is
  a directory you type. Requests outside it return 403.
- **Every `/api` route requires a session token**, generated per server start and injected into the
  served HTML. A cross-origin page cannot read that HTML, so it cannot obtain the token.

  This matters because writes changed the threat model. While the app was read-only, a hostile page
  could send requests but not read replies, and a JSON POST triggers a CORS preflight that fails, so
  exposure was near nil. A cross-origin form POST is a "simple request": no preflight, it just
  fires, and the attacker never needs to read the response, because the write already happened.
- The token and origin checks are scoped to `/api` and **not** to the HTML routes, because a
  top-level navigation from a bookmark or a link legitimately carries `Sec-Fetch-Site: cross-site`.
  Guarding the HTML refuses the app itself. The HTML sends `X-Frame-Options: DENY`.
- **Every route, HTML included, refuses a `Host` header other than `127.0.0.1:<port>` or
  `localhost:<port>`.** That closes DNS rebinding: a hostile site re-points its own hostname at
  127.0.0.1, after which the browser treats this server as that site and would let its page read the
  HTML and the token in it. The Host header still names the hostile site, so the request is refused.
  Nothing legitimate is affected: the only HTTP client is the LayerCake page itself (the CLI calls the
  server modules directly), and a bookmark to `http://127.0.0.1:5178` sends the right Host.
- None of this defends against a hostile process already running as you. It can write these files
  directly and does not need this app. The guard closes the browser path only.
- **The app window runs with `--disable-extensions --disable-sync`.** A browser extension is not a
  page and is not bound by "a cross-origin page cannot read our HTML": a content script reads the
  DOM, token included. A separate browser profile does not keep extensions out on its own. On a
  machine signed in to Windows with a Microsoft account, Edge signs a new profile in to that account
  and turns sync on, and sync installs your extensions into it. That happened here: four synced
  extensions, one a shopping extension with access to every URL. With both flags, no installed
  extension runs and nothing syncs. Edge's own built-in components (PDF viewer, WebRTC and the like)
  still load, as part of the browser. What the flags do not stop is Edge attaching the Windows
  account identity to the profile, which is the browser talking to Microsoft, not LayerCake talking
  to anything.

## Failure handling

Unreadable paths degrade to an error badge on the affected level; the rest of the scan completes.

| Case | Behavior |
|---|---|
| Nonexistent directory | Each missing ancestor gets an `ENOENT` error badge, scan still returns |
| Dead UNC share | 3 s per-operation timeout, level marked unreachable, no hang |
| Permission denied | `EACCES` / `EPERM` badge on the level, other levels unaffected |
| Malformed JSON | Parse error banner plus the raw text |
| Malformed YAML frontmatter | Parse error banner plus the raw block, markdown body still renders |
| File over 2 MB | Read capped at 2 MB with a truncation notice; JSON parsing is skipped |

Configurable via env: `PORT` (default 5178), `CLAUDE_EXPLORER_DIR_TIMEOUT_MS` (default 3000),
`LAYERCAKE_SNAPSHOT_DIR`, `LAYERCAKE_APPDATA_DIR`, `LAYERCAKE_CLAUDE_DATA_DIR` (default `~/.claude`,
for session data only).

## Layout

```
server/
  app.js         express app, localhost bind, per-scan allowlist, routes; never listens on import
  index.js       entry for npm start and the launcher: serves public/ from disk
  security.js    localhost CSRF guard and per-start session token
  scan.js        lineage resolver
  paths.js       platform paths, the scan manifest, snapshot root
  readfile.js    the only file-body reader
  writefile.js   the only edit path; depends on snapshot.js by design
  snapshot.js    capture, compare, restore, and the atomic write primitive
  flatten.js     the four flattened views
  watch.js       filesystem watcher: directory watches, debounce, config filter
  safety.js      denylists, editable categories, size caps, timeouts, errors
  transcript.js  the only transcript reader: records to a normalized session model
  jsonl.js       follows an append-only JSON Lines file by byte offset
  sessions.js    session discovery (the allowlist), running sessions, retention
  history.js     prompt history; pasted content never leaves it
  health.js      session health state, with its rules
  summaries.js   free summary cards; the opt-in AI summary (claude -p)
  appdata.js     LayerCake's own data store, written through atomicWrite
  session-routes.js  /api/sessions, /api/session/*, /api/history, /api/usage
  launch.js      Start Claude here: Windows Terminal + per-session --settings
  ingest.js      status line and hook posts from launched sessions
client/          React UI: explorer, viewers, editor, snapshots, watch bar, sessions
cli/             the layercake CLI, importing server modules directly
scripts/
  start.js            build-if-stale, then serve
  launch.js           build, serve, wait for ready, open an app-mode window
  install-shortcut.ps1  per-user Start Menu shortcut (-Desktop, -Uninstall)
  smoke.mjs           end to end test over the real HTTP API
  smoke-sessions.mjs  its session part: a synthetic Claude data folder and checks
desktop/
  window.js      the app window: browser, profile, isolation flags, error page
  main.js        entry of the single executable
  inflight.js    running-request count, so shutdown waits for a save to finish
  build.mjs      npm run build:exe
layercake.cmd    double-clickable entry point for the shortcut
```

`GET /api/manifest` returns the live scan manifest and the live write policy, both derived from the
code that enforces them, so what the app claims can be checked against what it does.

## Running it as a Windows app

`npm run app` (or `layercake.cmd`, or the Start Menu shortcut) builds if stale, starts the server,
waits until it actually answers, then opens it in Edge or Chrome **app mode**: a chromeless window
with its own taskbar entry that looks like a desktop app and costs no extra dependency. The browser
gets a profile of its own under `%LOCALAPPDATA%\LayerCake\browser`, so the window does not join your
running browser or its session, and it runs with extensions and sync switched off (see
[Network posture](#network-posture) for why the profile alone was not enough).

If the port is already answering, it opens a window against the running instance instead of starting
a second server.

```
powershell -ExecutionPolicy Bypass -File scripts\install-shortcut.ps1            # Start Menu
powershell -ExecutionPolicy Bypass -File scripts\install-shortcut.ps1 -Desktop   # and Desktop
powershell -ExecutionPolicy Bypass -File scripts\install-shortcut.ps1 -Uninstall
```

Per-user, so no elevation. Electron and Tauri were rejected: about 150 MB and a build story for the
first, a Rust toolchain for the second, to gain a window this already provides.

### Single executable

```
npm run build:exe      # -> dist\LayerCake.exe, about 87 MB
```

One file holding a Node runtime, the server and the client, built with Node's single executable
application (SEA) support. Copy it anywhere and double-click it: no Node install, no source folder,
no console window. It opens the same app-mode window as `npm run app`, and **closing the last
LayerCake window stops it**, after letting a save or restore that was still running finish. A second
double-click while it is running, or at the same moment, opens another window on the same server
rather than starting a new one.

The build runs `vite build`, bundles the server into one script with esbuild, embeds `public/` as
assets, injects the result into a copy of the `node.exe` that ran the build, and marks the copy a
Windows GUI program so no console appears. Rebuild after any change, including to `client/`.

What to know:

- **It prints nothing.** A GUI program has no console. A failure to start (usually the port) opens
  an error window saying what to do; an unexpected crash opens one with the stack. For anything
  deeper, run `npm run app` from a terminal, which is the same server with its output visible.
- **Another port:** `$env:PORT = 5200; & 'C:\path\to\LayerCake.exe'`. The browser keeps the
  remembered directory per port, so a different port starts without it.
- **It is unsigned.** Fine on the machine that built it. Downloaded onto another machine (so marked
  as coming from the internet), SmartScreen will warn on first run.
- **The CLI is not in it.** `layercake here` still runs from source (`npm run cli -- here`).
- **One case keeps it running after the window closes.** If an Edge for the LayerCake profile is
  already running (a window left open after the server was killed, say), Edge takes the new window
  itself and the exe can no longer see it, so it stays up rather than leave that window without a
  server. The next launch finds it and reuses it; Task Manager ends it.
- **Without Edge or Chrome** (Edge can be uninstalled in the EEA), it falls back to your default
  browser: a normal window in your normal profile, where your extensions run and can read the page,
  including the session token. It also cannot tell when that window closes, so it keeps running.
- Its taskbar entry and toasts belong to Edge, not LayerCake, as with `npm run app`. The exe keeps
  node.exe's icon and version resource, so Task Manager describes it as "Node.js JavaScript
  Runtime"; look for `LayerCake.exe` by name.

## Development

```
npm run dev:server     # API on 5178
npm run dev:client     # Vite with HMR on 5179, proxying /api
npm run smoke          # end to end test over the real HTTP API
npm run build:exe      # the single executable, see above
```

`npm run smoke` creates its own fixture tree, starts a server on its own port with its own snapshot
store, drives the real HTTP API, and removes everything it made. It needs no framework and adds no
dependency.

It exists because this code can fail **silently**. A CSRF guard applied one route too widely once
left every HTTP assertion green while the real app refused to load in a browser, since Node's
`fetch` sends no `Sec-Fetch-*` headers and a genuine navigation does. The suite now covers that
case, and it greps the finished snapshot tree for a credential sentinel with a positive control, so
a clean result cannot be a false clean.
