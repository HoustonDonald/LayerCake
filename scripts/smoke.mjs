/**
 * End to end smoke test. `npm run smoke`.
 *
 * Self contained: builds nothing, but creates its own fixture tree, starts a
 * server on its own port with its own snapshot store, exercises the real HTTP
 * API, and removes everything it made.
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
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { projectSlug } from '../server/paths.js';
import { makeSessionFixture, runLaunchChecks, runSessionChecks, runSummaryChecks, stopFixtureProcesses } from './smoke-sessions.mjs';
import { runCreateChecks } from './smoke-create.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

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

async function makeFixture() {
  smokeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'layercake-smoke-'));
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
  await fs.writeFile(path.join(configHome, 'settings.json'), JSON.stringify({ model: 'smoke' }, null, 2));
  await fs.writeFile(path.join(configHome, '.claude.json'), JSON.stringify({ projects: {} }, null, 2));
  await fs.writeFile(path.join(configHome, 'agents', 'home-agent.md'), '---\nname: home-agent\n---\n');
  // One MCP server in one file, which the walk reaches twice: it must read as
  // defined once, never as shadowing itself.
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

  return { proj, snaps: path.join(smokeDir, 'snaps'), configHome };
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

const { proj, snaps, configHome } = await makeFixture();
// Synthetic Claude session data and LayerCake app data: the real ones are never read or written.
const { claudeData, appData } = await makeSessionFixture(smokeDir, proj);

const serverStartedAt = Date.now();
const server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(PORT),
    LAYERCAKE_SNAPSHOT_DIR: snaps,
    LAYERCAKE_CLAUDE_DATA_DIR: claudeData,
    // Claude Code's own variable: the user level must follow it (#7).
    CLAUDE_CONFIG_DIR: configHome,
    LAYERCAKE_APPDATA_DIR: appData,
    // Launches build their argv and settings but never start Windows Terminal.
    LAYERCAKE_LAUNCH_DRY_RUN: '1',
    // A launched session counts as running for this long after its last
    // report. 45 s in use; short here so "stopped reporting" can be tested.
    LAYERCAKE_REPORT_WINDOW_MS: String(REPORT_WINDOW_MS),
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
      projectSlug('C:\\dev\\beetle-etl\\.claude\\worktrees\\bold-leavitt-3a0334') ===
        'C--dev-beetle-etl--claude-worktrees-bold-leavitt-3a0334'
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
    `got ${icon.status} "${iconType}", ${iconBytes.length} bytes (a public/ built before the icon existed needs npm run build)`
  );
  check('favicon.ico refuses a foreign Host header too', (await getWithHost('/favicon.ico', rebound)).status === 403);

  const manifestRes = await fetch(`${BASE}/api/manifest`, { headers: H });
  check('API accepts a valid token', manifestRes.status === 200);
  const manifest = await manifestRes.json();
  check(
    'manifest write policy is derived from the guards',
    manifest.write?.editableCategories?.includes('memory') &&
      manifest.write.requiresAcknowledgement.includes('hook')
  );
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
    skip('one call at a time per network share (5 checks)', 'UNC paths are a Windows form');
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
    check(
      'positive control: another share is not held up by it',
      (await timedFsCall('\\\\127.0.0.1\\layercake-smoke-other\\x', async () => 'answered').catch((e) => e.code)) === 'answered'
    );

    answer();
    await new Promise((r) => setTimeout(r, 0));
    const again = await timedFsCall(`${stuckShare}\\c`, async () => {
      started += 1;
      return 'answered';
    }).catch((e) => e.code);
    check('once the stranded call returns, the share is tried again', again === 'answered' && started === 2, `${again}, ${started} started`);
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
    let letter = null;
    for (const l of 'ZYXWVUTSRQPONM') {
      const taken = await fs.stat(`${l}:\\`).then(
        () => true,
        (err) => err.code !== 'ENOENT'
      );
      if (taken) continue;
      if (net(['use', `${l}:`, `\\\\localhost\\${proj[0]}$`, '/persistent:no']).status === 0) {
        letter = l;
        break;
      }
    }
    if (!letter) {
      skip(MAPPED_CHECKS, 'net use could not map a free drive letter to the admin share');
    } else {
      try {
        const mappedProj = `${letter}:${proj.slice(2)}`;
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
  await runLaunchChecks({ base: BASE, port: PORT, token, check, scanId: lineage.scanId, proj, appData, claudeData, reportWindowMs: REPORT_WINDOW_MS, serverStartedAt });

  // --- AI summaries, against a stand-in claude --------------------------------
  await runSummaryChecks({ base: BASE, token, check, skip, proj, smokeDir, appData });

  // --- create and delete (#15), restoring a file gone from disk (#92) --------
  // Last, because it scans more often than the server keeps scans (8), which
  // evicts the scan every check above still holds an id for.
  await runCreateChecks({ base: BASE, token, check, smokeDir, configHome });

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
