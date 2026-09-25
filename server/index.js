/**
 * LayerCake server. Localhost only, no outbound network.
 *
 * Security posture:
 *  - Binds 127.0.0.1. Never 0.0.0.0.
 *  - /api/file and /api/write only touch a path that a prior scan discovered.
 *    The scan result is the allowlist, so neither is a general purpose file
 *    reader or writer even though scan input is a directory the user typed.
 *  - Credential files are excluded at scan time and refused again at read and
 *    write time.
 *  - Every /api route requires the per-start session token, which is served
 *    only inside our own HTML. See security.js for why writes made that
 *    necessary when reads did not.
 *  - Every write is preceded by an automatic snapshot and lands atomically.
 */

import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveLineage } from './scan.js';
import { flatten } from './flatten.js';
import { readForDisplay } from './readfile.js';
import { editFile } from './writefile.js';
import { DEBOUNCE_MS, watchLineage } from './watch.js';
import {
  compareSnapshot,
  createSnapshot,
  listSnapshots,
  readManifest,
  readSnapshotFile,
  restoreFiles,
} from './snapshot.js';
import { isSecret, describeError, writePolicy } from './safety.js';
import { injectToken, originGuard, requireToken } from './security.js';
import {
  CLAUDE_DIR_FILE_TARGETS,
  CLAUDE_DIR_TREES,
  DIR_FILE_TARGETS,
  homeDir,
  managedCandidates,
  snapshotRoot,
} from './paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PORT = Number(process.env.PORT || 5178);
const HOST = '127.0.0.1';

/** scanId -> { lineage, allowed:Map<string,entry>, createdAt } . Bounded to MAX_SCANS. */
const scans = new Map();
const MAX_SCANS = 8;
let scanSeq = 0;

/**
 * Open /api/watch streams, so an evicted scan can take its watchers with it.
 * Bounded because each stream holds a directory handle per watched directory,
 * and a tab that never closes should not be able to accumulate them.
 */
const watchStreams = new Set();
const MAX_WATCH_STREAMS = 4;
const WATCH_KEEPALIVE_MS = 30000;

function closeStreamsFor(scanId) {
  for (const stream of [...watchStreams]) {
    if (stream.scanId === scanId) stream.close();
  }
}

/** Windows paths are case insensitive, so allowlist lookups are normalized. */
function allowKey(p) {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function registerScan(lineage) {
  scanSeq += 1;
  const scanId = `scan-${scanSeq}`;
  // The full entry is kept, not just the path: a write takes its category from
  // the scan result, so a request cannot relabel a hook as a note to dodge the
  // executable-content acknowledgement.
  const allowed = new Map();
  for (const level of lineage.levels) {
    for (const entry of level.entries) {
      if (entry.type === 'file') allowed.set(allowKey(entry.absPath), entry);
    }
  }
  scans.set(scanId, { lineage, allowed, createdAt: Date.now() });
  while (scans.size > MAX_SCANS) {
    const oldest = [...scans.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
    scans.delete(oldest[0]);
    // The watcher holds its own reference to the lineage, so it would happily
    // keep reporting changes for a scan the API can no longer resolve. Close it
    // with the scan rather than leaving orphaned directory handles behind.
    closeStreamsFor(oldest[0]);
  }
  return scanId;
}

const app = express();
// Must clear MAX_WRITE_BYTES with room for JSON escaping, or a write inside the
// documented 2 MB cap would be rejected by the body parser instead.
app.use(express.json({ limit: '8mb' }));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  // The served HTML carries the session token. A cross-origin page cannot read
  // a response it did not get CORS permission for, and cannot read a frame's
  // document across origins, but there is no reason to be framed at all.
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
  next();
});

// Both guards are scoped to /api, and deliberately NOT to the HTML routes.
//
// A top-level navigation carries Sec-Fetch-Site: cross-site whenever the user
// arrives from anywhere that is not this origin, including a bookmark, a link,
// or Chrome's new tab page. Refusing those refuses the app itself, which is
// exactly what happened the first time this was wired up.
//
// Leaving the HTML open costs nothing: a hostile page can cause a navigation
// but cannot read the result, so it cannot lift the token out of the markup.
// The token is what actually gates every state-changing route.
app.use('/api', originGuard(PORT));
app.use('/api', requireToken);

/** The scan manifest, so the UI can show exactly what will be probed. */
app.get('/api/manifest', (req, res) => {
  res.json({
    platform: process.platform,
    home: homeDir(),
    directoryTargets: DIR_FILE_TARGETS.map((t) => t.name),
    claudeDirFiles: CLAUDE_DIR_FILE_TARGETS.map((t) => t.name),
    claudeDirTrees: CLAUDE_DIR_TREES.map((t) => ({
      name: t.name,
      maxDepth: t.maxDepth,
      extensions: t.exts,
    })),
    managedCandidates: managedCandidates(),
    homeExtras: [
      path.join(homeDir(), '.claude.json'),
      path.join(homeDir(), 'CLAUDE.md'),
      path.join(homeDir(), '.claude', 'plugins'),
    ],
    neverRead: writePolicy().neverWritten,
    // Stated rather than implied, so the UI can show the write policy instead of
    // the user discovering it from a 403. Derived from the guards themselves.
    write: {
      ...writePolicy(),
      snapshotRoot: snapshotRoot(),
      rules: [
        'Only files discovered by the current scan can be written.',
        'Every write is preceded by an automatic snapshot and lands via temp file plus rename.',
        'Invalid JSON or YAML is refused; malformed markdown frontmatter is a warning only.',
        'Claude Code loads memory and settings at session start, so a running session is unaffected until restart.',
      ],
    },
  });
});

/** Directory existence check, used by the input field before a scan. */
app.get('/api/validate', async (req, res) => {
  const dir = String(req.query.dir || '');
  if (!dir.trim()) return res.status(400).json({ ok: false, message: 'No directory supplied' });
  try {
    const st = await fs.stat(path.resolve(dir));
    if (!st.isDirectory()) return res.json({ ok: false, message: 'Path exists but is not a directory' });
    return res.json({ ok: true, resolved: path.resolve(dir) });
  } catch (err) {
    const described = describeError(err);
    return res.json({ ok: false, message: described.message, code: described.code });
  }
});

app.post('/api/scan', async (req, res) => {
  const dir = String(req.body?.dir || '').trim();
  if (!dir) return res.status(400).json({ message: 'dir is required' });
  try {
    const lineage = await resolveLineage(dir);
    const scanId = registerScan(lineage);
    res.json({ scanId, ...lineage });
  } catch (err) {
    res.status(500).json({ message: err.message, ...describeError(err) });
  }
});

app.get('/api/file', async (req, res) => {
  const scanId = String(req.query.scanId || '');
  const target = String(req.query.path || '');
  const scan = scans.get(scanId);
  if (!scan) return res.status(404).json({ message: 'Unknown or expired scan. Re-scan the directory.' });
  if (!target) return res.status(400).json({ message: 'path is required' });
  if (!scan.allowed.has(allowKey(target))) {
    return res.status(403).json({
      message: 'Path is not part of this scan result. Only files discovered by the scan can be opened.',
    });
  }
  if (isSecret(target)) {
    return res.status(403).json({ message: 'Credential file. Never read by this tool.' });
  }
  const result = await readForDisplay(path.resolve(target));
  res.json(result);
});

app.get('/api/flatten', async (req, res) => {
  const scanId = String(req.query.scanId || '');
  const kind = String(req.query.kind || 'claude-md');
  const scan = scans.get(scanId);
  if (!scan) return res.status(404).json({ message: 'Unknown or expired scan. Re-scan the directory.' });
  try {
    const result = await flatten(scan.lineage, kind);
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
});

/**
 * Live filesystem events for a scan, as Server-Sent Events.
 *
 * The payload is paths and verbs only, never file content. Reading a body still
 * goes through /api/file and its allowlist check, so this route cannot be used
 * to sidestep it: the most it can tell you is that something in a directory the
 * scan already reported has moved.
 *
 * The client reads this with fetch plus a stream reader rather than EventSource,
 * because EventSource cannot set a request header and the session token is not
 * going in a query string where it would land in logs and history. That is also
 * why the wire format is hand-written rather than delegated to a library: it is
 * eight lines of text framing, and the consumer is ours.
 */
app.get('/api/watch', (req, res) => {
  const scanId = String(req.query.scanId || '');
  const scan = scans.get(scanId);
  if (!scan) {
    return res.status(404).json({ message: 'Unknown or expired scan. Re-scan the directory.' });
  }
  if (watchStreams.size >= MAX_WATCH_STREAMS) {
    return res.status(429).json({
      message: `Already watching on ${MAX_WATCH_STREAMS} connections. Close another LayerCake tab.`,
    });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
  });
  // Without this the first event can sit in Node's buffer until enough bytes
  // accumulate, which on a quiet filesystem is never.
  res.flushHeaders();

  const send = (event, payload) => {
    if (res.writableEnded) return false;
    return res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  };

  const watcher = watchLineage(scan.lineage, (changes) => {
    send('change', { changes, at: new Date().toISOString() });
  });

  // Says what is covered AND what is not. A UI that claims to be watching while
  // silently skipping a network ancestor is worse than one that does not watch
  // at all, because it converts "no events" into false reassurance.
  send('ready', {
    scanId,
    watchedCount: watcher.watchedCount,
    skipped: watcher.skipped,
    errors: watcher.errors,
    debounceMs: DEBOUNCE_MS,
  });

  // A comment line costs two bytes and proves the socket is still alive, which
  // is how the client distinguishes "nothing has changed" from "the server went
  // away". Without it a dead server looks exactly like a quiet filesystem.
  const keepalive = setInterval(() => {
    if (!res.writableEnded) res.write(': keepalive\n\n');
  }, WATCH_KEEPALIVE_MS);

  const stream = {
    scanId,
    closed: false,
    close() {
      if (this.closed) return;
      this.closed = true;
      clearInterval(keepalive);
      watcher.close();
      watchStreams.delete(this);
      if (!res.writableEnded) res.end();
    },
  };
  watchStreams.add(stream);

  // Covers the tab closing, a reload, and the fetch being aborted by the client
  // when it re-scans. All three arrive here as a closed request.
  req.on('close', () => stream.close());
  return undefined;
});

/** Resolves a scan plus one of its entries, or throws an HTTP-shaped error. */
function requireEntry(scanId, target) {
  const scan = scans.get(scanId);
  if (!scan) {
    const err = new Error('Unknown or expired scan. Re-scan the directory.');
    err.status = 404;
    throw err;
  }
  const entry = scan.allowed.get(allowKey(target));
  if (!entry) {
    const err = new Error('Path is not part of this scan result.');
    err.status = 403;
    throw err;
  }
  return { scan, entry };
}

function sendError(res, err) {
  res.status(err.status || 500).json({ message: err.message, code: err.code || null });
}

app.post('/api/write', async (req, res) => {
  const { scanId, path: target, content, expectedMtime, acknowledgeExecutable } = req.body || {};
  if (typeof content !== 'string') {
    return res.status(400).json({ message: 'content must be a string' });
  }
  try {
    const { scan, entry } = requireEntry(String(scanId || ''), String(target || ''));
    const result = await editFile({
      entry,
      content,
      lineage: scan.lineage,
      expectedMtime: expectedMtime || null,
      acknowledgeExecutable: Boolean(acknowledgeExecutable),
    });
    return res.json(result);
  } catch (err) {
    return sendError(res, err);
  }
});

app.post('/api/snapshot', async (req, res) => {
  const scan = scans.get(String(req.body?.scanId || ''));
  if (!scan) return res.status(404).json({ message: 'Unknown or expired scan. Re-scan first.' });
  try {
    const manifest = await createSnapshot(scan.lineage, {
      label: String(req.body?.label || '').slice(0, 200),
    });
    return res.json(manifest);
  } catch (err) {
    return sendError(res, err);
  }
});

app.get('/api/snapshots', async (req, res) => {
  try {
    return res.json({ root: snapshotRoot(), snapshots: await listSnapshots() });
  } catch (err) {
    return sendError(res, err);
  }
});

app.get('/api/snapshot/:id', async (req, res) => {
  try {
    return res.json(await readManifest(req.params.id));
  } catch (err) {
    return sendError(res, err);
  }
});

app.get('/api/snapshot/:id/compare', async (req, res) => {
  try {
    return res.json(await compareSnapshot(req.params.id));
  } catch (err) {
    return sendError(res, err);
  }
});

app.get('/api/snapshot/:id/file', async (req, res) => {
  try {
    return res.json(await readSnapshotFile(req.params.id, String(req.query.path || '')));
  } catch (err) {
    return sendError(res, err);
  }
});

app.post('/api/restore', async (req, res) => {
  const { scanId, id, paths } = req.body || {};
  if (!Array.isArray(paths) || paths.length === 0) {
    return res.status(400).json({ message: 'paths must be a non-empty array' });
  }
  const scan = scans.get(String(scanId || ''));
  if (!scan) return res.status(404).json({ message: 'Unknown or expired scan. Re-scan first.' });
  try {
    // Restore targets must still be in the current scan. Without this, a stale
    // snapshot could write to a path the current scan never validated.
    for (const p of paths) requireEntry(String(scanId), String(p));
    return res.json(await restoreFiles(String(id || ''), paths.map(String), scan.lineage));
  } catch (err) {
    return sendError(res, err);
  }
});

// index:false so every HTML response goes through the token injector below.
// Assets are served normally; only the shell carries the secret.
app.use(express.static(PUBLIC_DIR, { index: false }));

app.get('*', async (req, res) => {
  try {
    const html = await fs.readFile(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
    res.type('html').set('Cache-Control', 'no-store').send(injectToken(html));
  } catch {
    res
      .status(503)
      .type('text')
      .send('Client bundle missing. Run "npm run build" (or use "npm start", which builds first).');
  }
});

const server = app.listen(PORT, HOST, () => {
  process.stdout.write(`\nLayerCake  ->  http://${HOST}:${PORT}\n`);
  process.stdout.write(`Home: ${homeDir()}  Platform: ${process.platform}\n`);
  process.stdout.write(`Snapshots: ${snapshotRoot()}\n\n`);
});

// A busy port is an ordinary condition, usually a previous instance still
// running. Say what to do about it instead of dumping a stack trace.
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    process.stderr.write(
      `\nPort ${PORT} is already in use, most likely by an earlier LayerCake.\n\n` +
        `  Open the running one:   http://${HOST}:${PORT}\n` +
        `  Or free the port:       Stop-Process -Id (Get-NetTCPConnection -LocalPort ${PORT} -State Listen).OwningProcess -Force\n` +
        `  Or use another port:    $env:PORT = 5200; npm start\n\n`
    );
  } else if (err.code === 'EACCES') {
    process.stderr.write(
      `\nNot allowed to bind port ${PORT}. Pick a port above 1024: $env:PORT = 5200; npm start\n\n`
    );
  } else {
    process.stderr.write(`\nCould not start the server: ${err.message}\n\n`);
  }
  process.exit(1);
});
