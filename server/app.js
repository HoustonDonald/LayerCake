/**
 * LayerCake server. Localhost only, no outbound network.
 *
 * Security posture:
 *  - Binds 127.0.0.1. Never 0.0.0.0.
 *  - Answers only to its own Host header, on every route, so a DNS rebinding
 *    page cannot read the HTML and the token in it as same-origin.
 *  - /api/file, /api/write and /api/delete only touch a path that a prior scan
 *    discovered. The scan result is the allowlist, so none is a general purpose
 *    file reader or writer even though scan input is a directory the user typed.
 *    /api/create takes an option the scan offered, never a path (#15).
 *  - Credential files are excluded at scan time and refused again at read and
 *    write time.
 *  - Every /api route requires the per-start session token, which is served
 *    only inside our own HTML. See security.js for why writes made that
 *    necessary when reads did not.
 *  - Every edit, delete and restore is preceded by an automatic snapshot, and
 *    edits land atomically. A create never replaces a file, so it takes none.
 *
 * This module builds the app and never listens on import. Two entries use it:
 * server/index.js serves the client from public/ on disk (npm start, the
 * launcher, the smoke test), and desktop/main.js serves it from assets embedded
 * in the single executable. The routes, guards and allowlist are this one
 * function in both; only where the static files come from differs.
 */

import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';

import { resolveLineage } from './scan.js';
import { flatten } from './flatten.js';
import { readForDisplay } from './readfile.js';
import {
  NOT_RESTORABLE,
  createFile,
  createOptions,
  deleteFile,
  editFile,
  restorableWhenAbsent,
  restoreSnapshotFiles,
} from './writefile.js';
import { DEBOUNCE_MS, watchLineage } from './watch.js';
import {
  RETENTION_DAYS,
  compareSnapshot,
  createSnapshot,
  listSnapshots,
  readManifest,
  readSnapshotFile,
} from './snapshot.js';
import { MAX_FILE_BYTES, isSecret, describeError, writePolicy } from './safety.js';
import { hostGuard, injectToken, originGuard, requireToken } from './security.js';
import { registerSessionRoutes } from './session-routes.js';
import { listLaunches, registerIngestRoutes } from './ingest.js';
import { launchClaude } from './launch.js';
import {
  CLAUDE_DIR_FILE_TARGETS,
  CLAUDE_DIR_TREES,
  DIR_FILE_TARGETS,
  claudeHome,
  claudeHomeSource,
  globalConfigFile,
  homeDir,
  legacyGlobalConfigFile,
  managedCandidates,
  rootState,
  snapshotRoot,
} from './paths.js';

export const HOST = '127.0.0.1';

/** A non-empty string, and nothing that merely stringifies to one. */
const isText = (v) => typeof v === 'string' && v.length > 0;


// The state below is per process, not per app: one process serves one app.

/** scanId -> { lineage, allowed:Map<string,entry>, createdAt } . Bounded to MAX_SCANS. */
const scans = new Map();
const MAX_SCANS = 8;
let scanSeq = 0;

/**
 * Open /api/watch streams, so an evicted scan can take its watchers with it.
 * Bounded because each stream holds a directory handle per watched directory
 * and polls every share-side one, and a tab that never closes should not be
 * able to accumulate them.
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
  // What this scan offers to create (#15), kept like the allowlist: a create
  // names an option by id, and the path comes from here, never the request.
  scans.set(scanId, { lineage, allowed, creatable: createOptions(lineage), createdAt: Date.now() });
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

/**
 * Builds the app. `port` is the one it will listen on, which the origin guard
 * needs to recognise our own pages; `staticFiles` is where the client comes from
 * (diskStatic or memoryStatic below).
 */
export function createApp({ port, staticFiles }) {
  const app = express();
  // First, and on every route including the HTML: see hostGuard for why this
  // one, unlike the origin guard below, must not be scoped to /api.
  app.use(hostGuard(port));
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
    // img-src and media-src: rendered markdown (a Claude reply, a CLAUDE.md)
    // can contain ![x](https://host/?d=...), and without these the browser
    // fetches it: an outbound request, and the classic exfiltration channel
    // for text a model was tricked into writing. Only our own origin and data:.
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'; img-src 'self' data:; media-src 'self'");
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
  app.use('/api', originGuard(port));
  app.use('/api', requireToken);

  /** The scan manifest, so the UI can show exactly what will be probed. */
  app.get('/api/manifest', (req, res) => {
    res.json({
      platform: process.platform,
      home: homeDir(),
      // Claude Code's configuration home and where it came from (#7): the user
      // level, plugins, session data and .claude.json all follow CLAUDE_CONFIG_DIR.
      claudeHome: claudeHome(),
      claudeHomeSource: claudeHomeSource(),
      globalConfigFile: globalConfigFile(),
      directoryTargets: DIR_FILE_TARGETS.map((t) => t.name),
      claudeDirFiles: CLAUDE_DIR_FILE_TARGETS.map((t) => t.name),
      claudeDirTrees: CLAUDE_DIR_TREES.map((t) => ({
        name: t.name,
        maxDepth: t.maxDepth,
        extensions: t.exts,
      })),
      managedCandidates: managedCandidates(),
      homeExtras: [
        legacyGlobalConfigFile(),
        globalConfigFile(),
        path.join(homeDir(), 'CLAUDE.md'),
        path.join(claudeHome(), 'plugins'),
      ],
      neverRead: writePolicy().neverWritten,
      // Stated rather than implied, so the UI can show the write policy instead of
      // the user discovering it from a 403. Derived from the guards themselves.
      write: {
        ...writePolicy(),
        // Reported, not thrown, so a refused store (#88) reads as a message
        // rather than as a page with no write policy at all.
        snapshotRoot: rootState(snapshotRoot).root,
        snapshotRootError: rootState(snapshotRoot).error,
        rules: [
          'Only files discovered by the current scan can be written or deleted.',
          'Nothing inside the plugin cache is edited, deleted, created or restored: Claude Code replaces it when a plugin updates.',
          'New files are created only at a user or directory level, at places the scan offers, from a template, and never over an existing file.',
          'A delete takes a snapshot first and is refused unless that snapshot holds the file.',
          'A file gone from disk can be restored from a snapshot only where the current scan would list it, and is created, never written over.',
          'Every edit, delete and restore is preceded by an automatic snapshot, and edits land via temp file plus rename. A create replaces nothing, so it takes none.',
          'Invalid JSON or YAML is refused; malformed markdown frontmatter is a warning only.',
          'Claude Code loads memory and settings at session start, so a running session is unaffected until restart.',
        ],
      },
    });
  });

  app.post('/api/scan', async (req, res) => {
    const dir = String(req.body?.dir || '').trim();
    if (!dir) return res.status(400).json({ message: 'dir is required', code: 'EBADREQUEST' });
    try {
      const lineage = await resolveLineage(dir);
      const scanId = registerScan(lineage);
      res.json({ scanId, ...lineage, creatable: scans.get(scanId).creatable });
    } catch (err) {
      res.status(500).json({ message: err.message, ...describeError(err) });
    }
  });

  app.get('/api/file', async (req, res) => {
    const scanId = String(req.query.scanId || '');
    const target = String(req.query.path || '');
    const scan = scans.get(scanId);
    if (!scan) return res.status(404).json({ message: 'Unknown or expired scan. Re-scan the directory.', code: 'ESCANGONE' });
    if (!target) return res.status(400).json({ message: 'path is required', code: 'EBADREQUEST' });
    if (!scan.allowed.has(allowKey(target))) {
      return res.status(403).json({
        message: 'Path is not part of this scan result. Only files discovered by the scan can be opened.',
        code: 'ENOTINSCAN',
      });
    }
    if (isSecret(target)) {
      return res.status(403).json({ message: 'Credential file. Never read by this tool.', code: 'EREDACTED' });
    }
    const result = await readForDisplay(path.resolve(target));
    res.json(result);
  });

  app.get('/api/flatten', async (req, res) => {
    const scanId = String(req.query.scanId || '');
    const kind = String(req.query.kind || 'claude-md');
    const scan = scans.get(scanId);
    if (!scan) return res.status(404).json({ message: 'Unknown or expired scan. Re-scan the directory.', code: 'ESCANGONE' });
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
      return res.status(404).json({ message: 'Unknown or expired scan. Re-scan the directory.', code: 'ESCANGONE' });
    }
    if (watchStreams.size >= MAX_WATCH_STREAMS) {
      return res.status(429).json({
        message: `Already watching on ${MAX_WATCH_STREAMS} connections. Close another LayerCake tab.`,
        code: 'ETOOMANY',
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

    const watcher = watchLineage(
      scan.lineage,
      (changes) => {
        send('change', { changes, at: new Date().toISOString() });
      },
      // Coverage moves after ready: the first poll round settles whether a share
      // answers, a share can drop or come back at any time after, and a native
      // watch can fail. Same shape as ready, so it reads as a newer one.
      (coverage) => {
        send('coverage', { scanId, ...coverage, debounceMs: DEBOUNCE_MS });
      }
    );

    // Says what is covered AND what is not. A UI that claims to be watching while
    // silently skipping an ancestor, or a share that stopped answering, is worse
    // than one that does not watch at all, because it converts "no events" into
    // false reassurance.
    send('ready', { scanId, ...watcher.coverage(), debounceMs: DEBOUNCE_MS });

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
      err.code = 'ESCANGONE';
      throw err;
    }
    const entry = scan.allowed.get(allowKey(target));
    if (!entry) {
      const err = new Error('Path is not part of this scan result.');
      err.status = 403;
      // A code on every refusal, so a client or a log can tell them apart (#145).
      err.code = 'ENOTINSCAN';
      throw err;
    }
    return { scan, entry };
  }

  function sendError(res, err) {
    // details: structured facts the UI acts on, such as the command keys a
    // settings edit changed (#19). Never a file body.
    res.status(err.status || 500).json({ message: err.message, code: err.code || null, details: err.details || null });
  }

  app.post('/api/write', async (req, res) => {
    const { scanId, path: target, content, expectedMtime, acknowledgeExecutable } = req.body || {};
    if (!isText(scanId) || !isText(target)) return res.status(400).json({ message: 'scanId and path must be strings', code: 'EBADREQUEST' });
    if (typeof content !== 'string') {
      return res.status(400).json({ message: 'content must be a string', code: 'EBADREQUEST' });
    }
    try {
      const { scan, entry } = requireEntry(String(scanId || ''), String(target || ''));
      const result = await editFile({
        entry,
        content,
        lineage: scan.lineage,
        expectedMtime: expectedMtime || null,
        // Only a real true acknowledges: "false", [] and {} are truthy (#102).
        acknowledgeExecutable: acknowledgeExecutable === true,
      });
      return res.json(result);
    } catch (err) {
      return sendError(res, err);
    }
  });

  // #15: a new file from a template, at a place the scan offered. The request
  // names the option and, for a folder, a name; the server builds the path.
  app.post('/api/create', async (req, res) => {
    const { scanId, createId, name, ext, acknowledgeExecutable } = req.body || {};
    // Strings only: String(['x']) is 'x', so an array would pass as an id (#102).
    if (!isText(scanId) || !isText(createId)) return res.status(400).json({ message: 'scanId and createId must be strings', code: 'EBADREQUEST' });
    const scan = scans.get(scanId);
    if (!scan) return res.status(404).json({ message: 'Unknown or expired scan. Re-scan first.', code: 'ESCANGONE' });
    const option = scan.creatable.find((o) => o.id === String(createId || ''));
    if (!option) {
      return res.status(403).json({
        message: 'This scan does not offer that. Re-scan and choose from its list.',
        code: 'ENOTCREATABLE',
      });
    }
    try {
      return res.json(
        await createFile({
          option,
          name: typeof name === 'string' ? name : '',
          ext: typeof ext === 'string' ? ext : '',
          acknowledgeExecutable: acknowledgeExecutable === true,
        })
      );
    } catch (err) {
      return sendError(res, err);
    }
  });

  // #15: deletes a scanned file, after a snapshot that holds it.
  app.post('/api/delete', async (req, res) => {
    const { scanId, path: target, expectedMtime } = req.body || {};
    if (!isText(scanId) || !isText(target)) return res.status(400).json({ message: 'scanId and path must be strings', code: 'EBADREQUEST' });
    try {
      const { scan, entry } = requireEntry(scanId, target);
      return res.json(await deleteFile({ entry, lineage: scan.lineage, expectedMtime: expectedMtime || null }));
    } catch (err) {
      return sendError(res, err);
    }
  });

  app.post('/api/snapshot', async (req, res) => {
    const scan = scans.get(String(req.body?.scanId || ''));
    if (!scan) return res.status(404).json({ message: 'Unknown or expired scan. Re-scan first.', code: 'ESCANGONE' });
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
      return res.json({ root: snapshotRoot(), retentionDays: RETENTION_DAYS, snapshots: await listSnapshots() });
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

  // With a scanId, each row also says whether a restore under that scan would
  // put it back, and why not, so the page can disable a row before the click
  // rather than report it after (#96, #97). The restore route decides again.
  app.get('/api/snapshot/:id/compare', async (req, res) => {
    try {
      const result = await compareSnapshot(req.params.id);
      const scan = scans.get(String(req.query.scanId || ''));
      if (scan) {
        for (const row of result.rows) {
          const inScan = scan.allowed.has(allowKey(row.absPath));
          if (row.readOnly) {
            row.restorable = false;
            row.notRestorable = row.readOnly;
          } else if (!inScan && !(row.status === 'missing' && restorableWhenAbsent(scan.lineage, row.absPath))) {
            row.restorable = false;
            row.notRestorable = NOT_RESTORABLE;
          } else if (row.status !== 'missing' && row.currentSize > MAX_FILE_BYTES) {
            row.restorable = false;
            row.notRestorable = 'The file on disk is over the 2 MB snapshot cap, so no snapshot can hold it and replacing it would have no way back.';
          } else row.restorable = true;
        }
      }
      return res.json(result);
    } catch (err) {
      return sendError(res, err);
    }
  });

  app.get('/api/snapshot/:id/file', async (req, res) => {
    try {
      // A string, never ?path[]=x, which String() would flatten into one (#110).
      if (!isText(req.query.path)) return res.status(400).json({ message: 'path must be a string', code: 'EBADREQUEST' });
      return res.json(await readSnapshotFile(req.params.id, req.query.path));
    } catch (err) {
      return sendError(res, err);
    }
  });

  app.post('/api/restore', async (req, res) => {
    const { scanId, id, paths } = req.body || {};
    // Strings only, as for create, write and delete (#102, #110).
    if (!isText(id) || !Array.isArray(paths) || paths.length === 0 || !paths.every(isText)) {
      return res.status(400).json({ message: 'id must be a string, and paths a non-empty array of strings', code: 'EBADREQUEST' });
    }
    const scan = scans.get(String(scanId || ''));
    if (!scan) return res.status(404).json({ message: 'Unknown or expired scan. Re-scan first.', code: 'ESCANGONE' });
    try {
      // Restore targets must be in the current scan. Without this, a stale
      // snapshot could write to a path the current scan never validated. The
      // one exception is a file gone from disk (#92), which no later scan can
      // find: it may come back inside a level's config folders, and is then
      // created rather than written over.
      //
      // A path this scan cannot take is reported with the other failures
      // rather than refusing the batch, so one such row no longer stops the
      // rest being restored (#97). Only a batch with nothing restorable is
      // refused outright.
      // The fence lives in writefile.js, so the CLI gets it too (#105).
      return res.json(await restoreSnapshotFiles({ id, paths, lineage: scan.lineage }));
    } catch (err) {
      return sendError(res, err);
    }
  });

  // Session history and live sessions. Registered here, after the /api guards,
  // so every one of them is behind the Host, origin and token checks.
  registerSessionRoutes(app);

  // "Start Claude here". The directory comes from the scan store, never from the
  // request body, the same way a write takes its target from the scan.
  app.post('/api/launch', async (req, res) => {
    const scan = scans.get(String(req.body?.scanId || ''));
    if (!scan) return res.status(404).json({ message: 'Unknown or expired scan. Re-scan first.', code: 'ESCANGONE' });
    try {
      const screen = req.body?.screen && typeof req.body.screen === 'object' ? req.body.screen : null;
      return res.json(await launchClaude({ dir: scan.lineage.projectDir, port, screen }));
    } catch (err) {
      return sendError(res, err);
    }
  });

  app.get('/api/launches', (req, res) => res.json({ launches: listLaunches() }));

  // Status line and hook posts from sessions LayerCake launched. Not under
  // /api: the callers are Claude Code processes, not our page, so they carry a
  // per-launch secret instead of the page token (see ingest.js).
  registerIngestRoutes(app);

  // An /api path no route above answered is a 404, in JSON. Without this the
  // HTML fallback below answered it with the app page and a 200, so a removed
  // route (/api/validate, #67) still looked like it existed.
  app.use('/api', (req, res) => res.status(404).json({ message: 'No such API route.', code: 'ENOROUTE' }));

  // Assets are served normally. Only the HTML shell carries the secret, and it
  // gets it from the injector below, never from the static source.
  app.use(staticFiles.middleware);

  app.get('*', async (req, res) => {
    try {
      const html = await staticFiles.readIndexHtml();
      res.type('html').set('Cache-Control', 'no-store').send(injectToken(html));
    } catch {
      res
        .status(503)
        .type('text')
        .send('Client bundle missing. Run "npm run build" (or use "npm start", which builds first).');
    }
  });

  return app;
}

/**
 * Listens on 127.0.0.1 and settles once the socket is bound or has failed.
 * Callers decide what a failure means: a terminal prints guidance, the single
 * executable has no terminal and shows a window instead.
 */
export function listen(app, port) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, HOST);
    server.once('listening', () => resolve(server));
    server.once('error', reject);
  });
}

/**
 * The client bundle from a directory on disk: public/, as built by Vite.
 * index:false so a request for "/" falls through to the token injector.
 */
export function diskStatic(dir) {
  return {
    middleware: express.static(dir, { index: false }),
    readIndexHtml: () => fs.readFile(path.join(dir, 'index.html'), 'utf8'),
  };
}

/**
 * The client bundle from memory, for the single executable, which carries it
 * as embedded assets rather than as files.
 *
 * `files` maps a URL path without its leading slash ("assets/index-abc.js") to
 * a Buffer. It is an exact-match lookup with no filesystem behind it, so there
 * is no path to traverse. index.html is refused here, not served raw, so it
 * can only ever leave through the token injector.
 */
export function memoryStatic(files) {
  return {
    middleware(req, res, next) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();
      const key = req.path.slice(1);
      if (key === 'index.html' || !files.has(key)) return next();
      return res.type(path.extname(key)).send(files.get(key));
    },
    async readIndexHtml() {
      const html = files.get('index.html');
      if (!html) throw new Error('index.html is not embedded');
      return html.toString('utf8');
    },
  };
}
