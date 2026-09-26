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

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { projectSlug } from '../server/paths.js';
import { makeSessionFixture, runLaunchChecks, runSessionChecks, runSummaryChecks } from './smoke-sessions.mjs';

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
  // sentinel so the snapshot tree can be searched for it afterwards.
  await fs.writeFile(
    path.join(proj, '.credentials.json'),
    `{"token":"SMOKE-SENTINEL-${crypto.randomBytes(4).toString('hex')}"}`
  );
  // Claude Code's configuration home, relocated with CLAUDE_CONFIG_DIR (#7).
  // The user level is read from here, so smoke no longer scans or snapshots
  // the real ~/.claude as its user level.
  const configHome = path.join(smokeDir, 'claude-home');
  await fs.mkdir(path.join(configHome, 'agents'), { recursive: true });
  await fs.writeFile(path.join(configHome, 'CLAUDE.md'), '# user-level memory in the relocated home\n');
  await fs.writeFile(path.join(configHome, 'settings.json'), JSON.stringify({ model: 'smoke' }, null, 2));
  await fs.writeFile(path.join(configHome, '.claude.json'), JSON.stringify({ projects: {} }, null, 2));
  await fs.writeFile(path.join(configHome, 'agents', 'home-agent.md'), '---\nname: home-agent\n---\n');
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
  const hook = all.find((e) => e.category === 'hook' && e.absPath.startsWith(proj));
  check('scan found the project CLAUDE.md', Boolean(memo));
  check('scan found the project settings.json', Boolean(settings));
  check('scan found the project hook', Boolean(hook));
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

  // A file reached by two routes is not a shadow of itself. The fixture lives
  // under the home directory on Windows, so the walk re-finds home's config.
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
  const sentinel = JSON.parse(await fs.readFile(path.join(proj, '.credentials.json'), 'utf8')).token;
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
    (await fs.readFile(path.join(proj, '.credentials.json'), 'utf8')).includes(sentinel)
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
  const credPath = path.join(proj, '.credentials.json');
  const credBytes = await fs.readFile(credPath, 'utf8');
  await fs.writeFile(credPath, credBytes);
  await new Promise((r) => setTimeout(r, 1200));
  check(
    'no credential bytes appear in any watch frame',
    watch.events.length > 0 && !watch.events.some((e) => e.raw.includes(sentinel)),
    `${watch.events.length} frames`
  );

  await watch.close();

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
  const uncProj = /^[a-z]:\\/i.test(proj) ? `\\\\localhost\\${proj[0]}$${proj.slice(2)}` : null;
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

  // --- session history -----------------------------------------------------
  await runSessionChecks({ base: BASE, token, check, proj, appData });

  // --- launch and ingest (Phase 2), dry run --------------------------------
  await runLaunchChecks({ base: BASE, port: PORT, token, check, scanId: lineage.scanId, proj, appData, claudeData, reportWindowMs: REPORT_WINDOW_MS, serverStartedAt });

  // --- AI summaries, against a stand-in claude --------------------------------
  await runSummaryChecks({ base: BASE, token, check, proj, smokeDir, appData });

  check('smoke\'s own server stayed up for the whole run', serverExit === null, `exit: ${serverExit}`);

  process.stdout.write(`\n  ${pass} passed, ${fail} failed${skipped ? `, ${skipped} skipped` : ''}\n\n`);
  exitCode = fail ? 1 : 0;
} finally {
  server.kill();
  // Only ever the directory this run created, resolved and non-empty.
  if (smokeDir && path.isAbsolute(smokeDir) && smokeDir.includes('layercake-smoke-')) {
    await fs.rm(smokeDir, { recursive: true, force: true }).catch(() => {});
  }
}

process.exit(exitCode);
