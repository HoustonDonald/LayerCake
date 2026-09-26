/**
 * Session discovery: which Claude Code sessions exist on disk, which are
 * running, and a reader for each. The discovered set is the allowlist for every
 * /api/session route, the same way a scan result is for /api/file: a session id
 * that discovery did not produce is refused, and no path is ever built from a
 * request beyond looking an id up here.
 *
 * Read-only. Running sessions come from <claudeDataDir>/sessions/<pid>.json,
 * which Claude Code rewrites while it runs (undocumented, observed in 2.1.282).
 * Only files named <digits>.json are opened: each has a sibling .key file,
 * which is a secret and is never read.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import { claudeDataDir } from './paths.js';
import { readForDisplay } from './readfile.js';
import { DIR_TIMEOUT_MS, withTimeout } from './safety.js';
import { TranscriptReader } from './transcript.js';

export const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LIVE_FILE_RE = /^\d+\.json$/;
const AGENT_ID_RE = /^a[0-9a-f]{16}$/;

/** Claude Code's default when cleanupPeriodDays is unset. */
export const DEFAULT_RETENTION_DAYS = 30;

/** Re-listing the projects tree is cheap, but not free on every poll. */
const DISCOVERY_TTL_MS = 2000;
/**
 * Full models held in memory. The session list reads every transcript in
 * order, so past this many sessions an LRU cache hits nothing and every
 * listing re-parses all of them. Measured 2026-09-26: 44 sessions, 117 MB of
 * transcript, parse all in about 0.5 s; the models keep prompt and reply text,
 * not tool I/O.
 */
const MAX_READERS = 256;

let discovered = new Map();
let discoveredAt = 0;
const readers = new Map();

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

async function listDir(dir) {
  try {
    return await withTimeout(fs.readdir(dir, { withFileTypes: true }), DIR_TIMEOUT_MS, dir);
  } catch {
    return [];
  }
}

/**
 * Every transcript on disk: sessionId -> { sessionId, file, projectFolder,
 * size, mtimeMs }. Main transcripts only; subagent files live one level down
 * and are reached through their parent.
 */
export async function discoverSessions({ force = false } = {}) {
  if (!force && Date.now() - discoveredAt < DISCOVERY_TTL_MS) return discovered;
  const root = path.join(claudeDataDir(), 'projects');
  const next = new Map();
  for (const folder of await listDir(root)) {
    if (!folder.isDirectory()) continue;
    const dir = path.join(root, folder.name);
    for (const entry of await listDir(dir)) {
      const m = /^(.+)\.jsonl$/.exec(entry.name);
      if (!entry.isFile() || !m || !SESSION_ID_RE.test(m[1])) continue;
      const file = path.join(dir, entry.name);
      try {
        const st = await withTimeout(fs.stat(file), DIR_TIMEOUT_MS, file);
        next.set(m[1], { sessionId: m[1], file, projectFolder: folder.name, size: st.size, mtimeMs: st.mtimeMs });
      } catch {
        /* vanished between readdir and stat: Claude Code's cleanup, most likely */
      }
    }
  }
  discovered = next;
  discoveredAt = Date.now();
  return discovered;
}

/** True when a process with this pid exists. EPERM means it exists but is not ours. */
function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/**
 * PID reuse (#1). A crashed session can leave its pid file behind, and Windows
 * reuses pids, so "a process with this pid exists" can be an unrelated
 * process. The pid file carries procStart: the process creation time as a UTC
 * FILETIME (measured: equal to Get-Process StartTime.ToFileTimeUtc() to the
 * 100 ns tick for a running session). A process whose creation time differs
 * is not the session. The image name cannot decide it: a running session was
 * seen as "claude.exe.old.<n>" after Claude Code updated its own binary.
 *
 * Node cannot read another process's creation time, so this asks PowerShell,
 * once for all pids that need it: a fixed argv from its absolute System32
 * path, pids validated as integers, 5 s timeout, output parsed as numbers
 * only. A new spawn site, stated in CLAUDE.md. Results are cached per pid and
 * procStart for START_CHECK_TTL_MS: only a pid seen for the first time waits
 * for the query; a stale entry is refreshed in the background. A pid the query
 * could not read (another user's process, or gone) falls back to isAlive.
 */
const START_CHECK_TTL_MS = 60_000;
const START_QUERY_TIMEOUT_MS = 5000;
const startChecks = new Map(); // pid -> { procStart, match: boolean | null, at }
let startQuery = null;

function queryStartTimes(pids) {
  const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const ids = pids.filter((p) => Number.isInteger(p) && p > 0).join(',');
  const script = `Get-Process -Id ${ids} -ErrorAction SilentlyContinue | ForEach-Object { try { '{0} {1}' -f $_.Id, $_.StartTime.ToFileTimeUtc() } catch {} }`;
  return new Promise((resolve) => {
    execFile(ps, ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: START_QUERY_TIMEOUT_MS, windowsHide: true }, (_err, stdout) => {
      const out = new Map();
      for (const line of String(stdout || '').split(/\r?\n/)) {
        const m = /^(\d+) (\d+)$/.exec(line.trim());
        if (m) out.set(Number(m[1]), m[2]);
      }
      resolve(out); // a failed or timed-out query reads as "unknown", never as "dead"
    });
  });
}

async function refreshStartChecks(entries) {
  if (!entries.length) return;
  const run = queryStartTimes(entries.map((e) => e.pid)).then((times) => {
    const at = Date.now();
    for (const e of entries) {
      const live = times.get(e.pid);
      startChecks.set(e.pid, { procStart: e.procStart, match: live === undefined ? null : live === e.procStart, at });
    }
  });
  startQuery = run.finally(() => {
    if (startQuery === run) startQuery = null;
  });
  return run;
}

/** False only when the running process provably is not the one that wrote the pid file. */
async function sameProcess(candidates) {
  if (process.platform !== 'win32') return () => true;
  const now = Date.now();
  const missing = [];
  const stale = [];
  for (const c of candidates) {
    const known = startChecks.get(c.pid);
    if (!known || known.procStart !== c.procStart) missing.push(c);
    else if (now - known.at > START_CHECK_TTL_MS) stale.push(c);
  }
  if (missing.length) await refreshStartChecks([...missing, ...stale]);
  else if (stale.length && !startQuery) refreshStartChecks(stale); // background, stale values meanwhile
  return (c) => startChecks.get(c.pid)?.match !== false;
}

/**
 * Sessions with a running process. A pid file whose process is gone is
 * dropped: Claude Code does not always remove it after a crash.
 */
export async function liveSessions() {
  const dir = path.join(claudeDataDir(), 'sessions');
  const found = [];
  for (const entry of await listDir(dir)) {
    if (!entry.isFile() || !LIVE_FILE_RE.test(entry.name)) continue;
    const result = await readForDisplay(path.join(dir, entry.name));
    const j = result.parsed;
    if (!j || !SESSION_ID_RE.test(String(j.sessionId || ''))) continue;
    if (!isAlive(j.pid)) continue;
    found.push(j);
  }
  // Only files that carry a procStart can be checked; older ones keep isAlive.
  const checkable = found.filter((j) => typeof j.procStart === 'string' && /^\d+$/.test(j.procStart)).map((j) => ({ pid: j.pid, procStart: j.procStart }));
  const same = await sameProcess(checkable);
  const out = [];
  for (const j of found) {
    if (typeof j.procStart === 'string' && /^\d+$/.test(j.procStart) && !same({ pid: j.pid, procStart: j.procStart })) continue;
    out.push({
      pid: j.pid,
      sessionId: j.sessionId,
      cwd: j.cwd || null,
      status: j.status || null,
      kind: j.kind || null,
      entrypoint: j.entrypoint || null,
      version: j.version || null,
      name: j.name || null,
      startedAt: j.startedAt || null,
      updatedAt: j.statusUpdatedAt || j.updatedAt || null,
    });
  }
  return out;
}

/** cleanupPeriodDays from the user settings, which is where Claude Code reads it. */
export async function retentionDays() {
  const result = await readForDisplay(path.join(claudeDataDir(), 'settings.json'));
  const value = result.parsed?.cleanupPeriodDays;
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_RETENTION_DAYS;
}

/**
 * The reader for a discovered session, brought up to date. Throws an
 * HTTP-shaped error for an id discovery does not know.
 */
export async function getReader(sessionId) {
  if (!SESSION_ID_RE.test(String(sessionId || ''))) throw httpError(400, 'Not a session id.');
  let found = (await discoverSessions()).get(sessionId);
  if (!found) found = (await discoverSessions({ force: true })).get(sessionId);
  if (!found) throw httpError(404, 'Unknown session, or its transcript has been cleaned up.');

  let reader = readers.get(sessionId);
  if (!reader || reader.file !== found.file) reader = new TranscriptReader(sessionId, found.file);
  // Map order is insertion order: re-inserting marks it most recently used.
  readers.delete(sessionId);
  readers.set(sessionId, reader);
  while (readers.size > MAX_READERS) readers.delete(readers.keys().next().value);

  await reader.refresh();
  return reader;
}

/**
 * Last write time of each subagent's own transcript, so the UI can tell a
 * subagent that is working from one that is quiet. Stat only; the agent id
 * comes from the parent transcript and is pattern-checked before it becomes
 * part of a path.
 */
export async function subagentActivity(reader) {
  const dir = path.join(path.dirname(reader.file), reader.sessionId, 'subagents');
  const out = {};
  for (const sub of reader.model.subagents) {
    if (!sub.agentId || !AGENT_ID_RE.test(sub.agentId)) continue;
    const file = path.join(dir, `agent-${sub.agentId}.jsonl`);
    try {
      const st = await withTimeout(fs.stat(file), DIR_TIMEOUT_MS, file);
      out[sub.agentId] = { lastWriteAt: new Date(st.mtimeMs).toISOString(), bytes: st.size };
    } catch {
      /* not written yet, or already cleaned up */
    }
  }
  return out;
}
