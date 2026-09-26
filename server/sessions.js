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
 * Full models held in memory. The session list reads every transcript, so this
 * must exceed the number of sessions on disk or each listing re-parses the
 * evicted ones. Measured 2026-09-26: 44 sessions, 117 MB of transcript, parse
 * all in about 0.5 s; the models keep prompt and reply text, not tool I/O.
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
 * Sessions with a running process. A pid file whose process is gone is
 * dropped: Claude Code does not always remove it after a crash.
 */
export async function liveSessions() {
  const dir = path.join(claudeDataDir(), 'sessions');
  const out = [];
  for (const entry of await listDir(dir)) {
    if (!entry.isFile() || !LIVE_FILE_RE.test(entry.name)) continue;
    const result = await readForDisplay(path.join(dir, entry.name));
    const j = result.parsed;
    if (!j || !SESSION_ID_RE.test(String(j.sessionId || ''))) continue;
    if (!isAlive(j.pid)) continue;
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
