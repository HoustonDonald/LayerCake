# LayerCake reference

The full reference: what LayerCake scans, how each view is built, what it writes and how, and every
limit it knows about. For downloading it and getting started, see the [README](../README.md).

LayerCake is a local tool for seeing and managing the Claude Code configuration inheritance lineage:
what is inherited, from where, and in what order. Browse every level, edit the files, and snapshot or
restore the whole environment. Useful mostly when moving between projects, when the answer to "which
CLAUDE.md is actually winning here" is not obvious.

Built against Claude Code from **2.1.229** onward, **on Windows 11**; the newest version measured
against it is 2.1.284 (a plain Windows 11 in Windows Sandbox: #11, #157). Windows is the first-class target.
The smoke test also passes on Linux (Ubuntu under WSL2, Node 22). There, the checks of a
Windows-only form (UNC paths, drive letters, the libuv watch storm, PowerShell process start times,
`claude.cmd` shims, Windows project paths) print `SKIP` with their reason and a count, never a quiet
pass, and the summary line counts the skipped groups. macOS is untested. "Start Claude here" is Windows-only: it
opens Windows Terminal (or a console window without it), and its status line uses Windows's `curl.exe`.

```
npm install
npm run app        # build if stale, serve, and open a chromeless app window
npm start          # same without the window: open the address it prints, key included
npm run build:exe  # one-file Windows app, no Node needed to run it: dist\LayerCake.exe
```

## Requirements

LayerCake needs little beyond Windows, and works without the usual developer extras. The minimum
was checked on a plain Windows 11 in Windows Sandbox, which has no Git Bash, no PowerShell 7 and no
Windows Terminal: the exe opened its window and scanned, and "Start Claude here" opened Claude
Code.

| | Needed? | Without it |
|---|---|---|
| Windows 11 | Yes | Windows 10 should work but has never been run (#195). The smoke test also passes on Linux; macOS is untested. |
| Claude Code | For the Sessions tab and "Start Claude here" | The lineage, editing and snapshots need only the files. |
| Edge or Chrome | Recommended | The window opens in the default browser, without the isolation flags (see "Single executable"). |
| Windows Terminal | Recommended | "Start Claude here" opens a console window: no tab name, no placement beside LayerCake. |
| PowerShell 7 | No | LayerCake uses the Windows PowerShell 5.1 every Windows has. Claude Code uses 7 when installed, else 5.1, and the launched status line works under both (#11). |
| Git Bash | No | Claude Code runs the launched status line through PowerShell instead (#11). |
| Git, GitHub CLI | No | LayerCake never runs them. Where it needs a project's git facts it reads the `.git` folder as files, and a project with none just shows less. |
| Node.js | For the CLI and for running from source | The exe needs nothing installed. |

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

`here`, `tree`, `show` and `snapshots` lay their output out for the terminal's width, or 100
columns when piped. A long path is elided in the middle, a plugin's file is shown as
`<plugin> > <path inside it>` as the page shows it, and on a terminal `show settings` cuts a string
value too long for its line, with its full length beside it. Redirected or piped, the merged
settings are printed whole, and the page shows every value whole. File bodies (`show claude-md`)
are printed as they are.

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
%ProgramData%\ClaudeCode\managed-settings.json                   (legacy, not read by Claude Code)
%ProgramData%\Claude Code\managed-settings.json                  (legacy, not read by Claude Code)
C:\Program Files\ClaudeCode\managed-settings.json
/Library/Application Support/ClaudeCode/managed-settings.json    (macOS)
/etc/claude-code/managed-settings.json                           (Linux)
```

The legacy locations are still probed, because a policy left there is one its owner may believe is
in force; the settings view shows it as not read. The Windows folder is `C:\Program Files\ClaudeCode`
as written, not `%ProgramFiles%`: Claude Code 2.1.283 uses that fixed path, and so does its
documentation (#147).

The rest of this platform's managed tier (#147):

```
<managed folder>\CLAUDE.md                  managed instructions: loaded first, cannot be excluded
<managed folder>\managed-mcp.json           while it exists, the only MCP servers that load
<managed folder>\managed-settings.d\*.json  drop-ins, merged over managed-settings.json in name order
<config home>\remote-settings.json          Claude Code's cache of server-managed settings: shown, never merged
HKLM\SOFTWARE\Policies\ClaudeCode  Settings (Windows) policy as JSON in a REG_SZ or REG_EXPAND_SZ value
HKCU\SOFTWARE\Policies\ClaudeCode  Settings (Windows) the same, writable by the user
```

A drop-in is read as Claude Code reads one: a file (or link) directly in the folder whose name ends
in `.json`, in lower case, and does not start with a dot, in plain code-unit order, so `B.json`
comes before `a.json`. Anything else there is listed as not read. A deleted drop-in can be restored
like any other deleted file. One named like a credential file (`credentials.json`) is never opened,
as everywhere in LayerCake, so it is listed as redacted and left out of the merge although Claude
Code applies it. The server-managed cache is its own category, which is not editable (an edit lasts
until Claude Code's next fetch), is flagged sensitive (Claude Code writes it readable by its owner
only), and a restore does not select it unless asked.

The registry values are read with `reg.exe query <key> /v Settings`, the way Claude Code reads them:
from its System32 path, both keys at once, 5 s timeout, output capped at 2 MiB, parsed as data. They
are not files, so they are listed on the level but have no entry to open; the settings view shows
their content. `reg.exe` returns text in the console code page, so a character outside it is lost
(measured: `é` came back re-encoded and `✓` as `?`). Claude Code parses the same output, so it most
likely loses them too; a value holding such characters says so. Registry changes are picked up by
the next scan, not by the watcher. macOS's managed preferences (the MDM plist) are not read.

### 01 User / home

```
~\.claude\settings.json
~\.claude\settings.local.json
~\.claude\CLAUDE.md
~\.claude\CLAUDE.local.md
~\.claude\.mcp.json               listed, marked not read: Claude Code does not read it (#121)
~\.claude\keybindings.json
~\.claude\agents\**\*.md          (depth 2)
~\.claude\skills\**               (depth 3, .md .json .yaml .yml)
~\.claude\commands\**\*.md        (depth 3)
~\.claude\hooks\**                (depth 2, any extension)
~\.claude\rules\**\*.md           (depth 2)
~\.claude\memory\**\*.md          (depth 2)
~\.claude\.config.json           legacy name: read in place of ~\.claude.json while it exists
~\.claude.json                    flagged sensitive
~\CLAUDE.md                       flagged: only inherited when the project sits under home
```

Claude Code reads `.config.json` in the configuration home instead of `.claude.json` whenever that
file exists (checked in the 2.1.283 bundle). The scan then marks `.claude.json` as not read, and
the flattened MCP view leaves it out.

If `CLAUDE_CONFIG_DIR` is set, as Claude Code reads it, the `~\.claude` part of every path above
(and the plugins, project memory, sessions and history below) is that directory instead, and
`.claude.json` moves inside it too: Claude Code resolves it as `CLAUDE_CONFIG_DIR\.claude.json`.
`~\CLAUDE.md` does not move; it is a file in the home directory. The level says which location it
used and why, and `/api/manifest` states `claudeHome`, `claudeHomeSource` and `globalConfigFile`.
A `CLAUDE_CONFIG_DIR` that is not an absolute path is ignored, as Claude Code refuses it too.

A `CLAUDE_CONFIG_DIR` in the `env` block of the default home's `settings.json` moves the home as
well (#64), and LayerCake follows it the way Claude Code does, measured on Claude Code 2.1.284:
everything under the home, sessions included, comes from the new folder, and nothing from the old
one applies, not even that settings file's own hooks. Two things stay: `.claude.json`, which
Claude Code still keeps at `~\.claude.json`, and the settings file that made the move, which the
user level lists as inactive so it can be edited to move the home back. The level's note names
it. Checked before every scan and at startup, so an edit shows at the next scan. A project's
settings cannot move the home (measured); managed settings can, but that is not modelled (#158).

### 02 Plugins

```
~\.claude\plugins\installed_plugins.json
~\.claude\plugins\known_marketplaces.json
~\.claude\plugins\blocklist.json
~\.claude\plugins\cache\<marketplace>\<plugin>\<version>\{agents,skills,commands,hooks,rules,memory}
~\.claude\plugins\cache\<marketplace>\<plugin>\<version>\.claude-plugin\plugin.json
~\.claude\plugins\cache\<marketplace>\<plugin>\<version>\.mcp.json
```

**Everything in `cache\` is read only in LayerCake** (#126, owner decision 2026-09-28): it can be
opened, never edited, deleted, created in or restored. It is Claude Code's own copy of each
installed plugin, and Claude Code replaces a plugin's version folder when the plugin updates, so a
change made there would be lost without warning. Change a plugin at its source. The rule goes by
path (`readOnlyReason` in `safety.js`), whatever the file's category or the level that listed it,
and `/api/manifest` serves it as `write.readOnly`. A plugin's `.mcp.json` was already not editable
for a second reason: it can keep its servers at the top level rather than under `mcpServers`, where
the executable acknowledgement would not see a command being added.

Only the versions `installed_plugins.json` names are scanned; any other cached version (usually one
Claude Code marked `.orphaned_at` after an update) is listed under "other" as not read. If
`installed_plugins.json` cannot be read, every cached version is scanned and the level says so.

Which installed plugins load for the project is decided the way Claude Code 2.1.283 was measured to
decide it (#122), with `claude plugin list --json`, `claude mcp list` and a `claude -p` against a
local stub API (no usage), from a scratch config home holding a copy of this machine's plugins:

- A plugin loads only when the merged `enabledPlugins` of the settings Claude Code reads (the
  settings view's own merge) sets it `true`. `false` is off, and so is a plugin not named at all.
- A `local` or `project` install loads only where the project's git root, or the folder itself
  outside a repository, is its `projectPath`: from a subfolder of the repository it loads, from a
  subfolder of a plain folder it does not.
- Its agents, skills and commands are named `<plugin>:<name>` (the frontmatter name), so a plugin's
  never shadows a project's; its MCP servers, from the installed version's `.mcp.json` or an
  `mcpServers` object in `plugin.json`, are named `plugin:<plugin>:<server>`.

A file of a plugin that does not load stays listed, marked "not loaded" with the reason, and the
level note names those plugins. The definitions and MCP views leave such files out, and say how many.

### 03 Project memory (home-stored)

```
~\.claude\projects\<mangled-path>\memory\**\*.md
```

The slug is the absolute path with every character that is not an ASCII letter or digit replaced
by `-`, so `C:\dev\LayerCake` becomes `C--dev-LayerCake`. It is taken from the project's git root
when there is one (the main repository's for a worktree), not from the folder scanned: measured on
Claude Code 2.1.283 (#123), a session in a subfolder or a worktree loaded the repository root's
`MEMORY.md` and not its own. `autoMemoryDirectory`, which moves it, is not modelled. This is context
injection rather than a settings-precedence level, and the UI says so.

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
<dir>\.claude\.mcp.json           listed, marked not read: Claude Code does not read it (#121)
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

A folder inside those trees that is a link (a junction needs no admin rights, so people link shared
skills in this way) is walked like any folder, because Claude Code 2.1.283 was measured to load
skills and agents through one (#144). Every file behind it names the link and its target, in the
file viewer, since an edit or delete there lands in the target. A link to a network share is listed
under "other" and not walked, so a share that stops answering cannot stall a scan.

When the project sits under your home directory, the walk passes through home and finds
`~\CLAUDE.md` and `~\.claude` again, so their files appear at both the user level and the home
directory's level. Both sightings are shown, and when that `.claude` is the configuration home the
level says why. Counts are of distinct files: the summary bar, `layercake tree` and
`layercake here` count such a file once and say how many were reached twice, and redactions, errors
and the CLI's hook and rule counts are counted the same way.

### Never touched

```
.credentials.json    credentials.json    .env    .env.local
```

Excluded at scan time by basename and refused again at read time. They cannot be opened through the
API even by direct request.

Runtime-state directories directly inside a `.claude` folder (`sessions`, `projects`, `debug`,
`logs`, `cache` and the rest of `NON_CONFIG_DIRS` in `server/safety.js`) are listed but never
recursed into, because they are large and hold no config. Inside `hooks/`, which takes files of any
extension, the same names are skipped, so a hook's own `logs/` or `cache/` is not read as hooks.
Inside the other trees a folder with one of those names is a skill or a command, and is walked;
there only `.trash` (where Claude Code moves removed skills), `node_modules` and `.git` are skipped.
A skipped folder is listed under "other" with a note, never as a file to open (#130).

---

## Flattened views

Four chains, each stating its own merge rule in the UI rather than leaving it implied.

| View | What it shows |
|---|---|
| **CLAUDE.md chain** | `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`, `MEMORY.md` and `.claude\rules`, concatenated top to bottom with per-level headers, each level's rules after its `CLAUDE.md`, the managed folder's `CLAUDE.md` first (#147). A rule with `paths` in its frontmatter is marked conditional. `AGENTS.md` is left out, and marked in the Explorer, where the project's folders hold a `CLAUDE.md`. Individual per-project memory files are excluded: they are recalled on demand, not loaded every session, and sweeping in 60+ of them would bury the actual instruction set. |
| **settings.json chain** | Every settings file in precedence order, plus a computed effective merge and a table naming the level that won each key. |
| **Agents & skills** | Definitions grouped by declared name (frontmatter `name`, else filename or skill folder; a plugin's as `plugin:name`), showing which level's version shadows the others. Plugins that do not load here are left out and counted. |
| **MCP servers** | The `.mcp.json` in the project folder and every folder above it, plus the global and per-project `mcpServers` blocks in `~/.claude.json` (the per-project key is described below), with shadowed definitions flagged. A `.mcp.json` inside a `.claude` folder is listed as not read, naming the servers it defines, which are not loaded. While a `managed-mcp.json` exists in the managed folder, parsed or not, it has exclusive control: its servers are the only ones listed as loading, and every other source is listed with the servers it defines, not loaded (#147). Servers in managed settings' `managedMcpServers` load beside them and are not listed. |

The settings merge is **computed by this tool**, not read back out of Claude Code, and it follows
what Claude Code 2.1.283 was observed to read for a session started in the project directory:

- **Four sources, weakest first:** user (`settings.json` in the config home), the project's
  `.claude\settings.json`, its `.claude\settings.local.json`, then managed settings, which win.
- **No ancestor walk.** A parent folder's `.claude\settings.json` is not inherited, unlike
  `CLAUDE.md`. Such files are still listed, marked "not read by Claude Code" with the reason, and
  never merged. So are `keybindings.json`, the config home's `settings.local.json` (read only as
  the local settings of a session started in the folder above the config home, where the user and
  project file are one file, applied once), and the legacy managed locations.
- **Merge:** objects merge key by key, so `env` merges per variable; lists are combined and
  de-duplicated, so `permissions.allow` rules and hooks from every file apply. In every file,
  `fallbackModel` and `modelPicker` are taken whole from the stronger file and
  `extraKnownMarketplaces` and `managedMcpServers` entry by entry: Claude Code 2.1.283's own merge
  customizer, read from its bundle (#147). `modelPicker` is ignored in project and local files and
  `claudeMd` everywhere but managed policy (each listed as ignored), and a managed
  `availableModels` is taken as-is.
- **Managed policy is one source of four** (#147), from Claude Code's documentation and its 2.1.283
  bundle, highest first: server-managed settings, the HKLM registry value, the managed files, and
  the HKCU registry value. The managed files are `managed-settings.json` and then each drop-in in
  name order, a later file winning; a blank one counts as `{}`. By default (`first-wins`) the
  highest source holding a policy key is used alone; `managedSourcesBehavior` and
  `wslInheritsWindowsSettings` on their own do not count. With `managedSourcesBehavior: "merge"` in
  that source, every admin source holding a policy key applies, combined the same way. HKCU is used
  only when no admin source is present, one that fails to parse or to be read included, and never in
  a merge. An admin document (the HKLM value or a managed file) that does not parse as a JSON object
  is marked in red: Claude Code's bundle marks that fatal at startup, so it most likely will not
  start (read, not measured, since a real one needs elevation to write). A panel in the view names
  each source, whether it applies and why not; each managed file is badged applied or skipped.
- **Server-managed settings are not merged.** They come from Anthropic's servers; the cache Claude
  Code keeps in the config home is shown with the managed files, and the view says whether it
  exists. While they are in force they outrank everything else, so a present cache means the
  computed merge may not be what applies.
- **Not modelled, and said so in the rule:** `--settings` for one session, the keys a skipped admin
  source still supplies under `first-wins` (`env` per variable, `deniedMcpServers` and the others
  the docs list), the stricter rules of `merge` (a lock taking the strictest value, keys taken from
  the highest source only), keys Claude Code drops from some sources (`managedMcpServers` from user,
  project and local settings; plugin keys from the HKCU value, among others), `modelSettings`, the
  few security keys where a stricter lower value wins over managed, and on macOS and Linux the
  git-root location of `settings.local.json`.

How it was established (#119): a scratch config home and project tree, a marker hook, a distinct
`model` and an `env` pair in every candidate settings file, and `claude -p` pointed at a local stub
API, so no request left the machine and no usage was spent. The hooks that fired name the files
read; the `model` in the request names the precedence winner. Re-run that when Claude Code's
settings loader changes. The UI states the rule above the result so a wrong assumption is visible
rather than silent.

The MCP view's per-project block in `~/.claude.json` (where `claude mcp add --scope local` puts a
server) is the one Claude Code 2.1.283 was measured to use (#120): keyed by the git repository's
root when the project is inside one, the main repository's root for a worktree, else the project
directory itself, with forward slashes on Windows (`C:/dev/app`). A backslash key is never read,
though `.claude.json` holds many. The key's letter case is the case the folder was typed in when
Claude Code started, which a scan cannot know, so on Windows every key equal to it ignoring case is
listed, each named. The git root is found from the filesystem (`.git`, and a worktree's `gitdir:`
and `commondir`), never by running git. A `gitdir:` or `commondir` that leads onto a network share the
project is not on is not followed (#193): a .git file can arrive in a downloaded folder, and looking
there would connect out to that server; the folder holding the .git file is then the root. A submodule's is its own folder, which is reasoned, not
measured. How it was established: a scratch config home, then `claude mcp add --scope local` and
`claude mcp list` from a repository's root, a subfolder, a worktree, a folder in no repository and
the same folders typed in lower case. Neither command calls the model.

The same method placed a `.mcp.json` in every plausible folder (#121). Claude Code 2.1.283 read the
one in the project folder and in every folder above it, past the git root too, each as project
scope awaiting approval, and none inside a `.claude` folder, the configuration home's included. So
a server defined only in `~\.claude\.mcp.json` is not loaded; the MCP view says so.

The CLAUDE.md chain follows what Claude Code 2.1.283 was measured to load (#123), from the request
body a stub API received, with an `InstructionsLoaded` marker hook agreeing:

- `.claude\rules\**\*.md` load at session start from the configuration home and from every folder
  of the walk, each level's after its `CLAUDE.md`. A rule with `paths` in its frontmatter did not
  load at session start; it is read when Claude reads a matching file.
- `AGENTS.md` loads only when the project's folders (the folder and its ancestors) hold no
  `CLAUDE.md`, `.claude\CLAUDE.md` or `CLAUDE.local.md`; then it loads from every one of them. A
  `CLAUDE.md` in the configuration home does not count. `.claude\AGENTS.md` never loaded, and is not
  scanned.
- A plugin's rules were not measured and are left out of the chain.

---

## Write posture

The app reads the whole lineage and can edit the files it found. Writes are narrow and guarded.

- **Every mutating filesystem call lives in `server/snapshot.js`.** `server/writefile.js` is the
  policy layer (what may be written, validated how) and delegates the actual write to
  `snapshot.js#atomicWrite`; it contains no `fs` mutation of its own. Everything else in `server/`
  stays on `readFile`, `readdir`, `stat`, `lstat` and `fs.open(path, 'r')`. Audit it:
  ```
  rg -n "fs\.(writeFile|appendFile|mkdir|mkdtemp|rm|rmdir|unlink|rename|copyFile|cp|link|symlink|truncate|chmod|chown|utimes|createWriteStream)" server/
  ```
  The mutating calls belong in `snapshot.js`; `writefile.js` is the only other module permitted to
  appear there. The pattern also matches the identifier `truncated`, so read the hits rather than
  counting them.
- **Only files the current scan discovered can be written or deleted.** The scan result is the
  allowlist, and it supplies the file's category, so a request cannot relabel a hook to dodge a
  guard. New files are the one addition, and they are fenced: see
  [Creating and deleting files](#creating-and-deleting-files).
- **Every edit, delete and restore is preceded by an automatic snapshot**, and the response carries
  that snapshot id so the change can be undone. Each one then checks that the snapshot actually holds
  the file it is about to replace or remove, and refuses that file if not: a snapshot skips a file
  over the 2 MB cap, and replacing one would leave no copy anywhere. A save or delete of a file over
  the cap, or of one marked read-only, is refused before any snapshot is taken, so a refusal leaves
  nothing behind (#139, #141). A create replaces nothing, so it takes none. This is enforced by the import graph: `writefile.js` depends on `snapshot.js`, so a
  new route cannot skip it by forgetting.
- **Writes land atomically**, via a temp file in the same directory followed by a rename. A crash
  leaves either the old file or the new one, never a half-written config.
- **Structural validation before the write, with a deliberate severity split.** Invalid JSON or YAML
  is refused outright, because a malformed settings file degrades every future session; so is a
  settings file or `.mcp.json` whose top level is valid JSON but not an object (#145). Malformed
  markdown frontmatter is a warning and the write proceeds, because it breaks one definition and
  leaves the rest working.
- **Concurrent edits are detected.** The editor sends the mtime it loaded; a mismatch returns 409
  rather than silently winning the race against your other editor.
- **A pending edit can be reviewed before it is saved.** **Review changes** in the editor swaps the
  text box for a line diff of the draft against the body loaded from disk: unified hunks with three
  lines of context and a count of lines added and removed, computed in the browser by jsdiff (the
  `diff` package). **Save** works from either view, and reviewing is optional. Opening the review
  re-reads the file through `/api/file`, the same reader as everything else, and compares its mtime
  with the one loaded. If they differ it says the file changed on disk and draws no diff, because a
  diff against the old body would not show what Save replaces, and Save would get the 409 above.
  The comparison stops after 0.5 s rather than freeze the page (#54), and then says the two are too
  different to show line by line, with each one's line count: replacing every line of a
  5,000-line file froze the page for 3 s before. Ordinary edits finish well inside the limit.
- **An edited file keeps its line endings.** A browser text box turns every line break into LF, so
  the editor notes the file's ending when it loads and Save writes that one back: a CRLF file (any
  repo checked out with `core.autocrlf=true`) stays CRLF. A file that mixes CRLF and LF is saved
  with the one it uses more, and a tie, like a file with no line break at all, is saved as LF. The
  editor states that rule on any mixed file before you save, because a save then changes the
  minority lines too. A lone CR is not counted and is saved as the chosen ending. Line endings alone
  are not an unsaved change, and the review diff compares lines without their endings, so the edit
  itself stays visible.
- **Leaving the editor with unsaved changes asks first.** Switching to Flattened, Snapshots or
  Sessions, selecting another file, or scanning a directory would close the editor and lose the
  draft, so each one asks, and Cancel keeps editing. The watch bar's Rescan asks in the bar itself.
  Closing or reloading the window with unsaved changes gets the browser's own "Leave site?" prompt;
  the exe's window, and so the exe, stays open until it is answered. With no unsaved changes,
  closing just closes.
- **Credential files can be neither read nor written**, refused at scan time, at read time and at
  write time.
- **Executable config requires acknowledgement.** Hook files are executed by Claude Code rather than
  read, so saving one needs an explicit confirmation. So does a `settings.json` or `.mcp.json` edit
  that adds or changes something Claude Code runs: `hooks`, `statusLine`, `apiKeyHelper`, the cloud
  credential helpers, `fileSuggestion`, `policyHelper`, `processWrapper`, or an MCP server. The
  editor names the keys. Ordinary settings edits, and removing one of those keys, need no
  confirmation. `/api/manifest` lists the keys (`acknowledgeCommandKeys`). Be clear about what this
  is worth: it stops an absent-minded edit, not a determined one. The `env` block is not covered,
  though a variable like `NODE_OPTIONS` can arrange execution too, because it is edited routinely.

Claude Code loads memory and settings at session start, so an edit does not reach a session that is
already running. The UI says so after every save rather than leaving you to wonder, beside the undo
snapshot id and any validation warning, and that result stays on screen until the next save or until
you leave the editor.

### Creating and deleting files

Each user or directory level in the Explorer has **+ New file here**. It offers only what the scan
offered for that level, and the server builds the path from the choice, so a request never names a
path:

- **Fixed files that do not exist yet:** `CLAUDE.md` and `.mcp.json` in a directory, and
  `.claude/CLAUDE.md` in its `.claude` folder. At the user level: `CLAUDE.md` and `settings.json` in
  the configuration home.
- **Settings files only where Claude Code reads them** (#135): `.claude/settings.json` and
  `.claude/settings.local.json` in the project directory, never in a parent folder, whose settings
  Claude Code does not inherit. The configuration home's `settings.local.json` is offered only when
  the project is the folder above it, the one session that reads it. See the settings view below.
- **A named agent, command, rule, skill or hook** in the level's `.claude/agents`, `commands`,
  `rules`, `skills` (a folder holding `SKILL.md`) or `hooks` folder. The name is 1 to 64 lowercase
  letters, digits, `-` or `_`, so it is always one plain file name; Windows device names such as
  `con` are refused. A hook is `.sh`, `.ps1`, `.py`, `.js` or `.mjs`, and needs the same executable
  acknowledgement as editing one. It does nothing until a `hooks` entry in `settings.json` names it.

A new file starts from a short template and opens in the editor. **A create never replaces a file**:
it claims the name with an exclusive create, which refuses an existing one, and then moves the new
content onto that empty placeholder, so the file is never seen half written. So it needs no
snapshot, and its undo is a delete. Managed policy, plugins and Claude Code's own project memory are not offered.

**Delete** is in the file viewer and asks first, in the page. It takes a snapshot, and deletes only
if that snapshot holds the file: a file over the 2 MB cap, which snapshots skip, is refused, since
deleting it would have no way back. A read-only file is refused too, as a save of it is: Windows
would delete it anyway (the unlink clears the attribute), and someone marked it to keep it. The
mtime check that guards a save guards a delete too. The
result names the snapshot; restore the file from **Snapshots**, where it shows as `gone from disk`.

`GET /api/manifest` serves the create policy (`write.create`) from the same tables the server builds
the choices from.

### What is editable

The editable categories are served by `GET /api/manifest` (`write.editableCategories`), derived from
the same set the guards consult, and the UI reads them from there, so there is no second copy here
to drift. `other` is never among them: it is the bucket for files the scan lists but does not
understand, and editing an unclassified file is how you corrupt something structured. Delete follows
the same set. On top of the categories, a file in the plugin cache is read only whatever its
category (`write.readOnly`; see [02 Plugins](#02-plugins)): the viewer says "read only" and why.

### Limits

Found in the pre-release security review (#196) and kept, each because it needs a narrower case
than ordinary use:

- **Saving a file that is itself a link breaks the link.** A save writes a new file and renames it
  over the name, so a configuration file that is a hard link (or a file-level symbolic link) into a
  dotfiles folder becomes a file of its own, and the other name keeps the old content. Nothing is
  lost: the snapshot holds the old bytes. A linked *folder* (a junction) is not affected.
- **Rendered Markdown hides what Markdown hides.** A link-reference definition such as
  `[//]: # "text"` renders as nothing, so a CLAUDE.md can hold an instruction the rendered view does
  not show while Claude reads it. **Edit** shows the file's text as it is. Links in rendered
  Markdown are followed on a click.
- **A file is recognised as a credential by its name**, so a symbolic link named `x.md` that points
  at `.credentials.json` would be listed and read. Making one needs a symbolic link in a
  configuration folder (Developer Mode on Windows), and Claude Code would load it too.
- **Launch records are kept**, each with its secret, in LayerCake's data folder, so an old launch's
  session can still report after a restart. They are only readable by you there.

## Snapshots

A snapshot is a mirrored directory tree plus a `manifest.json`, not an archive format. If this tool
is broken or gone, recovery is File Explorer and copy/paste.

The **Snapshots** tab takes the full window, as **Sessions** does (#143, owner decision
2026-09-28): the lineage tree is not used while comparing, and beside it every path wrapped at
1000 px. **Explorer** brings the tree back.

```
%LOCALAPPDATA%\LayerCake\snapshots\<id>\manifest.json
%LOCALAPPDATA%\LayerCake\snapshots\<id>\files\C\Users\you\.claude\settings.json
```

Override the location with `LAYERCAKE_SNAPSHOT_DIR`. It is deliberately **not** under `~/.claude`:
that tree is a restore target, and a backup the restore can overwrite is not a backup.

- **What a snapshot holds depends on why it was taken** (owner decision, 2026-09-27). **Take
  snapshot** and `layercake backup` capture every file the scan found, deduplicated by path: a file
  can legitimately appear at two levels when the project sits under your home directory, and the
  snapshot stores one. The automatic snapshot taken before an edit, delete or restore holds only the
  files that operation replaces or removes, so it costs a file rather than the whole lineage (about
  100 files, mostly plugins), and opening it shows just those rows. It does not record the rest of
  your configuration as it was at that moment; take a snapshot by hand for that.
- **Snapshots are kept 30 days** (owner decision, 2026-09-27), then deleted when the next snapshot
  is taken; nothing prunes on a timer or when you look at the list. That includes one you took by
  hand. The age is read from the folder's name, the time LayerCake created it, never from the
  manifest, and a folder in the store that is not a snapshot is left alone. The panel and
  `layercake snapshots` both state the period.
- Runtime-state directories and credential files are excluded, as they are from the scan itself.
- **Files over the 2 MB cap are skipped and recorded, never truncated.** A truncated file restored
  is silent data loss.
- Restore is selective: pick a snapshot, see a per-file comparison against disk right now
  (`same` / `changed` / `missing` / `error`), then choose what to put back. Changed files and files
  gone from disk are preselected and listed first, so undoing a delete is one click; identical ones
  are not, because restoring them is a write with no effect.
  Files Claude Code rewrites as it runs, `~/.claude.json` and the plugin manifests, are never
  preselected: they nearly always differ, and rolling one back rolls back Claude Code's own state.
  The CLI leaves them out the same way unless `--only` names one by its full path or file name
  (`--only .claude.json`); the list is `write.restoreOnlyByName` in `/api/manifest`, and the page and the
  CLI both read it from the comparison rows. A row the current scan cannot restore is disabled, and
  says why. A plugin cache file is never restored, since the cache is read only (#126): its row is
  disabled with that reason, and the CLI leaves such files out, counts them, and exits 1 if `--only`
  asked for nothing else.
- **A restore takes its own snapshot first**, so it is itself undoable: the CLI prints the undo
  command with an `--only` for each file it replaced. A file the restore recreated is the exception,
  since that snapshot was taken while it was missing and a restore never deletes; the page and the
  CLI name such files as not covered by the undo (the restore's answer lists them as `created`). It does not replace a
  file that snapshot could not hold (over the 2 MB cap), nor one marked read-only: that row fails
  and says so. A requested path the snapshot does not hold fails too, saying so, rather than
  vanishing from the answer; paths match as the scan's do, ignoring case on Windows (#142). A row
  that fails does not stop the others. A snapshot does not record the read-only
  attribute, so a file a restore recreates is writable.
- **A file gone from disk can be restored**, including after a rescan that no longer lists it,
  wherever the current scan would list it: a file it probes by name (`~/CLAUDE.md`, a directory's
  `CLAUDE.md`, a settings file), a file in a `.claude` folder's trees, a file in the project-memory
  folder, or one of the plugins folder's own manifests. So anything **Delete** removed can come back. It is created
  rather than written over: if something has appeared at that path since the
  scan, the restore of that file fails and says so, because the restore's own snapshot could not
  hold the newcomer. Missing folders, such as a removed skill's, are made again.

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
| `Watching 65 folders (6 not watched)` | Live with gaps. Hover for the list and the reason, which includes a network share that is not answering. |
| `4 files changed on disk` | Something changed. Names each file, each with **Mute**, and offers **Rescan** and **Dismiss**. |
| `4 files changed on disk (1 muted)` | The same, and one of the four is a file you muted. It is counted and listed, marked muted. |
| `Watching 65 folders, 1 muted change` | Only muted files changed. Listed and marked muted, but the bar stays unlit. |
| `Watching 65 folders ... Notifications are blocked for this site` | **Notify me** was refused. The bar keeps watching; only desktop notifications are off. |
| `Not watching for changes` | The stream is down, with the reason. |

The idle state is deliberate. A watcher that only appears when something happens cannot tell you it
is working, so a blank bar would be ambiguous between "nothing changed" and "nothing is watching".
The gap count is there for the same reason: silently skipping an ancestor would turn "no events"
into false reassurance.

**Nothing re-scans on its own.** A scan replaces the lineage, which would swap the file under an
open editor and discard whatever was typed into it. The bar reports and you decide; if the editor
has unsaved work, Rescan asks again before discarding it.

**What raises an event.** A path the scan already knows about, present or absent, plus any new file
or folder inside one of the `.claude/` subtrees (`agents/`, `skills/`, `commands/`, `hooks/`,
`rules/`, `memory/`), where the set of valid names is open-ended. Those subtrees are the ones the scan
walked, in each directory's `.claude` folder and in the configuration home itself, so a home moved by
`CLAUDE_CONFIG_DIR` to a folder with another name is covered too. A `CLAUDE.md` that does not exist
yet is still a path the scan probed, so its creation is reported. Inside a subtree every folder from
its root down to each config file is watched, and so is a subtree that exists but holds nothing yet,
because that is where new config lands: a new skill is a new folder in `skills/`, and the event names
it. Deleting a folder is reported the same way.

**What does not.** Runtime state living beside the config, which is most of `~/.claude`:
`history.jsonl`, `daemon.log`, `backups/`, `sessions/`, `projects/`. Claude Code rewrites these
continuously while a session is running, and an unfiltered bar is lit permanently and says nothing.
Lock files and atomic-write temporaries are dropped for the same reason; the rename that publishes
such a write still raises an event naming the real file. The filter is read from the scan result and
the manifest rather than kept as a second list, so a target added to `paths.js` starts being watched
with no other change.

LayerCake's own saves and restores are suppressed for two seconds, so the bar stays a report of what
happened *outside* this window.

**A file that was only read is not reported** (#131). On Windows, reading a file can make its
folder's watch say it changed: NTFS updates the last-access time when the old one is about an hour
stale, and the watcher is told. So opening a file in LayerCake, Claude Code loading it, or the scan
listing a skill folder used to light the bar. A reported change is now checked against the path's own
times first, and counts only if its last-write time or its metadata-change time moved. A credential
file is never stat'ed, so its events are reported as they come.

**Muting a file.** Every changed file in the bar has a **Mute** button. A muted file still counts,
is still listed (marked muted), and still goes into a Rescan; what it loses is the right to light the
bar, or to raise a desktop notification. So a file that changes every few seconds, `~/.claude.json`
while Claude Code runs, stops burying the change you care about without disappearing. Muted files
that have not changed are behind a `1 muted` button in the bar, each with **Unmute**, so a mute set
long ago cannot quietly hide a file. A mute is a preference of this browser: it is kept in
`localStorage` (`layercake.watch.muted`, keyed by the path, lowercased on Windows), applies to that
path in every project you scan, and survives a reload. Every open LayerCake tab shares it: a mute set
in one shows in the others at once, and never undoes one set elsewhere. The server never sees it: the stream still
reports every event, so the mute changes what the bar does, never what the watcher reports.

**Desktop notifications** are opt-in behind the **Notify me** button, and fire only when the window
is in the background. `127.0.0.1` counts as a secure context, so this needs no HTTPS. The toast is
attributed to the browser rather than to LayerCake, because app identity requires a registered
application.

Implementation notes that matter if you change this:

- **Directories are watched, not files.** A per-file watch binds to the inode behind the file, and
  an atomic save replaces that inode, so it would go deaf on exactly the event it exists to catch.
- **Non-recursive.** The scan already reports every directory that holds something, so a recursive
  watch would only subscribe to the runtime state the scan is careful to skip.
- **Folders on a network share are polled, not watched.** `fs.watch` opens its handle eagerly,
  inside a synchronous call, and takes no timeout: binding one to a share on an unroutable address
  blocked the event loop for 21 s here. A UNC folder (`\\server\share\...`) is instead listed, and
  each config file in it stat'ed, every 5 s, through `withTimeout` like every other filesystem call.
  So is a folder on a drive letter mapped to a share (`Z:\...`). The scan finds those with Node's
  native `realpath` of the drive root, which resolves a mapped drive to the share behind it
  (`X:\` to `\\localhost\C$`, checked with a real `net use` mapping) and a local disk to itself; no
  helper process is started. A drive whose root does not answer at all is treated as a network
  drive, the side that can say it is unreachable (reasoned: a dead mapping could not be produced
  here to test it). The level says so (`Network drive: Z: maps ...`),
  and the answer is kept for the life of the server once a drive is found to be a network one;
  a local drive is asked again on every scan.
  The same filter decides what raises an event, so a share-side level reports what the same level
  would on a local disk, only up to about 5 s later: `change` when a file's modified time or size
  moves, `rename` when a name appears or goes. A rewrite that keeps both the modified time and the
  size is not seen. A folder that does not exist yet reads as empty rather than being skipped, so
  creating one shows up as its files appearing.
- **A share that stops answering is named, not waited on.** Each round first stats the share root.
  If that fails or times out (3 s), every folder on that share moves from the count to the gap list
  as `Share not reachable: ...`, and the bar updates without a rescan. A timed-out call cannot be
  cancelled and keeps a thread until the OS gives up, so that share gets no further calls, from the
  watcher or a scan, until it does: a dead share holds one thread, and every other level's events
  carry on.
  When it answers again the next round compares against what it last saw and reports the
  difference. A share-side level the scan itself could not reach is polled too, so the bar says the
  share is down instead of saying nothing, and when it comes back the folder is reported as changed,
  because nothing in it has been seen yet: rescan to read it.
- Rounds do not overlap: the next starts 5 s after the last one finishes. Calls to one share are
  made one at a time, across every open tab and any scan, so a share that dies strands one call,
  not one per folder, per tab or per scanned level. A mapped drive letter counts as the share it
  maps, once a scan has classified it.
- A local folder that is a symbolic link to a share is not recognised as one, since detection is by
  drive letter, and is watched natively (reasoned, not measured).
- **A watched folder that is deleted is closed at once.** On Windows, Node reports a deleted
  folder's own `\\?\` path, and keeps reporting it, about 130,000 times a second for as long as the
  handle stays open: over 3 s the server used 3.3 s of CPU and re-lit the bar 14 times, from
  deleting one skill folder. The watcher closes that handle on the first report, reports the folder
  as changed, and lists it as not watched (`Deleted after the watch started`) until the next scan.
- **A watched folder that is renamed or moved is closed too** (#76). Its own watch reports nothing
  about the move and follows the folder, so a file changed there would be reported under the path
  it left. Every event from a folder's watch is therefore taken only while the folder is still at
  its path with the same identity (a new folder made under the old name is not it). Where the
  parent folder is watched, its report of the move closes the watch at once; where it is not (a
  plugin's skill folder, project memory), the next change inside the moved folder does. Either way
  the folder is reported as changed and listed as not watched (`Moved, renamed or deleted after the
  watch started`) until the next scan.
- Events carry a path and a verb, never file content. Reading a body still goes through `/api/file`
  and its allowlist check.
- The client reads the stream with `fetch` and a stream reader, not `EventSource`, because
  `EventSource` cannot set a request header and the page key is not going in a query string.

Known: `~/.claude.json` is a real member of the lineage and Claude Code rewrites it every few
seconds during a session, so it appears in the bar often. It is reported rather than filtered
because it genuinely is config the tool tracks, and hiding a tracked file would be the worse lie.
Mute it in the bar to keep it counted without it lighting the bar.

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
  Claude Code records this only from about 2.1.265; for an older session the tree shows no badges
  and says why, rather than calling every file "not loaded".
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
  activity. Whenever it lists sessions, LayerCake keeps a small summary card for every session it
  finds on disk, including ones in other projects that a project's list does not show, so a
  deleted session stays in the list ("Kept after deletion"), with its card but no prompts or
  replies.
- **Prompt history only:** `~/.claude/history.jsonl` keeps every submitted prompt, across projects,
  long after transcripts are gone. Sessions known only from there are listed with their prompts and
  nothing else. That file also keeps a separate copy of anything you pasted, which LayerCake
  never sends to the page.
- **Pasted text is part of the prompt.** Claude Code writes a paste into the transcript's prompt
  itself, so it is shown in the prompt rail like any other prompt text, goes into an AI summary's
  digest if you ask for one (to Anthropic, which already received it in the session), and, when
  it is in a session's first prompt, its first 400 characters are kept in that session's card.
- **Running sessions** come from `~/.claude/sessions/<pid>.json`. Each has a sibling `.key` file,
  which is a secret and is never opened. A pid file counts only while its process runs and, on
  Windows, started when the file says it did (within 1 ms, in either form Claude Code records), so a
  pid the system reused after a crash does not read as a running session. That answer is cached for
  60 s per pid, so a reuse inside that minute can read live until it refreshes.

**Usage.** Everything above reads files and spends no Claude usage. The one exception is the
**Summarize with AI** button: on a click, and only then, it runs `claude -p` on Claude Haiku 4.5
over the session's prompts and visible replies, stripped of Claude Code's own context (no tools,
MCP servers, CLAUDE.md or plugins) so the call carries little besides the session. It finds Claude
Code as `claude.exe` on PATH (the native installer) or through the `claude.cmd` an npm install
creates, including yarn classic's, which runs npm's shim in turn, and always starts it by its full
path, so a `claude.cmd` in a project folder is never picked up (#191); "Start Claude here" finds it
the same way. With neither installed, both say so and start nothing. An estimate is shown before; the actual usage Claude Code reports is recorded after. Measured: a small session cost
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

Where Windows Terminal is not installed (stock Windows 10, or removed from a managed machine), the
same `claude` command opens in a console window of its own instead, with no tab name and no
placement, and the page says so (#157). Windows PowerShell 5.1 starts it with `Start-Process`, from
a script passed encoded so that no command line parses the folder or file names; that also works
where PowerShell runs in Constrained Language Mode. Verified in Windows Sandbox, which has no
Windows Terminal.

The settings file applies to that one session only (Claude Code documents `--settings` as a level
that "lasts one session and doesn't write to any file"); your own settings are never touched. It
adds two things:

- **A status line** that forwards Claude Code's status JSON to LayerCake with `curl.exe` and prints
  the line LayerCake sends back (`LayerCake · ctx 42% · $1.23 · 5h 12% · cache warm`) under the
  prompt. This is the only source of exact context use, cost, the 5-hour and weekly plan limits
  (Pro and Max) and prompt-cache warmth. It also re-runs every 15 seconds (`refreshInterval`), so
  a running session reports at least that often, except while a dialog such as a permission
  prompt is open: Claude Code hides the status line then. So a session with no pid file counts as
  running while it has reported in the last 45 s, or while a prompt or tool it reported is still
  open. Silence past that reads as "most likely stopped", which is how a crash or a closed tab
  stops reading as "running". Once Claude Code writes its own pid file for the session, that
  decides instead.
- **HTTP hooks** for the documented events (prompt submitted, tool start and finish, permission
  requests, notifications, subagents, compaction, instructions loaded, session end). These make
  **"Waiting for you"** possible: a permission prompt, an idle prompt, an MCP server asking for
  input, or a usage-limit resume waiting for Enter turns the session's glow amber until Claude
  moves again. They also show tools running right now, and why each memory file loaded (at start,
  a path-glob match, an include, a nested folder, after compaction).

  Claude Code sends no hook when you answer a permission prompt, so LayerCake sees the answer only
  when the tool finishes (or Claude moves on); the banner says so. A tool you stop with Esc, or
  deny, fires no hook either; it leaves "running now" once the transcript records its result, or
  at your next prompt.

**Zero tokens, measured.** A status line is displayed, never sent to the model (however often it
re-runs), and every hook is
answered with an empty 204, which Claude Code treats as "success, no output". The same one-line
prompt run with and without the settings file used exactly the same input (44,007 tokens each),
and the second run read its whole prompt from cache, which a single changed byte would have
prevented. The session view also counts context added by hooks, by hook name. That counts any
hook, yours and plugins' included; LayerCake's own add none, because their answers are empty.

Things to know:

- The launched session appears in the list after its first prompt, when Claude Code first writes
  its transcript.
- If LayerCake is closed while that session keeps running, each hook shows a "hook error" notice in
  the terminal. Claude does not see those notices (they are non-blocking errors), and the session
  works normally. The status line just goes blank. A restarted LayerCake picks the reporting back
  up: it reloads its launches at startup, and a running session reports again within 15 s (unless
  a dialog is open in it). Until
  then, and for good if it does not, the session reads "no report since restart"; LayerCake never
  guesses "running". A session launched by a LayerCake from before the 15-second refresh reports
  only on activity, so while idle it reads as not running.
- One terminal can carry several sessions: `/clear` starts a new one and `/resume` switches to
  another. LayerCake keeps each session's figures separately, so an old session never shows the
  new one's context, and once a session has ended its last status line is no longer shown as exact.
- The status line runs through Git Bash when installed, and through PowerShell on a machine
  without it, as Claude Code does it; `curl.exe` ships with Windows 10 and later. Both were
  checked (#11): through Claude Code's own PowerShell runner with PowerShell 7 here, and in
  Windows Sandbox (no Git Bash, no PowerShell 7), where Claude Code chose Windows PowerShell 5.1
  itself and the command delivered its JSON intact.
- The window placement is approximate: Windows Terminal sizes in character cells, not pixels.
- A project whose path contains `;` is refused. Windows Terminal reads `;` as "start another
  command", even inside quotes, so a folder named to exploit that could run a program of its
  maker's choosing beside Claude. Rename the folder to launch there.
- Workspace trust not yet accepted, `--safe-mode`, or a managed hook policy silence both channels;
  the session view says so rather than showing stale numbers.

LayerCake's own data (summary cards, AI summaries, the usage ledger) lives in
`%LOCALAPPDATA%\LayerCake\data`, never under `~/.claude`. Override it with `LAYERCAKE_APPDATA_DIR`,
and the Claude data folder read for sessions with `LAYERCAKE_CLAUDE_DATA_DIR`.

## Castle

The **Castle** tab (after a scan) is a live picture of the Claude Code sessions working in the
scanned project, meant to be read from across the desk: the project's own sections are rooms that
light up with what Claude does in them, and each session, subagent, skill, MCP call and web call is a
figure standing where it works. It follows the owner's Castle spec, which is kept outside this
repository; this section is the spec for what is built. This build is the spec's Phase 1 (the wiring
and an event log), Phase 2 (the plain castle), Phase 3 (the figures walk, #161) and Phase 4 (the art,
#162: a castle at night, drawn flat, rooms as stone floors lit by what happens in them). Polish is
#163. Everything shown comes from a real event: when LayerCake knows nothing, the castle shows less,
never something invented.

**The drawing.** Each room is a stone floor with its type's icon, its name and its state. A state is
a pool of light and a mark in the room's corner: Alarm red with a "!" and a heavy edge, Construction
amber with sparks, Survey blue with a lantern, Proven gold with a pennant, Embers dim orange with
coals (brighter while the room is warm), Dark in moonlight with a crescent. The marks, the state's
glyph and its name say the same as the colour, so no state rests on colour alone. Nothing moves on its
own: a castle with nothing happening redraws nothing.

**Full screen.** The Castle's **Full screen** button fills the screen with the Castle view alone:
the header, the tabs and the watch bar go, and Esc or **Exit full screen** brings them back. (F11 is
the browser's own full screen for the whole window, header included.)

**Where it comes from.**

- **Sessions started with Start Claude here** report through their hooks, as they already do for the
  Sessions tab. A tool call reaches the castle within a second, and only these sessions can say that
  Claude is **waiting for you** (the Herald).
- **Any other running session in the project** (started in a terminal, an IDE, anywhere) is drawn
  from its transcript, which Claude Code writes when each model response completes: a tool call
  appears when the response that makes it lands, and its result when the tool finishes. Each is
  labelled "from its transcript, about N s behind; no waiting signal", N measured live from the
  session's own new calls. Subagents are read from their own transcripts.
- A launched session is also backfilled from its transcript, so opening the castle mid-session, or
  after LayerCake restarts, shows what happened before. A call both sources report counts once,
  keyed by its tool_use id.
- The castle includes every session running now whose start folder is the project or inside it, and,
  if none is running, the most recent one, so it shows how that session left things. At most 6.

**The rooms are the project's own sections** (#167): its API, its database code, its UI, its agent,
whatever it actually has, named in its own words, inside the castle's wall. Each room has a
**type** from a fixed list, shown in the room, which says what kind of part it is: API, Routing,
Database, Storage, UI, Agent, Auth, Services, Core, Jobs, Integrations, CLI, Build, Config, Tests,
Docs, Logs. A project describes its rooms in `castle.json` (below), which Claude drafts from the
project's layout; the page's **Copy prompt for Claude** gives it the prompt. Rooms keep their places:
people learn the map by where rooms are, so new rooms go at the edges.

Until a project has a `castle.json`, the built-in map applies: twelve common areas, each typed, with
patterns from folder and file names that usually mean the job:

| Room (type) | Built-in examples |
|---|---|
| Database | `**/db/**`, `**/migrations/**`, `**/*.sql` |
| Core | `**/lib/**`, `**/core/**`, `**/utils/**` |
| Integrations | `**/integrations/**`, `**/.mcp.json` |
| Logs | `**/logs/**`, `**/*.log` |
| Docs | `**/docs/**`, `**/*.md` |
| Jobs | `**/jobs/**`, `**/workers/**` |
| Build and config (Build) | `**/scripts/**`, `**/.github/**`, `**/package.json` |
| UI | `**/client/**`, `**/components/**`, `**/*.css`, `**/*.jsx` |
| Tests | `**/tests/**`, `**/*.test.*`, `**/*smoke*` |
| Auth | `**/auth/**`, `**/*auth*`, `**/*security*` |
| API | `**/routes/**`, `**/api/**`, `**/app.*` |
| Services | `**/services/**`, `**/middleware/**` |

**The ground (#172).** The castle is **Duskhold**, a keep whose north wall is **the Frostwall**, with
**the Wilds**, a forest, beyond it. **Hollowmere** is a village on a mere west of the keep, **the
Sept** a seven-sided hall below it where git and GitHub work is done (#186), and **the Citadel** a
beacon tower on a rock east of it (#183). The gate is the keep's only way in or out: a road runs west
and east in front of it, and on south, and each place has its own spur off it: Hollowmere's up the
west band's outer edge, the Sept's straight to its door, the Citadel's in the east. The names are
the project's own inventions.

The built-in map is a starting point, not a picture of the project: on LayerCake's own repository it
left 24 of the 28 files in `server/` unclaimed, and a drafted map leaves none. The full lists are on
the page (click a room). A file several rooms claim lights all of them. A file in the project that no
room claims belongs to **Hollowmere**, which is the sign the map needs a pattern; one of its eight
houses lights a window for each such file touched, and a unit working on one walks out of the gate
and west along the road to it. A file outside the project (your home folder, Claude's configuration,
other projects) belongs to **the Citadel**; it is counted apart, since no pattern could claim it, its
beacon is lit once any such file has been touched, one of its six windows for each, and a unit
working on one walks out of the gate and east along the road. Past the windows drawn, the count by
its name says how many. Clicking Hollowmere or the Citadel (anywhere in its band) lists its files.

**The Sept** (#186) is where git and GitHub work is done. A shell call whose command starts with
`git` or `gh` (recognised by its first words, the way test and build runs are) walks its Mason or
Knight out of the gate and up the Sept's spur, and the rooms of any project files it names still
light as Survey. There it acts out the command: a commit lights a candle, a push hauls the bell rope
(and the Sept's own bell swings while the push runs), a status, log, diff or show reads the ledger,
and anything else turns the crank. A git or gh command that fails with an exit code (a rejected push,
a merge with conflicts) raises the Sept's Alarm, a red glow and a mark, until a later one succeeds;
one with no verdict (denied, interrupted, refused) changes nothing. Hover the Sept for the branch,
the count and its latest command.

- **What it reads.** The project's `.git` folder, as files and through the same reader as every other
  file: HEAD, the branch's ref (loose or in `packed-refs`), the `[branch]` section of `config` for its
  remote, that remote's ref, and the branch's log. Git is never run, so the Sept works where git is
  not installed, and it sees git you run yourself as well as Claude's. A worktree's `.git` file is
  followed to its folder, but never onto a network share the project is not on (#193): the Sept then
  says ".git points at a share". Nothing in `.git` is written, and nothing but the branch name and a count
  leaves the server: never a commit message, a remote URL or a path.
- **The banner** over its door names the branch, or the short commit when HEAD is detached.
- **Its seven windows** light one for each commit on the branch not yet on its remote, counted back
  along the branch's log to where it last stood at the remote's commit. When that log cannot say (a
  reset, rebase or merging pull since, a remote that has moved on, an expired log, no remote branch)
  one window lights and it says "not pushed: unknown". An amended commit counts as none, so amending a commit already pushed reads "all pushed".
- **No repository, or one that cannot be read** (a share that is down, HEAD caught mid-write): the
  Sept stands unlit with no banner and says so, and nothing else changes.

**Where runs go** comes from the types: a test run lights the first Tests room, a build run the first
Build room, a migration the first Database room (a command rule can name a room instead). Any other
shell call works in the rooms of the project files its command names (`cat server/scan.js` works
in that file's room; only names a room's patterns claim count, so `origin/main` is no file), and one
that names none (`ls`, `echo done`) moves no one and lights nothing: it used to send every such
call to the first Build room, which then filled with units doing git work there (#176). Git and gh
calls go to the Sept instead, lighting the rooms of the files they name (#186). Those names
only choose rooms; none is listed among a room's files. MCP calls
wait on the Frostwall above the first Integrations room, else above the gate's column.

**Room states**, highest priority first. The page shows each rule beside the state (hover a state in
the legend, or click a room); the rules come from the server with the data.

| State | When |
|---|---|
| Alarm | A change to a file here failed; a test or build run failed while this room had unproven changes; or one file here was edited 4 or more times in 10 minutes with no passing test or build between (thrash) |
| Construction | A file here was edited or created in the last 60 s |
| Survey | Read, searched, or worked on by a shell command in the last 60 s, with no change |
| Proven | Changed, then a proof run passed, and not changed since; ends with the session that ran it |
| Embers | Touched by the current sessions, quiet now; brightness follows recent activity |
| Dark | Not touched by the current sessions |

- **Scaffolding** (poles, planks, a hatch and "unproven") marks a room changed since the last passing proof run,
  whatever its lighting: unverified work at a glance.
- **Documentation is never on trial.** No run can prove a Docs room, so a change there puts up no
  scaffolding, no run judges it, and editing one file there again and again is not thrash. It
  lights as Construction, then Embers; only a failed change raises its Alarm.
- **Runs.** A shell call is a test, build or migration run when a segment of its command starts with a
  rule's words (`npm test`, `npm run smoke`, `pytest`, `dotnet build`, ...; castle.json adds the
  project's own). It passes or fails by its exit code, so `npm test | tail` reads as `tail`'s. A run
  started in the background has no verdict. A run judges every scaffolded room: a pass takes their
  scaffolding down, a failure raises their Alarm (a heuristic: the failing test may have nothing to
  do with that room, and the room's detail says which run caused it). **Proof** is a passing test
  run by default; a project with no tests sets `"proof": ["test", "build"]`.
- **No verdict is not a failure.** A call you deny, one Claude Code rejects or refuses before it
  runs, and one you interrupt never raise an Alarm, and a run with no exit code (refused, timed out)
  proves and fails nothing. A transcript records a refused call as an error, so from a transcript an
  error counts as a failure only with evidence the tool ran: an exit code, or a system error code
  such as EACCES.
- **Alarm clears by cause:** a failed change on a later successful call in that room, a failed run
  on a passing proof run (a failed build also on a passing build), thrash on any passing test or build
  or once 2 minutes pass with no further edit of that file. (In an edit, test, edit loop whose test
  takes longer than that, the thrash Alarm goes dark during each run and comes back at the next edit.)
- **Session end:** Construction, Survey and Proven fall to Embers; Alarm and scaffolding stay until
  their rule clears them, because they describe the code, not the session.
- A room holds what it shows for 3 s before changing, except to Alarm, which shows at once; light
  fades over 1.5 s. A room cooling in Embers dims in a small step every 10 s, without a fade: a fade
  per step kept the castle redrawing for minutes after work. With reduced motion set, nothing pulses.

**Units** (a figure on a dark disc ringed in its session's colour, or a Knight's own): a **Mason**
(with a hammer) is a session, in the room of its latest call, resting once 60 s pass with no call or compaction running (dimmed,
with a "z"); a **Knight** (a helm and a banner in its own colour) is a subagent, from its start to its
stop; a **Wizard** (hat and robe) is a skill Claude invoked, beside its caller until the caller's turn
ends (a skill you type as `/name` is not seen); a **Raven** (a bird on a disc ringed in its session's
colour, larger than the rest, #182) is an MCP call, on the Frostwall above the first Integrations
room (else above the gate's column), and the wall's name moves to the other end so it is not
covered; a **Scout** (a horse) is
a web fetch or search, down the road from the gate; the **Herald** (a bell, with a ring) is at the gate while a launched session
waits for you, the one unit that pulses; a **Scribe** (hooded, writing at a lectern) is at the gate while Claude Code compacts
the conversation (below). Clicking a unit opens the room it stands in. Hovering one
says what it is doing first (its latest call, where, a Knight's task), then the session it belongs
to: its name in quotes, with who named it, Claude Code or you, because a title Claude Code chose
("Session cleanup") otherwise reads as what the unit is doing (#179). The room's "Here now" says the
same.

**Raiders** (three hooded archers, on dark discs ringed in ice) are a test run while it runs (#172).
They come out of the Wilds, or stand out at the front south of the road, whichever side is nearer the
rooms they aim at, and loose arrows over the wall at the rooms with unproven changes (the ones the
run's verdict judges) and at the code the command's named test files are for (#177). That is a
guess by name: `scan.test.js`, `scan.spec.ts`, `test_scan.py`, `scan_test.go` and `ScanTests.cs` point
at `scan`, looked for beside the test, mirrored out of a tests folder (`tests/server/scan.test.js`:
`server/scan.js`), and among files of that name the castle has seen calls touch; Tests and Docs rooms
are left out. A bare `npm test` names nothing. With no unproven changes and no named test file, the
band musters at the forest's edge and shoots at nothing: the run's own Tests room is not what it
tests. A **crane** (a treadwheel crane, ringed in wood) is a
build run (#173: a build builds, it does not attack), before the gate south of the road, hoisting stones along a cable
onto the rooms with unproven changes. With none, it stands idle, no cable out: the build's own room
is not what it builds (#178). Both leave when the run ends, or when its turn is interrupted, and the verdict
lands as the rules say: a passing proof run takes the scaffolding down (a test run; a build too where
`proof` includes builds), and a failure raises the Alarm. Their arrows and stones are drawn as a
flip-book, 8 frames a second on one shared timer, only while a run is on screen, and they hold still
with reduced motion.

**The gate and its torches** (#163). The gate's portcullis is up, and the torches along the front
wall are lit, while any session in the castle is running. It stays up until the last Mason or Knight
walking out is out, then drops, and the torches go out. It rises or drops in six frames on the
flip-book; when the castle opens or reconnects it is simply where it should be. The flames flicker on
the flip-book too, but only ride it: they move while something else on screen is acting, never start
it, and stand still when the castle does. With reduced motion the gate snaps and the flames hold
still. Hover the gate to read which it is.

**Movement.** Units walk; none jumps from room to room.

- A Mason or Knight walks the corridors to the room of its call: out of its room's door onto the
  corridor below, along to a gap between the columns, up or down, along, and in. One room to the
  next takes about 1 s.
- Hollowmere, the Sept and the Citadel are reached out of the gate and along the road in front of
  it, each up its own spur, and left the same way (#183, #186). On LayerCake's own castle such a walk runs to 2,060 long, so it takes its length's time at
  about a room-to-room walk's pace (800 a second; three of those measure 325 to 1,195), from 1 s up
  to 3 s, sped up with a queue like any other.
- Every room it worked in is walked through, in order, and none is skipped: parallel calls in three
  rooms send it through all three. When several are queued it speeds up to keep up (with n queued,
  each takes 1/n of a second, never under 0.25 s); rooms on the way are crossed through their middle.
- A Mason or Knight first seen while the castle is open walks in from the gate to where it is (what
  it did before the castle saw it, such as a resumed session's earlier work, is not walked), and
  walks out through the gate when its session ends or stops reporting, or its subagent stops. A
  Raven flies from its room up to the wall and back when its call returns; a Scout walks out of
  the gate and back; a Wizard fades in beside its caller and goes where it goes.
- What was already there when the castle opens, or reconnects (a rescan, a hidden tab shown again),
  stands where it is: a walk nobody saw would be invented. So does every unit when the map is
  reloaded, since the rooms changed and nobody walked.
- Raiders and cranes do not walk: they appear with their run and go with it.
- With reduced motion set, nothing walks: a unit that moves fades in at its new place.
- Walking costs nothing when nobody walks: each walk is one browser animation that ends on arrival,
  with no drawing loop running in between.

**Poses** (#163). A Mason or Knight acts out its latest call once it is in the room: it hammers on
a stone for an edit, lays a stone for a write, reads a scroll, swings a lantern for a search, and
turns a crank for a shell command, with the room's light in the act (sparks off the hammer, the
lantern's blue light, dust as the stone lands, steam off the crank). A working Knight holds its
banner in its other hand.

- A pose plays for as long as the call runs, and for at least 2 s from when the castle sees the
  call. Most reads and searches end inside 60 to 150 ms, so without the minimum they would never
  show; and a session read from its transcript is seen a few seconds late, often after the call
  ended.
- The walk comes first: a unit walks to the room, then acts. A later call takes over at once.
- A call already over when the castle opens or reconnects plays nothing; one still running plays at
  once.
- A call a helper carries (a subagent, a skill, an MCP or web call) has no pose: the Knight, Wizard,
  Raven or Scout is the one at work. A Raven beats its wings and a Scout trots for as long as they
  are out, and a Wizard sparkles while the unit beside it acts. A Raven drops five feathers along
  each flight, up to the wall and back, which drift down and fade over about 2 s (#182).
- The Herald swings its bell on the ring's slow pulse rather than on the flip-book, since it can
  stand at the gate for hours while Claude waits for you.
- **The Scribe** writes at its lectern, its quill moving along the line, for as long as Claude Code
  compacts the conversation, and for at least 2 s from when the castle sees it; its session's Mason
  waits meanwhile, and rests 60 s after the compaction ends, not during it. A session started with
  Start Claude here reports a compaction's start and end through its hooks, so its Scribe is live.
  Any other session's transcript records a compaction only once it is over, with its length, so its
  Scribe comes afterwards, for 2 s. One already over when the castle opens or reconnects is not
  shown. A compaction whose end never arrives ends at its session's next call, prompt or stop. The
  hover card says what started it: `/compact`, or a full context.
- Poses, arrows and stones step on one timer, 8 frames a second, which runs only while something on
  screen is acting; a still castle runs no timer. With reduced motion set, a pose holds its first
  frame for as long as it would have played.

**castle.json.** A project describes its rooms with `castle.json` at its root. LayerCake reads it
and never writes it. **Copy prompt for Claude** copies a prompt to paste into a Claude session in
the project, so Claude drafts the file from the project's real layout (and, when the file exists,
keeps every room where it is and adds new ones at the edges); the prompt is built by the server from
the same rules the file is checked against. **Reload map** re-reads it, and so does an edit to it
that the castle sees.

```json
{
  "version": 2,
  "rooms": [
    { "id": "scan", "name": "Scan and lineage", "type": "core", "col": 1, "row": 0, "patterns": ["server/scan.js", "server/paths.js"] },
    { "id": "api", "name": "HTTP API", "type": "api", "col": 1, "row": 1, "patterns": ["server/app.js"] }
  ],
  "gate": 1,
  "commands": [{ "words": "npm run smoke", "kind": "test" }],
  "proof": ["test"]
}
```

- Each room has an `id` (1 to 32 lowercase letters, digits and dashes, unique, and not a place the
  castle already uses: gate, beyond-gate, village, wilds, outside, perch, project), a `name` of up to 40
  characters in the project's own words, a `type` from the list above, and its place: `col` 0 to 3
  and `row` 0 to 5, one room a cell, row 0 at the back. At most 24 rooms. The floor is as big as the
  rooms placed on it, and the gate is in the front wall under the column `gate` names (else the
  middle one). Only the rooms the file lists exist: no built-in room is added to them.
- Patterns are relative to the project root with `/`; only `*`, `?` and whole-segment `**` are
  wildcards (no braces, classes, `!` or backslashes); a pattern without a slash matches at the root
  only. At most 50 patterns a room, 200 characters each, 100 command rules, 64 KB.
- A version 1 file (the old fixed castle rooms, renamed or dropped) is no longer read: the page says
  so, and Copy prompt for Claude drafts a version 2.
- A file that cannot be used leaves the built-in map in force AND the page says why.
- castle.json can arrive in a cloned repository, so it is data only: the matcher is LayerCake's own
  and cannot be made to backtrack (a pattern that kept a regular-expression matcher busy for over a
  minute costs microseconds), and command rules are word prefixes, never regular expressions.

**Things to know.**

- The castle exists only while a Castle tab is open: nothing is followed or kept for a project nobody
  is looking at. A hidden tab pauses its stream (each open stream holds one of the browser's six
  connections to LayerCake) and catches up when shown.
- When the stream stops, a "Not live since ..." layer says so and does not fade: a dead stream never
  passes for a quiet castle. After a LayerCake restart the page must be reloaded.
- Hook history is kept in memory, so a restart loses what only the hooks saw (the Herald's history);
  the transcript backfills the rest, compactions included.
- At most 4 castle streams at once, 6 sessions per castle, and the latest 20,000 events per castle
  (the page says when older ones are left out).
- Hollowmere and the Citadel fit their drawings to the floor's height, so on a floor of one or two
  rows (castle.json puts every room in row 0, or rows 0 and 1) they draw smaller: about a sixth of full size on one row
  (#184). Each stays a click target with its count.
- Searches light a room only when scoped to a folder that room claims; their matched files are not
  used. A shell command's changes to files are not seen (only the files a tool names), so a room a
  script rewrote stays as it was.
- The server keeps each Mason's and Knight's last 12 room changes for the page to walk. A picture
  goes out within 250 ms of a hook and each second from transcripts, so only a unit changing room
  more than 12 times inside one of those windows has its oldest rooms left out of the walk. A
  subagent or session that ends in the same window as its last calls walks out from where the page
  last saw it, without those rooms.

## Network posture

- Binds `127.0.0.1` only, never `0.0.0.0`.
- No outbound requests. Nothing is sent anywhere. LayerCake starts few processes, each with a fixed
  command line: the browser for its window; `reg.exe` during a scan, to read Claude Code's policy
  from the registry; and Windows PowerShell 5.1, to read the start times of running processes so a
  reused process id cannot pass for a running session. Two more start only on your click:
  `claude -p` for an AI summary, and Windows Terminal (or, without it, a console window) running
  `claude` for **Start Claude here** (see [Sessions](#sessions)).
- `/ingest/<launch>/<secret>/…` accepts the status line and hooks of a session LayerCake launched.
  It is outside `/api` because its callers are Claude Code processes, not the page: instead of the
  page token it needs that launch's secret (compared in constant time), refuses any request
  carrying an `Origin` header (a browser always sends one; Claude Code does not), and is behind the
  Host guard like everything else. What arrives is kept in memory, reduced to tool names and
  one-line summaries, plus, for the Castle, the file paths a call names, the first words of a shell
  command (to recognise a test or build run; never sent to the page), whether the call succeeded,
  and what started a compaction (`manual` or `auto`, anything else dropped). No tool input or output
  body is kept.
- Castle routes (`/api/castle/*`) take a scan id, never a path, and serve paths, tool names, one-line
  summaries and room states.
- Session routes serve prompts and replies, so they accept only a session id the server itself
  discovered on disk, never a path, the same way file routes accept only what a scan found.
- `/api/file` and `/api/write` only touch a path the preceding scan discovered. The scan result *is*
  the allowlist, so neither is a general-purpose file reader or writer even though the scan input is
  a directory you type. Requests outside it return 403.
- **Every `/api` route requires the page key** (#189): 32 random bytes made once and kept in your
  LayerCake data folder (`%LOCALAPPDATA%\LayerCake\data\page-key`), which only you can read there.
  It is never in the page. A port on 127.0.0.1 is open to every user signed in to the computer, so
  anything in the page could be read by another of them; until #189 the key was, and another user
  could have used LayerCake as you. Instead, the launch that opens the window gives the address
  the key after a `#` (`http://127.0.0.1:5178/#t=...`), a part of the address no request carries
  and that another user cannot read from the browser's command line. The page keeps it in its own
  storage and takes it out of the address bar. `npm start` prints that address on your console.
  Delete the file to make a new key at the next start. If the data folder cannot keep it (refused,
  unwritable), the server makes a key for that run only and says so.
- **A launch opens its window only on your own LayerCake** (#189, #190). When something already
  answers on the port, the launch sends a random challenge to `/hello` and checks the answer, an
  HMAC of the challenge under the key, against its own; the key itself is never sent. A server that
  cannot answer is another program or another user's LayerCake, and the launch says so and opens
  nothing. Without that, a second user's LayerCake opened on the first user's files, and a program
  that took the port first could serve the window a page of its own, which could leave a service
  worker in the window's profile to rewrite LayerCake's pages later. In case one ever got there,
  the server answers any service worker update check with a 404 and `Clear-Site-Data: "storage"`,
  which removes it, serves the page at `/` only, and sends a Content-Security-Policy allowing
  scripts and requests from its own origin only, and no workers.
- A cross-origin page cannot read the window's storage or address, so it cannot obtain the key.

  This matters because writes changed the threat model. While the app was read-only, a hostile page
  could send requests but not read replies, and a JSON POST triggers a CORS preflight that fails, so
  exposure was near nil. A cross-origin form POST is a "simple request": no preflight, it just
  fires, and the attacker never needs to read the response, because the write already happened.
- The token and origin checks are scoped to `/api` and **not** to the HTML routes, because a
  top-level navigation from a bookmark or a link legitimately carries `Sec-Fetch-Site: cross-site`.
  Guarding the HTML refuses the app itself. The HTML sends `X-Frame-Options: DENY`.
- **Every route, HTML included, refuses a `Host` header other than `127.0.0.1:<port>` or
  `localhost:<port>`.** That closes DNS rebinding: a hostile site re-points its own hostname at
  127.0.0.1, after which the browser treats this server as that site and would let its page read
  whatever the server answers. The Host header still names the hostile site, so the request is refused.
  Nothing legitimate is affected: LayerCake's own callers address the server as `127.0.0.1` (the CLI
  calls the server modules directly and makes no HTTP call), and a bookmark to
  `http://127.0.0.1:5178` sends the right Host. In a browser that has opened LayerCake before, the page still has its key;
  in any other, its requests are refused with a message saying how to open LayerCake (#189).
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
| Dead UNC share (a dead mapped drive takes the same path once a scan has classified it; reasoned, not tested) | 3 s per-operation timeout, level marked unreachable, no hang; the watch bar lists its folders as `Share not reachable`. After one call to the share times out it gets no other until that one returns, so its remaining levels fail at once as `ESHARESTUCK` (not tried) and a dead share holds one threadpool thread, not all four (see "Watching for changes" for why a timed-out call holds one) |
| Permission denied | `EACCES` / `EPERM` badge on the level, other levels unaffected |
| Malformed JSON | Parse error banner plus the raw text |
| Malformed YAML frontmatter | Parse error banner plus the raw block, markdown body still renders |
| File over 2 MB | Read capped at 2 MB with a truncation notice; JSON parsing is skipped |

Configurable via env: `PORT` (default 5178), `CLAUDE_EXPLORER_DIR_TIMEOUT_MS` (default 3000),
`LAYERCAKE_SNAPSHOT_DIR`, `LAYERCAKE_APPDATA_DIR`, `LAYERCAKE_CLAUDE_DATA_DIR` (default `~/.claude`,
for session data only), `LAYERCAKE_BROWSER_PROFILE_DIR` (the app window's browser profile, default
`%LOCALAPPDATA%\LayerCake\browser`).

## Layout

```
server/
  app.js         express app, localhost bind, per-scan allowlist, routes; never listens on import
  index.js       entry for npm start and the launcher: serves public/ from disk
  security.js    localhost CSRF guard, the page key check, the launch's challenge
  scan.js        lineage resolver
  paths.js       platform paths, the scan manifest, snapshot root
  readfile.js    the only file-body reader
  writefile.js   the only edit path; depends on snapshot.js by design
  snapshot.js    capture, compare, restore, and the atomic write primitive
  flatten.js     the four flattened views
  watch.js       filesystem watcher: directory watches, polling on a share, debounce, config filter
  safety.js      denylists, editable categories, size caps, timeouts, errors
  sharegate.js   one filesystem call per network share at a time, for the scan and the watcher
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
  castle.js      the Castle: sessions, events from hooks and transcripts, the fold, the state
  castlemap.js   the Castle's floor plan, castle.json, the glob matcher, command rules
  castle-routes.js  /api/castle/stream, /api/castle/room, /api/castle/reload
client/          React UI: explorer, viewers, editor, snapshots, watch bar, sessions, castle
cli/             the layercake CLI, importing server modules directly
scripts/
  start.js            build-if-stale, then serve
  launch.js           build, serve, wait for ready, open an app-mode window
  build-if-stale.js   the client build rule, shared by start.js, launch.js and smoke.mjs
  install-shortcut.ps1  per-user Start Menu shortcut (-Desktop, -Uninstall)
  smoke.mjs           end to end test over the real HTTP API
  smoke-sessions.mjs  its session part: a synthetic Claude data folder and checks
  smoke-castle.mjs    its Castle part: hooks, transcripts, castle.json, the fold
  make-icon.mjs       draws desktop/layercake.ico; run by hand, the .ico is committed
desktop/
  window.js      the app window: browser, profile, isolation flags, error page
  main.js        entry of the single executable
  inflight.js    running-request count, so shutdown waits for a save to finish
  build.mjs      npm run build:exe
  layercake.ico  the exe's icon, and the page's favicon.ico (vite.config.js emits it into the build)
layercake.cmd    double-clickable entry point for the shortcut
```

`GET /api/manifest` returns the live scan manifest and the live write policy, both derived from the
code that enforces them, so what the app claims can be checked against what it does.

## Running it as a Windows app

`npm run app` (or `layercake.cmd`, or the Start Menu shortcut) builds if stale, starts the server,
waits until it actually answers, then opens it in Edge or Chrome **app mode**: a chromeless window
with its own taskbar entry that looks like a desktop app and costs no extra dependency. The browser
gets a profile of its own under `%LOCALAPPDATA%\LayerCake\browser` (`LAYERCAKE_BROWSER_PROFILE_DIR`
moves it), so the window does not join your running browser or its session, and it runs with
extensions and sync switched off (see [Network posture](#network-posture) for why the profile alone
was not enough).

The window also runs with Edge's startup boost off (`--disable-features=msEdgeStartupBoost`). With
it on, every close of the window (5 of 5 measured) made Edge start a background
`msedge --no-startup-window` for your default Edge profile, not LayerCake's. Only this window is
affected; your own Edge setting is not touched.

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
rather than starting a new one. A double-click just as the last window closes also works: the new
launch notices the old server going away and takes over its port, and the new window's "can't reach
this page" reloads itself onto it.

The build runs `vite build`, bundles the server into one script with esbuild, and embeds `public/` as
assets. It then copies the `node.exe` that ran the build, gives the copy LayerCake's icon and version
information (with `resedit`, a build-only dependency that nothing at runtime loads), injects the
bundle into it, and marks it a Windows GUI program so no console appears. Last, it reads the finished
file back and fails the build if the name, the icon or the injected bundle is not there. Rebuild after
any change, including to `client/`.

What to know:

- **It prints nothing.** A GUI program has no console. A failure to start (usually the port) opens
  an error window saying what to do; an unexpected crash opens one with the stack. For anything
  deeper, run `npm run app` from a terminal, which is the same server with its output visible.
- **Another port:** `$env:PORT = 5200; & 'C:\path\to\LayerCake.exe'`. The browser keeps the
  remembered directory per port, so a different port starts without it.
- **It is unsigned.** Fine on the machine that built it. Downloaded onto another machine (so marked
  as coming from the internet), SmartScreen will warn on first run.
- **The CLI is not in it.** `layercake here` still runs from source (`npm run cli -- here`).
- **It follows the browser profile, not just its own browser.** If an Edge for the LayerCake profile
  is already running (a window left open after the server was killed, say, or an `npm run app`
  window on another port), Edge takes the new window itself and the exe's own browser exits at once.
  The exe then stays up until no browser is running on that profile, so it stops when the last
  window on the profile closes, including windows that are not its own. A window closed within five
  seconds of opening also stops it: it watches for the profile's lock file while its browser starts,
  and a browser that showed one and then left the profile empty was closed, not handed off.
- **Without Edge or Chrome** (Edge can be uninstalled in the EEA), it falls back to your default
  browser: a normal window in your normal profile, where your extensions run and can read the page,
  including the page key. It also cannot tell when that window closes, so it keeps running.
- **It is named LayerCake, with its own icon.** Task Manager's Processes tab lists it as
  "LayerCake", Explorer's Properties > Details shows that name with the version in `package.json`,
  and Explorer shows the cake icon.
  The icon is `desktop/layercake.ico`, drawn by `node scripts/make-icon.mjs`, which only needs
  running again to change the drawing. The copyright line is LayerCake's, taken from `LICENSE` at
  build time, followed by a credit to Node.js, since most of the file is Node and its license asks
  for its notice to travel with copies. A release carries the full notices beside the exe in
  `THIRD_PARTY_NOTICES.txt`.
- Its taskbar entry and toasts belong to Edge, not LayerCake, as with `npm run app`. The page serves
  the same cake as `/favicon.ico`, which Edge shows in the window's title bar.

## Development

```
npm run dev:server     # API on 5178
npm run dev:client     # Vite with HMR on 5179, proxying /api/
npm run smoke          # end to end test over the real HTTP API
npm run build:exe      # the single executable, see above
```

Open the dev page at `http://localhost:5179`, not `http://127.0.0.1:5179`: Vite listens on the IPv6
loopback (`::1`) by default, so the IPv4 address does not connect.

`dev:client` needs `dev:server` already running on the same `PORT`, and a built client
(`npm run build`, once). When Vite is listening it prints `LayerCake dev page:` with the address to
open, the page key after the `#` (#189), the way `npm start` does; the page keeps it, so reloads
and hot updates go on working. Only this page's own requests (the browser marks them
same-origin) are presented to the origin guard as the server's page, and Vite's CORS is off so no
other localhost page can read what the proxy returns. All of it lives in `vite.config.js` and none
of it reaches a build. The dev server serves the cake at `/favicon.ico` too, straight from `desktop/layercake.ico`.

On a computer shared by several signed-in users, the client build's lock (a named pipe,
`\\.\pipe\layercake-client-build-<hash>`) can be held by another user, and `npm start` would then wait
for it (#196; reasoned from the code, not tested). The exe and a built tree are not affected.

`npm run smoke` rebuilds the client first if `public/` is stale (the same rule as `npm start`),
creates its own fixture tree, starts a server on its own port with its own snapshot
store, drives the real HTTP API, and removes everything it made. It needs no framework and adds no
dependency. Checks this machine cannot run print as `SKIP` with the reason, never as a pass. The
mapped-drive checks run only with `SMOKE_MAPPED_DRIVE=1`, because they map a free drive letter to
the admin share (`net use`) for the run and remove it afterwards.

It exists because this code can fail **silently**. A CSRF guard applied one route too widely once
left every HTTP assertion green while the real app refused to load in a browser, since Node's
`fetch` sends no `Sec-Fetch-*` headers and a genuine navigation does. The suite now covers that
case, and it greps the finished snapshot tree for a credential sentinel with a positive control, so
a clean result cannot be a false clean.
