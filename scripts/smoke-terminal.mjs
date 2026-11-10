/** Windows end-to-end check of the authenticated terminal API and mixed Castle. */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectSlug } from '../server/paths.js';
import { encodeCommand, psQuote, WINDOWS_POWERSHELL } from '../server/powershell.js';
import { minimalTranscript } from './smoke-sessions.mjs';

if (process.platform !== 'win32') {
  console.log('Terminal smoke requires Windows ConPTY.');
  process.exit(0);
}

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'layercake-terminal-smoke-'));
const exe = process.argv.includes('--exe');
const profile = path.join(tmp, 'browser');
const data = path.join(tmp, 'data');
const home = path.join(tmp, 'home');
const bin = path.join(tmp, 'bin');
const project = path.join(tmp, 'project');
const other = path.join(project, 'other-checkout');
const streams = new Set();
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let child;
let base;
let token;

async function until(check, description) {
  for (let attempt = 0; attempt < 160; attempt += 1) {
    const result = await check();
    if (result) return result;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

async function call(route, data, expected = 200) {
  const headers = { 'X-LayerCake-Token': token };
  const options = { headers, signal: AbortSignal.timeout(20000) };
  if (data !== undefined) {
    options.method = 'POST';
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(data);
  }
  const response = await fetch(base + route, options);
  const body = await response.text();
  assert.equal(response.status, expected, `${route} ${body}`);
  return body ? JSON.parse(body) : null;
}

async function stream(route) {
  const controller = new AbortController();
  streams.add(controller);
  const response = await fetch(base + route, { headers: { 'X-LayerCake-Token': token }, signal: controller.signal });
  assert.equal(response.status, 200);
  const events = [];
  const decoder = new TextDecoder();
  const consume = async () => {
    let buffer = '';
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let end;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const match = /^event: ([^\n]+)\ndata: (.+)$/.exec(frame);
        if (match) events.push({ name: match[1], payload: JSON.parse(match[2]) });
      }
    }
  };
  consume().catch((err) => { if (!controller.signal.aborted) events.push({ name: 'error', payload: err.message }); });
  return { events, wait: (name, check = () => true) => until(() => events.find((e) => e.name === name && check(e.payload))?.payload, name) };
}

async function fixturePort() {
  const socket = net.createServer();
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

try {
  for (const dir of [bin, home, path.join(project, 'lib'), path.join(project, '.git'), path.join(other, '.git')]) {
    await fs.mkdir(dir, { recursive: true });
  }
  for (const tool of ['claude', 'codex']) {
    await fs.copyFile(path.join(root, 'scripts', 'smoke-terminal-stub.mjs'), path.join(bin, `${tool}-fixture.mjs`));
    await fs.writeFile(path.join(bin, `${tool}.cmd`), `@node "%~dp0${tool}-fixture.mjs" %*\r\n`);
  }
  await fs.writeFile(path.join(project, 'AGENTS.md'), 'Fixture instructions.\n');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(?:PATH|PORT|OPENAI.*|CODEX.*|CLAUDE.*|LAYERCAKE_.*)$/i.test(key)));
  Object.assign(env, {
    PATH: [bin, path.dirname(process.execPath), path.join(process.env.SystemRoot, 'System32')].join(path.delimiter),
    HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, '.codex'),
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'), LAYERCAKE_CLAUDE_DATA_DIR: path.join(home, '.claude'),
    LAYERCAKE_APPDATA_DIR: data, LAYERCAKE_SNAPSHOT_DIR: path.join(tmp, 'snapshots'),
    LAYERCAKE_BROWSER_PROFILE_DIR: profile, LAYERCAKE_MANAGED_DIR: path.join(tmp, 'managed'),
    LAYERCAKE_POLICY_KEYS: JSON.stringify({ hklm: 'HKCU\\Software\\LayerCakeSmokeTerminal-HKLM', hkcu: 'HKCU\\Software\\LayerCakeSmokeTerminal-HKCU' }),
    LAYERCAKE_INGEST_PORT: String(await fixturePort()), LAYERCAKE_FIXTURE_PROJECT: project,
    LAYERCAKE_LAUNCH_DRY_RUN: '1',
  });
  child = spawn(exe ? path.join(root, 'dist', 'LayerCake.exe') : process.execPath,
    exe ? [] : [path.join(root, 'server', 'index.js')], { cwd: tmp, env, windowsHide: true, stdio: 'ignore' });
  const run = await until(async () => {
    if (child.exitCode !== null) throw new Error(`LayerCake exited ${child.exitCode} during startup.`);
    try { return JSON.parse(await fs.readFile(path.join(data, 'server.json'), 'utf8')); } catch { return null; }
  }, 'LayerCake startup');
  base = `http://127.0.0.1:${run.port}`;
  token = run.key;
  assert.equal((await fetch(base + '/api/terminals')).status, 403);
  assert.equal((await fetch(base + '/')).status, 200);

  const { scanId } = await call('/api/scan', { dir: project });
  const { scanId: otherScan } = await call('/api/scan', { dir: other });
  const config = await call(`/api/codex/config?scanId=${scanId}`);
  assert.equal(config.config.model, 'fixture-project');
  assert.equal(config.instructions[0]?.content.trim(), 'Fixture instructions.');
  assert.ok(!JSON.stringify(config).includes('fixture-private-value'));
  assert.equal((await call('/api/codex/config')).config.model, 'fixture-user');
  const { sessions } = await call(`/api/codex/sessions?scanId=${scanId}`);
  const saved = sessions[0];
  assert.equal(saved.title, 'Saved Codex fixture');
  await call('/api/terminals', { scanId: otherScan, tool: 'codex', resume: saved.sessionId }, 409);

  const start = (tool, scan = scanId, resume) => call('/api/terminals', { scanId: scan, tool, resume, report: true });
  const [first, second, codex] = await Promise.all([start('claude'), start('claude'), start('codex', scanId, saved.sessionId)]);
  const thirdCheckout = await start('claude', otherScan);
  assert.equal(new Set([first.id, second.id, codex.id]).size, 3);
  await call('/api/terminals', { scanId, tool: 'codex', resume: saved.sessionId }, 409);
  const a = await stream(`/api/terminals/${first.id}/stream`);
  const b = await stream(`/api/terminals/${second.id}/stream`);
  const c = await stream(`/api/terminals/${codex.id}/stream`);
  const d = await stream(`/api/terminals/${thirdCheckout.id}/stream`);
  const [aLease, bLease, cLease, dLease] = await Promise.all([a.wait('ready'), b.wait('ready'), c.wait('ready'), d.wait('ready')]);
  const typed = (term, lease, text) => call(`/api/terminals/${term.id}/input`, { controller: lease.controller, data: text }, 204);
  await call(`/api/terminals/${second.id}/input`, { controller: aLease.controller, data: 'wrong' }, 409);
  await call(`/api/terminals/${first.id}/resize`, { controller: aLease.controller, cols: 90, rows: 25 }, 204);
  await typed(first, aLease, 'first-only\r');
  await typed(second, bLease, 'second-only\r');
  const output = (s) => s.events.filter((e) => e.name === 'output').map((e) => e.payload.data).join('');
  await until(() => output(a).includes('[first-only]') && output(b).includes('[second-only]'), 'isolated input');
  assert.ok(!output(a).includes('[second-only]') && !output(b).includes('[first-only]'));
  const again = await stream(`/api/terminals/${first.id}/stream`);
  assert.ok((await again.wait('ready')).data.includes('[first-only]'));
  await a.wait('replaced');
  await call(`/api/terminals/${first.id}/input`, { controller: aLease.controller, data: 'old controller' }, 409);
  await call(`/api/terminals/${codex.id}/rename`, { title: 'Codex task' });
  assert.equal((await call(`/api/codex/sessions?scanId=${scanId}`)).sessions[0].title, 'Codex task');

  const castle = await stream(`/api/castle/stream?scanId=${scanId}`);
  await typed(codex, cLease, 'fixture-edit\r');
  await typed(thirdCheckout, dLease, 'fixture-test\r');
  await castle.wait('state', (state) => state.sessions.some((s) => s.tool === 'codex' && s.terminalId === codex.id) &&
    state.sessions.some((s) => s.tool === 'claude' && s.terminalId === first.id) &&
    !state.sessions.some((s) => s.terminalId === thirdCheckout.id) &&
    Object.values(state.rooms).some((r) => r.scaffolding));
  await typed(codex, cLease, 'fixture-test\r');
  await castle.wait('state', (state) => Object.values(state.rooms).some((r) => r.cause?.kind === 'proven' || !r.scaffolding && r.lastChange !== null));
  // A tab's state (#207), read where the page reads it: the terminal list.
  const activity = async (t) => (await call('/api/terminals')).find((x) => x.id === t.id).activity;
  const becomes = (t, state) => until(async () => { const a = await activity(t); return a.state === state ? a : null; }, `${t.tool} terminal ${state}`);
  assert.ok((await call('/api/terminal-states')).some((r) => r.state === 'waiting' && r.rule), 'the state rules are served with the states');
  // Claude Code: a prompt was reported and no end of turn, so a turn is open.
  assert.equal((await activity(first)).state, 'working');
  const againLease = await again.wait('ready');
  await typed(first, againLease, 'fixture-permission\r');
  assert.equal((await becomes(first, 'waiting')).inferred, false, 'Claude Code reports its own permission prompt');
  await typed(first, againLease, 'fixture-stop\r');
  await becomes(first, 'idle');
  // Codex reports no prompt. A turn's end is idle; a call that started and has
  // not finished is working while the terminal prints, and reads as an
  // approval prompt, marked as an inference, once it has been quiet for 5 s.
  await typed(codex, cLease, 'fixture-stop\r');
  await becomes(codex, 'idle');
  await typed(codex, cLease, 'fixture-pending\r');
  await becomes(codex, 'working');
  assert.equal((await becomes(codex, 'waiting')).inferred, true, 'a quiet Codex terminal with a call open is an inferred wait');
  assert.equal((await call(`/api/terminals/${first.id}/keep`, { keep: true })).keep, true);
  assert.equal((await call('/api/terminals')).find((t) => t.id === first.id).keep, true, 'a keep-on-close mark is on the list');
  await call(`/api/terminals/${first.id}/keep`, { keep: 'yes' }, 400);

  // Hand-off to Windows Terminal (#205). The launch is a dry run: what is
  // checked is that the embedded process ends and the SAME chat is what would
  // be started, in the terminal's own folder. The fixture reported a prompt
  // moments ago and sent no SessionEnd, so by its reports the session is still
  // running: the resume guard passes only because the terminal's exit ended it.
  const claudeProjects = path.join(home, '.claude', 'projects', projectSlug(project));
  await fs.mkdir(claudeProjects, { recursive: true });
  await minimalTranscript(claudeProjects, first.sessionId, project, 'Fixture prompt');
  const moved = await call(`/api/terminals/${first.id}/handoff`, {});
  assert.equal(moved.dryRun, true);
  assert.equal(moved.argv[moved.argv.indexOf('--resume') + 1], first.sessionId, 'the hand-off resumes the same Claude session');
  assert.equal(moved.argv[moved.argv.indexOf('-d') + 1], project, 'in the terminal\'s own folder');
  await again.wait('state', (state) => state.running === false);
  assert.equal((await call('/api/terminals')).find((t) => t.id === first.id).running, false, 'the embedded process ended');
  // Nothing said yet in this one: no chat to continue, so it is refused and left running.
  const kept = await call(`/api/terminals/${thirdCheckout.id}/handoff`, {}, 409);
  assert.equal(kept.code, 'ECANNOTKEEP');
  await typed(thirdCheckout, dLease, 'still-here\r');
  await until(() => output(d).includes('[still-here]'), 'a refused hand-off leaves its terminal running');
  const movedCodex = await call(`/api/terminals/${codex.id}/handoff`, {});
  assert.deepEqual(movedCodex.argv.slice(movedCodex.argv.indexOf('resume'), movedCodex.argv.indexOf('resume') + 2), ['resume', saved.sessionId]);
  await c.wait('state', (state) => state.running === false);
  const codexAgain = await start('codex', scanId, saved.sessionId);
  const e = await stream(`/api/terminals/${codexAgain.id}/stream`);
  await e.wait('ready');

  await typed(second, bLease, '\x03');
  await until(() => output(b).includes('FIXTURE INTERRUPTED'), 'Ctrl+C');
  await typed(second, bLease, 'fixture-exit\r');
  await b.wait('state', (state) => state.running === false && state.exitCode === 0);
  await call(`/api/terminals/${codexAgain.id}/close`, {}, 204);
  await e.wait('state', (state) => state.running === false);
  console.log(`Terminal, configuration, and mixed Castle checks passed (${exe ? 'portable executable' : 'source server'}).`);
} finally {
  for (const controller of streams) controller.abort();
  if (child && child.exitCode === null && exe) {
    const command = `Get-CimInstance Win32_Process -Filter "ParentProcessId=${child.pid}" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains(${psQuote(profile)}) } | ForEach-Object { (Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue).CloseMainWindow() }`;
    try { execFileSync(WINDOWS_POWERSHELL, ['-NoProfile', '-EncodedCommand', encodeCommand(command)], { windowsHide: true, stdio: 'ignore', timeout: 5000 }); } catch { /* cleanup below */ }
    await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(4000)]);
  }
  if (child && child.exitCode === null) child.kill();
  if (path.dirname(tmp) === await fs.realpath(os.tmpdir()) && path.basename(tmp).startsWith('layercake-terminal-smoke-')) {
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 }).catch(() => {});
  }
}
