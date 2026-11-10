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
const runs = path.join(tmp, 'runs');
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
  // A read is asked once more when its connection was reset: after a pause
  // longer than the server's keep-alive, fetch can pick up a socket the server
  // has just closed. A write is never repeated.
  const response = await fetch(base + route, options).catch((err) => {
    if (data !== undefined || err.cause?.code !== 'ECONNRESET') throw err;
    return fetch(base + route, { headers, signal: AbortSignal.timeout(20000) });
  });
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

/** What each fixture CLI process was started with: one record per process, written by the stub. A record still being written is skipped. */
const runsOf = async () => (await Promise.all((await fs.readdir(runs).catch(() => [])).map(async (name) => { try { return JSON.parse(await fs.readFile(path.join(runs, name), 'utf8')); } catch { return null; } }))).filter(Boolean);
const runWith = async (flag, id) => (await runsOf()).find((r) => r.argv.includes(flag) && r.argv[r.argv.indexOf(flag) + 1] === id);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** Asks every app window on the test's own browser profile to close, as a click on its X does. */
function closeWindows() {
  const command = `Get-CimInstance Win32_Process -Filter "Name='msedge.exe' OR Name='chrome.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains(${psQuote(profile)}) -and $_.CommandLine.Contains('--app=') } | ForEach-Object { [void](Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue).CloseMainWindow() }`;
  try { execFileSync(WINDOWS_POWERSHELL, ['-NoProfile', '-EncodedCommand', encodeCommand(command)], { windowsHide: true, stdio: 'ignore', timeout: 8000 }); } catch { /* the caller's wait decides */ }
}

/**
 * The app windows on the test's own browser profile: title, size, and whether
 * maximised. `maximize` maximises them first. Read through user32, since the
 * executable's own windows have no debugging port.
 */
async function appWindows({ maximize = false } = {}) {
  const script = [
    'Add-Type @"',
    'using System; using System.Runtime.InteropServices;',
    'public class LcWin { [StructLayout(LayoutKind.Sequential)] public struct R { public int L, T, Rt, B; }',
    '  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);',
    '  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);',
    '  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h); }',
    '"@',
    `Get-CimInstance Win32_Process -Filter "Name='msedge.exe' OR Name='chrome.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains(${psQuote(profile)}) -and $_.CommandLine.Contains('--app=') } | ForEach-Object {`,
    '  $p = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue',
    '  if ($p -and $p.MainWindowHandle -ne 0) {',
    `    ${maximize ? '[void][LcWin]::ShowWindow($p.MainWindowHandle, 3)' : ''}`,
    '    $r = New-Object LcWin+R; [void][LcWin]::GetWindowRect($p.MainWindowHandle, [ref]$r)',
    '    "{0}|{1}|{2}|{3}" -f ($r.Rt - $r.L), ($r.B - $r.T), [LcWin]::IsZoomed($p.MainWindowHandle), $p.MainWindowTitle',
    '  }',
    '}',
  ].join('\n');
  let out = '';
  try { out = execFileSync(WINDOWS_POWERSHELL, ['-NoProfile', '-EncodedCommand', encodeCommand(script)], { windowsHide: true, encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return []; }
  return out.split(/\r?\n/).filter((line) => /^\d+\|/.test(line)).map((line) => {
    const [width, height, zoomed, ...title] = line.split('|');
    return { width: Number(width), height: Number(height), zoomed: zoomed === 'True', title: title.join('|') };
  });
}

async function fixturePort() {
  const socket = net.createServer();
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

try {
  for (const dir of [bin, home, runs, path.join(project, 'lib'), path.join(project, '.git'), path.join(other, '.git')]) {
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
    LAYERCAKE_FIXTURE_RUNS: runs,
    // From source the hand-off is a dry run; the executable's own close makes the real launch (below).
    ...(exe ? {} : { LAYERCAKE_LAUNCH_DRY_RUN: '1' }),
  });
  // Starts LayerCake and waits for its own run record: the pid in it tells this
  // run's record from one an earlier run in the same data folder left behind.
  const startApp = async () => {
    child = spawn(exe ? path.join(root, 'dist', 'LayerCake.exe') : process.execPath,
      exe ? [] : [path.join(root, 'server', 'index.js')], { cwd: tmp, env, windowsHide: true, stdio: 'ignore' });
    const run = await until(async () => {
      if (child.exitCode !== null) throw new Error(`LayerCake exited ${child.exitCode} during startup.`);
      try {
        const record = JSON.parse(await fs.readFile(path.join(data, 'server.json'), 'utf8'));
        return record.pid === child.pid ? record : null;
      } catch { return null; }
    }, 'LayerCake startup');
    base = `http://127.0.0.1:${run.port}`;
    token = run.key;
  };
  await startApp();
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
  // What the chooser shown at close reads (#205): every running session, its
  // Keep mark, and why it could not be kept. Answering is refused while
  // LayerCake is not closing; only the executable opens a decision.
  const closing = await call('/api/close');
  assert.equal(closing.pending, false);
  const row = (t) => closing.sessions.find((s) => s.id === t.id);
  assert.deepEqual([row(first).keep, row(first).refusal], [true, null], 'a marked session with a saved chat can be kept');
  assert.match(row(thirdCheckout).refusal, /Nothing has been said/, 'a session with no chat yet says why it cannot be kept');
  assert.equal((await call('/api/close', { keep: [] }, 409)).code, 'ENOTCLOSING');
  assert.equal((await call('/api/prefs', { askOnClose: false })).askOnClose, false, '"Don\'t ask again" is a stored preference');
  assert.equal((await call('/api/prefs', { askOnClose: 'no' })).askOnClose, false, 'and only a boolean changes it');
  assert.equal((await call('/api/prefs', { askOnClose: true })).askOnClose, true);
  const moved = await call(`/api/terminals/${first.id}/handoff`, {});
  if (exe) {
    // No dry run in the executable: the same chat really starts, in a console window.
    assert.ok((await until(() => runWith('--resume', first.sessionId), 'the Claude session to start again')).argv.includes('--settings'), 'a hand-off while LayerCake stays open keeps its reporting');
  } else {
    assert.equal(moved.dryRun, true);
    assert.equal(moved.argv[moved.argv.indexOf('--resume') + 1], first.sessionId, 'the hand-off resumes the same Claude session');
    assert.equal(moved.argv[moved.argv.indexOf('-d') + 1], project, 'in the terminal\'s own folder');
  }
  await again.wait('state', (state) => state.running === false);
  assert.equal((await call('/api/terminals')).find((t) => t.id === first.id).running, false, 'the embedded process ended');
  // Nothing said yet in this one: no chat to continue, so it is refused and left running.
  const kept = await call(`/api/terminals/${thirdCheckout.id}/handoff`, {}, 409);
  assert.equal(kept.code, 'ECANNOTKEEP');
  await typed(thirdCheckout, dLease, 'still-here\r');
  await until(() => output(d).includes('[still-here]'), 'a refused hand-off leaves its terminal running');
  const movedCodex = await call(`/api/terminals/${codex.id}/handoff`, {});
  if (exe) await until(async () => (await runsOf()).find((r) => r.tool === 'codex' && r.argv[r.argv.indexOf('resume') + 1] === saved.sessionId && !r.argv.includes('-c')), 'the Codex chat to start again');
  else assert.deepEqual(movedCodex.argv.slice(movedCodex.argv.indexOf('resume'), movedCodex.argv.indexOf('resume') + 2), ['resume', saved.sessionId]);
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

  // Closing with sessions running (#205), which only the executable does: it
  // outlives its window, asks which sessions to keep, moves those to a
  // terminal of their own and ends the rest. The launch is real here. The
  // fixture PATH has no wt.exe, so a kept session opens in a console window,
  // and each fixture process records its arguments, which is what is checked.
  if (exe) {
    const kept = await start('claude');
    const ended = await start('claude');
    for (const t of [kept, ended]) await minimalTranscript(claudeProjects, t.sessionId, project, 'Fixture prompt');
    const embedded = await until(async () => {
      const found = [await runWith('--session-id', kept.sessionId), await runWith('--session-id', ended.sessionId)];
      return found.every(Boolean) ? found : null;
    }, 'both embedded sessions to start');
    // This test's own streams go first, as a real window's do when it closes:
    // an open one is a request still running, which the executable waits for.
    for (const controller of streams) controller.abort();
    const exited = (what) => until(() => child.exitCode !== null, what);
    const mainWindow = await until(async () => (await appWindows())[0], 'the main window');
    closeWindows();
    // The window is gone and sessions are running: a decision is opened and a chooser window with it.
    await until(async () => (await call('/api/close')).pending, 'the executable to ask which sessions to keep');
    const chooser = await until(async () => (await appWindows()).find((w) => /closing/i.test(w.title)), 'the chooser window to show its own title');
    assert.ok(chooser.width < mainWindow.width && chooser.width <= 900 && chooser.height <= 800, `the chooser is a small window (${chooser.width} by ${chooser.height}; main ${mainWindow.width} by ${mainWindow.height})`);
    assert.ok(embedded.every((r) => alive(r.pid)), 'nothing is ended while the question is open');
    // A read first: it gives the answer below a connection the server has not just closed.
    await call('/api/close');
    await call('/api/close', { keep: [kept.id], dontAsk: true }, 204);
    await exited('the executable to exit after the answer');
    const resumed = await until(() => runWith('--resume', kept.sessionId), 'the kept session to start again outside LayerCake');
    assert.ok(!resumed.argv.includes('--settings'), 'a session kept at close is started without reporting settings');
    assert.equal(await runWith('--resume', ended.sessionId), undefined, 'a session that was not ticked is not started again');
    await until(() => embedded.every((r) => !alive(r.pid)), 'both embedded processes to end');
    assert.ok(alive(resumed.pid), 'the kept session is running after LayerCake has exited');
    try { process.kill(resumed.pid); } catch { /* it ended by itself */ }
    closeWindows();
    assert.equal(JSON.parse(await fs.readFile(path.join(data, 'prefs.json'), 'utf8')).askOnClose, false, '"Don\'t ask again" in the answer is stored');

    // Two sessions with saved chats in a fresh run, the first marked Keep.
    const pair = async () => {
      const { scanId: scan } = await call('/api/scan', { dir: project });
      const marked = await call('/api/terminals', { scanId: scan, tool: 'claude', report: true });
      const plain = await call('/api/terminals', { scanId: scan, tool: 'claude', report: true });
      for (const t of [marked, plain]) await minimalTranscript(claudeProjects, t.sessionId, project, 'Fixture prompt');
      await call(`/api/terminals/${marked.id}/keep`, { keep: true });
      await until(async () => (await runWith('--session-id', marked.sessionId)) && (await runWith('--session-id', plain.sessionId)), 'both embedded sessions to start');
      return { marked, plain };
    };
    const keptOnly = async ({ marked, plain }, how) => {
      const again = await until(() => runWith('--resume', marked.sessionId), `the marked session to start again (${how})`);
      assert.equal(await runWith('--resume', plain.sessionId), undefined, `the unmarked session is not started again (${how})`);
      try { process.kill(again.pid); } catch { /* it ended by itself */ }
    };

    // Nothing running: closing asks nothing and ends. A question nobody answers would keep it up.
    await startApp();
    const secondMain = await until(async () => (await appWindows())[0], 'the next run\'s main window');
    assert.ok(secondMain.width > chooser.width + 100, `the chooser's size is not remembered for the main window (${secondMain.width} wide after a ${chooser.width} wide chooser)`);
    closeWindows();
    await exited('the executable to exit with no session running');

    // "Don't ask again" is on: no question, the marks decide.
    await startApp();
    const unasked = await pair();
    closeWindows();
    await exited('the executable to exit without asking');
    await keptOnly(unasked, 'not asked');

    // Asking again, from a maximised window, and the chooser closed without an answer: the marks decide.
    await startApp();
    await call('/api/prefs', { askOnClose: true });
    const unanswered = await pair();
    await until(async () => (await appWindows({ maximize: true }))[0], 'the main window to maximise');
    await until(async () => (await appWindows())[0]?.zoomed, 'the main window to be maximised');
    closeWindows();
    await until(async () => (await call('/api/close')).pending, 'the executable to ask again');
    const small = await until(async () => (await appWindows()).find((w) => /closing/i.test(w.title)), 'the chooser window');
    assert.ok(!small.zoomed && small.width <= 900, `the chooser opens small after a maximised main window (${small.width} wide, maximised ${small.zoomed})`);
    closeWindows();
    await exited('the executable to exit after the chooser was closed');
    await keptOnly(unanswered, 'chooser closed');
    console.log('Keep-on-close checks passed (portable executable).');
  }
} finally {
  for (const controller of streams) controller.abort();
  if (exe) {
    closeWindows();
    if (child && child.exitCode === null) await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(4000)]);
    // The chooser's window, if the run stopped while it was open.
    closeWindows();
  }
  if (child && child.exitCode === null) child.kill();
  // A kept fixture session, if a failed run left one behind in its console window.
  for (const name of await fs.readdir(runs).catch(() => [])) {
    try { process.kill(JSON.parse(await fs.readFile(path.join(runs, name), 'utf8')).pid); } catch { /* gone */ }
  }
  if (path.dirname(tmp) === await fs.realpath(os.tmpdir()) && path.basename(tmp).startsWith('layercake-terminal-smoke-')) {
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 }).catch(() => {});
  }
}
