# HANDOFF

Working state for picking this up in a new session. **Disposable.** Durable rules live in
`CLAUDE.md`, user-facing spec in `README.md`. If something here contradicts those, they win and this
file is stale.

Last verified: **2026-09-25**. Write/snapshot work was done 2026-09-05; file watching 2026-09-15;
the single executable and the app-window isolation fix 2026-09-25 (see "2026-09-25" below).

---

## Where things stand

LayerCake went from a read-only lineage viewer to a read-write manager. Everything below is built
and verified. Nothing is half-finished or knowingly broken.

**Start here to confirm the state yourself, before trusting a word of this file:**

```
npm run smoke                       # expect: 0 failed
node cli/index.js here C:\dev\LayerCake   # expect: ~18 line summary, exit 0
```

Both were green on 2026-09-15.

The watch feature also has a mutation check worth re-running if you touch `server/watch.js`. Make
the watcher a no-op that still executes (in `flush()`, compute `batch` then discard it instead of
calling `onChange`) and the suite must go red on three assertions. It did on 2026-09-15. Revert with
`git checkout HEAD -- server/watch.js` (plain `git checkout -- <path>` restores the *staged* copy)
and confirm with `git status --porcelain` showing nothing for it.

### What was added

| Area | Files | What it does |
|---|---|---|
| Write path | `server/writefile.js` | Policy layer: what may be written, validated how. Delegates the write itself. |
| Snapshots | `server/snapshot.js` | Capture, compare, restore, and the `atomicWrite` primitive. |
| CSRF guard | `server/security.js` | Per-start session token plus origin check, scoped to `/api`. |
| Editor UI | `client/components/FileEditor.jsx` | Textarea, dirty tracking, hook acknowledgement, save result. |
| Snapshot UI | `client/components/SnapshotPanel.jsx` | List, per-file compare against disk, selective restore. |
| CLI | `cli/` (4 files) | `here`, `tree`, `show`, `backup`, `snapshots`, `diff`, `restore`. |
| Launcher | `scripts/launch.js`, `layercake.cmd`, `scripts/install-shortcut.ps1` | App-mode window, Start Menu shortcut. |
| Test net | `scripts/smoke.mjs` | Assertions over the real HTTP API; the run prints the count. |
| Watcher | `server/watch.js` | Directory watches over the scanned lineage, 250 ms debounce, config filter derived from the scan and manifest. |
| Watch stream | `GET /api/watch` in `server/app.js` | SSE. Paths and verbs only, never content. Bounded to 4 concurrent streams; closes with its scan. |
| Watch UI | `client/useWatch.js`, `client/components/WatchBanner.jsx` | Always-on status bar, change list, opt-in desktop notifications. |

New endpoints: `POST /api/write`, `POST /api/snapshot`, `GET /api/snapshots`,
`GET /api/snapshot/:id`, `GET /api/snapshot/:id/compare`, `GET /api/snapshot/:id/file`,
`POST /api/restore`, `GET /api/watch`. All behind the token.

### 2026-09-25: single executable, and the app window was not isolated

| Area | Files | What it does |
|---|---|---|
| Single exe | `desktop/main.js`, `desktop/build.mjs` | `npm run build:exe` -> `dist\LayerCake.exe` (86.5 MB, Node 24.3.0). No console; exits when its window's Edge exits. |
| App window | `desktop/window.js` | Moved out of `scripts/launch.js`, now shared. Adds `--disable-extensions --disable-sync`. |
| Server split | `server/app.js`, `server/index.js` | `app.js` builds the app without listening; `index.js` is the terminal entry, unchanged in behavior. |
| Git | `.gitignore` | Local repository created 2026-09-25, baseline commit first. No remote. |

**Why the flags:** Edge signed the "separate" LayerCake profile in to the Windows Microsoft account
and synced four extensions into it, one a shopping extension with access to every URL and content
scripts on every page, able to read the session token in our DOM. Measured before and after: 3
extension processes, then 0.

Verified on the built exe (commands in the commit message of `Add a single-executable build`):
no console host (control gets one; a console-subsystem copy gets one); UI served from the embedded
bundle; token and origin guards; scan; exit on window close; second launch reuses the server; port
squatter gives the error window; mutant with exit-on-close as a no-op stays running.

---

## Decisions already made, so they do not get relitigated

These were the user's calls, made explicitly on 2026-09-05. Do not reopen without asking.

1. **Browser UI, not a TUI.** The level tree and provenance tables are wide comparison surfaces that
   degrade badly at 80 columns. The CLI covers the one-shot-answer job instead.
2. **Edit in place with a mandatory automatic snapshot**, rather than backup-only or unguarded
   writes.
3. **Snapshots capture everything the scan finds**, minus runtime state, rather than user-level only.
4. **Packaging: a Node SEA single executable, still showing browser app mode.** Reopened by the user
   on 2026-09-25 ("Can we just make it a stand-alone app?", Windows preferred, no .NET) and settled
   on SEA over Electron and over polishing the launcher. The `.cmd` plus `npm run app` path stays for
   running from source. Electron remains the answer only if the window's own identity (taskbar,
   toast attribution) starts to matter; SEA does not change either.

---

## Open, awaiting the user

Nothing blocks progress. These were flagged and not answered.

1. **Snapshots contain files that can hold OAuth tokens** (`~/.claude.json`, `settings.local.json`,
   `.mcp.json`). Flagged `sensitive` in the manifest rather than excluded, because excluding them
   makes a restore quietly incomplete. Safe in place (same user ACL as the originals), exposed the
   moment a snapshot is copied to a share, a USB stick or another machine. Alternative if he wants
   it: an opt-in `--redact-sensitive` that omits them and records the omission loudly.
2. **Hook-edit blocking is a speed bump, not a boundary**, and is documented as such.
   `settings.json` defines hooks inline and is ordinary editable config, so anyone who can write
   settings can arrange execution anyway. Closing this properly means treating `settings.json` as
   executable config too, which is a real UX cost.
3. **The product was renamed to LayerCake** (was "Claude Explorer"). Package name, title, UI brand,
   server banner. Reversible. `localStorage` keys deliberately kept the old `claude-explorer.*`
   prefix so the remembered directory survives; there is a comment saying so in `client/App.jsx`.
4. **`scripts/smoke.mjs` was the assistant's addition, not requested.** Justified only because one
   bug in this work was silent (green suite, completely broken app). Kill it in one line if the
   owner disagrees.
5. **`~/.claude.json` lights the watch bar every few seconds during an active Claude Code session.**
   It is a genuine member of the lineage and it genuinely changes, so it is reported rather than
   filtered: hiding a file the tool tracks would be the worse lie. If the churn is more annoying
   than the signal is useful, the options are a per-file mute in the bar, or a "quiet" toggle that
   keeps counting but stops re-lighting. Both are product calls, not technical ones. Nothing was
   built for this.
6. **Desktop notifications were built opt-in and background-only**, behind a "Notify me" button.
   The toast is attributed to Edge or Chrome, not LayerCake, because app identity needs a registered
   AppUserModelID, which a browser page cannot have. The SEA exe did not change this (the window is
   still Edge's); only Electron would.
7. **The watcher declines UNC paths.** `fs.watch` binds its handle eagerly with no timeout, so a
   dead share could block the event loop, and every other filesystem call here is wrapped in
   `withTimeout` precisely because that was a known failure. They are reported in the bar's
   "not watched" list rather than silently dropped. A project on a network share therefore gets a
   scan but no live events for the share-side levels.
8. **The existing app-window profile still holds what sync put there** (2026-09-25).
   `%LOCALAPPDATA%\LayerCake\browser` is signed in to the user's Microsoft account and has four
   installed extensions plus synced data (sync had passwords, typed URLs, tabs and more enabled). The
   new flags stop the extensions running and stop further sync, but the stored copies remain.
   Deleting the folder removes them; Edge recreates it on the next launch. Cost: the remembered
   directory and the notification toggle. Recommended, not done: it is the user's data.
9. **No GitHub repository yet.** Local git only. Private was recommended (the docs name local paths
   and the machine's config layout); awaiting the visibility decision.
10. **`npm audit` lists 6 advisories, all present at the baseline commit** (express, body-parser and
    qs moderate; js-yaml high; vite high; esbuild moderate, dev-server only). Not addressed.
11. **The exe carries node.exe's icon and version resource**, so Task Manager calls it "Node.js
    JavaScript Runtime". Setting both at build time needs one dev dependency (e.g. `resedit`). Not
    built: nobody asked, and the process is findable as `LayerCake.exe`.

---

## The most obvious gap, if you want the next feature

**You cannot create or delete files, only edit existing ones.** This is structural, not an
oversight: `/api/write` resolves its target through `requireEntry`, which looks the path up in the
scan result, and the scan only reports files that exist. So there is no path to "add a new agent" or
"remove this skill" from either surface.

That is a real limit for a tool sold as managing the environment. Doing it properly needs a
different mechanism than the allowlist, because the allowlist is keyed on existence. Likely shape: a
create endpoint constrained to a known-good directory (`<level>/.claude/agents/` and friends) plus a
category, rather than an arbitrary path. Worth designing deliberately, since it widens the write
surface that the current design deliberately narrowed.

Smaller known gaps:

- No diff of your own pending edit before saving. You see the file, not what you changed.
- POSIX is handled in code but untested. Windows is the only verified platform.
- `other`-category files are deliberately not editable. That is by design, not a gap.

---

## Bugs found and fixed during this work

Recorded because the pattern matters more than the individual fixes.

1. **CSRF guard blocked the browser's own navigation.** Applied to every route, it refused any
   arrival carrying `Sec-Fetch-Site: cross-site`, which includes bookmarks, links and the new tab
   page. **36 HTTP assertions stayed green while the app was completely unusable**, because Node's
   `fetch` sends no `Sec-Fetch-*` headers. Found only by opening a browser. The guard is now scoped
   to `/api`, and `scripts/smoke.mjs` asserts the navigation case.
2. **Same-file-two-routes counted as shadowing, in three places in `server/flatten.js`.** When a
   project sits under the home directory (most projects on Windows), the directory walk passes
   through home and re-finds what the user level already reported.
   - `flattenDefinitions`: agents appeared to shadow themselves.
   - `flattenMemory`: the instruction chain printed the same CLAUDE.md twice, overstating what
     Claude Code actually loads.
   - `flattenMcp`: `context7` reported as shadowing itself. **This third one was missed after the
     first two were fixed and the class was declared handled.** It was found by a subagent
     afterwards.
   All three now key on `samePathKey` from `paths.js`. MCP additionally keys on scope, because
   `~/.claude.json` legitimately defines a server in both its global and per-project blocks and that
   is a genuine shadow.
3. **Ctrl+C stranded the launcher** at `Terminate batch job (Y/N)?` on a console the user thought
   they had closed. Fixed with `call :run %* < nul` in `layercake.cmd`, scoped so the failure-path
   `pause` still reads the keyboard.

**The lesson worth carrying:** fixing two instances of a class and declaring it handled is how the
third survives. The MCP fix was mutation-tested afterwards (revert it and the suite fails naming
`context7`), which is the only reason there is confidence the assertion discriminates.

---

## Environment notes

- **Port 5178 had no listener on 2026-09-25** (checked before any test that day). The user's
  long-running server from 2026-09-07 was gone. If one is running when you arrive, it is the user's:
  do not kill it without asking. A 403 in an open tab means the server restarted and the tab holds a
  stale session token; a reload fixes it.
- Test ports used during development were 5188, 5199 and 5399. All free as of 2026-09-08.
- `%LOCALAPPDATA%\LayerCake\snapshots` has never been created. All testing redirected
  `LAYERCAKE_SNAPSHOT_DIR` to scratch paths, and those were cleaned up. **Test snapshots contain
  real copies of `~/.claude.json`, so always redirect and always clean up.**
- The built bundle in `public/` was rebuilt on 2026-09-25 by `npm run build:exe`. A change under `client/` makes it
  stale and `npm start` rebuilds; a change under `server/` alone does not and does not need to.

---

## Traps paid for during this work

Windows and tooling specifics, on top of what `C:\dev\CLAUDE.md` already documents.

- **Heredocs mangled backslashes twice**, both at exit 0. A Python heredoc turned `\Users` into an
  escape error, and another silently ate `\n` in a replacement string. Use the Write tool for any
  content containing Windows paths or escape sequences.
- **`String.replace` in a fixup script hit two matching blocks** and corrupted an unrelated
  function. `node --check` passed, because the result was still syntactically valid. Executing the
  code caught it; parsing it did not.
- **`node --check` proves a file parses, not that it runs.** Import-and-parse checks passed on code
  with a `ReferenceError` waiting in an untaken branch.
- **The LSP reported syntax errors for lines past the end of a file** while a subagent was
  mid-edit. Stale diagnostics; `node --check` plus actually running it is the tiebreaker.
- **`form_input` on a React controlled input sets the DOM value without firing the change event**,
  so state never updates and the form submits empty. Type into it instead.
- **Coordinate clicks in the browser tool were unreliable**; clicking by `ref` from `find` worked
  every time.

---

## If you resume

1. Run the two commands at the top. If they are not green, something changed under you; find out
   what before building on it.
2. Read `CLAUDE.md` invariants before touching `server/`. They are the product, not style.
3. `npm run smoke` before calling any `server/` change done. It cannot see the UI, so a green run is
   necessary and not sufficient. The one bug it missed was found by opening a browser.
4. Smoke never runs the exe. After touching `server/app.js`, `desktop/` or `client/`, run
   `npm run build:exe` and launch `dist\LayerCake.exe` with `Start-Process` (as Explorer would).
