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

## Commands

```
npm start          # build client if stale, then serve http://127.0.0.1:5178
npm run app        # same, then open a chromeless app-mode browser window
npm run cli -- here    # effective environment for the current directory
npm run dev:server # API only on 5178
npm run dev:client # Vite HMR on 5179, proxying /api to 5178
npm run smoke      # end to end over the real HTTP API
npm run build:exe  # dist\LayerCake.exe, the single executable (Windows only)
```

**Run `npm run smoke` before calling any change to `server/` done.** It is the only regression net.
It builds its own fixture, port and snapshot store, and cleans up after itself, so it is safe to run
while you are working. A green run is necessary and not sufficient: it cannot see the UI, and the
one bug it missed was found by opening a browser.

**Smoke never runs the exe.** It starts `server/index.js`, which serves `public/` from disk; the exe
serves an embedded copy through `desktop/main.js`. After touching `server/app.js`, `desktop/` or
`client/`, rebuild and launch the exe the way Explorer does (`Start-Process`, not from a console,
which would lend it one), then check that a window opens, the UI loads, and closing the window ends
`LayerCake.exe`. The exe prints nothing, so a failure there shows as an error window or as silence.

Env knobs: `PORT` (default 5178), `CLAUDE_EXPLORER_DIR_TIMEOUT_MS` (default 3000), and
`LAYERCAKE_SNAPSHOT_DIR` (default `%LOCALAPPDATA%\LayerCake\snapshots`).

`npm start` builds only when `public/index.html` is older than the newest file under `client/`, so a
change to `server/` alone does not trigger a rebuild and does not need one.

## Architecture

```
server/paths.js     platform paths, the scan manifest, snapshot root
server/safety.js    denylists, editable categories, size cap, timeout, errors
server/scan.js      lineage resolver -> ordered levels
server/readfile.js  the ONLY producer of a file body
server/flatten.js   the four flattened views
server/watch.js     directory watches over a scanned lineage; read-only, never opens a body
server/snapshot.js  capture, compare, restore, and the atomic write primitive
server/writefile.js the ONLY edit path; depends on snapshot.js by design
server/security.js  localhost CSRF guard and session token
server/app.js       express app, 127.0.0.1 bind, per-scan allowlist; builds, never listens on import
server/index.js     terminal entry: app.js serving public/ from disk, listens on load
client/             React 18 + Vite, two-pane explorer plus editor, snapshots and watch bar
cli/                layercake CLI, imports server modules directly
scripts/launch.js   build, serve, then open an app-mode browser window
desktop/window.js   the app window (browser, profile, isolation flags), shared by launch.js and main.js
desktop/main.js     single-executable entry: embedded client, exits when its window's browser does
desktop/build.mjs   vite + esbuild + SEA blob + postject + GUI subsystem -> dist\LayerCake.exe
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
`desktop/build.mjs` writes, to `public/` and `dist/`.

**Every write snapshots first, and that is structural.** `writefile.js` imports `snapshot.js`, not
the reverse, so a new route cannot skip the snapshot by forgetting to call it. Keep that direction.
Writes land via temp file plus rename in the same directory, so a crash leaves the old file or the
new one, never a half-written config that breaks every future session.

**The snapshot store must never live under `~/.claude`.** That tree is a restore target, and a
backup the restore can overwrite is not a backup. See `snapshotRoot()`.

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

**Watch events carry paths and verbs, never content.** `/api/watch` streams from whole directories,
so it necessarily sees files no scan entry covers. The moment a body rides along in that payload it
becomes a second file reader that skips both the allowlist and the credential refusal. Keep it a
notifier; reading stays on `/api/file`. The filter deciding which events reach the client is
likewise read from the scan result and the manifest rather than kept as its own list, for the same
reason the write policy is: a hand-maintained copy drifts and quietly stops matching what the scan
actually treats as config.

**The CSRF guard belongs on `/api` only, never on the HTML routes.** A top-level navigation carries
`Sec-Fetch-Site: cross-site` whenever the user arrives from a bookmark, a link, or the new tab page.
Guarding the HTML refuses the app itself; this was shipped once and broke the whole UI while an HTTP
test suite stayed green, because Node's `fetch` sends no `Sec-Fetch-*` headers. The session token is
what actually gates state change, and a hostile page cannot read our HTML to steal it.

**Localhost only.** `HOST` is hardcoded `127.0.0.1`. No outbound requests exist anywhere; keep it
that way, including in the client.

**The app window runs with `--disable-extensions --disable-sync`** (`APP_FLAGS` in
`desktop/window.js`). The session token sits in our DOM, and the CSRF design rests on "a hostile page
cannot read our HTML". An extension is not a page, and a separate `--user-data-dir` profile does NOT
keep extensions out: Edge signs a new profile in to the Windows Microsoft account, turns sync on, and
sync installs the user's extensions. That was measured on this machine, including a shopping extension
with access to every URL. Removing either flag reopens it silently: nothing breaks, the UI works, and
a third party can read the token.

**Errors are values, never throws.** `readForDisplay` and the scan functions return an error object
so one unreadable level degrades to a badge and the rest of the scan completes. A dead UNC share must
not hang a scan: every filesystem call goes through `withTimeout`.

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

- ESM throughout (`"type": "module"`), Node >= 18, `node:` prefixed builtins.
- Comments explain *why*, especially for platform quirks. Match that density; it is deliberate.
  Windows-specific behavior (case folding, `UNKNOWN` errno on a dead share, ProgramData variants)
  gets a comment naming the quirk.
- Dependencies are deliberately few: express, js-yaml, react, react-markdown. Adding one needs a
  reason, and anything that could reach the network needs a strong one.
- Windows is the first-class target; POSIX paths are handled but secondary. Nothing may assume a
  drive letter or a backslash.

## Known limits, stated rather than papered over

- **Blocking hook edits is a speed bump, not a boundary.** `settings.json` can define hooks inline
  and is an ordinary editable file, so anyone who can write settings can arrange execution without
  touching a hook script. The acknowledgement stops an absent minded edit, not a determined one.
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
  it needs, and check the others while you are there.**

  Note the MCP key is `samePathKey(path)` **plus scope**, not path alone: `~/.claude.json` defines a
  server in both its global block and its per-project block, and that is a genuine shadow. Deduping
  on path alone there would hide a real one.
- **The app window's profile is still signed in to the Windows Microsoft account.** The isolation
  flags stop sync and extensions; no flag found stops Edge attaching the account identity.
- **The exe stops with its window only when it launched the browser process.** If an Edge for the
  LayerCake profile is already running, Edge takes the window and the exe cannot see it, so it stays
  up (the safe side: a live window with a server) until the next launch reuses it or Task Manager
  ends it. The hand-off is recognised as a browser exit within 5 s of launch (`HANDOFF_MS`).

## When adding scan coverage

Add the target to the manifest in `server/paths.js`, not inline in `scan.js`. `GET /api/manifest`
serves that manifest to the UI so the tool's claims can be checked against its behavior, and a target
hardcoded elsewhere breaks that correspondence. Then update the README table for the level.
