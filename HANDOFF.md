# HANDOFF

Working state for picking this up in a new session. **Disposable.** Durable rules live in
`CLAUDE.md`, user-facing spec in `README.md`. If something here contradicts those, they win and this
file is stale.

Last verified: **2026-09-29** (the Castle, section below). Write/snapshot work was done 2026-09-05; file watching 2026-09-15;
the single executable and the app-window isolation fix 2026-09-25; session history (Phase 1 of the
session-wrap plan) 2026-09-26; testing against a copy of a real project, 2026-09-26 to 27 (see
those sections below).

---

## Where things stand

LayerCake went from a read-only lineage viewer to a read-write manager. Everything below is built
and verified. Nothing is half-finished or knowingly broken.

**Start here to confirm the state yourself, before trusting a word of this file:**

```
npm run smoke                       # expect: 0 failed
node cli/index.js here C:\dev\LayerCake   # expect: ~18 line summary, exit 0
```

Smoke was 397 passed, 0 failed, 3 skipped on 2026-09-28 with 42df32a (Windows; the skips are the
opt-in mapped-drive checks, a Linux-only one, and #144's link-to-a-share check, which needs a
directory symlink this user cannot make without Developer Mode). With `SMOKE_MAPPED_DRIVE=1`: 400
passed, 0 failed, 2 skipped (it could not pass before 42df32a, #156). WSL Ubuntu (Node 22.22.1, copy
at `/tmp/layercake-linux-smoke`, lockfile unchanged so `rsync` the tree over it and run
`node scripts/smoke.mjs`): 341 passed, 0 failed, 17 skipped on 2026-09-28 with 42df32a.
Smoke writes and deletes a throwaway `HKCU\Software\LayerCakeSmoke-*` key on Windows (#147).

2026-09-29, with the Castle: `node scripts/smoke.mjs` gave 477 passed, 0 failed, 3 skipped (the
same three skips), the castle checks taking about 21 s of it.

`dist\LayerCake.exe` was rebuilt from abd1a61 (the Castle) on 2026-09-30, after the owner closed
his copy, and launch-checked with `exe-lifecycle-castle.ps1` (all passed); it is current. Older
"not rebuilt" notes below are history.

### 2026-09-29: the Castle view (#159, #160; #164 found on the way)

The owner's Castle spec, kept outside the repository at his request (untracked 2026-09-30; it is
in the history of abd1a61) ("The Castle": a live, passive picture of a project, rooms lit
by what Claude does in them, units for the session, subagents, skills, MCP and web calls, a Herald
when Claude waits). The plan, reviewed by two design agents against the code, is at
`C:\Users\donal\.claude\plans\review-the-contents-of-glimmering-shamir.md`. Owner decisions 18 to 20
below. Built: the spec's Phase 1 (wiring, event log) and Phase 2 (the plain castle), one commit.
Phases 3 to 5 are #161 to #163 (#162, art, needs the owner's direction first). The README
"Castle" section is the user-facing spec; CLAUDE.md has the invariants (the Castle paragraph, the
transcript and ingest lines, the known limit).

What it is, in the code: `server/castle.js` (sessions, the merge of hook and transcript events by
tool_use_id, the fold, the state), `server/castlemap.js` (floor plan, built-in patterns, castle.json
read only, a hand-written glob matcher, command rules, the Copy-prompt text),
`server/castle-routes.js`, a per-session ring of reduced records in `ingest.js`, `toolTargets` /
`toolVerdict` / `SubagentReader` in `transcript.js`, and `client/components/CastleView.jsx` and
`CastleStage.jsx` (SVG). Full Screen is element full screen of the Castle view.

**Mutants** (`mutate-castle.mjs`, the final tree): all 24 caught, control 477/0. One ("hooks push
only on the 1 s tick") is caught by timing, not firmly. Another, "units of stopped sessions kept",
survived the first round and was class (a) (a terminal session ends with no SessionEnd), so smoke
gained the check that now catches it.

Measured and found, each in the commit message:
- **Real-session probe** (`probe-castle.mjs`, `claude -p` on Haiku, $0.10): 11 of 11 tool calls in
  the castle log, none doubled; hook to castle 89 to 265 ms; the transcript shows each call a median
  205 ms after its hook, so the spec's "transcripts lag" does not hold for tool calls. Hook
  `agent_id` has the transcript file's format (`a` + 16 hex). This session, read from its own
  transcript: 1.8 to 2.8 s behind (parallel calls land when the whole response does).
- **#164, found by that probe and fixed:** a command Claude Code refused before running it was a
  failed test run (the transcript records a refusal as an error; no hook failure fires).
- **The fold oracle** (smoke: close every stream, reopen, the fresh fold must equal the old) caught a
  real defect on its first run: a session joining a castle later never had its subagent files read.
- **Idle cost:** a smooth CSS pulse on an Alarm cost 15.9% of a core in the renderer, a stepped one
  still 5.6%; a class toggled every 1.2 s costs 0.19% (`ui-idle.mjs`).
- **picomatch rejected:** a review agent measured it running over a minute on one hostile pattern;
  the hand-written matcher agreed with it on 200,000 random cases (`diff-glob.mjs`) and smoke asserts
  its hostile/benign time ratio.

Tooling, in this session's scratchpad (`%TEMP%\claude\c--dev-layercake\f49f6395-...\scratchpad`):
`mutate-castle.mjs` (every Castle mutant; engine from `mutate-64.mjs`), `probe-castle.mjs`,
`castle-live.mjs` (a castle stream on real sessions, frames summarised), `ui-castle.mjs` and
`ui-castle-2.mjs` (headless Edge: render, drawer, full screen, the 3 s hold, Alarm skipping it,
rescan, clipboard, reduced motion, not-live layer, colour-vision screenshots), `ui-idle.mjs`,
`diff-glob.mjs`, `bench-fold.mjs`, `build-exe-copy.mjs`, `exe-lifecycle-castle.ps1` with
`castle-exe-check.mjs` (the exe from a tree copy: castle stream, Castle tab, full screen in an
app-mode window with the exe's flags, window close ends it), `survey-shapes.mjs` (key names and
counts of real transcripts, no content).

**Next: #161, movement.** Its plan is the issue's comment of 2026-09-30
(https://github.com/HoustonDonald/LayerCake/issues/161#issuecomment-5913405122); no code for it has
been written. Start in `fold()` in castle.js (a `trail` per Mason and Knight: `ensureCaller` and
the call-start branch where `caller.room` is set; `stateFrame` passes it on), then
`client/components/castleMotion.js` and the Web Animations driver in CastleStage.jsx. Extend
`ui-castle-2.mjs` (hook-driven headless Edge) for the walking checks, and `mutate-castle.mjs` for
its mutants. The owner's spec is at `C:\dev\_notes\layercake\VisualizerSpec.md` ("Motion and
behavior", "The inhabitants").

### 2026-09-28, night: the (b) queue (#76, #54, #64; #95 part 1 left open)

Each commit message lists its measurements, checks and mutants:
- **02b40cb** (#76): a watched folder renamed or moved is closed, not followed. Its own watch
  reports nothing and names its children under the old path (measured); now each event waits for
  a path-and-identity check, and a watched parent's rename runs it at once (31 of 78 watched
  folders here have no watched parent).
- **e94a162** (#54): Review changes stops after 0.5 s (jsdiff's own `timeout`) and says the two
  are too different; a 5,000-line full replacement froze the page 3 s in headless Edge.
- **e439593** (#64): a `CLAUDE_CONFIG_DIR` in the default home's settings env moves the home, and
  LayerCake follows it (measured on 2.1.284 with a zero-usage probe: everything moves but
  `.claude.json`). Managed settings doing the same is #158, filed, not modelled.
- **#95 part 1** left open with the analysis on the issue: the suggested lockfile signal cannot
  tell a hand-off from a quick close; fixing it needs the exe relaunch-timing harness.

Scratch tools of this round: `watch-rename-76.mjs`, `parents-76.mjs`, `mutate-76.mjs`,
`diff-54.mjs`, `ui-54.mjs` (headless Edge, using the 82a4caf9 session's `edge.mjs`),
`control-54.cjs`, `cfgdir-probe-64.mjs` (the zero-usage home probe), `mutate-64.mjs`.

### 2026-09-28, late evening: a plain-Windows minimum (#11, #157)

Owner: PowerShell 7 and Git Bash may be requirements, but keep a minimum that works without them.
LayerCake itself needs neither (its processes: wt.exe, reg.exe, System32 Windows PowerShell 5.1,
claude, the browser). The work machines are Windows 11 with Terminal, no Git Bash, native Claude
Code installs (owner's answers, on #11 and #89).
- **c1fd5c4** (#11): the launched status line works under PowerShell. Later proven in Windows
  Sandbox: Claude Code chose 5.1 itself there.
- **8dfb36f** (#157): "Start Claude here" opens a console window where wt.exe is missing, through
  an encoded Windows PowerShell 5.1 `Start-Process` (every other route measured and rejected; see
  the commit). README "Requirements" states what is needed and what works without it.
- **Windows Sandbox is enabled on this machine** and is the plain-Windows test bed (CLAUDE.md,
  Known limits). Kit in this session's scratchpad: `layercake-plain.wsb` (networking off),
  `layercake-plain-net.wsb` (on), `sandbox-in\run.ps1` (the last driver) and `stub.mjs`. Copy
  `claude.exe`, `node.exe` and the exe into `sandbox-in` before a run; results land in
  `sandbox-out`. Offline, a never-signed-in Claude Code exits at once, so a launch test needs
  networking on.
- Scratch probes worth keeping: `console-probe\probe3.mjs` to `probe7.mjs` (how to open a console
  window), `probe-11c.ps1` (a hook with shell "powershell" takes Claude Code's PowerShell branch),
  `e2e-157.ps1` (the fallback on this machine, wt.exe hidden from the server's PATH).

### 2026-09-28: triage of the open issues, and the order to take them in

The owner's answers that set it: LayerCake runs on this machine AND on managed work machines;
macOS and Linux are not required; mapped drives are likely at work. Every issue's triage comment
holds the detail. Work top down:

1. ~~**#147**~~: done, 2026-09-28 afternoon (section below).
2. ~~**#150**~~: done, 2026-09-28 evening (section below).
3. **#75**: a dead mapped drive, (a) at work. Needs the owner: a local share for the fast-failure
   case, a work machine off VPN for the timeout case (plan on the issue). The owner chose to skip
   it for now (2026-09-28 evening).
4. ~~**#79 with #95 part 2**~~: done, 2026-09-28 evening, with #156 found on the way.
5. ~~**#76**, **#54**, **#64**~~: done 2026-09-28 night. **#95 part 1**: left open, not cheap
   after all (analysis on the issue).
6. **#146** (macOS/Linux, not required), **#74** (needs Developer Mode to test).
7. Verification only: ~~**#11**~~ (done 2026-09-28 evening: the work machines have no Git Bash,
   so it rose, and it checks out under PowerShell), **#89** (stays low: the work machines use the
   native installer).

The owner chose to keep documented (b) limits open (#74, #54, #89, #11). #11 has since been
verified rather than kept as a limit, and closed with the residual stated.

### 2026-09-28, evening: #150 found and fixed; smoke robustness (#79, #95 part 2, #156)

Two commits, each message listing every check and mutant:
- **fd300e6** (#150): `createExclusive` published with a hard link, then removed the temp name.
  On Windows, while another program (most likely antivirus; not identified) still held that name,
  the new file could not be replaced for 28 to 60 s, so a save, delete or restore moments after a
  create failed with EPERM once the 5 s rename retry ran out. Now: temp, exclusive empty
  placeholder, rename. Product-level A/B side by side under load: HEAD 14 of 1,200 failed, the fix
  0 of 1,200. 24 smoke runs four at a time never showed it; a targeted loop did at once.
  Classified (a) on a busy machine or heavier endpoint protection. Nothing in smoke fails if the
  hard link comes back (it needs load); the scratch loops are the evidence.
- **42df32a** (#79, #156, #95 part 2): the opt-in mapped-drive run maps to its own fixture folder,
  writes its pid, and removes a smoke mapping whose run has ended; its launch checks take their own
  scan (#156: the opt-in run could not pass, reproduced on HEAD); the client build holds a named-pipe
  lock so runs started together on a stale tree build once. #95 stays open for part 1.

Tooling, in this session's scratchpad (`%TEMP%\claude\c--dev-layercake\6d86c8d6-...\scratchpad`):
`stress-150d.mjs` (create then atomicWrite: modes link, plain, placeholder), `stress-150e.mjs`
(the product sequence; `STRESS_ROOT` points it at another tree's `server/`),
`create-branches-150.mjs`, `mutate-150.mjs` (mutants in tree copies; junction unlinked before any
delete), `test-79.mjs` (plants three mappings, runs smoke with the flag, checks and cleans up),
`lock-test-95.mjs`, `e2e-95.cjs`, `exe-lifecycle-150.ps1`.

**Two traps met:** `Invoke-RestMethod` turns an ISO `mtime` into a DateTime and `ConvertTo-Json`
writes `.100Z` back as `.1Z`, which the server reads as a conflict (use `ConvertFrom-Json -DateKind
String`); and several processes appending to one file with `>>` in Git Bash lose lines, so give
each process its own log.

### 2026-09-28, afternoon: managed policy (#147)

One commit, its message listing every check. What changed is in README "00 Managed / enterprise
settings" and the settings-merge bullets; the rules are in CLAUDE.md (policy.js's reg.exe line,
`isDropInName` in the restore fence, the two smoke-only knobs).

- **Premise corrected:** decision 17's note says server-managed settings cannot be read from disk.
  Claude Code caches them at `<config home>\remote-settings.json`. LayerCake lists that file read
  only and never merges it (the assistant's call, labelled as such to the owner): Claude Code
  fetches it again at startup and can hold it back for approval.
- **Found and fixed on the way:** LayerCake read `%ProgramFiles%` where Claude Code uses a fixed
  `C:\Program Files\ClaudeCode` (#153), and smoke probed the machine's own managed folders (#154).
- **A review agent** found eight real gaps, all fixed in the same commit; the (b) remainder is #155.
- **Exe:** built in a tree copy and launch-checked on port 5231 while the owner's copy ran;
  `dist\LayerCake.exe` has been rebuilt since (top of this file).
- **Tooling** in this session's scratchpad (`83d40ce1-...`): `mutate-147b.mjs` (the engine and
  every #147 mutant), `ui-147.mjs` (headless Edge), `exe-lifecycle-147.ps1`, `copy-tree.cjs`.
- **Harness traps met again:** a JSON env var through Git Bash lost its doubled backslashes, and
  reg.exe's `/f` became a path without `MSYS_NO_PATHCONV=1` (both CLAUDE.md 3h). Set such values
  from Node or PowerShell.

### 2026-09-28, morning: the two open owner decisions (#143, #126)

Asked in the terminal; the owner took both recommendations (decisions 15 and 16 below). One commit,
its message listing the checks and mutants:
- **#143:** Snapshots takes the full window, as Sessions does (`App.jsx`). At 1000 px the panel went
  from 580 px to the whole window, and a project path from 15 lines to 1 (headless Edge, with HEAD's
  client as the control that fails). A very long path, such as a plugin cache file's, still wraps.
- **#126:** the plugin cache is read only, by path (`readOnlyReason` in safety.js): no edit, delete,
  create or restore under `<config home>/plugins/cache`. Restore and create were not in the question;
  they follow from "read only" because each writes the file, and are labelled as that inference in
  the commit. The CLI restore leaves such files out and counts them. The plugins folder's own
  manifests are unaffected. `pluginShape`'s cache branch in writefile.js was deleted as unreachable.
- **#152**, found on the way and fixed in the same commit: a save dropped the viewed file's note.

Exe: built and launch-checked in a tree copy on port 5231 (`exe-lifecycle-126.ps1`) while the
owner's copy ran; `dist\LayerCake.exe` has been rebuilt since (top of this file). Tooling in this session's scratchpad (`d003ca25-...`): `mutate-126.mjs` (the 125
engine and mutants, plus 13 for #126), `ui-126-143.mjs`, `exe-lifecycle-126.ps1`.

### 2026-09-28, night: snapshots, UI polish, junctions, write-path edges, the CLI's width

Shipped and closed, each commit message listing its checks and mutants:
- **aa25340** (#139, #141): an over-cap or read-only file is refused before any snapshot; save,
  delete and restore all refuse a read-only file (a delete used to succeed: the unlink clears it).
- **e949e53** (#132, #136, part of #143): the Snapshots panel compares again after a restore's
  rescan; a restore names the files it recreated (`created`), which its undo cannot remove; the
  Restore bar is sticky.
- **510f4db** (#130, #133): runtime folders such as `skills/.trash` go to `other`, never an entry;
  another OS's managed folder is no watch gap; a muted-only bar can be dismissed; the delete banner
  leads with local time and clears when the file is restored. Not changed, said in the commit: the
  "77,091 px" line scrolls inside its block, and the tree pane is resizable.
- **2c7a1f0** (#144): a folder that is a link (a junction) is walked, since Claude Code loads skills
  and agents through one (measured); each file notes the link; a link to a UNC share is listed, not
  walked (`readlink`, never touching the share). The file viewer now shows every entry's note.
- **d4ac237** (#142, #145): restore matches paths as the fence does and fails what it cannot match;
  every refusal carries a code; a settings or `.mcp.json` file must be an object; the command
  template's `$ARGUMENTS` is a real placeholder.
- **7bd582e** (#124): the CLI fits the terminal's width (done by a subagent in a tree copy, reviewed;
  the settings dump is cut only on a terminal). **4588b0f** (#151): `layercake session` too.

Filed: #150 (a restore failed once under four parallel smoke runs), since reproduced and fixed
(fd300e6).
Owner decisions #143 and #126 were settled the next morning (section above). Owner-facing, not an
issue: `context7` sits only in `~/.claude/.mcp.json`, which no session reads (told on Telegram and in
the terminal).

Everything else open is (b), platform-only, or a question: `gh issue list`.

**Mutants:** `mutate-125.mjs` in this session's scratchpad holds all 35 of the evening and night
rounds; on the final tree the control passed 352 and every one was caught.

### 2026-09-27, evening: the views now match what Claude Code loads (#125, #120 to #123, #149)

Each established by a zero-usage probe of Claude Code 2.1.283 (scratch config home; `claude mcp
list`, `claude plugin list --json`, or `claude -p` against a stub API that records the request and
refuses it); each commit message lists the measurements, checks and mutants.
- **24697d7** (#125): counts are of distinct files, with "N reached twice".
- **cbd211e** (#120): `~/.claude.json` project keys are forward slashes, at the git root (a
  worktree's main repository), case as typed; `lineage.gitRoot` finds that root from the filesystem.
- **72b8b50** (#121): a `.mcp.json` inside `.claude` (the config home's included) is never read;
  listed as not read. Owner-facing: this machine's `context7` lives only there, so no session loads
  it (told on Telegram; the owner's call).
- **32b38b6** (#122, #121): plugins. Only installed versions are scanned; a plugin loads only when
  `enabledPlugins` sets it true (missing is off); a local install only at its projectPath's git
  root; names `plugin:name`, servers `plugin:<plugin>:<server>` (`server/plugins.js`). A plugin's
  `.mcp.json` is category `plugin-mcp`, not editable: as `mcp`, a write adding a flat-map server
  returned 200 with no acknowledgement.
- **49edc6e** (#123): rules in the chain (conditional when `paths:`); AGENTS.md only when the
  project's folders hold no CLAUDE.md; project memory keyed by the git root. The managed-folder part
  moved to #147 (needs elevation to measure).
- **2e43c73** (#149, the owner's screenshot): long tool names no longer print over the summary.

The owner had the exe running all session, so every exe check built in a copy of the tree and
launched on port 5231 beside it. `dist\LayerCake.exe` has been rebuilt since (top of this file).

Tooling, in this session's scratchpad (`%TEMP%\claude\c--dev-layercake\82a4caf9-...\scratchpad`):
`mutate-125.mjs` (every mutant of this round, 25 plus the control; name filter as argument),
`edge.mjs` (see the trap below), `ui-120/121/122/123/125/149.mjs`, `exe-lifecycle-125.ps1` (safe
beside a running LayerCake: follows its own window by the Edge process's profile, the exe by PID,
and checks that no Edge started by the test runs on the real profile), `copy-tree.mjs`, and the
probes `mcp-probe-120/121.mjs`, `plugin-probe-122*.mjs`, `instr-probe-123.mjs`, `agents-probe-123*.mjs`.

**A trap:** headless Edge 154 exits 0 at once and relaunches itself, so `puppeteer.launch` fails
("Code: 0") and leaves the browser running on the test profile. `edge.mjs` starts Edge with
`--remote-debugging-port=0` and connects through `<profile>\DevToolsActivePort` instead.

### 2026-09-27, later: faster saves, and the settings model now matches Claude Code

Shipped and closed, each commit message listing its measurements, checks and mutants:
- **5c6e3ec** (#137): a snapshot copies local files 8 at a time; files on a share stay one at a
  time, in a lane of their own, because the share gate counts each call's budget from when it is
  queued (#69), so eight queued together on a slow share time out untried (a mutant with the share
  lane 8 wide timed out 7 of 12 share files). A save over HTTP: 0.9 to 1.1 s before, 0.2 to 0.3 s
  after. Nothing in smoke fails if the lane width goes back to 1; it is a measured timing claim.
- **e8267f7** (#118, #119): the settings view merges only the files Claude Code reads (user, the
  project's `settings.json` and `settings.local.json`, managed), objects per key, lists combined.
  Established with a zero-usage probe of Claude Code 2.1.283 (method in README "Flattened views");
  two of the issue's claims were wrong (the git-root rule is POSIX only, #146; `env` merges per
  variable). Parent folders' settings, `keybindings.json`, the config home's `settings.local.json`
  and the legacy ProgramData managed path are listed as not read, with the reason.
- **0eec620** (#135): create offers a settings file only where Claude Code reads it, from the same
  `settingsSourceFiles` in paths.js the view uses.

Filed: #146 (macOS/Linux git-root `settings.local.json`, not modelled) and #147 (managed-settings.d,
registry and server-managed policy not scanned).

Then, after the owner started trying the exe:
- **5cabd14** (#129): long settings keys wrap instead of printing over the Mode column.
- **55064be** (#131, reproduced): a file that was only READ was reported changed. NTFS updates last
  access when about an hour stale and the Windows watcher reports it; a native change now counts only
  if mtime or ctime moved. The owner hit it by clicking files.
- **c53c3c3** (owner decision 12 below; #140; part of #143): automatic snapshots hold only the files
  they protect; snapshot folders cannot be shared by two saves; a delete's undo opens ticked.
  #138 is now only the retention question (retitled, `question`); #139 and the rest of #143 are open.
- `dist\LayerCake.exe` rebuilt from c53c3c3 and launch-checked (`exe-lifecycle-final.ps1`, which
  also asks the embedded server a #135 question, since a bundle marker cannot see server code).

Ambient lighting (session-wrap plan, physical lights): tried on the owner's Aura case fans and
shelved, decision 14 and #148. The owner turned Windows Dynamic Lighting off for the test and was told
he can turn it back on.

**Owner-facing finding:** the 23 `permissions.allow` rules in `~\.claude\settings.local.json` apply
only to sessions started in `C:\Users\donal`. For this repo the real count is 7 (the old view said
30). Explained to the owner, with a page: https://claude.ai/artifact/7KhyWt5WZto4asiupJ2CdM. Moving
any of them to `~\.claude\settings.json` is the owner's call (several approve a whole shell).

Tooling from this round, in this session's scratchpad
(`%TEMP%\claude\C--dev-LayerCake\06150164-...\scratchpad`), none of it in the repository:
- `settings-probe-119.mjs`: the zero-usage settings probe (marker hooks, stub API). Re-run it when
  Claude Code's settings loader changes. It builds and uses `C:\lc-settings-probe`; `rm-probe.mjs`
  removes it after checking for links (the harness refuses a plain delete of a child of `C:\`).
- `mutate-119.mjs`: the mutant engine from `mutate-v.mjs` with the #119 and #135 mutants, plus a
  whole-file edit (`{ file, whole }`) for running HEAD's version of a file as a mutant.
- `ui-119.mjs` (the settings view in headless Edge, puppeteer from the earlier session's
  `ui-tool`), `exe-lifecycle-119.ps1`, `bench-137.mjs`, `save-http-137.mjs`, `share-lane-137.mjs`.

**A trap:** `node scripts/build-if-stale.js` does nothing at exit 0: the module exports the rule
and runs nothing. Rebuild the client with `npm run build` (or let `npm start` or smoke do it).

### 2026-09-26 to 27: tested against a copy of a real project (beetle-etl)

**Owner directive, standing: make NO writes or modifications to `C:\dev\beetle-etl`; copy it for
testing.** Four testers worked on copies in the session scratchpad: the read path (scan, views,
CLI), the write path (HTTP, CLI, headless Edge), the UI and watch bar, and the real transcripts
(counts only, no content printed). Afterwards, the only changes inside `C:\dev\beetle-etl` since the
copy was made were a new agent worktree and `Server\logs\combined2.log`, both from the owner's own
live beetle-etl session and server. The copies are deleted; the evidence folders are kept (below).

Filed #111 to #145. Shipped and closed, each commit message listing its checks and mutants:
- **2f19fba** (#111 to #116): the transcript reader handles `queued_command` attachments, so
  background subagents finish, prompts typed while Claude is busy show ("sent while busy"), drift
  inside attachments is counted, and a failed Agent call ends as failed.
- **e68f0fb** (#127): a change directly inside `C:\` no longer closes the drive root's watch. Node
  names a root's children `\name`, which `path.isAbsolute` accepts.
- **be27bf7** (#117): a file reached by two routes is listed once, in `flatten.js`
  (`collapseRoutes`), not collapsed separately by each client.
- **aee2d6f** (#134): CLI restore takes `~/.claude.json` and the plugin manifests only by name; the
  printed undo names exactly the replaced files and was pasted into PowerShell and Git Bash to prove it.
- **f318933** (#128): a refused "Notify me" no longer replaces the watch bar.

**Suggested order for what is open** (the issues hold the detail; all reachable in ordinary use
unless marked):
All done (2026-09-27 and 28, sections above): #137, #118, #119, #135, #129, #131, #138, #140,
#125, #120 to #124, #130, #132, #133, #136, #139, #141, #142, #144, #145, #149, #151; #143 all but
the full-width question. Still open from this list: platform or managed-machine only, #146, #147.

**A process slip, disclosed to the owner:** the first exe check on 2026-09-26 (21:58) did not set
`LAYERCAKE_BROWSER_PROFILE_DIR`, so its Edge wrote into the real `%LOCALAPPDATA%\LayerCake\browser`
profile (browsing data for the local page). `exe-lifecycle-3fix.ps1` redirects it and asserts the
real profile's newest file is unchanged; `exe-lifecycle-111.ps1` does not, so do not reuse it.

Tooling from this round, in the scratchpad named below, none of it in the repository:
- `smoke-in-copy.mjs`: smoke in a throwaway tree copy, so a rebuild does not swap `public/` under
  someone using it.
- `mutate-v.mjs`: now also carries the #111 to #134 mutants.
- `ui-tool/ui-3fix.mjs` and `ui-3fix-control.mjs` (#117, #128, #134 in the page; the control builds
  HEAD and a mutant tree and expects each to go red); `ui-tool/ui-queued-112.mjs` and its control.
- `exe-lifecycle-3fix.ps1`, `undo-paste-134.ps1`, `cli-empty-134.mjs`.
- `beetle/agent-A` to `agent-D`: the testers' scripts and outputs, cited by #111 to #145.
- `issues/`: the filing scripts, one per batch, bodies passed by file.

### 2026-09-26, later: the open-issue sweep

Issues #1 to #110 were worked through, bar ten. Two adversarial review rounds of the create/delete
feature (#15) each found real problems (#96 to #110), all fixed. Highlights:
- Create and delete (#15, owner decision 9).
- Restore of a file gone from disk (#92), with one fence for the HTTP route and the CLI
  (`restoreSnapshotFiles`, #105).
- Every write that replaces or removes a file proves its snapshot holds it (#96, #100).
- The share gate is per server, with one budget per call, and covers the reads before every write
  (#66, #68, #69).
- The exe follows its browser profile (#10, #58 to #60, #93, #94).
- Smoke reads nothing of the machine's own config (#78).

The open ones are small, (b), or questions: `gh issue list`.

Verification tooling that is NOT in the repository lives in that session's scratchpad
(`%TEMP%\claude\C--dev-LayerCake\bcd84aa6-...\scratchpad`):
- `mutate-v.mjs`: every mutant, one tree copy each, 4 in parallel.
- `ui-tool/`: headless-Edge harnesses for create/delete, the editor fixes and the close prompt.
- `verify-r5/`: the second reviewer's harness, with a fake home under `C:\lc-verify-r5`.
- `agent-exe/`: the exe lifecycle, quick-close and Host-guard runs.

A new session has none of it; rebuild from the commit messages, which name each check and mutant.

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
| Git | `.gitignore` | Created 2026-09-25, baseline commit first. Private remote: `github.com/HoustonDonald/LayerCake`. |
| Host guard | `hostGuard` in `server/security.js` | Refuses a foreign `Host` on every route: closes DNS rebinding. |

**Why the flags:** Edge signed the "separate" LayerCake profile in to the Windows Microsoft account
and synced four extensions into it, one a shopping extension with access to every URL and content
scripts on every page, able to read the session token in our DOM. Measured before and after: 3
extension processes, then 0. A fresh profile later showed 6 extension processes with the flags on:
all Edge component extensions (location 5, shipped inside Edge, no all-sites access), which
`--disable-extensions` does not cover. Nothing installed runs.

**Owner decisions, 2026-09-25** ("Go with your recommendations"): the old synced profile at
`%LOCALAPPDATA%\LayerCake\browser` was deleted (2,236 files, 595 MB; Edge recreates it on the next
launch, now without sync), the repository went to a private GitHub remote, and the Host guard was
added (smoke asserts the rebinding request shape; a no-op mutant fails 3 assertions).

**`npm audit` cleared, same day** (owner: "fix the npm audit advisories"): 6 advisories to 0. In
range: qs 6.16.0 (clears express and body-parser), js-yaml 4.3.2; `package.json` floors raised to
the fixed versions. Major: Vite 5 to 7.3.6 (the advisories cover every Vite up to 6.4.2; 7 rather
than 8 to avoid the Rolldown switch), esbuild 0.21 to 0.28.2, one copy shared with Vite.
`@vitejs/plugin-react` 4.7 already supports Vite 7 and was left alone. Consequence: `engines` is now
`^20.19.0 || >=22.12.0`. Verified: smoke; headless-rendered UI text identical to the Vite 5 build;
a headless Edge pass (scan, open a file, Flattened, Snapshots, no console errors) against both the
disk server and the exe; every exe suite; express confirmed inlined in the SEA bundle.

Verified on the built exe (commands in the commit message of `Add a single-executable build`):
no console host (control gets one; a console-subsystem copy gets one); UI served from the embedded
bundle; token and origin guards; scan; exit on window close; second launch reuses the server; port
squatter gives the error window; mutant with exit-on-close as a no-op stays running.

An independent review then found four real defects in that first cut, all fixed and re-verified on
the exe, each with a mutant that went red:

- **Shutdown cut off running saves.** `server.close()` waits on connections, and the window's died
  with Edge. Now `desktop/inflight.js` waits for handlers. Test: a 3,000-file snapshot whose client
  disconnects as the window closes completes (manifest written, exe exits about 8.7 s later); the
  mutant exits in 0.6 s and leaves a snapshot with no manifest.
- **Two simultaneous launches showed a false "another program" error**, and the survivor then never
  exited. Now a failed listen re-probes for 3 s. Test: two launches at once give two windows, one
  server, no error window; the mutant gives one error window and a stranded process.
- **The relaunch command broke on a path containing an apostrophe.** Now quoted by doubling the
  same quote character (PowerShell's parser confirmed; the ASCII-pair fix the review suggested would
  have corrupted a curly apostrophe).
- **A future `import.meta` in a bundled module would crash the exe silently.** Now a build error,
  and `server/app.js` is imported lazily so any init-time throw reaches the error window.

Class (b) findings recorded, not fixed: `diskStatic` serves `/index.html` raw (pre-existing, fails
closed), `memoryStatic` does not URL-decode `req.path` (Vite's names are ASCII).

**A test-harness slip wrote two test snapshots into the real store**
(`%LOCALAPPDATA%\LayerCake\snapshots`) when a mutant left a process running that the next test
attached to. The store had not
existed before that run; it was deleted, and the harness now refuses to run if the port is held by
anything but the process it launched.

### 2026-09-26: session history (Phase 1 and 1b of the session-wrap plan)

The owner's vision: wrap a live Claude Code terminal session with everything that affects it. The
plan (researched, measured, owner decisions recorded) is at
`C:\Users\donal\.claude\plans\ok-let-s-keep-that-adaptive-island.md`: Phase 1 passive session
observer, 1b optional AI summaries, Phase 2 launch and wrap (Windows Terminal companion, per-session
status line and hooks via `--settings`), optional physical lights, and a later separate decision on
an embedded terminal.

Built (Phase 1 + 1b): the Sessions tab, `layercake session`, the Explorer loaded-memory overlay,
and the server modules listed in CLAUDE.md's architecture. Owner decisions: retention stays at 30
days (LayerCake keeps a card per listed session instead); AI summaries on, Haiku, click only.

Measured, for the record:
- All 44 transcripts on this machine (117 MB) parse in about 0.5 s; first `/api/sessions` 0.7 s,
  then about 70 ms. 0 unrecognised record types on 2.1.197 to 2.1.282.
- A default `claude -p` call starts at a median of 85K tokens of Claude Code's own context. The
  stripped-down summarizer measured 1,091 in (for a 569-token digest), 583 out, $0.004.
- `--bare` would break a subscription login (API key only); `--safe-mode` keeps it.
- LayerCake adds about 0.6 GB RAM beside a session (mostly its Edge window).

Verified: smoke 112 passed (session checks run over a synthetic data folder; sentinels for a pasted
secret, a `.key` file, CLAUDE.md bodies and tool output never appear in any response); mutants
caught: tool results counted as prompts, usage per block, unknown counter discarded,
`pastedContents` kept, `.trash` walked. Headless Edge (puppeteer-core, scratch only) drove the
Sessions tab and the overlay against real sessions: list, glow, gauge, rail, turn view, prompt-only
history, no console errors.

Fixed along the way, each its own commit or check: `projectSlug` (paths with `.` or a space),
`skills/.trash` being listed as live skills, and a stale "background agent still running" line (now
from subagent statuses, live sessions only).

### 2026-09-26: Phase 2, launch and wrap (owner: "go ahead with Phase 2")

"Start Claude here" (Sessions tab) opens a Windows Terminal tab running
`claude --session-id <id> --settings <file>`; the file adds a curl.exe status-line forwarder and
http hooks, answered at `/ingest/<launch>/<secret>/…` (`server/launch.js`, `server/ingest.js`).
The session view then shows exact context, cost, 5-hour and weekly limits, prompt-cache warmth,
tools running now, InstructionsLoaded reasons, and "Waiting for you" (amber glow) on permission or
idle prompts.

Measured on this machine:
- A real launch through the API (no prompt sent, so no usage): the tab opened on the right half,
  `claude.exe` ran with the settings file, and the status line and hooks both reported with the
  assigned session id. No `sessions/<pid>.json` appeared within 30 s and no transcript before a
  prompt; hence liveness from hooks and "appears after the first prompt".
- Zero tokens: the same one-line `claude -p` prompt on Haiku with and without the settings file
  used 44,007 input tokens both times; the second read all of it from cache; its hooks did fire.
  Cost of that check: $0.06.

Verified: smoke 141 passed (29 new, launch in dry-run mode: argv, settings file, ingest guards,
empty hook answers, waiting, running tools, exact context, restart persistence, hook liveness);
mutants caught: JSON hook answer, Origin check off, notification discarded, secret check always
true, exact context ignored. Headless Edge rendered the wrapped panel and the live waiting banner.

### 2026-09-26: Phase 1 review fixes (commit 30eb174)

An independent review of 8c3084c's range found eight user-reachable defects, all fixed; the commit
message lists each. The two with the largest blast radius: a `claude` that exits without reading
stdin (any digest over about 64 KB, 11 of 44 real sessions) killed the whole server through an
unhandled EPIPE; and the Explorer overlay badged every memory file "not loaded" for sessions that
predate Claude Code recording its loads (28 of 44), which reads as the opposite of the truth.

Smoke now drives `summaries.js` through a stand-in `claude` (`scripts/smoke-claude-stub.mjs`, chosen
by `LAYERCAKE_CLAUDE_CMD`), so the stripped-down argv and the digest are asserted, not assumed.
Verified: smoke 153 passed; five review-fix mutants caught; the reviewer's stream-leak reproduction
gets 200; overlay checked in headless Edge on three real projects; exe rebuilt, launch suite passes.

Named limits, not fixed, now issues: summary timeout does not reach grandchildren (#2); a reused PID
can make a dead session read as live (#1); an exe shutdown mid-summary leaves that run out of the
ledger (#3).

### 2026-09-26: Phase 2 reviews (security and correctness), all findings fixed

Two independent reviews of the Phase 2 range. Every finding was filed as an issue (#20 to #30), and
all of them are fixed and closed:
- **Security (6cde47e):** a project path containing `;` injected Windows Terminal subcommands (#20,
  high). The ingest secret appearing on curl's command line is now disclosed (#21).
- **Correctness (de84318):** ingest state is per session, not per launch (#22); waits and running
  tools end on transcript evidence (#23); launches are restored at startup (#24); the hook meter
  says it counts any hook (#25); the Start button always recovers (#26); smoke checks that could not
  fail now can (#27), and smoke grades only its own server (#28, 0df17d4); two more waiting types
  (#29); the stream slot race is closed (#30).

HANDOFF's Phase 2 entry above says "restart persistence" was verified. It was not: that check only
read a status code. It is now covered by #27's checks.

**Verification round (c8eeffff).** An independent check of those fixes found two ordinary-use bugs
in restored launches, plus eight lesser ones (#31 to #40), all fixed. The structural change: a
launched session's status line now re-runs every 15 s (`refreshInterval`), and a launched session
without a pid file counts as running only while it reports (45 s window). That also closed #4.
Verified live, with no usage spent: a real idle launch with no prompt reported every 15.0 s.

Method worth reusing: targeted mutants, each run in its own copy of the tree (node_modules
junctioned) and 4 at a time, because smoke now picks a free port. That did 15 smoke runs in 57 s,
against about 2.9 min serially (11.5 s a run). It also leaves the working tree unmutated. The script
lives only in the session scratchpad (`mutate-p2.mjs`).

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

Made by the owner on 2026-09-26, when asked about the open issues:

5. **Hook errors in a launched terminal after LayerCake closes stay as they are (#5, closed).**
   Restarting LayerCake stops them. Silent command hooks were rejected: a process spawn per tool
   call, and the zero-token claim would need re-measuring.
6. **The watch bar gets a per-file mute (#13).** A muted file is still counted and shown as muted;
   it stops re-lighting the bar. Nothing is hidden.
7. **Snapshots keep the files that can hold OAuth tokens (#18, closed)**, flagged `sensitive` and
   documented, so a restore is always complete. No redaction option.
8. **Settings edits that add or change something that runs a command need the executable
   acknowledgement (#19)**: hooks, statusLine, apiKeyHelper and the like. Ordinary settings edits
   stay free of it.
9. **Config files can be created and deleted, fenced (#15).** Create only inside the known
   `.claude` folders of a scanned level (agents, commands, skills, rules, CLAUDE.md and friends),
   from a template, never at an arbitrary path. Delete only a file the scan found, snapshotted first.
   A new hook still needs the executable acknowledgement.
10. **`/api/validate` is deleted (#67)**, with the unused `validateDir` helper. Scan already reports a
    bad directory, and it was a path-taking endpoint nothing called.
11. **Closing the window with unsaved editor changes asks first (#71)**, through the browser's own
    "Leave site?" prompt, only while the editor is dirty. The exe's window then stays open, and the exe
    running, until it is answered.

Made by the owner on 2026-09-27 ("b"):

12. **Automatic snapshots hold only the files the operation changes.** The snapshot before an edit,
    delete or restore copies just the files it replaces or removes; **Take snapshot** and
    `layercake backup` still copy the whole lineage. Chosen over keeping full copies with content
    stored once. It narrows how decision 3 applies: an automatic snapshot no longer records the rest of
    the configuration as it was at that moment.
13. **Snapshots are kept 30 days** ("30 days for now", #138), manual ones included, then deleted when
    the next snapshot is taken.
14. **Ambient lighting: shelved** ("let's forget about it"). The owner first chose the ASUS Aura case
    fans and allowed the local network call; both Aura interfaces accepted every command and the fans
    never changed. Findings and what to try first are in #148 (closed, not planned). The no-outbound
    invariant stands: no lighting code was written.

Made by the owner on 2026-09-28, asked in the terminal, each the recommended option:

15. **Snapshots takes the full window (#143)**, as Sessions does; Explorer brings the tree back.
16. **Plugin cache files are read only in LayerCake (#126)**: viewable, never edited or deleted,
    each saying why. Restore and create were extended to match, as the assistant's inference.
17. **Registry policy is read with reg.exe (#147)**: `System32\reg.exe query` on the two
    `Policies\ClaudeCode` keys, fixed argv, read only, 5 s timeout, output parsed as data. Built
    2026-09-28 (`server/policy.js`), with its line in CLAUDE.md. The note's "server-managed
    settings cannot be read from disk" was wrong: see the #147 section above.

Made by the owner on 2026-09-29, asked in the terminal while planning the Castle, each the
recommended option:

18. **The Castle draws sessions LayerCake did not launch from their transcripts**, labelled "from
    its transcript, about N s behind; no waiting signal". Overrides the spec's "transcripts never
    drive the live view"; launched sessions stay hook-driven.
19. **The floor plan is the proposed 3 by 4 grid.** The spec's own diagram did not come through in
    the file; Keep, Great Hall and Barracks are the assistant's additions to the nine rooms its text
    names. It is one table (`ROOMS` in castlemap.js), replaceable while nobody has learned it.
20. **Full Screen is for the Castle view only** (element full screen: the header, tabs and watch bar
    go). The hook is inside CastleView.jsx; moving it to its own file is the cost of reuse.

---

## Open work lives in GitHub issues

Since 2026-09-26 every open problem is an issue in `HoustonDonald/LayerCake` (`gh issue list`), so
this file no longer restates them. Owner decisions carry the `question` label and a title starting
"Decide:". Config files can now be created and deleted (#15, decision 9), and a file gone from disk
can be restored from a snapshot (#92); the README section "Creating and deleting files" is the spec.

## Noted for the owner, not problems

1. **The product was renamed to LayerCake** (was "Claude Explorer"). Package name, title, UI brand,
   server banner. Reversible. `localStorage` keys deliberately kept the old `claude-explorer.*`
   prefix so the remembered directory survives; there is a comment saying so in `client/App.jsx`.
2. **`scripts/smoke.mjs` was the assistant's addition, not requested.** Justified only because one
   bug in this work was silent (green suite, completely broken app). Kill it in one line if the
   owner disagrees.
3. **Desktop notifications were built opt-in and background-only**, behind a "Notify me" button.
   The toast is attributed to Edge or Chrome, not LayerCake, because app identity needs a registered
   AppUserModelID, which a browser page cannot have. The SEA exe did not change this (the window is
   still Edge's); only Electron would.
4. **Next in the session-wrap plan: optional physical lights** (ASUS Aura REST drives the case
   fans; a WLED strip would be the real monitor-edge option), then the separately decided
   embedded terminal. Phase 2 (launch and wrap) is done; see its section above. Not started.

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
   - **A fourth, 2026-09-26 (#117):** flatten decided `shadowed` correctly but kept both sightings
     for its clients to collapse. The CLI did; the page drew the second as "shadowed". Found by two
     testers on a real project. Now `collapseRoutes` in `flatten.js` lists each file once, so no
     client can repeat it. The settings view lists such a file once too, and merges only what Claude
     Code reads (#118, #119, fixed 2026-09-27).
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
- `%LOCALAPPDATA%\LayerCake\snapshots` and `\data` still did not exist on 2026-09-27. All testing
  redirected them to scratch paths, and those were cleaned up. **Test snapshots contain real copies
  of `~/.claude.json`, so always redirect and always clean up.** `\browser` exists (the app window's
  profile, created 2026-09-25); see the process slip above.
- `C:\lc-verify-r5` (an earlier reviewer's fake home) is gone; the owner removed it.
- The built bundle in `public/` and `dist\LayerCake.exe` were rebuilt on 2026-09-28 (42df32a). A change under
  `client/` makes `public/` stale and `npm start` rebuilds; a change under `server/` alone does not
  and does not need to.

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
- **A third heredoc mangled a backslash anchor** (2026-09-26, a node heredoc editing smoke). It was
  caught only because the edit script threw on an anchor count before writing. Same rule: Write or
  Edit tool.
- **A non-admin user can create a folder in `C:\` but not a file** (EPERM). A smoke probe at the
  drive root has to be a folder.
- **CSS `text-transform: uppercase` changes `innerText`.** A case-sensitive regex on a turn label
  made a negative check unable to fail; match with `/i` and run the positive control.
- **`find -not -path '*/node_modules/*'` still descends into node_modules**; it only filters the
  output, and it timed out over a large project. Use `-prune`.

---

## If you resume

1. Run the two commands at the top. If they are not green, something changed under you; find out
   what before building on it.
2. Read `CLAUDE.md` invariants before touching `server/`. They are the product, not style.
3. `npm run smoke` before calling any `server/` change done. It cannot see the UI, so a green run is
   necessary and not sufficient. The one bug it missed was found by opening a browser.
4. Smoke never runs the exe. After touching `server/app.js`, `desktop/` or `client/`, run
   `npm run build:exe` and launch `dist\LayerCake.exe` with `Start-Process` (as Explorer would),
   with every data folder and `LAYERCAKE_BROWSER_PROFILE_DIR` redirected.
5. Take the open issues in the order of the 2026-09-28 triage section above, re-checking it
   against `gh issue list` for anything filed since.
