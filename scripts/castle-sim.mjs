#!/usr/bin/env node
/**
 * The Castle under a heavy-ish workload, to watch it and to measure it (owner
 * request, 2026-09-30). It starts a LayerCake of its own on a spare port, with
 * every data folder in a scratch folder and launches in dry run, and opens an
 * app window on a browser profile of its own. So nothing here reaches the real
 * app, the real Claude data folder, the real snapshot store, or a terminal.
 * It spends no Claude usage.
 *
 *   node scripts/castle-sim.mjs replay [--project DIR] [--sessions 3] [--speed 10] [--max-gap 20] [--minutes 5] [--hold 120]
 *   node scripts/castle-sim.mjs stress [--project DIR] [--sessions 3] [--knights 3] [--minutes 3] [--pace 1200] [--hold 60]
 *   (--port 5190 and --no-window apply to both)
 *
 * replay: your own recent sessions in the project, and their subagents, happen
 *   again: each record is copied into the scratch Claude data folder when its
 *   turn comes, its timestamp moved to now, sped up, with idle gaps capped. The
 *   server reads them as it reads any running session it did not launch, so the
 *   reader under test is the real one; the only field touched here is each
 *   record's `timestamp`. A live idle process and its pid file stand in for
 *   Claude Code's, and go when the session's records run out.
 * stress: hook events through dry-run launches, shaped as smoke sends them:
 *   Masons working the project's own files, Knights, Wizards, Ravens, Scouts,
 *   a Herald now and then, passing and failing test runs, the odd thrash.
 *
 * The window is Edge or Chrome in app mode, with the app window's isolation
 * flags and a DevTools port on 127.0.0.1, through which the simulator points
 * it at the project, opens the Castle, and closes it when the run ends. The
 * work starts once the Castle is drawn. Without Edge or Chrome it says which
 * address to open and waits for the Castle there.
 */
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_FLAGS, findBrowser } from '../desktop/window.js';
import { claudeDataDir, projectSlug } from '../server/paths.js';
import { resolveConfigHome } from '../server/scan.js';
import { buildClientIfStale } from './build-if-stale.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** The page's remembered-folder key (client/App.jsx LAST_KEY): set, the page scans that folder on load. */
const LAST_DIR_KEY = 'claude-explorer.lastDir';

/** A minimal Chrome DevTools Protocol client over Node's own WebSocket: send a command, get its result. */
function devtools(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const waiting = new Map();
    let next = 0;
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      const w = waiting.get(msg.id);
      if (!w) return;
      waiting.delete(msg.id);
      if (msg.error) w.reject(new Error(msg.error.message));
      else w.resolve(msg.result);
    };
    ws.onerror = () => reject(new Error(`no DevTools connection at ${url}`));
    ws.onopen = () =>
      resolve({
        send: (method, params = {}, sessionId = undefined) =>
          new Promise((res, rej) => {
            const id = (next += 1);
            waiting.set(id, { resolve: res, reject: rej });
            ws.send(JSON.stringify({ id, method, params, sessionId }));
          }),
        close: () => ws.close(),
      });
  });
}

/**
 * Starts the scratch LayerCake and scans `project`. Returns what a workload
 * needs: `launch()` for a hook channel, `openWindow()`, and `stop()`.
 */
export async function startSim({ project, port = 5190 }) {
  // A private name for the scratch root: a cleanup guarded on a shared
  // variable such as TMP deletes the wrong tree (C:\dev\CLAUDE.md 3h).
  const simRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'layercake-sim-'));
  const claudeData = path.join(simRoot, 'claude');
  fs.mkdirSync(path.join(claudeData, 'projects'), { recursive: true });
  fs.mkdirSync(path.join(claudeData, 'sessions'), { recursive: true });
  await buildClientIfStale();
  const server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      LAYERCAKE_LAUNCH_DRY_RUN: '1',
      // Its sessions report on a port Windows picks (#200), beside a running LayerCake.
      LAYERCAKE_INGEST_PORT: '0',
      LAYERCAKE_APPDATA_DIR: path.join(simRoot, 'appdata'),
      LAYERCAKE_SNAPSHOT_DIR: path.join(simRoot, 'snapshots'),
      LAYERCAKE_CLAUDE_DATA_DIR: claudeData,
      // A configuration home and user folder of its own (#199): its window has
      // a DevTools port another signed-in user could reach, and nothing reached
      // through this server may write the real settings. The Castle needs
      // neither; replay copies the transcripts it reads into claudeData.
      CLAUDE_CONFIG_DIR: path.join(simRoot, 'config-home'),
      USERPROFILE: path.join(simRoot, 'home'),
      HOME: path.join(simRoot, 'home'),
    },
    stdio: 'ignore',
  });
  const children = [];
  let cdp = null;
  let windowProfile = null;
  const base = `http://127.0.0.1:${port}`;
  let html = null;
  for (let i = 0; i < 100 && html === null; i += 1) {
    if (server.exitCode !== null) break;
    try {
      html = await (await fetch(`${base}/`)).text();
    } catch {
      await sleep(200);
    }
  }
  if (html === null) {
    server.kill();
    throw new Error(`the scratch server did not answer on ${base} (is port ${port} in use? --port picks another)`);
  }
  // The page key (#189, #198): in the scratch server's run record, written once
  // it listens; never in its HTML.
  const token = JSON.parse(fs.readFileSync(path.join(simRoot, 'appdata', 'server.json'), 'utf8')).key;
  const H = { 'X-LayerCake-Token': token, 'Content-Type': 'application/json' };
  // The address a window opens at: the key in the fragment, as a launch does.
  const pageUrl = `${base}/#t=${token}`;
  const post = async (route, body) => {
    const res = await fetch(`${base}${route}`, { method: 'POST', headers: H, body: JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${route}: ${res.status} ${json.message || ''}`);
    return json;
  };
  const scan = await post('/api/scan', { dir: project });

  return {
    base,
    pageUrl,
    claudeData,
    project,
    /** A dry-run launch: a session id and its hook channel. Nothing starts. */
    async launch() {
      const l = await post('/api/launch', { scanId: scan.scanId });
      const settings = JSON.parse(fs.readFileSync(l.settingsPath, 'utf8'));
      const hookUrl = settings.hooks.PreToolUse[0].hooks[0].url;
      const statusUrl = hookUrl.replace(/\/hook$/, '/statusline');
      const send = (url, body) =>
        fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session_id: l.sessionId, cwd: project, ...body }) }).catch(() => null);
      return { sessionId: l.sessionId, settingsPath: l.settingsPath, hook: (body) => send(hookUrl, body), statusline: () => send(statusUrl, {}) };
    },
    /** A live idle process: the pid a transcript session's liveness rests on. */
    idleProcess() {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'ignore', windowsHide: true });
      children.push(child);
      return child;
    },
    /** Resolves once a page has the project's Castle open (its room route answers only then), or after `ms`. */
    async castleOpened(ms) {
      const until = Date.now() + ms;
      while (Date.now() < until) {
        const res = await fetch(`${base}/api/castle/room?scanId=${scan.scanId}&room=wilds`, { headers: H }).catch(() => null);
        if (res?.status === 200) return true;
        await sleep(1000);
      }
      return false;
    },
    /**
     * An app window on a profile of this run's own (on the real one, an open
     * LayerCake window would take it over, #59), with the app window's
     * isolation flags and a DevTools port, which is how the Castle gets
     * opened in it and how it is closed at the end. False with no Edge or Chrome.
     */
    async openWindow() {
      const browser = findBrowser();
      if (!browser) return false;
      const profile = path.join(simRoot, 'browser');
      spawn(browser.exe, [`--app=${pageUrl}`, `--user-data-dir=${profile}`, ...APP_FLAGS, '--remote-debugging-port=0'], { detached: true, stdio: 'ignore' }).unref();
      // Chromium writes the port, then the browser's WebSocket path.
      for (let i = 0; i < 100 && !cdp; i += 1) {
        try {
          const [devPort, wsPath] = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split(/\r?\n/);
          if (devPort && wsPath) cdp = await devtools(`ws://127.0.0.1:${devPort}${wsPath}`);
        } catch {
          await sleep(100);
        }
      }
      windowProfile = profile;
      return cdp ? `${browser.name} (app mode)` : false;
    },
    /** Points the window at the project and opens its Castle. True once the Castle is drawn. */
    async showCastle(ms = 30_000) {
      if (!cdp) return false;
      const until = Date.now() + ms;
      let sessionId = null;
      while (!sessionId && Date.now() < until) {
        const { targetInfos } = await cdp.send('Target.getTargets');
        const page = targetInfos.find((t) => t.type === 'page' && t.url.startsWith(base));
        if (page) ({ sessionId } = await cdp.send('Target.attachToTarget', { targetId: page.targetId, flatten: true }));
        else await sleep(250);
      }
      if (!sessionId) return false;
      const run = async (expression) => (await cdp.send('Runtime.evaluate', { expression, returnByValue: true }, sessionId))?.result?.value;
      await run(`localStorage.setItem(${JSON.stringify(LAST_DIR_KEY)}, ${JSON.stringify(project)}); location.reload(); true`).catch(() => null);
      while (Date.now() < until) {
        await sleep(500);
        // The reload scans the remembered folder; then the Castle tab.
        const got = await run(`(() => {
          if (document.querySelector('.castle-svg')) return 'open';
          const b = [...document.querySelectorAll('.modes button')].find((x) => x.textContent.trim() === 'Castle');
          if (b && !b.disabled) b.click();
          return 'waiting';
        })()`).catch(() => 'reloading');
        if (got === 'open') return true;
      }
      return false;
    },
    async stop() {
      if (cdp) {
        await cdp.send('Browser.close').catch(() => null);
        cdp.close();
        // Chromium removes the profile's lockfile when its browser ends.
        for (let i = 0; i < 100 && fs.existsSync(path.join(windowProfile, 'lockfile')); i += 1) await sleep(100);
      }
      for (const c of children) c.kill();
      server.kill();
      // The server may hold a file a moment after it is killed.
      fs.rmSync(simRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    },
  };
}

/* ------------------------------------------------------------------ replay */

/** The project's recent sessions in the real Claude data folder, newest first, skipping any written in the last 10 minutes (likely running). */
async function recentSessions(project, count) {
  await resolveConfigHome().catch(() => null);
  const dir = path.join(claudeDataDir(), 'projects', projectSlug(project));
  if (!fs.existsSync(dir)) throw new Error(`no Claude sessions for ${project} (looked in ${dir})`);
  return fs
    .readdirSync(dir)
    .filter((f) => /^[0-9a-f-]{36}\.jsonl$/.test(f))
    .map((f) => ({ id: f.slice(0, 36), file: path.join(dir, f), mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .filter((s) => Date.now() - s.mtime > 10 * 60_000)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, count)
    .map((s) => ({ ...s, subDir: path.join(dir, s.id, 'subagents') }));
}

/** Every line of a session and its subagents on one timeline, each with the time its record carries (or the one before it). */
function timelineOf(session) {
  const out = [];
  const add = (file, target) => {
    let last = null;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      const t = Date.parse(rec?.timestamp);
      if (Number.isFinite(t)) last = t;
      if (last !== null) out.push({ t: last, rec, target });
    }
  };
  add(session.file, { kind: 'main' });
  if (fs.existsSync(session.subDir)) {
    for (const f of fs.readdirSync(session.subDir)) {
      const m = /^(agent-[A-Za-z0-9]+)\.jsonl$/.exec(f);
      if (m) add(path.join(session.subDir, f), { kind: 'sub', name: m[1] });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

async function replay(sim, opts) {
  const sessions = await recentSessions(sim.project, opts.sessions);
  if (!sessions.length) throw new Error('no finished sessions to replay in that project');
  const slugDir = path.join(sim.claudeData, 'projects', projectSlug(sim.project));
  fs.mkdirSync(slugDir, { recursive: true });
  const endBy = Date.now() + opts.minutes * 60_000;
  const one = async (session, delay) => {
    await sleep(delay);
    const events = timelineOf(session);
    const start = Date.now();
    // Sim time: gaps capped at --max-gap, then divided by --speed.
    let v = 0;
    let prev = events[0]?.t ?? 0;
    const out = path.join(slugDir, `${session.id}.jsonl`);
    const subOut = path.join(slugDir, session.id, 'subagents');
    let child = null;
    let pidFile = null;
    let written = 0;
    for (const ev of events) {
      v += Math.min(ev.t - prev, opts.maxGap * 1000) / opts.speed;
      prev = ev.t;
      const at = start + v;
      if (at > endBy) break;
      if (at > Date.now()) await sleep(at - Date.now());
      if (ev.rec.timestamp) ev.rec.timestamp = new Date(at).toISOString();
      const line = `${JSON.stringify(ev.rec)}\n`;
      if (ev.target.kind === 'main') fs.appendFileSync(out, line);
      else {
        fs.mkdirSync(subOut, { recursive: true });
        const file = path.join(subOut, `${ev.target.name}.jsonl`);
        if (!fs.existsSync(file)) {
          const meta = path.join(session.subDir, `${ev.target.name}.meta.json`);
          if (fs.existsSync(meta)) fs.copyFileSync(meta, path.join(subOut, `${ev.target.name}.meta.json`));
        }
        fs.appendFileSync(file, line);
      }
      written += 1;
      // Running from its first record: a pid file whose process is alive.
      if (!child && fs.existsSync(out)) {
        child = sim.idleProcess();
        pidFile = path.join(sim.claudeData, 'sessions', `${child.pid}.json`);
        fs.writeFileSync(pidFile, JSON.stringify({ pid: child.pid, sessionId: session.id, cwd: sim.project, status: 'busy', kind: 'interactive' }));
      }
    }
    if (child) child.kill();
    if (pidFile) fs.rmSync(pidFile, { force: true });
    return { id: session.id, records: written, of: events.length };
  };
  console.log(`replaying ${sessions.length} session(s) at ${opts.speed}x, gaps capped at ${opts.maxGap} s, for up to ${opts.minutes} min`);
  const results = await Promise.all(sessions.map((s, i) => one(s, i * 4000)));
  for (const r of results) console.log(`  ${r.id}: ${r.records} of ${r.of} records replayed`);
}

/* ------------------------------------------------------------------ stress */

function projectFiles(project) {
  const git = spawnSync('git', ['-C', project, 'ls-files'], { encoding: 'utf8' });
  const rel = git.status === 0 ? git.stdout.split('\n').filter(Boolean) : [];
  if (!rel.length) throw new Error(`stress needs the project's files from git ls-files, and ${project} gave none`);
  return rel.map((r) => path.join(project, r));
}

async function stress(sim, opts) {
  const files = projectFiles(sim.project);
  const pick = (list) => list[Math.floor(Math.random() * list.length)];
  const between = (lo, hi) => lo + Math.random() * (hi - lo);
  const endBy = Date.now() + opts.minutes * 60_000;
  let n = 0;
  const id = () => `toolu_sim_${String((n += 1)).padStart(6, '0')}`;
  const counts = {};
  const count = (k) => (counts[k] = (counts[k] || 0) + 1);

  const call = async (s, tool, input, { agent = null, ms = between(200, 1500), fail = null, response = {} } = {}) => {
    const who = agent ? { agent_id: agent, agent_type: 'general-purpose' } : {};
    const tid = id();
    await s.hook({ hook_event_name: 'PreToolUse', tool_name: tool, tool_use_id: tid, tool_input: input, ...who });
    await sleep(ms);
    if (fail) await s.hook({ hook_event_name: 'PostToolUseFailure', tool_name: tool, tool_use_id: tid, tool_input: input, error: fail, ...who });
    else await s.hook({ hook_event_name: 'PostToolUse', tool_name: tool, tool_use_id: tid, tool_input: input, tool_response: response, ...who });
  };
  const work = async (s, agent) => {
    const r = Math.random();
    const file = pick(files);
    if (r < 0.4) return count('read'), call(s, 'Read', { file_path: file }, { agent });
    if (r < 0.5) return count('search'), call(s, 'Grep', { pattern: 'castle', path: path.dirname(file) }, { agent });
    if (r < 0.7) return count('edit'), call(s, 'Edit', { file_path: file, old_string: 'a', new_string: 'b' }, { agent, response: { filePath: file } });
    if (r < 0.72) return count('failed edit'), call(s, 'Edit', { file_path: file, old_string: 'a', new_string: 'b' }, { agent, fail: 'EACCES: permission denied' });
    if (agent) return count('read'), call(s, 'Read', { file_path: file }, { agent });
    if (r < 0.78) {
      // A test run: a pass most of the time, by its exit code.
      const failed = Math.random() < 0.15;
      count(failed ? 'failed test run' : 'passing test run');
      return call(s, 'Bash', { command: 'npm run smoke', description: 'Run smoke' }, { ms: between(3000, 8000), fail: failed ? 'Exit code 1\nsmoke: 1 failed' : null, response: { stdout: 'passed', stderr: '' } });
    }
    if (r < 0.82) return count('Wizard'), call(s, 'Skill', { skill: pick(['simplify', 'code-review', 'castle-demo']) });
    if (r < 0.88) return count('Raven'), call(s, pick(['mcp__sim__lookup', 'mcp__sim__search']), { q: 'castle' }, { ms: between(2000, 4000) });
    if (r < 0.93) return count('Scout'), call(s, 'WebFetch', { url: 'https://example.com/', prompt: 'title' }, { ms: between(2000, 4000) });
    if (r < 0.96) {
      count('Herald');
      await s.hook({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' });
      return sleep(between(3000, 6000));
    }
    // Thrash: one file edited four times running.
    count('thrash');
    for (let i = 0; i < 4; i += 1) await call(s, 'Edit', { file_path: file, old_string: 'a', new_string: 'b' }, { response: { filePath: file }, ms: 300 });
  };

  const knight = async (s) => {
    const agent = `a${crypto.randomBytes(8).toString('hex')}`;
    count('Knight');
    await s.hook({ hook_event_name: 'SubagentStart', agent_id: agent, agent_type: 'general-purpose' });
    const calls = Math.round(between(5, 15));
    for (let i = 0; i < calls && Date.now() < endBy; i += 1) {
      await work(s, agent);
      await sleep(between(opts.pace * 0.5, opts.pace * 1.5));
    }
    await s.hook({ hook_event_name: 'SubagentStop', agent_id: agent, agent_type: 'general-purpose' });
  };

  const session = async (i) => {
    await sleep(i * 3000);
    const s = await sim.launch();
    await s.statusline();
    const keep = setInterval(() => s.statusline(), 10_000);
    const knights = new Set();
    let actions = 0;
    await s.hook({ hook_event_name: 'UserPromptSubmit', prompt: 'simulated' });
    while (Date.now() < endBy) {
      if (knights.size < opts.knights && Math.random() < 0.15) {
        const k = knight(s).finally(() => knights.delete(k));
        knights.add(k);
      }
      await work(s, null);
      actions += 1;
      // A turn ends now and then: Wizards go, the Mason rests a moment.
      if (actions % 20 === 0) {
        await s.hook({ hook_event_name: 'Stop' });
        await sleep(between(2000, 5000));
        await s.hook({ hook_event_name: 'UserPromptSubmit', prompt: 'simulated' });
      }
      await sleep(between(opts.pace * 0.5, opts.pace * 1.5));
    }
    await Promise.all(knights);
    clearInterval(keep);
    await s.hook({ hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' });
  };
  console.log(`stress: ${opts.sessions} session(s), up to ${opts.knights} Knight(s) each, a call every ${opts.pace} ms or so, for ${opts.minutes} min`);
  await Promise.all(Array.from({ length: opts.sessions }, (_, i) => session(i)));
  console.log(`  sent: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')}`);
}

/* ------------------------------------------------------------------ main */

function parseArgs(argv) {
  const [mode, ...rest] = argv;
  const opts = { mode, project: ROOT, port: 5190, sessions: 3, speed: 10, maxGap: 20, minutes: mode === 'stress' ? 3 : 5, knights: 3, pace: 1200, hold: mode === 'stress' ? 60 : 120, window: true };
  for (let i = 0; i < rest.length; i += 1) {
    const key = rest[i].replace(/^--/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (key === 'noWindow') opts.window = false;
    else if (key === 'project') opts.project = path.resolve(rest[(i += 1)]);
    else if (key in opts && typeof opts[key] === 'number') opts[key] = Number(rest[(i += 1)]);
    else throw new Error(`unknown option ${rest[i]}`);
  }
  if (!['replay', 'stress'].includes(mode)) throw new Error('usage: castle-sim.mjs replay|stress [options] (see the comment at the top)');
  for (const k of ['sessions', 'speed', 'maxGap', 'minutes', 'knights', 'pace', 'hold', 'port']) {
    if (!Number.isFinite(opts[k]) || opts[k] < 0) throw new Error(`--${k} must be a number of 0 or more`);
  }
  return opts;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let sim = null;
  const finish = async (code) => {
    if (sim) await sim.stop().catch(() => null);
    process.exit(code);
  };
  process.on('SIGINT', () => finish(130));
  try {
    const opts = parseArgs(process.argv.slice(2));
    sim = await startSim({ project: opts.project, port: opts.port });
    console.log(`scratch LayerCake at ${sim.base} (project ${opts.project})`);
    if (opts.window) {
      const opened = await sim.openWindow();
      if (opened && (await sim.showCastle())) console.log(`window: ${opened}, Castle open.`);
      else {
        // No browser to drive, or the page did not get there: say what to do,
        // and start once the Castle is on screen so none of the work is missed.
        console.log(`open ${sim.base}, enter ${opts.project}, Scan, then Castle; waiting up to 5 minutes...`);
        console.log((await sim.castleOpened(5 * 60_000)) ? 'Castle open.' : 'Castle not opened; starting anyway.');
      }
    }
    if (opts.mode === 'replay') await replay(sim, opts);
    else await stress(sim, opts);
    console.log(`done; holding for ${opts.hold} s, then the window closes (Ctrl+C ends it sooner)`);
    await sleep(opts.hold * 1000);
    await finish(0);
  } catch (err) {
    console.error(err.message);
    await finish(1);
  }
}
