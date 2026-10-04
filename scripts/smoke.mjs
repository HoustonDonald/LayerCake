/**
 * End to end smoke test. `npm run smoke`.
 *
 * Self contained: rebuilds the client only when public/ is stale (the rule npm
 * start uses, #94), creates its own fixture tree, starts a server on its own
 * port with its own snapshot store, exercises the real HTTP API, and removes
 * everything it made. A rebuild empties public/ first, so on Windows the check
 * and the build hold a lock: runs started together on a stale tree build once,
 * and the others wait and then find it fresh (#95).
 *
 * Why this exists when the project has no test framework: the write path can
 * fail SILENTLY. A CSRF guard applied one route too widely left every HTTP
 * check green while the actual app refused to load in a browser, because Node's
 * fetch sends no Sec-Fetch-* headers and a real navigation does. That class of
 * failure does not announce itself, which is the bar for building a check
 * rather than just fixing the bug.
 *
 * Deliberately not a framework. It is a list of assertions and a counter.
 */

import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { projectSlug, samePathKey } from '../server/paths.js';
import { buildClientIfStale } from './build-if-stale.js';
import { makeSessionFixture, runLaunchChecks, runSessionChecks, runSummaryChecks, stopFixtureProcesses } from './smoke-sessions.mjs';
import { runCreateChecks } from './smoke-create.mjs';
import { runCastleChecks } from './smoke-castle.mjs';
import { runManagedChecks, runManagedDefaultsChecks, runManagedWatchCheck } from './smoke-managed.mjs';
import { runConfigHomeChecks } from './smoke-confighome.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// The server below serves public/ as built, so checks of what the client ships
// (the favicon, the HTML) would otherwise grade whatever build happens to be there.
await buildClientIfStale();

/** A port nothing is listening on right now, chosen by the OS. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

// Not a fixed port: two runs at once (parallel reviewers, a mutation loop)
// would otherwise share one, and the loser's server dies of EADDRINUSE while
// its checks run against the winner's server, fixture and code (#28).
const PORT = Number(process.env.SMOKE_PORT || (await freePort()));
const REPORT_WINDOW_MS = 4000;
const CASTLE_TIME_SCALE = 0.05;
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0;
let fail = 0;
let skipped = 0;
function check(name, ok, detail = '') {
  if (ok) {
    pass += 1;
    process.stdout.write(`  PASS  ${name}\n`);
  } else {
    fail += 1;
    process.stdout.write(`  FAIL  ${name} ${detail}\n`);
  }
}

/** A check this machine cannot run. Printed and counted, so it never reads as a pass. */
function skip(name, reason) {
  skipped += 1;
  process.stdout.write(`  SKIP  ${name} (${reason})\n`);
}

/**
 * A private variable name, never TMP or TEMP.
 * `[[ -n "$TMP" ]] && rm -rf "$TMP"` deletes the user's entire temp directory
 * on Windows, because TMP is an OS environment variable and the guard never
 * blocks. The same shape in JS is just as easy to write.
 */
let smokeDir = null;
/** Set when the drive root could not be written and the fixture went to %TEMP% (#78). */
let fixtureFellBack = false;
/** True when the fixture could make a directory link to a share (#144); else the error code. */
let shareLinkMade = false;

async function makeFixture() {
  // Under the drive root, not in %TEMP%, which is inside the user profile: the
  // walk from there passed through the real home folder, so smoke watched the
  // real ~/.claude, saw its rewrites, and copied real config into snapshots
  // (#78). The server also gets a home of its own below. Falls back to the temp
  // folder where the root cannot be written (Linux, where /tmp is not under
  // home anyway, or a locked-down machine).
  smokeDir = await fs
    .mkdtemp(path.join(path.parse(os.tmpdir()).root, 'layercake-smoke-'))
    .catch(() => {
      fixtureFellBack = true;
      return fs.mkdtemp(path.join(os.tmpdir(), 'layercake-smoke-'));
    });
  // The project is nested one level deep so the walk covers an ancestor that
  // also carries config. That is what makes a GENUINE shadow possible inside
  // the fixture, without depending on whatever the real ~/.claude happens to
  // contain on this machine.
  const parent = path.join(smokeDir, 'parent');
  const proj = path.join(parent, 'proj');
  await fs.mkdir(parent, { recursive: true });
  await fs.writeFile(
    path.join(parent, '.mcp.json'),
    JSON.stringify({ mcpServers: { 'smoke-shadowed': { command: 'ancestor' } } }, null, 2)
  );
  await fs.mkdir(path.join(proj, '.claude', 'hooks'), { recursive: true });
  await fs.mkdir(path.join(proj, '.claude', 'agents'), { recursive: true });
  // A live skill beside one Claude Code has moved to its trash: only the live
  // one is config, and the scan must say so.
  await fs.mkdir(path.join(proj, '.claude', 'skills', 'live-skill'), { recursive: true });
  await fs.writeFile(path.join(proj, '.claude', 'skills', 'live-skill', 'SKILL.md'), '---\nname: live-skill\n---\nUse me.\n');
  await fs.mkdir(path.join(proj, '.claude', 'skills', '.trash', '1790446985109-30604-abc', 'old-skill'), { recursive: true });
  await fs.writeFile(
    path.join(proj, '.claude', 'skills', '.trash', '1790446985109-30604-abc', 'old-skill', 'SKILL.md'),
    '---\nname: old-skill\n---\nDeleted.\n'
  );
  await fs.writeFile(path.join(proj, 'CLAUDE.md'), '# Original project memory\n');
  await fs.writeFile(
    path.join(proj, '.claude', 'settings.json'),
    JSON.stringify({ model: 'opus', permissions: { allow: ['Bash'] } }, null, 2)
  );
  await fs.writeFile(path.join(proj, '.claude', 'hooks', 'pre.sh'), '#!/bin/sh\necho original\n');
  // Same server name as the ancestor's, from a different file: a real shadow.
  await fs.writeFile(
    path.join(proj, '.mcp.json'),
    JSON.stringify({ mcpServers: { 'smoke-shadowed': { command: 'project' } } }, null, 2)
  );
  await fs.writeFile(
    path.join(proj, '.claude', 'agents', 'reviewer.md'),
    '---\nname: reviewer\n---\n\nReview things.\n'
  );
  // Must be found and refused, never copied into a snapshot. The value is a
  // sentinel so the snapshot tree can be searched for it afterwards. The same
  // sentinel also sits inside hooks/, a tree the scan walks and a snapshot
  // copies: the root file is one no scan probes, so on its own the snapshot
  // grep could not fail even with every credential guard removed (#85).
  const credSentinel = `{"token":"SMOKE-SENTINEL-${crypto.randomBytes(4).toString('hex')}"}`;
  await fs.writeFile(path.join(proj, '.credentials.json'), credSentinel);
  await fs.writeFile(path.join(proj, '.claude', 'hooks', 'credentials.json'), credSentinel);
  // Claude Code's configuration home, relocated with CLAUDE_CONFIG_DIR (#7).
  // The user level is read from here, so smoke no longer scans or snapshots
  // the real ~/.claude as its user level. It is the .claude folder of an
  // ancestor on the walk, the shape ~/.claude has for a project under home,
  // so every file in it is reached by two routes and the dedupe checks below
  // have something to dedupe. Off the walk they could not fail (#84).
  const configHome = path.join(smokeDir, '.claude');
  await fs.mkdir(path.join(configHome, 'agents'), { recursive: true });
  await fs.writeFile(path.join(configHome, 'CLAUDE.md'), '# user-level memory in the relocated home\n');
  // The settings model (#119): each file below is one Claude Code reads for a
  // session in proj, or one it does not, and every key tells which rule
  // applied. A marker key (userLocalOnly, ancestorOnly, bindings) is set only
  // by a file that must not be merged.
  const hook = (says) => [{ hooks: [{ type: 'command', command: `echo ${says}` }] }];
  await fs.writeFile(path.join(configHome, 'settings.json'), JSON.stringify({
    model: 'smoke',
    permissions: { allow: ['Read'] },
    env: { SMOKE_USER: 'user', SMOKE_WIN: 'user' },
    hooks: { SessionStart: hook('user') },
    fallbackModel: ['user-fallback'],
    modelPicker: { fromUser: true },
    // #122: unnamed-plugin is left out, which Claude Code treats as off.
    enabledPlugins: {
      'on-plugin@smoke-mkt': true,
      'off-plugin@smoke-mkt': false,
      'away-plugin@smoke-mkt': true,
      'here-plugin@smoke-mkt': true,
    },
  }, null, 2));
  // Installed plugins (#122, #121), each a case measured on Claude Code
  // 2.1.283: enabled; set false; not named in enabledPlugins; a local install
  // for another folder; a local install for proj (in no repository, so proj
  // is its root). on-plugin has an older cached version, marked orphaned,
  // that installed_plugins.json does not name, and an agent named like
  // proj's own "reviewer". smoke-plugin is where the create checks plant a
  // file (#97).
  const cache = path.join(configHome, 'plugins', 'cache', 'smoke-mkt');
  const plugFile = async (rel, body) => {
    await fs.mkdir(path.dirname(path.join(cache, rel)), { recursive: true });
    await fs.writeFile(path.join(cache, rel), body);
  };
  await plugFile('on-plugin/1.0.0/.orphaned_at', '1790000000000');
  await plugFile('on-plugin/1.0.0/agents/reviewer.md', '---\nname: reviewer\n---\nOld version.\n');
  await plugFile('on-plugin/2.0.0/agents/reviewer.md', '---\nname: reviewer\n---\nPlugin reviewer.\n');
  // A plugin .mcp.json may hold its servers at the top level, as playwright's does.
  await plugFile('on-plugin/2.0.0/.mcp.json', JSON.stringify({ browser: { command: 'on-cmd' } }));
  await plugFile('off-plugin/1.0.0/agents/off-agent.md', '---\nname: off-agent\n---\n');
  await plugFile('off-plugin/1.0.0/.mcp.json', JSON.stringify({ mcpServers: { offsrv: { command: 'off-cmd' } } }));
  await plugFile('unnamed-plugin/1.0.0/agents/unnamed-agent.md', '---\nname: unnamed-agent\n---\n');
  await plugFile('away-plugin/1.0.0/agents/away-agent.md', '---\nname: away-agent\n---\n');
  await plugFile('here-plugin/1.0.0/agents/here-agent.md', '---\nname: here-agent\n---\n');
  await plugFile('here-plugin/1.0.0/.claude-plugin/plugin.json', JSON.stringify({ name: 'here-plugin', mcpServers: { inline: { command: 'here-cmd' } } }));
  const install = (name, version, extra = {}) => [{ scope: 'user', installPath: path.join(cache, name, version), version, ...extra }];
  await fs.writeFile(path.join(configHome, 'plugins', 'installed_plugins.json'), JSON.stringify({
    version: 2,
    plugins: {
      'on-plugin@smoke-mkt': install('on-plugin', '2.0.0'),
      'off-plugin@smoke-mkt': install('off-plugin', '1.0.0'),
      'unnamed-plugin@smoke-mkt': install('unnamed-plugin', '1.0.0'),
      'away-plugin@smoke-mkt': install('away-plugin', '1.0.0', { scope: 'local', projectPath: parent }),
      'here-plugin@smoke-mkt': install('here-plugin', '1.0.0', { scope: 'local', projectPath: proj }),
      'smoke-plugin@smoke-mkt': install('smoke-plugin', '1.0.0'),
    },
  }, null, 2));
  await fs.writeFile(path.join(configHome, 'settings.local.json'), JSON.stringify({ userLocalOnly: true, env: { SMOKE_WIN: 'user-local' } }, null, 2));
  await fs.writeFile(path.join(configHome, 'keybindings.json'), JSON.stringify({ bindings: [] }, null, 2));
  await fs.mkdir(path.join(parent, '.claude'), { recursive: true });
  await fs.writeFile(path.join(parent, '.claude', 'settings.json'), JSON.stringify({ ancestorOnly: true, permissions: { allow: ['Ancestor'] } }, null, 2));
  await fs.writeFile(path.join(proj, '.claude', 'settings.local.json'), JSON.stringify({
    model: 'local',
    permissions: { allow: ['Read', 'Edit'] },
    env: { SMOKE_LOCAL: 'local', SMOKE_WIN: 'local' },
    hooks: { SessionStart: hook('local') },
    fallbackModel: ['local-fallback'],
    modelPicker: { fromLocal: true },
  }, null, 2));
  // Local-scope MCP servers (#120), in folders of their own so proj's MCP view
  // is unchanged. Claude Code keys a project by its git root (a worktree by
  // the main repository's) with forward slashes, and never reads a backslash
  // key; each server below is one it would or would not load. The .git folder
  // needs no real repository: the scan only looks for it.
  const gitRepo = path.join(smokeDir, 'mcp-git');
  const worktree = path.join(smokeDir, 'mcp-wt');
  const wtGitDir = path.join(gitRepo, '.git', 'worktrees', 'mcp-wt');
  await fs.mkdir(path.join(gitRepo, 'sub'), { recursive: true });
  await fs.mkdir(wtGitDir, { recursive: true });
  await fs.mkdir(worktree, { recursive: true });
  await fs.mkdir(path.join(smokeDir, 'mcp-plain'), { recursive: true });
  // As git writes them: an absolute gitdir with forward slashes, a relative commondir.
  await fs.writeFile(path.join(worktree, '.git'), `gitdir: ${wtGitDir.replace(/\\/g, '/')}\n`);
  await fs.writeFile(path.join(wtGitDir, 'commondir'), '../..\n');
  // A .git file naming a share (#193), as one could arrive in a downloaded
  // folder: never followed, so the scan never connects out to it.
  await fs.mkdir(path.join(smokeDir, 'git-share'), { recursive: true });
  await fs.writeFile(path.join(smokeDir, 'git-share', '.git'), 'gitdir: //127.0.0.1/layercake-smoke-none/wt\n');
  const fwd = (p) => p.replace(/\\/g, '/');
  const localServer = (name) => ({ mcpServers: { [name]: { command: name } } });
  const projects = {
    [fwd(gitRepo)]: localServer('local-git-root'),
    [fwd(path.join(gitRepo, 'sub'))]: localServer('local-git-sub'),
    [fwd(path.join(smokeDir, 'mcp-plain'))]: localServer('local-plain'),
  };
  // Only Windows spells a path with backslashes; elsewhere this key is the forward one.
  if (process.platform === 'win32') projects[gitRepo] = localServer('local-backslash');
  // Instructions (#123), each a case measured on Claude Code 2.1.283: rules in
  // the config home and in proj, one conditional on paths; an AGENTS.md in
  // parent, which proj's CLAUDE.md stops; a lone AGENTS.md in a folder whose
  // walk holds no project CLAUDE.md (the config home's does not count); and
  // a MEMORY.md under mcp-git's slug, which a scan of its subfolder must find.
  await fs.mkdir(path.join(configHome, 'rules'), { recursive: true });
  await fs.writeFile(path.join(configHome, 'rules', 'user-rule.md'), '# user rule\n');
  await fs.mkdir(path.join(proj, '.claude', 'rules'), { recursive: true });
  await fs.writeFile(path.join(proj, '.claude', 'rules', 'plain.md'), '# plain rule\n');
  await fs.writeFile(path.join(proj, '.claude', 'rules', 'cond.md'), '---\npaths:\n  - "src/**/*.ts"\n---\n# conditional rule\n');
  await fs.writeFile(path.join(parent, 'AGENTS.md'), '# parent agents\n');
  await fs.mkdir(path.join(smokeDir, 'agents-only'), { recursive: true });
  await fs.writeFile(path.join(smokeDir, 'agents-only', 'AGENTS.md'), '# lone agents\n');
  // #144: a skill folder that is a junction, which Claude Code loads through
  // (measured); and, where the OS lets this user make one, a link to a share,
  // which must be listed and never walked. The share does not exist: reading
  // the link must not touch it.
  const sharedSkill = path.join(smokeDir, 'shared-skills', 'linked-skill');
  await fs.mkdir(sharedSkill, { recursive: true });
  await fs.writeFile(path.join(sharedSkill, 'SKILL.md'), '---\nname: linked-skill\n---\nShared.\n');
  await fs.symlink(sharedSkill, path.join(proj, '.claude', 'skills', 'linked-skill'), 'junction');
  const shareTarget = process.platform === 'win32' ? '\\\\localhost\\lc-no-such-share\\skills' : '//localhost/lc-no-such-share/skills';
  shareLinkMade = await fs.symlink(shareTarget, path.join(proj, '.claude', 'skills', 'share-skill'), 'dir').then(() => true, (e) => e.code);
  const repoMemory = path.join(configHome, 'projects', projectSlug(gitRepo), 'memory');
  await fs.mkdir(repoMemory, { recursive: true });
  await fs.writeFile(path.join(repoMemory, 'MEMORY.md'), '# memory of the repository root\n');
  await fs.writeFile(path.join(configHome, '.claude.json'), JSON.stringify({ projects }, null, 2));
  await fs.writeFile(path.join(configHome, 'agents', 'home-agent.md'), '---\nname: home-agent\n---\n');
  // One MCP server in one file, which the walk reaches twice: the file is
  // listed once. Claude Code does not read a .mcp.json inside .claude (#121),
  // so it is listed as not read and its server is not loaded.
  await fs.writeFile(
    path.join(configHome, '.mcp.json'),
    JSON.stringify({ mcpServers: { 'smoke-two-routes': { command: 'home' } } }, null, 2)
  );
  // A credential file inside a .claude folder on the walk, where the scan
  // lists that folder and must redact it. The redaction check used to pass on
  // Windows only because the walk crossed the real home folder and met the
  // real ~/.claude/.credentials.json; on Linux (/tmp is not under home) it
  // failed. Planted here, it tests the fixture, not the machine (#17).
  await fs.writeFile(path.join(proj, '.claude', '.credentials.json'), JSON.stringify({ planted: 'SMOKE-PROJECT-CREDENTIAL' }));

  // The server's home folder (#78): empty, so nothing of the machine's is read.
  const fakeHome = path.join(smokeDir, 'home');
  await fs.mkdir(fakeHome, { recursive: true });

  return { proj, snaps: path.join(smokeDir, 'snaps'), configHome, fakeHome };
}

/**
 * A GET with a Host header of our choosing. node:http rather than fetch,
 * because the Fetch spec lists Host as a header a caller may not set.
 */
function getWithHost(pathname, host, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: pathname, headers: { ...headers, Host: host } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
  });
}

/**
 * Ready means OUR server is listening, not that something answers the port:
 * server/index.js prints its URL only after its own listen succeeded, and a
 * server that failed to bind exits instead. Anything else answering on the
 * port is some other process, and grading it would be a false verdict (#28).
 */
async function waitForServer(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (serverExit !== null) return false;
    if (serverOut.includes(`http://127.0.0.1:${PORT}`)) {
      try {
        const res = await fetch(`${BASE}/`);
        if (res.ok) return true;
      } catch {
        /* listening, but not answering yet */
      }
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

const { proj, snaps, configHome, fakeHome } = await makeFixture();
// Managed policy (#147): an empty managed folder, legacy folder and registry
// keys of the run's own, none of which exist, so the machine's policy is never
// read and a managed machine's cannot change a verdict. Set in smoke's own
// environment before anything starts, so every server, CLI run and in-process
// scan below inherits them rather than each spawn having to remember.
process.env.LAYERCAKE_MANAGED_DIR = path.join(smokeDir, 'no-managed-policy');
process.env.ProgramData = path.join(smokeDir, 'no-programdata');
process.env.LAYERCAKE_POLICY_KEYS = JSON.stringify({
  hklm: `HKCU\\Software\\LayerCakeSmoke-none-${process.pid}\\HKLM`,
  hkcu: `HKCU\\Software\\LayerCakeSmoke-none-${process.pid}\\HKCU`,
});
// Synthetic Claude session data and LayerCake app data: the real ones are never read or written.
const { claudeData, appData } = await makeSessionFixture(smokeDir, proj);

// "Start Claude here" starts claude by its full path or not at all (#191), so
// the server gets an empty stand-in claude.exe first on its PATH: launches are
// dry runs here, so it is named in the argv and never started, and smoke does
// not depend on Claude Code being installed.
const claudeStandIn = path.join(smokeDir, 'claude-bin', 'claude.exe');
if (process.platform === 'win32') {
  await fs.mkdir(path.dirname(claudeStandIn), { recursive: true });
  await fs.writeFile(claudeStandIn, '');
}
// Windows spells it Path; a second key spelt PATH would leave which one wins to chance.
const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';

const serverStartedAt = Date.now();
const server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
  cwd: ROOT,
  env: {
    ...process.env,
    [pathKey]: process.platform === 'win32' ? [path.dirname(claudeStandIn), process.env[pathKey] || ''].join(path.delimiter) : process.env[pathKey],
    PORT: String(PORT),
    LAYERCAKE_SNAPSHOT_DIR: snaps,
    LAYERCAKE_CLAUDE_DATA_DIR: claudeData,
    // Claude Code's own variable: the user level must follow it (#7).
    CLAUDE_CONFIG_DIR: configHome,
    // A home of its own, so ~/CLAUDE.md and ~/.claude are the fixture's, never
    // the machine's (#78). os.homedir() reads USERPROFILE on Windows, HOME
    // elsewhere.
    USERPROFILE: fakeHome,
    HOME: fakeHome,
    LAYERCAKE_APPDATA_DIR: appData,
    // Launches build their argv and settings but never start Windows Terminal.
    LAYERCAKE_LAUNCH_DRY_RUN: '1',
    // A launched session counts as running for this long after its last
    // report. 45 s in use; short here so "stopped reporting" can be tested.
    LAYERCAKE_REPORT_WINDOW_MS: String(REPORT_WINDOW_MS),
    // The Castle's windows (60 s active, 45 s heat half-life, 10 min thrash)
    // at 1/20, so their lapses can be tested in seconds (#160).
    LAYERCAKE_CASTLE_TIME_SCALE: String(CASTLE_TIME_SCALE),
    // AI summaries run a stand-in for claude: no usage is ever spent here.
    LAYERCAKE_CLAUDE_CMD: JSON.stringify([
      process.execPath,
      path.join(ROOT, 'scripts', 'smoke-claude-stub.mjs'),
      path.join(smokeDir, 'claude-stub'),
    ]),
  },
  // Piped, and always drained: its first line is the readiness signal, and its
  // stderr says why it exited if it did.
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverOut = '';
let serverExit = null;
const keep = (chunk) => {
  serverOut = (serverOut + chunk).slice(-8000);
};
server.stdout.setEncoding('utf8').on('data', keep);
server.stderr.setEncoding('utf8').on('data', keep);
server.once('exit', (code, signal) => {
  serverExit = code ?? signal;
});

let exitCode = 1;
try {
  if (!(await waitForServer())) {
    process.stdout.write(`\n  Smoke's own server never came up on ${BASE} (exit: ${serverExit}).\n${serverOut}\n`);
    throw new Error('server did not start');
  }

  const html = await (await fetch(`${BASE}/`)).text();
  const token = /name="layercake-token" content="([a-f0-9]+)"/.exec(html)?.[1];
  check('token is injected into served HTML', Boolean(token));

  // Pinned against folder names Claude Code actually created (2026-09-26): a
  // dot and a space are replaced too, not just separators and the colon.
  if (process.platform === 'win32') {
    check('project slug replaces separators and the colon', projectSlug('C:\\dev\\LayerCake') === 'C--dev-LayerCake');
    check(
      'project slug replaces a dot (worktree path)',
      projectSlug('C:\\dev\\my-app\\.claude\\worktrees\\bold-leavitt-3a0334') ===
        'C--dev-my-app--claude-worktrees-bold-leavitt-3a0334'
    );
    check(
      'project slug replaces a space',
      projectSlug('C:\\Users\\me\\Finance Optimization') === 'C--Users-me-Finance-Optimization'
    );
  } else {
    skip('project slug of a Windows path (3 checks)', 'the pinned folder names are Windows paths');
  }

  const H = { 'X-LayerCake-Token': token, 'Content-Type': 'application/json' };

  // --- the guard, and the navigation it must NOT block --------------------
  const nav = await fetch(`${BASE}/`, {
    headers: {
      'Sec-Fetch-Site': 'cross-site',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Dest': 'document',
    },
  });
  check('a cross-site top-level navigation still loads the app', nav.status === 200);
  check('that navigation still receives a usable token', /layercake-token/.test(await nav.text()));
  check(
    'HTML denies framing',
    (await fetch(`${BASE}/`)).headers.get('x-frame-options') === 'DENY'
  );

  check('API refuses a request with no token', (await fetch(`${BASE}/api/manifest`)).status === 403);
  check(
    'API refuses a wrong token',
    (await fetch(`${BASE}/api/manifest`, { headers: { 'X-LayerCake-Token': 'deadbeef' } })).status === 403
  );
  check(
    'API refuses a cross-origin request even with a valid token',
    (await fetch(`${BASE}/api/manifest`, { headers: { ...H, Origin: 'http://evil.example' } })).status === 403
  );
  check(
    'API refuses a cross-site fetch even with a valid token',
    (await fetch(`${BASE}/api/manifest`, { headers: { ...H, 'Sec-Fetch-Site': 'cross-site' } })).status === 403
  );

  // --- DNS rebinding: the Host guard, on the HTML as well as the API ------
  const rebound = `rebind.example:${PORT}`;
  const reboundHtml = await getWithHost('/', rebound);
  check('HTML refuses a foreign Host header', reboundHtml.status === 403, `got ${reboundHtml.status}`);
  check('a refused HTML response carries no token', !/layercake-token/.test(reboundHtml.body));
  check(
    'API refuses a rebinding request shaped exactly like one (same-origin, valid token, foreign Host)',
    (await getWithHost('/api/manifest', rebound, { 'X-LayerCake-Token': token, 'Sec-Fetch-Site': 'same-origin' }))
      .status === 403
  );
  check(
    'positive control: the same request with our own Host is accepted',
    (await getWithHost('/api/manifest', `127.0.0.1:${PORT}`, { 'X-LayerCake-Token': token, 'Sec-Fetch-Site': 'same-origin' }))
      .status === 200
  );
  check('localhost is an accepted Host too', (await getWithHost('/', `localhost:${PORT}`)).status === 200);

  // --- the page icon (#60) --------------------------------------------------
  // Without it the request fell through to the HTML route: a 200, but HTML, so
  // the window showed a generic icon. Hence the type and the bytes, not the status.
  const icon = await fetch(`${BASE}/favicon.ico`);
  const iconType = icon.headers.get('content-type') || '';
  const iconBytes = Buffer.from(await icon.arrayBuffer());
  check(
    'favicon.ico is the exe icon, served as an image',
    icon.status === 200 &&
      iconType.startsWith('image/') &&
      iconBytes.equals(await fs.readFile(path.join(ROOT, 'desktop', 'layercake.ico'))),
    `got ${icon.status} "${iconType}", ${iconBytes.length} bytes`
  );
  check('favicon.ico refuses a foreign Host header too', (await getWithHost('/favicon.ico', rebound)).status === 403);

  const manifestRes = await fetch(`${BASE}/api/manifest`, { headers: H });
  check('API accepts a valid token', manifestRes.status === 200);
  // #67: /api/validate is deleted, and an /api path nothing answers is a JSON
  // 404. The HTML fallback used to answer it with the app page and a 200.
  for (const p of ['/api/validate?dir=C%3A%5C', '/api/no-such-route']) {
    const r = await fetch(`${BASE}${p}`, { headers: H });
    const type = r.headers.get('content-type') || '';
    check(`${p.split('?')[0]} is a JSON 404, not the app page`, r.status === 404 && type.includes('json'), `${r.status} ${type}`);
  }
  const manifest = await manifestRes.json();
  check(
    'manifest write policy is derived from the guards',
    manifest.write?.editableCategories?.includes('memory') &&
      manifest.write.requiresAcknowledgement.includes('hook')
  );
  check('manifest states the read-only plugin cache, where it is and why (#126)',
    manifest.write?.readOnly?.length === 1 && manifest.write.readOnly[0].dir === path.join(configHome, 'plugins', 'cache') &&
      /^Plugin cache/.test(manifest.write.readOnly[0].reason),
    JSON.stringify(manifest.write?.readOnly));
  check(
    'manifest neverRead is derived from the secret list',
    manifest.neverRead.includes('.credentials.json') && manifest.neverRead.includes('.env')
  );
  check(
    'snapshot root is outside the .claude tree',
    !manifest.write.snapshotRoot.split(path.sep).includes('.claude')
  );

  // --- scan ---------------------------------------------------------------
  const scanRes = await fetch(`${BASE}/api/scan`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ dir: proj }),
  });
  const lineage = await scanRes.json();
  check('scan succeeds', scanRes.status === 200 && Array.isArray(lineage.levels));

  const all = lineage.levels.flatMap((l) => l.entries);
  const memo = all.find((e) => e.absPath === path.join(proj, 'CLAUDE.md'));
  const settings = all.find((e) => e.absPath === path.join(proj, '.claude', 'settings.json'));
  // By path, not "the first hook": hooks/ also holds the planted credential,
  // and a regressed redaction would otherwise hand that to the hook checks.
  const hook = all.find((e) => e.absPath === path.join(proj, '.claude', 'hooks', 'pre.sh'));
  check('scan found the project CLAUDE.md', Boolean(memo));
  check('scan found the project settings.json', Boolean(settings));
  check('scan found the project hook', hook?.category === 'hook');
  check('scan lists a live skill', all.some((e) => e.category === 'skill' && e.absPath.includes('live-skill')));
  check('scan does not list a trashed skill as config', !all.some((e) => e.category === 'skill' && e.absPath.includes('.trash')));
  // #130: the trash folder is listed among the things not read, with its
  // note, and is no entry: the page draws entries as files to open.
  const trashDir = path.join(proj, '.claude', 'skills', '.trash');
  const projOther = lineage.levels.flatMap((l) => l.other || []);
  // #144: the junctioned skill is listed, as a skill, saying which link it is
  // reached through; the link to a share is listed and not walked.
  const linkedManifest = all.find((e) => samePathKey(e.absPath) === samePathKey(path.join(proj, '.claude', 'skills', 'linked-skill', 'SKILL.md')));
  check('a skill folder linked in with a junction is scanned, naming the link (#144)',
    linkedManifest?.category === 'skill' && linkedManifest.isSkillManifest === true && /Reached through the link .*linked-skill/.test(linkedManifest.note || ''),
    JSON.stringify(linkedManifest && { category: linkedManifest.category, note: linkedManifest.note }));
  if (process.platform !== 'win32') {
    skip('a link to a network share is listed, not walked (#144, #74)', 'UNC paths are a Windows form');
  } else if (shareLinkMade === true) {
    const shareLink = lineage.levels.flatMap((l) => l.other || []).find((o) => samePathKey(o.absPath) === samePathKey(path.join(proj, '.claude', 'skills', 'share-skill')));
    check('a link to a network share is listed, not walked (#144, #74)',
      /network share: listed, not scanned/.test(shareLink?.note || '') && !all.some((e) => e.absPath.includes('share-skill')),
      JSON.stringify(shareLink));
  } else {
    skip('a link to a network share is listed, not walked (#144, #74)', `this user cannot make a directory link (${shareLinkMade})`);
  }
  check('a runtime folder such as skills/.trash is listed as not read, never as an entry to open (#130)',
    !all.some((e) => samePathKey(e.absPath) === samePathKey(trashDir)) &&
      projOther.some((o) => samePathKey(o.absPath) === samePathKey(trashDir) && o.type === 'dir' && /Runtime state/.test(o.note || '')),
    JSON.stringify(projOther.map((o) => o.name)));
  check(
    'scan excluded the credential file',
    !all.some((e) => e.name === '.credentials.json') &&
      lineage.levels.some((l) => l.redacted.some((r) => r.absPath.endsWith('.credentials.json')))
  );

  // #7: CLAUDE_CONFIG_DIR relocates the user level, plugins and .claude.json,
  // exactly as Claude Code reads it; ~/CLAUDE.md stays in the home directory.
  const userLevel = lineage.levels.find((l) => l.kind === 'user');
  const pluginsLevel = lineage.levels.find((l) => l.kind === 'plugins');
  const userFiles = userLevel?.entries.map((e) => e.absPath) || [];
  const realHome = path.join(os.homedir(), '.claude');
  check('CLAUDE_CONFIG_DIR: the user level is read from the relocated config home',
    userLevel?.dir === configHome && userFiles.includes(path.join(configHome, 'CLAUDE.md')) &&
      userFiles.includes(path.join(configHome, 'agents', 'home-agent.md')) &&
      !userFiles.some((p) => p.toLowerCase().startsWith(realHome.toLowerCase() + path.sep)),
    JSON.stringify({ dir: userLevel?.dir, files: userFiles.length }));
  check('CLAUDE_CONFIG_DIR: .claude.json is read from inside it, and plugins beneath it',
    userFiles.includes(path.join(configHome, '.claude.json')) && pluginsLevel?.dir === path.join(configHome, 'plugins'),
    JSON.stringify({ plugins: pluginsLevel?.dir }));
  check('CLAUDE_CONFIG_DIR: the manifest states the location and its source',
    manifest.claudeHome === configHome && manifest.claudeHomeSource === 'CLAUDE_CONFIG_DIR' &&
      manifest.globalConfigFile === path.join(configHome, '.claude.json'),
    JSON.stringify({ home: manifest.claudeHome, source: manifest.claudeHomeSource }));

  // #78: none of the machine's own config is read. The fixture sits outside
  // the real home folder and the server has a home of its own, so no level is
  // the real home or inside it. Where the drive root could not be written, the
  // fixture fell back into %TEMP%, under home, and this cannot hold.
  const machineHome = os.homedir();
  const underRealHome = (p) =>
    Boolean(p) && (samePathKey(p) === samePathKey(machineHome) || samePathKey(p).startsWith(samePathKey(machineHome) + path.sep));
  if (fixtureFellBack && underRealHome(smokeDir)) {
    skip('the scan reads nothing from the real home folder', 'the drive root could not be written, so the fixture is under home');
  } else {
    const inHome = lineage.levels.filter((l) => underRealHome(l.dir) || l.entries.some((e) => underRealHome(e.absPath)));
    check('the scan reads nothing from the real home folder', inHome.length === 0 && manifest.home !== machineHome,
      JSON.stringify(inHome.map((l) => l.dir)));
  }
  // #147: the managed folder, the drop-ins and the registry values the main
  // run reads are its own, and absent; a registry value is queried and found missing.
  {
    const managedLevel = lineage.levels.find((l) => l.kind === 'managed');
    const own = (p) => p.toLowerCase().startsWith(smokeDir.toLowerCase());
    check('the scan reads no managed policy of the machine\'s (#147)',
      manifest.managedFolder?.every((t) => own(t.file)) && own(manifest.managedDropInDir || '') &&
        (manifest.registryPolicy || []).every((k) => /LayerCakeSmoke-none-/.test(k.key)) &&
        (process.platform !== 'win32' || (managedLevel?.policies?.length === 2 && managedLevel.policies.every((p) => p.state === 'absent'))),
      JSON.stringify({ folder: manifest.managedFolder, registry: manifest.registryPolicy, policies: managedLevel?.policies }));
  }

  const scanId = lineage.scanId;
  const write = (body) =>
    fetch(`${BASE}/api/write`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ scanId, ...body }),
    });

  // --- the four flattened views must all render ---------------------------
  for (const kind of ['claude-md', 'settings', 'definitions', 'mcp']) {
    const r = await fetch(`${BASE}/api/flatten?scanId=${scanId}&kind=${kind}`, { headers: H });
    check(`flatten "${kind}" renders`, r.status === 200);
  }

  // --- the settings view is Claude Code's model, not a walk (#118, #119) ---
  // Observed on Claude Code 2.1.283: user, then the project's settings.json
  // and settings.local.json, managed on top; no parent folder; objects merge
  // per key, lists combine.
  const settingsView = async (id) =>
    (await fetch(`${BASE}/api/flatten?scanId=${id}&kind=settings`, { headers: H })).json();
  const sv = await settingsView(scanId);
  const svFiles = sv.sections.flatMap((s) => s.files);
  const svFile = (p) => svFiles.find((f) => samePathKey(f.path) === samePathKey(p));
  const allowed = sv.merged.permissions?.allow || [];
  check('settings: local beats project beats user', sv.merged.model === 'local', JSON.stringify(sv.merged.model));
  check('settings: permission lists from user, project and local are combined once each',
    allowed.length === 3 && ['Read', 'Bash', 'Edit'].every((r) => allowed.includes(r)), JSON.stringify(allowed));
  check('settings: env merges per variable',
    sv.merged.env?.SMOKE_USER === 'user' && sv.merged.env?.SMOKE_LOCAL === 'local' && sv.merged.env?.SMOKE_WIN === 'local',
    JSON.stringify(sv.merged.env));
  check('settings: hook lists from two files both apply', sv.merged.hooks?.SessionStart?.length === 2,
    JSON.stringify(sv.merged.hooks));
  check('settings: fallbackModel is taken whole from the strongest file',
    JSON.stringify(sv.merged.fallbackModel) === JSON.stringify(['local-fallback']), JSON.stringify(sv.merged.fallbackModel));
  check('settings: modelPicker in a local file is ignored, and says so',
    sv.merged.modelPicker?.fromUser === true && sv.merged.modelPicker?.fromLocal === undefined &&
      sv.ignored?.some((i) => i.keyPath === 'modelPicker' && i.source === 'local'),
    JSON.stringify([sv.merged.modelPicker, sv.ignored]));
  check("settings: a parent folder's settings are listed as not read, and not merged",
    sv.merged.ancestorOnly === undefined && !allowed.includes('Ancestor') &&
      /parent folder/.test(svFile(path.join(path.dirname(proj), '.claude', 'settings.json'))?.notRead || ''),
    JSON.stringify(svFile(path.join(path.dirname(proj), '.claude', 'settings.json'))));
  check("settings: the config home's settings.local.json is not read for a project elsewhere",
    sv.merged.userLocalOnly === undefined && Boolean(svFile(path.join(configHome, 'settings.local.json'))?.notRead));
  check('settings: keybindings.json is shown but not merged',
    sv.merged.bindings === undefined && Boolean(svFile(path.join(configHome, 'keybindings.json'))?.notRead));
  const allowRow = sv.provenance.find((p) => p.keyPath === 'permissions.allow');
  check('settings: a combined list names every file that added to it',
    JSON.stringify(allowRow?.sources?.map((s) => s.source)) === JSON.stringify(['user', 'project', 'local']) &&
      allowRow.sources[2]?.added?.length === 1,
    JSON.stringify(allowRow));
  check('settings: the config home is applied once and credited to the user level, not to the walk (#118)',
    svFiles.filter((f) => samePathKey(f.path) === samePathKey(path.join(configHome, 'settings.json'))).length === 1 &&
      JSON.stringify(svFile(path.join(configHome, 'settings.json'))?.sources) === JSON.stringify(['user']) &&
      sv.provenance.every((p) => p.sources?.every((s) => ['user', 'project', 'local'].includes(s.source))),
    JSON.stringify(sv.provenance.map((p) => p.sources?.map((s) => s.source))));
  // A session started in the folder above the config home: its settings.json
  // is the user and the project file at once, read once, and only then is the
  // config home's settings.local.json read, as that folder's local settings.
  const homeScan = await (await fetch(`${BASE}/api/scan`, { method: 'POST', headers: H, body: JSON.stringify({ dir: path.dirname(configHome) }) })).json();
  const hv = await settingsView(homeScan.scanId);
  const hvFile = (p) => hv.sections.flatMap((s) => s.files).find((f) => samePathKey(f.path) === samePathKey(p));
  check("settings: started above the config home, its settings.local.json is read as local settings",
    hv.merged.userLocalOnly === true && hv.merged.env?.SMOKE_WIN === 'user-local' &&
      JSON.stringify(hvFile(path.join(configHome, 'settings.json'))?.sources) === JSON.stringify(['user', 'project']) &&
      JSON.stringify(hvFile(path.join(configHome, 'settings.local.json'))?.sources) === JSON.stringify(['local']),
    JSON.stringify([hv.merged, hv.sections.flatMap((s) => s.files).map((f) => [f.path, f.sources])]));

  // A file reached by two routes is not a shadow of itself. The fixture's
  // config home is an ancestor's .claude folder, so the walk re-finds it.
  // Prove that precondition first: without it every check below passes on a
  // tree that deduplicates nothing (#84).
  const levelsHolding = (p) =>
    lineage.levels.filter((l) => l.entries.some((e) => e.absPath.toLowerCase() === p.toLowerCase())).length;
  check('fixture: the config home is reached by two routes',
    levelsHolding(path.join(configHome, 'CLAUDE.md')) === 2 &&
      levelsHolding(path.join(configHome, 'agents', 'home-agent.md')) === 2 &&
      levelsHolding(path.join(configHome, '.mcp.json')) === 2,
    JSON.stringify([levelsHolding(path.join(configHome, 'CLAUDE.md')), levelsHolding(path.join(configHome, '.mcp.json'))]));
  // The walk level holding the relocated home says why its files repeat (#91).
  const homeWalkLevel = lineage.levels.find((l) => l.kind === 'directory' && l.dir.toLowerCase() === path.dirname(configHome).toLowerCase());
  check("the walk level whose .claude is the config home says its files repeat",
    /configuration home/.test(homeWalkLevel?.note || '') &&
      lineage.levels.filter((l) => /configuration home, so its files/.test(l.note || '')).length === 1,
    JSON.stringify(homeWalkLevel?.note));
  // #125: the file count is of distinct files, with the repeats counted apart,
  // so the two add up to what the levels list. The three files above are among
  // the repeats, so a count of sightings cannot pass.
  const sightings = lineage.levels.reduce((n, l) => n + l.entries.filter((e) => e.type === 'file').length, 0);
  check('the file count counts a file reached by two routes once, and says how many (#125)',
    lineage.summary.repeatedFileCount >= 3 &&
      lineage.summary.fileCount + lineage.summary.repeatedFileCount === sightings,
    JSON.stringify([lineage.summary, sightings]));
  const defs = await (
    await fetch(`${BASE}/api/flatten?scanId=${scanId}&kind=definitions`, { headers: H })
  ).json();
  const selfShadowed = defs.groups.filter(
    (g) => g.shadowed && new Set(g.definitions.map((d) => d.path.toLowerCase())).size === 1
  );
  check('no definition is reported as shadowing itself', selfShadowed.length === 0,
    JSON.stringify(selfShadowed.map((g) => g.name)));

  const mem = await (
    await fetch(`${BASE}/api/flatten?scanId=${scanId}&kind=claude-md`, { headers: H })
  ).json();
  const chain = mem.sections.flatMap((s) => s.files.map((f) => f.path.toLowerCase()));
  check('the instruction chain lists each file once', chain.length === new Set(chain).size);
  // #123: rules load with the chain, after their level's CLAUDE.md; one with
  // paths frontmatter is marked; parent's AGENTS.md is stopped by proj's CLAUDE.md.
  const memFiles = mem.sections.flatMap((s) => s.files);
  const memFile = (p) => memFiles.find((f) => samePathKey(f.path) === samePathKey(p));
  const projSection = mem.sections.find((s) => s.files.some((f) => samePathKey(f.path) === samePathKey(path.join(proj, 'CLAUDE.md'))));
  const projOrder = (projSection?.files || []).map((f) => path.basename(f.path).toLowerCase());
  check('rules are in the instruction chain, after their level\'s CLAUDE.md, a conditional one marked (#123)',
    Boolean(memFile(path.join(configHome, 'rules', 'user-rule.md'))?.rule) && !memFile(path.join(configHome, 'rules', 'user-rule.md')).conditional &&
      Boolean(memFile(path.join(proj, '.claude', 'rules', 'plain.md'))) &&
      /src\/\*\*\/\*\.ts/.test(memFile(path.join(proj, '.claude', 'rules', 'cond.md'))?.conditional || '') &&
      projOrder.indexOf('claude.md') < projOrder.indexOf('plain.md'),
    JSON.stringify(projOrder));
  const parentAgents = lineage.levels.flatMap((l) => l.entries).find((e) => samePathKey(e.absPath) === samePathKey(path.join(path.dirname(proj), 'AGENTS.md')));
  check('an AGENTS.md is not read where the project\'s folders hold a CLAUDE.md, and says why (#123)',
    parentAgents?.inactive === true && /only when the project's folders hold no CLAUDE\.md/.test(parentAgents.note || '') &&
      !memFile(path.join(path.dirname(proj), 'AGENTS.md')) && /AGENTS\.md file\(s\) are left out/.test(mem.rule),
    JSON.stringify({ entry: parentAgents && { inactive: parentAgents.inactive, note: parentAgents.note } }));

  // Same class of bug lived in flattenMcp and was fixed later than the other
  // two, so it gets its own assertion rather than being assumed covered.
  const mcp = await (
    await fetch(`${BASE}/api/flatten?scanId=${scanId}&kind=mcp`, { headers: H })
  ).json();
  const selfShadowedMcp = (mcp.servers || []).filter(
    (s) =>
      s.shadowed &&
      new Set(s.definitions.map((d) => `${d.path.toLowerCase()}|${d.scope}`)).size === 1
  );
  check('no MCP server is reported as shadowing itself', selfShadowedMcp.length === 0,
    JSON.stringify(selfShadowedMcp.map((s) => s.name)));

  // A zero above is the convenient answer, so prove the check can still SEE a
  // shadow. The fixture defines one server name in two different files on
  // purpose; if this stops reporting shadowed, the assertion above has gone
  // blind rather than the bug having been fixed.
  const planted = (mcp.servers || []).find((s) => s.name === 'smoke-shadowed');
  check('positive control: a genuine two-file shadow is still detected',
    Boolean(planted?.shadowed), planted ? 'found but not flagged' : 'planted server not found');
  check(
    'the genuine shadow names the project-level file as the winner',
    planted?.winner?.command === 'project',
    JSON.stringify(planted?.winner?.command)
  );

  // Not reporting a self-shadow is not enough: the page drew every sighting in
  // `definitions` after the first as "shadowed", so the payload itself must
  // list a file once and name the other route (#117). The config home above is
  // reached twice, which the precondition check proved.
  const twice = (list, keyOf) => list.length !== new Set(list.map(keyOf)).size;
  const repeatedDefs = defs.groups.filter((g) => twice(g.definitions, (d) => samePathKey(d.path)));
  const homeAgent = defs.groups.find((g) => g.name === 'home-agent');
  check('a definition reached by two routes is listed once, naming the other route (#117)',
    repeatedDefs.length === 0 && homeAgent?.definitions.length === 1 && homeAgent.definitions[0].alsoReachedFrom?.length === 1,
    JSON.stringify({ repeated: repeatedDefs.map((g) => g.name), homeAgent: homeAgent?.definitions }));
  const repeatedServers = (mcp.servers || []).filter((s) => twice(s.definitions, (d) => `${samePathKey(d.path)}|${d.scope}`));
  const homeMcp = (mcp.sources || []).filter((s) => samePathKey(s.path) === samePathKey(path.join(configHome, '.mcp.json')));
  check('an MCP source file reached by two routes is listed once (#117)',
    !twice(mcp.sources || [], (s) => samePathKey(s.path)) && repeatedServers.length === 0 &&
      homeMcp.length === 1 && homeMcp[0].alsoReachedFrom?.length === 1,
    JSON.stringify(homeMcp));
  // #121: Claude Code never reads a .mcp.json inside .claude, the config
  // home's included. It is listed as not read, naming the server it defines,
  // and that server is not among the servers loaded; the scan marks it too.
  const homeMcpEntries = lineage.levels.flatMap((l) => l.entries).filter((e) => samePathKey(e.absPath) === samePathKey(path.join(configHome, '.mcp.json')));
  check('a .mcp.json inside .claude is listed as not read, and its servers are not loaded (#121)',
    /Not read by Claude Code/.test(homeMcp[0]?.notRead || '') && JSON.stringify(homeMcp[0]?.serverNames) === '["smoke-two-routes"]' &&
      !(mcp.servers || []).some((s) => s.name === 'smoke-two-routes') &&
      homeMcpEntries.length === 2 && homeMcpEntries.every((e) => e.inactive === true && /Not read by Claude Code/.test(e.note || '')) &&
      (mcp.servers || []).some((s) => s.name === 'smoke-shadowed'),
    JSON.stringify({ source: homeMcp[0], servers: (mcp.servers || []).map((s) => s.name) }));

  // --- plugins: what loads, under which names (#122, #121) -----------------
  const plugLevel = lineage.levels.find((l) => l.kind === 'plugins');
  const plugEntry = (rel) => plugLevel.entries.find((e) => samePathKey(e.absPath) === samePathKey(path.join(configHome, 'plugins', 'cache', 'smoke-mkt', rel)));
  const oldVersion = path.join(configHome, 'plugins', 'cache', 'smoke-mkt', 'on-plugin', '1.0.0');
  check('a cached version installed_plugins.json does not name is listed, not scanned (#122)',
    !plugLevel.entries.some((e) => samePathKey(e.absPath).startsWith(samePathKey(oldVersion) + path.sep)) &&
      plugLevel.other.some((o) => samePathKey(o.absPath) === samePathKey(oldVersion) && /does not name \(marked orphaned\)/.test(o.note || '')) &&
      Boolean(plugEntry(path.join('on-plugin', '2.0.0', 'agents', 'reviewer.md'))),
    JSON.stringify(plugLevel.other.map((o) => [o.name, o.note])));
  const groupNames = defs.groups.map((g) => g.name);
  const projReviewer = defs.groups.find((g) => g.category === 'agent' && g.name === 'reviewer');
  check('a plugin\'s agent is named plugin:name and does not shadow the project\'s of the same name (#122)',
    groupNames.includes('on-plugin:reviewer') && projReviewer?.definitions.length === 1 && !projReviewer.shadowed,
    JSON.stringify({ names: groupNames, reviewer: projReviewer?.definitions.map((d) => d.path) }));
  check('only plugins that load here count: disabled, not enabled and another project\'s are left out (#122)',
    groupNames.includes('here-plugin:here-agent') &&
      !groupNames.some((n) => /^(off|unnamed|away)-plugin:/.test(n)) && defs.notLoaded === 3,
    JSON.stringify({ names: groupNames, notLoaded: defs.notLoaded }));
  const noteOf = (rel) => plugEntry(rel)?.inactive === true ? plugEntry(rel).note || '' : '(active)';
  check('each file of a plugin that does not load says why (#122)',
    /Disabled/.test(noteOf(path.join('off-plugin', '1.0.0', 'agents', 'off-agent.md'))) &&
      /Not enabled/.test(noteOf(path.join('unnamed-plugin', '1.0.0', 'agents', 'unnamed-agent.md'))) &&
      /Installed for .*local scope/.test(noteOf(path.join('away-plugin', '1.0.0', 'agents', 'away-agent.md'))) &&
      !plugEntry(path.join('here-plugin', '1.0.0', 'agents', 'here-agent.md'))?.inactive,
    JSON.stringify(['off', 'unnamed', 'away'].map((p) => noteOf(path.join(`${p}-plugin`, '1.0.0', 'agents', `${p}-agent.md`)))));
  const serverNames = (mcp.servers || []).map((s) => s.name);
  const offMcp = (mcp.sources || []).find((s) => samePathKey(s.path) === samePathKey(path.join(configHome, 'plugins', 'cache', 'smoke-mkt', 'off-plugin', '1.0.0', '.mcp.json')));
  check('a loaded plugin\'s MCP servers are named plugin:<plugin>:<server>, a disabled one\'s are not loaded (#121)',
    serverNames.includes('plugin:on-plugin:browser') && serverNames.includes('plugin:here-plugin:inline') &&
      !serverNames.some((n) => /offsrv/.test(n)) && Boolean(offMcp?.notRead) &&
      JSON.stringify(offMcp?.serverNames) === '["plugin:off-plugin:offsrv"]',
    JSON.stringify({ servers: serverNames, off: offMcp }));
  // Listed and read, never edited: its servers can sit at the top level, where
  // the executable acknowledgement (which looks for mcpServers) would not see
  // a command being added.
  const onMcp = path.join(configHome, 'plugins', 'cache', 'smoke-mkt', 'on-plugin', '2.0.0', '.mcp.json');
  const onMcpBefore = await fs.readFile(onMcp, 'utf8');
  const onMcpWrite = await write({ path: onMcp, content: JSON.stringify({ browser: { command: 'on-cmd' }, added: { command: 'evil' } }) });
  check("a plugin's .mcp.json is listed but not editable (#122)",
    onMcpWrite.status === 403 && (await fs.readFile(onMcp, 'utf8')) === onMcpBefore &&
      plugEntry(path.join('on-plugin', '2.0.0', '.mcp.json'))?.category === 'plugin-mcp',
    `${onMcpWrite.status}`);

  // --- write refusals -----------------------------------------------------
  check(
    'write refuses a credential file',
    (await write({ path: path.join(proj, '.credentials.json'), content: 'x' })).status === 403
  );
  check(
    'write refuses a path outside the scan result',
    (await write({ path: path.join(proj, 'nope', 'x.md'), content: 'x' })).status === 403
  );
  check('write refuses invalid JSON', (await write({ path: settings.absPath, content: '{ nope' })).status === 400);

  // #19: a settings edit that adds or changes something Claude Code runs needs
  // the executable acknowledgement; ordinary edits and removals do not.
  const settingsBefore = await fs.readFile(settings.absPath, 'utf8');
  const parsedSettings = JSON.parse(settingsBefore);
  const withHook = JSON.stringify({ ...parsedSettings, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo smoke' }] }] } }, null, 2);
  const plainEdit = JSON.stringify({ ...parsedSettings, model: 'smoke-model' }, null, 2);
  const hookRefused = await write({ path: settings.absPath, content: withHook });
  const hookRefusal = await hookRefused.json();
  check('a settings edit that adds a hook needs the executable acknowledgement, and names the key',
    hookRefused.status === 403 && hookRefusal.code === 'EEXECUTABLE' && JSON.stringify(hookRefusal.details?.commandKeys) === '["hooks"]' &&
      (await fs.readFile(settings.absPath, 'utf8')) === settingsBefore,
    JSON.stringify({ status: hookRefused.status, code: hookRefusal.code, details: hookRefusal.details }));
  check('an ordinary settings edit needs no acknowledgement', (await write({ path: settings.absPath, content: plainEdit })).status === 200);
  check('with the acknowledgement, the hook edit saves',
    (await write({ path: settings.absPath, content: withHook, acknowledgeExecutable: true })).status === 200);
  check('removing a command key needs no acknowledgement', (await write({ path: settings.absPath, content: plainEdit })).status === 200);
  const mcpFile = path.join(proj, '.mcp.json');
  const mcpBefore = JSON.parse(await fs.readFile(mcpFile, 'utf8'));
  const mcpRefused = await write({
    path: mcpFile,
    content: JSON.stringify({ mcpServers: { ...mcpBefore.mcpServers, added: { command: 'node', args: ['server.js'] } } }, null, 2),
  });
  const mcpRefusal = await mcpRefused.json();
  check('adding an MCP server (a command) to .mcp.json needs the acknowledgement',
    mcpRefused.status === 403 && JSON.stringify(mcpRefusal.details?.commandKeys) === '["mcpServers"]', JSON.stringify(mcpRefusal));
  // Leave the file as the checks below expect it.
  await write({ path: settings.absPath, content: settingsBefore });
  check(
    'settings.json is unchanged after the refused write',
    JSON.parse(await fs.readFile(settings.absPath, 'utf8')).model === 'opus'
  );

  const hookRes = await write({ path: hook.absPath, content: 'echo pwned' });
  check(
    'write refuses a hook without acknowledgement',
    hookRes.status === 403 && (await hookRes.json()).code === 'EEXECUTABLE'
  );
  check(
    'hook is unchanged after the refused write',
    (await fs.readFile(hook.absPath, 'utf8')).includes('original')
  );
  check(
    'write accepts a hook with acknowledgement',
    (await write({ path: hook.absPath, content: 'echo ok', acknowledgeExecutable: true })).status === 200
  );

  // --- a real edit --------------------------------------------------------
  const before = await fs.readFile(memo.absPath, 'utf8');
  const saveRes = await write({ path: memo.absPath, content: '# Edited by smoke test\n' });
  const saved = await saveRes.json();
  check('write succeeds on a memory file', saveRes.status === 200, JSON.stringify(saved));
  check(
    'file on disk actually changed',
    (await fs.readFile(memo.absPath, 'utf8')) === '# Edited by smoke test\n'
  );
  check('write returned an undo snapshot id', Boolean(saved.undoSnapshotId));
  check('write returned the session-restart notice', /session start/.test(saved.notice || ''));
  check(
    'write refuses on an mtime conflict',
    (await write({ path: memo.absPath, content: 'x', expectedMtime: '2000-01-01T00:00:00.000Z' })).status === 409
  );

  // #49: Windows refuses to rename over a file another process has open, so a
  // save failed whenever something (antivirus, Claude Code, an editor) was
  // reading the file. Save repeatedly while this process reads it in a loop.
  let reading = true;
  let reads = 0;
  const reader = (async () => {
    while (reading) {
      await fs.readFile(memo.absPath).catch(() => {});
      reads += 1;
    }
  })();
  const raced = [];
  for (let i = 0; i < 40; i++) raced.push((await write({ path: memo.absPath, content: `# Edited by smoke test\n${i}\n` })).status);
  reading = false;
  await reader;
  check('saves succeed while something else is reading the file', raced.every((s) => s === 200) && reads > 20,
    `${raced.filter((s) => s !== 200).length} of 40 failed (${[...new Set(raced)].join(',')}); ${reads} reads`);
  // Leave the file as the checks below expect it.
  await write({ path: memo.absPath, content: '# Edited by smoke test\n' });

  // --- snapshot and restore ----------------------------------------------
  const snapRes = await fetch(`${BASE}/api/snapshot`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ scanId, label: 'smoke' }),
  });
  const snap = await snapRes.json();
  check('snapshot captured files', snapRes.status === 200 && snap.counts.files > 0);
  check(
    'snapshot manifest excludes credentials',
    !snap.files.some((f) => f.absPath.endsWith('.credentials.json'))
  );
  check(
    'snapshot deduplicates a file reached by two routes',
    snap.files.length === new Set(snap.files.map((f) => f.absPath.toLowerCase())).size
  );
  // The snapshot stores each distinct file once, by its own dedupe, so it is a
  // second opinion on the scan's file count (#125).
  check('the scan counts the files a full snapshot holds',
    snap.counts.files + snap.counts.skipped + snap.counts.errors === lineage.summary.fileCount,
    JSON.stringify([snap.counts, lineage.summary.fileCount]));

  const list = await (await fetch(`${BASE}/api/snapshots`, { headers: H })).json();
  check('snapshot list includes the undo snapshot', list.snapshots.some((s) => s.id === saved.undoSnapshotId));

  const restoreRes = await fetch(`${BASE}/api/restore`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ scanId, id: saved.undoSnapshotId, paths: [memo.absPath] }),
  });
  const restored = await restoreRes.json();
  check('restore reports success', restoreRes.status === 200 && restored.restored.length === 1);
  check('file content is back to the original', (await fs.readFile(memo.absPath, 'utf8')) === before);
  check('restore produced its own undo snapshot', Boolean(restored.undoSnapshotId));

  const cmp = await (
    await fetch(`${BASE}/api/snapshot/${saved.undoSnapshotId}/compare`, { headers: H })
  ).json();
  check(
    'compare reports the restored file as same',
    cmp.rows.find((r) => r.absPath === memo.absPath)?.status === 'same'
  );

  // --- what a snapshot holds (owner decision, 2026-09-27) -----------------
  // The automatic snapshot before an edit, delete or restore holds only the
  // files that operation replaces; one taken on request holds the lineage.
  const manifestOf = async (id) => (await fetch(`${BASE}/api/snapshot/${encodeURIComponent(id)}`, { headers: H })).json();
  const pathsIn = (m) => (m.files || []).map((f) => samePathKey(f.absPath));
  const editUndo = await manifestOf(saved.undoSnapshotId);
  check("an edit's undo snapshot holds exactly the edited file",
    JSON.stringify(pathsIn(editUndo)) === JSON.stringify([samePathKey(memo.absPath)]), JSON.stringify(pathsIn(editUndo)));
  const restoreUndo = await manifestOf(restored.undoSnapshotId);
  check("a restore's undo snapshot holds exactly the restored file",
    JSON.stringify(pathsIn(restoreUndo)) === JSON.stringify([samePathKey(memo.absPath)]), JSON.stringify(pathsIn(restoreUndo)));
  const scannedFiles = new Set(all.filter((e) => e.type === 'file').map((e) => samePathKey(e.absPath)));
  check('a snapshot taken on request holds every file the scan found',
    scannedFiles.size > 1 && snap.counts.files === scannedFiles.size && pathsIn(snap).every((p) => scannedFiles.has(p)),
    `${snap.counts.files} stored of ${scannedFiles.size} scanned`);

  // #140: saves at the same moment each keep their own undo. Snapshot ids are
  // millisecond times, and six parallel saves used to share one or two
  // folders, each manifest replacing the last.
  {
    const names = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'].map((n) => path.join(proj, '.claude', 'agents', `concurrent-${n}.md`));
    for (const p of names) await fs.writeFile(p, `---\nname: ${path.basename(p, '.md')}\n---\nbefore\n`);
    const concurrentScan = await (await fetch(`${BASE}/api/scan`, { method: 'POST', headers: H, body: JSON.stringify({ dir: proj }) })).json();
    const results = await Promise.all(names.map(async (p) => {
      const res = await fetch(`${BASE}/api/write`, {
        method: 'POST',
        headers: H,
        body: JSON.stringify({ scanId: concurrentScan.scanId, path: p, content: `---\nname: ${path.basename(p, '.md')}\n---\nafter\n` }),
      });
      return { p, status: res.status, body: await res.json() };
    }));
    const ids = results.map((r) => r.body.undoSnapshotId);
    const holds = await Promise.all(results.map(async (r) => JSON.stringify(pathsIn(await manifestOf(r.body.undoSnapshotId))) === JSON.stringify([samePathKey(r.p)])));
    check('six saves at once each keep their own undo snapshot, holding their own file (#140)',
      results.every((r) => r.status === 200) && new Set(ids).size === 6 && holds.every(Boolean),
      JSON.stringify({ statuses: results.map((r) => r.status), distinctIds: new Set(ids).size, holds }));
    for (const p of names) await fs.rm(p, { force: true });
  }

  // #138: snapshots are kept 30 days (owner decision, 2026-09-27), pruned when
  // the next one is taken. Age is read from the folder name LayerCake gave it.
  {
    const idAt = (daysAgo) => new Date(Date.now() - daysAgo * 24 * 3600e3).toISOString().replace(/[:.]/g, '-');
    const plant = async (name) => {
      await fs.mkdir(path.join(snaps, name, 'files'), { recursive: true });
      await fs.writeFile(path.join(snaps, name, 'manifest.json'), JSON.stringify({ version: 1, id: name, label: 'planted', createdAt: new Date().toISOString(), files: [], errors: [], skipped: [], counts: { files: 0 } }));
    };
    const expired = idAt(40);
    const kept = idAt(29);
    await plant(expired);
    await plant(kept);
    await fs.mkdir(path.join(snaps, 'not-a-snapshot'), { recursive: true });
    // A junction named like an expired snapshot, pointing outside the store:
    // pruning must neither follow it nor remove it.
    const outside = path.join(path.dirname(configHome), 'outside-the-store');
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(outside, 'precious.txt'), 'keep me\n');
    const lure = path.join(snaps, idAt(50));
    await fs.symlink(outside, lure, 'junction');

    const listed = await (await fetch(`${BASE}/api/snapshots`, { headers: H })).json();
    const taken = await fetch(`${BASE}/api/snapshot`, { method: 'POST', headers: H, body: JSON.stringify({ scanId, label: 'triggers pruning' }) });
    const exists = async (p) => fs.lstat(p).then(() => true, () => false);
    check('the snapshot list states the retention period', listed.retentionDays === 30, JSON.stringify(listed.retentionDays));
    check('taking a snapshot deletes one older than 30 days, and keeps one 29 days old (#138)',
      taken.status === 200 && !(await exists(path.join(snaps, expired))) && (await exists(path.join(snaps, kept))),
      JSON.stringify({ status: taken.status, expiredLeft: await exists(path.join(snaps, expired)), keptLeft: await exists(path.join(snaps, kept)) }));
    check('pruning leaves a folder that is not a snapshot, and a junction, alone, and never follows it',
      (await exists(path.join(snaps, 'not-a-snapshot'))) && (await exists(lure)) && (await fs.readFile(path.join(outside, 'precious.txt'), 'utf8')) === 'keep me\n');
    await fs.rm(lure, { force: true, recursive: false }).catch(() => fs.rmdir(lure));
    await fs.rm(path.join(snaps, 'not-a-snapshot'), { recursive: true, force: true });
    await fs.rm(path.join(snaps, kept), { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }

  // --- the check that matters most: grep the artifact ---------------------
  // Asserting the manifest omits credentials is not the same as proving no
  // credential BYTES reached the snapshot tree. Search it, with a positive
  // control so a zero result cannot be a false clean.
  // The sentinel's walked copy (hooks/) is the one that can reach a snapshot
  // if a guard regresses, so the positive controls are about that copy: the
  // walk must reach it (it is redacted, not missed) and it must hold the bytes.
  const walkedCred = path.join(proj, '.claude', 'hooks', 'credentials.json');
  const sentinel = JSON.parse(await fs.readFile(walkedCred, 'utf8')).token;
  check('positive control: the walk reaches the planted credential and redacts it',
    lineage.levels.some((l) => l.redacted.some((r) => r.absPath.toLowerCase() === walkedCred.toLowerCase())));
  let found = 0;
  async function grep(dir) {
    for (const d of await fs.readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) await grep(p);
      else if ((await fs.readFile(p, 'utf8').catch(() => '')).includes(sentinel)) found += 1;
    }
  }
  await grep(snaps);
  check('no credential bytes anywhere in the snapshot tree', found === 0, `${found} hits`);
  check(
    'positive control: the sentinel is findable where it does exist',
    (await fs.readFile(walkedCred, 'utf8')).includes(sentinel)
  );

  // --- file watching -------------------------------------------------------
  //
  // The sentence under test is "LayerCake tells you when a config file changes
  // on disk", so the assertion has to make a REAL change with plain fs and read
  // a REAL event off the HTTP stream. Asserting that the stream opens, or that
  // watchTargets returns directories, would both stay green if the watcher were
  // gutted to a no-op that still sent its ready frame.

  /** Minimal SSE reader. Collects frames; `waitFor` polls rather than queueing
   *  waiters, because a poll is four lines and a pub-sub is a component. */
  function openWatch(scanId, headers) {
    const controller = new AbortController();
    const events = [];
    let failure = null;

    const pump = (async () => {
      const res = await fetch(`${BASE}/api/watch?scanId=${encodeURIComponent(scanId)}`, {
        headers,
        signal: controller.signal,
      });
      if (!res.ok) {
        failure = { status: res.status, body: await res.json().catch(() => null) };
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let split = buffer.indexOf('\n\n');
        while (split !== -1) {
          const frame = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          const name = /^event: *(.+)$/m.exec(frame)?.[1]?.trim();
          const data = /^data: *(.+)$/m.exec(frame)?.[1];
          if (name && data) events.push({ name, raw: frame, data: JSON.parse(data) });
          split = buffer.indexOf('\n\n');
        }
      }
    })().catch((err) => {
      if (!controller.signal.aborted) failure = { status: 0, body: { message: err.message } };
    });

    return {
      events,
      get failure() {
        return failure;
      },
      async waitFor(name, timeoutMs = 6000) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          const hit = events.find((e) => e.name === name);
          if (hit) return hit;
          if (failure) return null;
          await new Promise((r) => setTimeout(r, 50));
        }
        return null;
      },
      async close() {
        controller.abort();
        await pump;
      },
    };
  }

  const noToken = { 'Content-Type': 'application/json' };
  const refusedWatch = openWatch(scanId, noToken);
  await refusedWatch.waitFor('ready', 1500);
  check('watch stream refuses a request with no session token', refusedWatch.failure?.status === 403);
  await refusedWatch.close();

  const staleWatch = openWatch('scan-does-not-exist', H);
  await staleWatch.waitFor('ready', 1500);
  check('watch stream refuses an unknown scan', staleWatch.failure?.status === 404);
  await staleWatch.close();

  const watch = openWatch(scanId, H);
  const ready = await watch.waitFor('ready');
  check('watch stream opens and reports readiness', Boolean(ready));
  // #133: another OS's managed folder is listed by the scan for reference but
  // is no gap here: on Windows /Library/... is C:\Library\..., never there.
  const otherOs = process.platform === 'win32' ? /Library[\\/]Application Support|[\\/]etc[\\/]claude-code/ : /ProgramData|Program Files/;
  const gapPaths = [...(ready?.data?.skipped || []), ...(ready?.data?.errors || [])].map((g) => g.absPath || g.path || '');
  check("the watch's gaps hold no other OS's managed folder (#133)",
    !gapPaths.some((p) => otherOs.test(p)) &&
      lineage.levels.find((l) => l.kind === 'managed')?.absent.some((a) => a.platform && a.platform !== process.platform),
    JSON.stringify(gapPaths));
  check(
    'watch reports at least one watched directory',
    (ready?.data?.watchedCount || 0) > 0,
    `watchedCount=${ready?.data?.watchedCount}`
  );
  check(
    'watch states what it is NOT covering',
    Array.isArray(ready?.data?.skipped) && Array.isArray(ready?.data?.errors)
  );
  // The negative half of #57: a folder on a local disk is not taken for a
  // network one. Polling it would still count as watched, so the count above
  // cannot tell; the list of polled folders can.
  check(
    'local folders are watched natively, not polled',
    Array.isArray(ready?.data?.polled) && ready.data.polled.length === 0,
    JSON.stringify(ready?.data?.polled)
  );

  // The decisive assertion. Plain fs, not the API, so nothing inside LayerCake
  // is told the change happened: the only way this can pass is if the watcher
  // actually observed the filesystem.
  await fs.writeFile(memo.absPath, '# Changed by something other than LayerCake\n');
  const changed = await watch.waitFor('change');
  check('a change made outside LayerCake produces a change event', Boolean(changed));
  check(
    'the change event names the file that changed',
    (changed?.data?.changes || []).some((c) => c.name === path.basename(memo.absPath)),
    JSON.stringify(changed?.data?.changes || [])
  );

  // The route must stay a notifier, never a second way to read a file. It is on
  // the same allowlist-free footing as /api/scan, so content leaking into the
  // event payload would bypass the /api/file guard entirely.
  //
  // Requires an event to exist first. Without that the "no content" assertion
  // passes on an empty list, which is exactly the state a broken watcher
  // produces: it would report clean on the mutation it exists to catch.
  const observed = changed?.data?.changes || [];
  const sawContent = observed.some((c) => 'content' in c || 'body' in c || 'data' in c);
  check('the change event carries no file content', observed.length > 0 && !sawContent);

  // Lock and temp files must not reach the banner. Claude Code rewrites
  // ~/.claude.json constantly while a session runs, and each rewrite is a lock
  // plus a temp plus a rename; unfiltered, that noise buries every real event.
  //
  // Written as a PAIR on purpose. "the lock file raised no event" would also be
  // true of a watcher that died, so the real file written alongside it is the
  // positive control that proves the watcher was awake to ignore the lock.
  const watchDir = path.dirname(memo.absPath);
  await fs.writeFile(path.join(watchDir, 'settings.json.lock'), 'lock');
  await fs.writeFile(path.join(watchDir, 'AGENTS.md'), '# real file, written alongside the lock\n');
  await new Promise((r) => setTimeout(r, 1500));

  const named = watch.events
    .filter((e) => e.name === 'change')
    .flatMap((e) => e.data.changes || [])
    .map((c) => c.name);
  check('positive control: the real file written alongside the lock was seen', named.includes('AGENTS.md'));
  check('a .lock file raises no change event', !named.includes('settings.json.lock'));

  // Runtime state lives in the same directories as config. `~/.claude` holds
  // history.jsonl and daemon.log next to settings.json, and both rewrite
  // constantly while Claude Code runs. The filter is derived from the scan and
  // the manifest, so this pair proves both halves of it at once: an open
  // subtree accepts a name nothing ever probed, and a closed directory does not.
  const projClaude = path.join(proj, '.claude');
  await fs.writeFile(path.join(projClaude, 'history.jsonl'), '{"runtime":"state"}\n');
  await fs.writeFile(path.join(projClaude, 'agents', 'brand-new.md'), '---\nname: new\n---\n');
  await new Promise((r) => setTimeout(r, 1500));

  const named2 = watch.events
    .filter((e) => e.name === 'change')
    .flatMap((e) => e.data.changes || [])
    .map((c) => c.name);
  check(
    'a new file in an open config subtree is reported even though nothing probed it',
    named2.includes('brand-new.md')
  );
  check('runtime state beside the config is not reported', !named2.includes('history.jsonl'));

  // #131: opening a file in LayerCake must not report it changed. On Windows a
  // read can fire the folder watch's 'change' (a last-access update, written
  // when the old one is about an hour stale), so the access time is backdated
  // first. The precondition is a bare fs.watch showing that this machine fires
  // on a read at all: with last-access updates off the check below could not
  // fail, and is skipped, visibly, instead.
  {
    const hourAgo = () => new Date(Date.now() - 2 * 3600e3);
    const probeDir = path.join(path.dirname(configHome), 'atime-probe');
    await fs.mkdir(probeDir, { recursive: true });
    const probeFile = path.join(probeDir, 'probe.md');
    await fs.writeFile(probeFile, 'probe\n');
    await fs.utimes(probeFile, hourAgo(), (await fs.stat(probeFile)).mtime);
    await new Promise((r) => setTimeout(r, 200));
    let readFires = false;
    const bare = fsSync.watch(probeDir, (type, name) => {
      if (type === 'change' && name === 'probe.md') readFires = true;
    });
    await new Promise((r) => setTimeout(r, 200));
    await fs.readFile(probeFile);
    await new Promise((r) => setTimeout(r, 1500));
    bare.close();
    await fs.rm(probeDir, { recursive: true, force: true });

    const opened = path.join(proj, '.claude', 'agents', 'reviewer.md');
    if (!readFires) {
      skip('opening a file does not report it changed (#131)', 'this machine does not fire a watch event on a read (last-access updates off)');
    } else {
      // Backdated BEFORE this stream opens: setting the times is itself a
      // metadata change, which a watch already running would rightly report.
      await fs.utimes(opened, hourAgo(), (await fs.stat(opened)).mtime);
      await new Promise((r) => setTimeout(r, 200));
      const readWatch = openWatch(scanId, H);
      await readWatch.waitFor('ready');
      const namedIn = (w) => w.events.filter((e) => e.name === 'change').flatMap((e) => e.data.changes || []).map((c) => c.name);
      const shown = await fetch(`${BASE}/api/file?scanId=${scanId}&path=${encodeURIComponent(opened)}`, { headers: H });
      await new Promise((r) => setTimeout(r, 1500));
      const afterRead = namedIn(readWatch);
      await fs.writeFile(opened, '---\nname: reviewer\n---\n\nReview things, carefully.\n');
      await new Promise((r) => setTimeout(r, 1500));
      const afterWrite = namedIn(readWatch);
      await readWatch.close();
      check('positive control: the file was opened, and a real edit of it still lights the bar',
        shown.status === 200 && afterWrite.includes('reviewer.md'), JSON.stringify({ status: shown.status, afterWrite }));
      check('opening a file does not report it changed (#131)', !afterRead.includes('reviewer.md'), JSON.stringify(afterRead));
    }
  }

  // A credential file sits in a watched directory, so it can raise an event.
  // The name is already public in level.redacted; the BYTES must never be.
  // Both copies: the root one, and the one inside an open config subtree,
  // where events are reported for files no scan probed.
  for (const credPath of [path.join(proj, '.credentials.json'), walkedCred]) {
    await fs.writeFile(credPath, await fs.readFile(credPath, 'utf8'));
  }
  await new Promise((r) => setTimeout(r, 1200));
  check(
    'no credential bytes appear in any watch frame',
    watch.events.length > 0 && !watch.events.some((e) => e.raw.includes(sentinel)),
    `${watch.events.length} frames`
  );

  // The #127 misfire at the HTTP boundary: this scan watches the drive root,
  // and the fixture is a child of it, so a write directly in the fixture folder
  // is a change inside the root. The root must not come back as changed, nor
  // be dropped from the watch as deleted.
  if (!fixtureFellBack) {
    const driveRoot = path.parse(smokeDir).root;
    const isRoot = (p) => samePathKey(p) === samePathKey(driveRoot);
    await fs.writeFile(path.join(smokeDir, 'root-child-change.txt'), 'x');
    await new Promise((r) => setTimeout(r, 1200));
    const misfires = watch.events.filter((e) =>
      (e.name === 'change' && (e.data.changes || []).some((c) => isRoot(c.absPath))) ||
      (e.name === 'coverage' && (e.data.skipped || []).some((s) => isRoot(s.absPath))));
    check('the stream never reports the drive root changed or deleted after a change inside it (#127)',
      misfires.length === 0, JSON.stringify(misfires.map((e) => e.data)));
  }

  await watch.close();

  // --- open config trees found by level, not by folder name (#65, #80) ------
  // A config home moved by CLAUDE_CONFIG_DIR to a folder not named .claude, or
  // one spelled .Claude, still holds open trees: a new agent there is news.
  // The lineage is built by hand around the imported watcher, so this needs no
  // second server with another CLAUDE_CONFIG_DIR.
  {
    const { watchLineage } = await import('../server/watch.js');
    const homes = [
      ['a config home not named .claude (#65)', path.join(smokeDir, 'watch-cfg')],
      ['a config home spelled .Claude (#80)', path.join(smokeDir, 'watch-home', '.Claude')],
    ];
    for (const [label, home] of homes) {
      const agentsDir = path.join(home, 'agents');
      await fs.mkdir(agentsDir, { recursive: true });
      await fs.writeFile(path.join(agentsDir, 'existing.md'), '---\nname: existing\n---\n');
      const lin = {
        levels: [{ kind: 'user', dir: home, entries: [{ absPath: path.join(agentsDir, 'existing.md'), type: 'file', category: 'agent' }], absent: [], errors: [] }],
        networkDrives: [],
      };
      const seen = [];
      const w = watchLineage(lin, (batch) => seen.push(...batch));
      await new Promise((r) => setTimeout(r, 300));
      await fs.writeFile(path.join(agentsDir, 'brand-new.md'), '---\nname: brand-new\n---\n');
      const until = Date.now() + 5000;
      while (Date.now() < until && !seen.some((c) => c.name === 'brand-new.md')) await new Promise((r) => setTimeout(r, 100));
      w.close();
      check(`a new agent in ${label} raises a change event`, seen.some((c) => c.name === 'brand-new.md'),
        JSON.stringify(seen.map((c) => c.name)));
    }
  }

  // --- a change directly inside the drive root (#127) ------------------------
  // Node names a child of C:\ "\name", which path.isAbsolute accepts, and the
  // watcher took every absolute name for the folder's own deletion report: the
  // first change inside C:\ closed its watch and lit "C:\ changed", so a later
  // C:\CLAUDE.md went unreported. Every scan on Windows watches the root. The
  // probe is a path the lineage lists as absent directly under the root, so its
  // creation is news; the folder made and removed first is the misfire trigger.
  // Both are folders: a user may create a folder in C:\ but not a file.
  if (fixtureFellBack) {
    skip('a change inside the drive root keeps it watched (3 checks)', 'the drive root could not be written, so the fixture is not under it');
  } else {
    const { watchLineage } = await import('../server/watch.js');
    const root = path.parse(smokeDir).root;
    const probe = path.join(root, `${path.basename(smokeDir)}-probe`);
    const noise = path.join(root, `${path.basename(smokeDir)}-noise`);
    const lin = { levels: [{ kind: 'directory', dir: root, entries: [], absent: [{ absPath: probe }], errors: [] }], networkDrives: [] };
    const seen = [];
    const w = watchLineage(lin, (batch) => seen.push(...batch));
    const before = w.coverage();
    try {
      await new Promise((r) => setTimeout(r, 300));
      await fs.mkdir(noise);
      await fs.rm(noise, { recursive: true });
      await new Promise((r) => setTimeout(r, 800));
      await fs.mkdir(probe);
      const until = Date.now() + 5000;
      while (Date.now() < until && !seen.some((c) => c.name === path.basename(probe))) await new Promise((r) => setTimeout(r, 100));
      const after = w.coverage();
      check('a folder created directly in the drive root is reported after another change there (#127)',
        seen.some((c) => c.name === path.basename(probe)), JSON.stringify(seen.map((c) => c.absPath)));
      check('the drive root itself is not reported as changed', !seen.some((c) => samePathKey(c.absPath) === samePathKey(root)),
        JSON.stringify(seen.map((c) => c.absPath)));
      check('the drive root stays watched', after.watchedCount === before.watchedCount && after.watchedCount > 0 &&
        !after.skipped.some((s) => samePathKey(s.absPath) === samePathKey(root)), JSON.stringify(after));
    } finally {
      w.close();
      await fs.rm(probe, { recursive: true, force: true });
      await fs.rm(noise, { recursive: true, force: true });
    }
  }

  // --- watching on a network share (#14) -----------------------------------
  //
  // Share-side folders are polled rather than watched, because binding
  // fs.watch to a dead share blocks the event loop. Nothing above reaches that
  // code: every path in the fixture is local.

  /** Opens a watch on a fresh scan of `dir`; returns the stream and its ready frame. */
  async function watchScanOf(dir) {
    const res = await fetch(`${BASE}/api/scan`, { method: 'POST', headers: H, body: JSON.stringify({ dir }) });
    const scanned = await res.json();
    const stream = openWatch(scanned.scanId, H);
    return { scanned, stream, ready: await stream.waitFor('ready') };
  }
  const sameDir = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

  // The same fixture through the admin share, \\localhost\C$\..., is a real UNC
  // path to a local folder, so a change made with plain fs locally is a change
  // on the share. The admin share can be disabled or refused, so a missing one
  // is reported as SKIP, never passed quietly.
  const viaAdminShare = (p) => (/^[a-z]:\\/i.test(p) ? `\\\\localhost\\${p[0]}$${p.slice(2)}` : null);
  const uncProj = viaAdminShare(proj);
  const adminShare = uncProj
    ? await Promise.race([
        fs.stat(uncProj).then(
          () => true,
          () => false
        ),
        new Promise((r) => setTimeout(() => r(false), 3000)),
      ])
    : false;
  if (!adminShare) {
    skip('polling a live share through the admin share (4 checks)', `no admin share for ${proj}`);
  } else {
    const share = await watchScanOf(uncProj);
    check(
      'share-side folders are polled, not skipped',
      (share.ready?.data?.polled || []).some((p) => sameDir(p, uncProj)) &&
        !(share.ready?.data?.skipped || []).some((s) => /network/i.test(s.reason)),
      JSON.stringify(share.ready?.data?.skipped || [])
    );
    // The first round is the baseline; a change before it ends is part of it.
    const firstRound = await share.stream.waitFor('coverage', 15000);
    check(
      'the first poll round finds the share reachable',
      Boolean(firstRound) &&
        !firstRound.data.errors.some(
          (e) => /share not reachable/i.test(e.message) || String(e.path).toLowerCase().startsWith(uncProj.toLowerCase())
        ),
      JSON.stringify(firstRound?.data?.errors || null)
    );
    const marker = `share-side edit ${crypto.randomBytes(4).toString('hex')}`;
    await fs.writeFile(memo.absPath, `# ${marker}\n`);
    const deadline = Date.now() + 15000;
    let seen = null;
    while (!seen && Date.now() < deadline) {
      seen = share.stream.events
        .filter((e) => e.name === 'change')
        .flatMap((e) => (e.data.changes || []).map((c) => ({ c, raw: e.raw })))
        .find(({ c }) => sameDir(c.absPath, path.join(uncProj, 'CLAUDE.md')));
      if (!seen) await new Promise((r) => setTimeout(r, 100));
    }
    check('a change under a network share path produces a change event naming it', Boolean(seen));
    check(
      'that event is a path and a verb, never content',
      Boolean(seen) &&
        seen.c.kind === 'change' &&
        JSON.stringify(Object.keys(seen.c).sort()) === JSON.stringify(['absPath', 'dir', 'kind', 'name']) &&
        !seen.raw.includes(marker),
      JSON.stringify(seen?.c || null)
    );
    await share.stream.close();
  }

  // A share that does not answer. \\localhost with a share name that does not
  // exist fails on the loopback in milliseconds, so this needs no network and
  // no admin share. The scan cannot read those levels, and the stream must say
  // so by name. (Whether they are left out of watchedCount cannot be told apart
  // here: they are already left out at ready, from the scan's own error.)
  const deadShare = `\\\\localhost\\layercake-smoke-no-share-${crypto.randomBytes(3).toString('hex')}\\proj`;
  if (process.platform === 'win32') {
    const dead = await watchScanOf(deadShare);
    const polledDead = dead.ready?.data?.polled || [];
    const deadRound = await dead.stream.waitFor('coverage', 15000);
    check(
      'a share that does not answer is named as not reachable, folder by folder',
      polledDead.length > 0 &&
        polledDead.every((p) => (deadRound?.data?.errors || []).some((e) => e.path === p && /share not reachable/i.test(e.message))),
      JSON.stringify(deadRound?.data?.errors || null)
    );
    await dead.stream.close();
  } else {
    skip('a share that does not answer is named as not reachable', 'UNC paths are a Windows form');
  }

  // --- one call at a time per network share (#55) --------------------------
  //
  // A timed-out call is abandoned, not cancelled: it keeps a threadpool thread
  // until the OS gives up, 21 s for a share on an unroutable address. A scan
  // that went on calling such a share stranded a thread per level and starved
  // every other filesystem call in the server. A real hang needs a share that
  // does not answer, which smoke cannot count on without a network, so this
  // strands a call that never settles in this process's own gate, then runs the
  // real scan code against that share. The share is on the loopback, so a call
  // that got past the gate would fail fast instead of going anywhere. The
  // measured version, a real dead share through the HTTP API, is in the commit
  // that fixed #55.
  if (process.platform !== 'win32') {
    skip('one call at a time per network server (9 checks)', 'UNC paths are a Windows form');
  } else {
    const { timedFsCall } = await import('../server/sharegate.js');
    const { resolveLineage } = await import('../server/scan.js');
    const stuckShare = `\\\\127.0.0.1\\layercake-smoke-stuck-${crypto.randomBytes(3).toString('hex')}`;
    let started = 0;
    let answer = null;
    const neverAnswers = () => {
      started += 1;
      return new Promise((resolve) => (answer = resolve));
    };
    const first = timedFsCall(`${stuckShare}\\a`, neverAnswers).then(() => 'answered', (e) => e.code);
    const second = timedFsCall(`${stuckShare}\\b`, neverAnswers).then(() => 'answered', (e) => e.code);
    await new Promise((r) => setTimeout(r, 100));
    check('a second call to a share waits while the first is out', started === 1, `${started} started`);
    const [firstCode, secondCode] = await Promise.all([first, second]);
    check(
      'a share whose call timed out gets no new call until that one returns',
      firstCode === 'ETIMEDOUT' && secondCode === 'ESHARESTUCK' && started === 1,
      `${firstCode}, ${secondCode}, ${started} started`
    );

    const blocked = await resolveLineage(`${stuckShare}\\a\\b\\proj`);
    const shareLevels = blocked.levels.filter((l) => String(l.dir).toLowerCase().startsWith(stuckShare.toLowerCase()));
    check(
      'the scan sends that share nothing: every share-side level is refused, none timed out',
      shareLevels.length === 4 &&
        shareLevels.every((l) => l.status === 'error' && l.errors.length > 0 && l.errors.every((e) => e.code === 'ESHARESTUCK')),
      JSON.stringify(shareLevels.map((l) => l.errors.map((e) => e.code)))
    );
    // #68: the gate is per SERVER. Another share on the same server waits its
    // turn behind the stranded call; another server does not.
    check(
      'another share on the same server is refused while the call is stranded',
      (await timedFsCall('\\\\127.0.0.1\\layercake-smoke-other\\x', async () => 'answered').catch((e) => e.code)) === 'ESHARESTUCK'
    );
    check(
      'positive control: another server is not held up by it',
      (await timedFsCall('\\\\localhost\\layercake-smoke-other\\x', async () => 'answered').catch((e) => e.code)) === 'answered'
    );

    // #66: the file reader and the snapshot go through the gate too, so a file
    // on the stranded share is refused at once instead of costing a thread and
    // 21 s per click, and a snapshot records it as an error rather than hanging.
    {
      const { readForDisplay } = await import('../server/readfile.js');
      const { createSnapshot } = await import('../server/snapshot.js');
      const onStuck = `${stuckShare}\\a\\CLAUDE.md`;
      let t0 = Date.now();
      const read = await readForDisplay(onStuck);
      const readMs = Date.now() - t0;
      const savedDir = process.env.LAYERCAKE_SNAPSHOT_DIR;
      process.env.LAYERCAKE_SNAPSHOT_DIR = path.join(smokeDir, 'gate-snaps');
      t0 = Date.now();
      let snap;
      try {
        snap = await createSnapshot({
          projectDir: stuckShare,
          levels: [{ kind: 'directory', label: 'stuck', dir: `${stuckShare}\\a`, entries: [{ absPath: onStuck, type: 'file', category: 'memory' }] }],
        });
      } finally {
        if (savedDir === undefined) delete process.env.LAYERCAKE_SNAPSHOT_DIR;
        else process.env.LAYERCAKE_SNAPSHOT_DIR = savedDir;
      }
      const snapMs = Date.now() - t0;
      check('a file on a stranded share is refused at once by the reader and the snapshot',
        read.error?.code === 'ESHARESTUCK' && readMs < 1000 && snap.files.length === 0 &&
          snap.errors.some((e) => e.code === 'ESHARESTUCK') && snapMs < 1000,
        JSON.stringify({ read: read.error?.code, readMs, snap: snap.errors.map((e) => e.code), snapMs }));
    }

    answer();
    await new Promise((r) => setTimeout(r, 0));
    const again = await timedFsCall(`${stuckShare}\\c`, async () => {
      started += 1;
      return 'answered';
    }).catch((e) => e.code);
    check('once the stranded call returns, the share is tried again', again === 'answered' && started === 2, `${again}, ${started} started`);

    // #69: one budget per call, counted from when it was queued. A call that
    // waited behind a slow one used to get a fresh full timeout after, so it
    // could take two timeouts in all.
    {
      const slowServer = `\\\\127.0.0.2\\layercake-smoke-slow-${crypto.randomBytes(3).toString('hex')}`;
      let releaseB = null;
      const a = timedFsCall(`${slowServer}\\a`, () => new Promise((r) => setTimeout(() => r('answered'), 2500)));
      const queuedAt = Date.now();
      const b = timedFsCall(`${slowServer}\\b`, () => new Promise((r) => (releaseB = r))).then(() => 'answered', (e) => e.code);
      const [aCode, bCode] = [await a.catch((e) => e.code), await b];
      const bMs = Date.now() - queuedAt;
      releaseB?.('late');
      check('a call queued behind a slow one times out within its own budget, not after a second one',
        aCode === 'answered' && bCode === 'ETIMEDOUT' && bMs < 4200, `${aCode} ${bCode} ${bMs} ms`);
    }
  }

  const changesIn = (stream) =>
    stream.events.filter((e) => e.name === 'change').flatMap((e) => e.data.changes || []);
  async function waitForChange(stream, match, timeoutMs = 4000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = changesIn(stream).find(match);
      if (hit || Date.now() > deadline) return hit || null;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  const seenPaths = (stream) => JSON.stringify(changesIn(stream).map((c) => c.absPath));

  // --- a new folder inside an open config subtree (#56) --------------------
  //
  // Its own fixture, because the main one cannot show this: its skills/ holds
  // a .trash folder, which is a scan entry, so skills/ is watched as that
  // entry's parent by accident. Here skills/ holds only skill folders and
  // agents/ exists but is empty, which is what a young project looks like.
  const treeProj = path.join(smokeDir, 'trees', 'proj');
  const treeSkills = path.join(treeProj, '.claude', 'skills');
  const treeAgents = path.join(treeProj, '.claude', 'agents');
  await fs.mkdir(path.join(treeSkills, 'first-skill'), { recursive: true });
  await fs.writeFile(path.join(treeSkills, 'first-skill', 'SKILL.md'), '---\nname: first-skill\n---\n');
  await fs.mkdir(treeAgents, { recursive: true });
  await fs.writeFile(path.join(treeProj, '.claude', 'settings.json'), '{}\n');
  // #76: a skill folder to move away (its parent, skills/, is watched), and a
  // project memory folder to move (its parent is not watched).
  const movedSkill = path.join(treeSkills, 'moved-skill');
  await fs.mkdir(movedSkill);
  await fs.writeFile(path.join(movedSkill, 'SKILL.md'), '---\nname: moved-skill\n---\n');
  const treeMemory = path.join(configHome, 'projects', projectSlug(treeProj), 'memory');
  await fs.mkdir(treeMemory, { recursive: true });
  await fs.writeFile(path.join(treeMemory, 'MEMORY.md'), '# memory\n');

  const trees = await watchScanOf(treeProj);
  // Named, not just "something under .claude moved". On a local disk the
  // watch on .claude reports skills/ itself as changed when a folder appears
  // inside it, which lights the bar without saying what was added; on a share
  // nothing reports it at all (checked further down).
  await fs.mkdir(path.join(treeSkills, 'added-skill'));
  await fs.writeFile(path.join(treeSkills, 'added-skill', 'SKILL.md'), '---\nname: added-skill\n---\n');
  check(
    'a new skill folder raises an event naming it',
    Boolean(await waitForChange(trees.stream, (c) => sameDir(c.absPath, path.join(treeSkills, 'added-skill')))),
    seenPaths(trees.stream)
  );
  await fs.writeFile(path.join(treeAgents, 'first-agent.md'), '---\nname: first-agent\n---\n');
  check(
    'a first file in an empty config folder raises an event naming it',
    Boolean(await waitForChange(trees.stream, (c) => sameDir(c.absPath, path.join(treeAgents, 'first-agent.md')))),
    seenPaths(trees.stream)
  );

  // Removing a folder that is itself watched. On Windows libuv then reports
  // the folder's own \\?\ path as renamed, around 130,000 times a second, for
  // as long as the watch stays open: a spinning core, and a bar re-lit on
  // every debounce. So this asserts silence afterwards, not just an event.
  await fs.rm(path.join(treeSkills, 'first-skill'), { recursive: true });
  check(
    'removing a skill folder raises an event naming it',
    Boolean(await waitForChange(trees.stream, (c) => sameDir(c.absPath, path.join(treeSkills, 'first-skill')))),
    seenPaths(trees.stream)
  );
  await new Promise((r) => setTimeout(r, 1000));
  const quietFrom = trees.stream.events.length;
  const quietAt = Date.now();
  // The events alone cannot show a handle left open: the folder stops being
  // reported, and libuv goes on spinning. Its CPU can. Measured over 3 s after
  // such a deletion: 3,328 ms of server CPU with the storm, 31 ms without.
  const serverCpuMs = () => {
    const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const r = spawnSync(ps, ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${server.pid}).TotalProcessorTime.TotalMilliseconds`], {
      encoding: 'utf8',
      timeout: 20000,
      windowsHide: true,
    });
    const ms = Number(String(r.stdout).trim());
    return r.status === 0 && Number.isFinite(ms) ? { ms, at: Date.now() } : null;
  };
  const cpuBefore = process.platform === 'win32' ? serverCpuMs() : null;
  await new Promise((r) => setTimeout(r, 1500));
  const cpuAfter = cpuBefore ? serverCpuMs() : null;
  if (process.platform !== 'win32') {
    skip('a removed folder does not leave the server spinning', 'the storm is a Windows libuv behaviour');
  } else if (!cpuBefore || !cpuAfter) {
    skip('a removed folder does not leave the server spinning', 'could not read the server process CPU time');
  } else {
    const share = (cpuAfter.ms - cpuBefore.ms) / (cpuAfter.at - cpuBefore.at);
    check(
      'a removed folder does not leave the server spinning',
      share < 0.3,
      `server used ${Math.round(share * 100)}% of a core after the removal`
    );
  }
  // Only this fixture's paths: the scan also covers the real home, and a
  // running Claude Code rewrites ~/.claude.json every few seconds.
  const afterRemoval = trees.stream.events
    .slice(quietFrom)
    .filter((e) => e.name === 'change' && (e.data.changes || []).some((c) => c.absPath.startsWith(treeProj)));
  check(
    'a removed folder does not go on raising events',
    afterRemoval.length === 0,
    `${afterRemoval.length} change frames in ${((Date.now() - quietAt) / 1000).toFixed(1)} s, starting 1 s after the removal`
  );
  check(
    'no event names a path the watcher did not build from a real child name',
    !changesIn(trees.stream).some((c) => c.absPath.includes('\\?\\') || (c.name && path.isAbsolute(c.name))),
    seenPaths(trees.stream)
  );

  // #76: a watched folder that moves keeps its native watch, which reports
  // nothing about the move and goes on reporting its children, named under the
  // OLD path. The skill folder's parent is watched, so its move must show in
  // the coverage at once; the memory folder's parent is not, so only the next
  // change inside it can reveal the move. Neither may report a child under the
  // path it left.
  const coverageAfter = async (from, match, timeoutMs = 6000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = trees.stream.events.slice(from).find((e) => e.name === 'coverage' && (e.data.skipped || []).some(match));
      if (hit || Date.now() > deadline) return hit || null;
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  const movedFromThere = (dir) => (s) => sameDir(s.absPath, dir) && /moved/i.test(s.reason || '');
  const beforeMoves = trees.stream.events.length;
  await fs.rename(movedSkill, path.join(treeProj, 'moved-away'));
  check(
    'a watched folder moved away stops counting as watched at once, and says so (#76)',
    Boolean(await coverageAfter(beforeMoves, movedFromThere(movedSkill))),
    JSON.stringify(trees.stream.events.slice(beforeMoves).filter((e) => e.name === 'coverage').map((e) => e.data.skipped))
  );
  await fs.rename(treeMemory, `${treeMemory}-moved`);
  // A new folder under the old name at once: the path alone would pass it as
  // the watched one, and only the file identity tells them apart.
  await fs.mkdir(treeMemory);
  await new Promise((r) => setTimeout(r, 400));
  await fs.writeFile(path.join(treeProj, 'moved-away', 'SKILL.md'), '---\nname: moved-skill\n---\nedited\n');
  await fs.writeFile(path.join(`${treeMemory}-moved`, 'MEMORY.md'), '# memory, edited\n');
  check(
    'a watched folder with no watched parent is found moved at the next change inside it (#76)',
    Boolean(await coverageAfter(beforeMoves, movedFromThere(treeMemory))),
    JSON.stringify(trees.stream.events.slice(beforeMoves).filter((e) => e.name === 'coverage').map((e) => e.data.skipped))
  );
  await new Promise((r) => setTimeout(r, 800));
  const underOldPath = trees.stream.events
    .slice(beforeMoves)
    .filter((e) => e.name === 'change')
    .flatMap((e) => e.data.changes || [])
    .filter((c) => [movedSkill, treeMemory].some((dir) => c.absPath.toLowerCase().startsWith(`${dir}${path.sep}`.toLowerCase())));
  check('a moved folder\'s children are never reported under the path it left (#76)', underOldPath.length === 0, JSON.stringify(underOldPath));
  await trees.stream.close();

  // The same on a share, where it was worse: the poll of .claude compares a
  // folder by presence only, so a skill folder appearing inside skills/ raised
  // nothing at all.
  const uncTrees = viaAdminShare(treeProj);
  if (!adminShare || !uncTrees) {
    skip('a new skill folder on a share raises an event naming it', `no admin share for ${treeProj}`);
  } else {
    const shareTrees = await watchScanOf(uncTrees);
    // The first round is the baseline; a folder made before it ends is part of it.
    await shareTrees.stream.waitFor('coverage', 15000);
    await fs.mkdir(path.join(treeSkills, 'share-skill'));
    await fs.writeFile(path.join(treeSkills, 'share-skill', 'SKILL.md'), '---\nname: share-skill\n---\n');
    check(
      'a new skill folder on a share raises an event naming it',
      Boolean(
        await waitForChange(
          shareTrees.stream,
          (c) => sameDir(c.absPath, path.join(uncTrees, '.claude', 'skills', 'share-skill')),
          15000
        )
      ),
      seenPaths(shareTrees.stream)
    );
    await shareTrees.stream.close();
  }

  // --- a drive letter mapped to a share (#57) ------------------------------
  //
  // Needs a real mapped drive, and mapping one changes this machine's drive
  // letters for the length of the run, so it runs only when asked:
  // SMOKE_MAPPED_DRIVE=1. subst would not do: it maps a letter to a LOCAL
  // folder, which is exactly what must stay natively watched.
  const MAPPED_CHECKS = 'a mapped network drive is polled (3 checks)';
  if (process.platform !== 'win32') {
    skip(MAPPED_CHECKS, 'drive letters are a Windows form');
  } else if (process.env.SMOKE_MAPPED_DRIVE !== '1') {
    skip(MAPPED_CHECKS, 'set SMOKE_MAPPED_DRIVE=1 to map a free letter to the admin share for the run');
  } else if (!adminShare) {
    skip(MAPPED_CHECKS, `no admin share for ${proj}`);
  } else {
    const netExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'net.exe');
    const net = (args) => spawnSync(netExe, args, { encoding: 'utf8', timeout: 20000, windowsHide: true });
    const LETTERS = 'ZYXWVUTSRQPONM';
    // What a letter points at: its share path, itself for a local disk, null
    // when it is free, 'unknown' when it fails or does not answer in 3 s (a
    // dead mapping can hold a call for about 21 s).
    const targetOf = (l) =>
      Promise.race([
        fs.realpath(`${l}:\\`).then(
          (real) => real,
          (err) => (err.code === 'ENOENT' ? null : 'unknown')
        ),
        new Promise((r) => setTimeout(() => r('unknown'), 3000)),
      ]);
    // Mapped to this run's own fixture folder rather than the share's root, so
    // a mapping smoke made names a layercake-smoke- folder and is never taken
    // for one of the user's. A run killed before its finally leaves its mapping
    // until logoff (#79), so each run first removes those whose run has ended,
    // by the pid written beside the fixture before mapping. A pid another
    // process has since taken keeps the mapping: the safe side.
    const ownMapping = /^\\\\localhost\\([a-z])\$(\\(?:[^\\]+\\)*layercake-smoke-[^\\]+)$/i;
    const runEnded = async (target) => {
      const [, drive, rest] = ownMapping.exec(target);
      const pid = Number(await fs.readFile(path.join(`${drive}:${rest}`, 'smoke.pid'), 'utf8').catch(() => ''));
      if (!Number.isInteger(pid) || pid <= 0) return false;
      try {
        process.kill(pid, 0);
        return false;
      } catch (err) {
        return err.code === 'ESRCH';
      }
    };
    for (const l of LETTERS) {
      const target = await targetOf(l);
      if (typeof target === 'string' && ownMapping.test(target) && (await runEnded(target))) {
        const removed = net(['use', `${l}:`, '/delete', '/y']).status === 0;
        process.stdout.write(`  NOTE  ${removed ? 'removed' : 'could not remove'} ${l}:, left mapped to ${target} by a smoke run that has ended (#79)\n`);
      }
    }
    await fs.writeFile(path.join(smokeDir, 'smoke.pid'), String(process.pid));
    let letter = null;
    for (const l of LETTERS) {
      if ((await targetOf(l)) !== null) continue;
      if (net(['use', `${l}:`, viaAdminShare(smokeDir), '/persistent:no']).status === 0) {
        letter = l;
        break;
      }
    }
    if (!letter) {
      skip(MAPPED_CHECKS, 'net use could not map a free drive letter to the admin share');
    } else {
      try {
        const mappedProj = `${letter}:${proj.slice(smokeDir.length)}`;
        const mapped = await watchScanOf(mappedProj);
        check(
          'a folder on a mapped network drive is polled, not watched natively',
          (mapped.ready?.data?.polled || []).some((p) => sameDir(p, mappedProj)),
          JSON.stringify(mapped.ready?.data?.polled || null)
        );
        check(
          'the scan says the level is on a network drive',
          /network drive/i.test(mapped.scanned.levels.find((l) => sameDir(l.dir, mappedProj))?.note || ''),
          JSON.stringify(mapped.scanned.levels.find((l) => sameDir(l.dir, mappedProj))?.note ?? null)
        );
        await mapped.stream.waitFor('coverage', 15000);
        await fs.writeFile(memo.absPath, `# mapped-drive edit ${crypto.randomBytes(4).toString('hex')}\n`);
        check(
          'a change on a mapped drive produces a change event naming it',
          Boolean(
            await waitForChange(mapped.stream, (c) => sameDir(c.absPath, path.join(mappedProj, 'CLAUDE.md')), 15000)
          ),
          seenPaths(mapped.stream)
        );
        await mapped.stream.close();
      } finally {
        net(['use', `${letter}:`, '/delete', '/y']);
      }
    }
  }

  // --- session history -----------------------------------------------------
  await runSessionChecks({ base: BASE, token, check, skip, proj, appData });

  // --- launch and ingest (Phase 2), dry run --------------------------------
  // A scan of its own: the server keeps 8, and the first one's id was evicted
  // by the time the opt-in mapped-drive checks had scanned too (#156).
  const launchScan = await (await fetch(`${BASE}/api/scan`, { method: 'POST', headers: H, body: JSON.stringify({ dir: proj }) })).json();
  await runLaunchChecks({ base: BASE, port: PORT, token, check, scanId: launchScan.scanId, proj, appData, claudeData, reportWindowMs: REPORT_WINDOW_MS, serverStartedAt, claudeProgram: claudeStandIn });

  // --- AI summaries, against a stand-in claude --------------------------------
  await runSummaryChecks({ base: BASE, token, check, skip, proj, smokeDir, appData });

  // --- the Castle (#159, #160): hooks, transcripts, map, fold, stream ---------
  // A project folder of its own: the main one already holds live sessions.
  // It ends by scanning 8 times to test eviction, so it runs just before the
  // create checks, which re-scan for themselves.
  const castleStarted = Date.now();
  await runCastleChecks({ base: BASE, token, check, smokeDir, claudeData });
  process.stdout.write(`  (castle checks took ${((Date.now() - castleStarted) / 1000).toFixed(1)} s)\n`);

  // --- create and delete (#15), restoring a file gone from disk (#92) --------
  // Last, because it scans more often than the server keeps scans (8), which
  // evicts the scan every check above still holds an id for.
  await runCreateChecks({ base: BASE, token, check, skip, smokeDir, configHome, snaps, fakeHome });

  // --- managed policy (#147), on a server of its own ----------------------------
  await runManagedChecks({ root: ROOT, check, skip, smokeDir });
  await runManagedDefaultsChecks({ check, skip });
  await runManagedWatchCheck({ check, smokeDir });

  // --- a configuration home moved by a settings env block (#64), own server ---
  await runConfigHomeChecks({ root: ROOT, check, smokeDir });

  // --- local-scope MCP servers (#120) ----------------------------------------
  // Found under the key Claude Code uses. The fixture's .claude.json names each
  // server after the key holding it. After the create checks, for the same
  // reason: four more scans would evict the scan the checks above hold.
  const mcpFor = async (dir) => {
    const s = await (await fetch(`${BASE}/api/scan`, { method: 'POST', headers: H, body: JSON.stringify({ dir }) })).json();
    const m = await (await fetch(`${BASE}/api/flatten?scanId=${s.scanId}&kind=mcp`, { headers: H })).json();
    return { names: (m.servers || []).map((x) => x.name).filter((n) => n.startsWith('local-')).sort(), m, s };
  };
  const smokeRoot = path.dirname(configHome);
  const inSub = await mcpFor(path.join(smokeRoot, 'mcp-git', 'sub'));
  check('a folder inside a git repository gets the root\'s local MCP servers, not its own key\'s, and never a backslash key\'s (#120)',
    JSON.stringify(inSub.names) === JSON.stringify(['local-git-root']) &&
      inSub.s.gitRoot?.dir?.toLowerCase() === path.join(smokeRoot, 'mcp-git').toLowerCase() &&
      /mcp-git"/.test(inSub.m.servers.find((x) => x.name === 'local-git-root')?.winner?.scope || ''),
    JSON.stringify({ names: inSub.names, gitRoot: inSub.s.gitRoot, key: inSub.m.projectKey }));
  const inWorktree = await mcpFor(path.join(smokeRoot, 'mcp-wt'));
  check('a worktree gets the main repository\'s local MCP servers (#120)',
    JSON.stringify(inWorktree.names) === JSON.stringify(['local-git-root']) && inWorktree.s.gitRoot?.via === 'worktree',
    JSON.stringify({ names: inWorktree.names, gitRoot: inWorktree.s.gitRoot }));
  // #123: project memory is keyed by the git root, so the subfolder's scan
  // finds the repository's MEMORY.md, in the chain as well as the tree.
  const subMemLevel = inSub.s.levels.find((l) => l.kind === 'project-memory');
  const subChain = await (await fetch(`${BASE}/api/flatten?scanId=${inSub.s.scanId}&kind=claude-md`, { headers: H })).json();
  check("a subfolder's project memory is its git root's (#123)",
    samePathKey(subMemLevel?.dir || '') === samePathKey(path.join(configHome, 'projects', projectSlug(path.join(smokeRoot, 'mcp-git')), 'memory')) &&
      subChain.sections.some((s) => s.files.some((f) => /memory of the repository root/.test(f.content || ''))),
    JSON.stringify({ dir: subMemLevel?.dir, note: subMemLevel?.note }));
  // A lone AGENTS.md loads: the only CLAUDE.md on its walk is the config home's.
  const agentsOnly = await (await fetch(`${BASE}/api/scan`, { method: 'POST', headers: H, body: JSON.stringify({ dir: path.join(smokeRoot, 'agents-only') }) })).json();
  const loneChain = await (await fetch(`${BASE}/api/flatten?scanId=${agentsOnly.scanId}&kind=claude-md`, { headers: H })).json();
  check('a lone AGENTS.md is read, the config home\'s CLAUDE.md not counting against it (#123)',
    loneChain.sections.some((s) => s.files.some((f) => samePathKey(f.path) === samePathKey(path.join(smokeRoot, 'agents-only', 'AGENTS.md')))),
    JSON.stringify(loneChain.sections.flatMap((s) => s.files.map((f) => f.path))));
  const toShare = await (await fetch(`${BASE}/api/scan`, { method: 'POST', headers: H, body: JSON.stringify({ dir: path.join(smokeRoot, 'git-share') }) })).json();
  check('a .git file pointing at a network share is not followed: no connection out (#193)',
    toShare.gitRoot?.via === 'git file' && /network share/.test(toShare.gitRoot?.refused || '') && samePathKey(toShare.gitRoot?.dir || '') === samePathKey(path.join(smokeRoot, 'git-share')),
    JSON.stringify(toShare.gitRoot));

  // #192: configuration from a cloned repository reaches the terminal through
  // the CLI. Its control sequences (a clipboard write, a line erase, concealed
  // text, a bidirectional override) must arrive visibly, never acted on, and a
  // CRLF file must still read as lines. The CLI's own environment is the
  // server's: the fixture's homes, never the machine's.
  const hostile = path.join(smokeRoot, 'cli-hostile');
  await fs.mkdir(hostile, { recursive: true });
  await fs.writeFile(path.join(hostile, '.mcp.json'), JSON.stringify({ mcpServers: { 'evil\u001b]52;c;U01PS0U=\u0007': { command: 'safe\u001b[2K\r\u001b[1Ahidden\u202etxt.exe' } } }));
  await fs.writeFile(path.join(hostile, 'CLAUDE.md'), '# first line\r\nshown \u001b[8mconcealed\u001b[28m\r\nlast line\r\n');
  const cliEnv = { ...process.env, CLAUDE_CONFIG_DIR: configHome, USERPROFILE: fakeHome, HOME: fakeHome, LAYERCAKE_SNAPSHOT_DIR: snaps, LAYERCAKE_APPDATA_DIR: appData, LAYERCAKE_CLAUDE_DATA_DIR: claudeData, NO_COLOR: '' };
  const cliOut = ['mcp', 'claude-md']
    .map((view) => spawnSync(process.execPath, [path.join(ROOT, 'cli', 'index.js'), 'show', view, hostile], { env: cliEnv, encoding: 'utf8', windowsHide: true }).stdout)
    .join('\n');
  check('the CLI prints control sequences from configuration visibly, never acting on them, and CRLF as lines (#192)',
    !/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e]/.test(cliOut) &&
      cliOut.includes('evil^[]52;c;U01PS0U=^G') && cliOut.includes('safe^[[2K^M^[[1Ahidden<U+202E>txt.exe') &&
      cliOut.includes('shown ^[[8mconcealed^[[28m') && /# first line\nshown/.test(cliOut),
    JSON.stringify(cliOut.slice(0, 1200)));
  // Invisible formatting characters in source (bidirectional overrides, zero-width
  // marks, a byte-order mark) make code read differently from how it runs, and
  // an editing tool once turned \u escapes into them unseen (#192). Written as
  // escapes they are visible; this keeps it so. Walked from the folders, not git.
  const INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/;
  const sources = [];
  const walkSource = async (dir) => {
    for (const d of await fs.readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, d.name);
      if (d.isDirectory() && d.name !== 'node_modules') await walkSource(p);
      else if (d.isFile() && /\.(m?js|cjs|jsx)$/.test(d.name)) sources.push(p);
    }
  };
  for (const top of ['server', 'client', 'cli', 'scripts', 'desktop']) await walkSource(path.join(ROOT, top));
  const withInvisible = [];
  for (const p of sources) if (INVISIBLE.test(await fs.readFile(p, 'utf8'))) withInvisible.push(path.relative(ROOT, p));
  check('no source file holds an invisible formatting character; escapes are used instead (#192)',
    sources.length > 40 && INVISIBLE.test('planted \u202e here') && withInvisible.length === 0,
    JSON.stringify({ files: sources.length, withInvisible }));
  const inPlain = await mcpFor(path.join(smokeRoot, 'mcp-plain'));
  check('a folder in no git repository gets the servers keyed by itself (#120)',
    JSON.stringify(inPlain.names) === JSON.stringify(['local-plain']) && inPlain.s.gitRoot === null,
    JSON.stringify({ names: inPlain.names, gitRoot: inPlain.s.gitRoot }));
  if (process.platform === 'win32') {
    const upper = await mcpFor(path.join(smokeRoot, 'mcp-plain').toUpperCase());
    check('on Windows a key differing only in case is found (#120)',
      JSON.stringify(upper.names) === JSON.stringify(['local-plain']), JSON.stringify(upper.names));
  } else {
    skip('on Windows a key differing only in case is found (#120)', 'Windows only');
  }

  check('smoke\'s own server stayed up for the whole run', serverExit === null, `exit: ${serverExit}`);

  process.stdout.write(`\n  ${pass} passed, ${fail} failed${skipped ? `, ${skipped} skipped` : ''}\n\n`);
  exitCode = fail ? 1 : 0;
} finally {
  server.kill();
  stopFixtureProcesses();
  // Only ever the directory this run created, resolved and non-empty.
  if (smokeDir && path.isAbsolute(smokeDir) && smokeDir.includes('layercake-smoke-')) {
    await fs.rm(smokeDir, { recursive: true, force: true }).catch(() => {});
  }
}

process.exit(exitCode);
