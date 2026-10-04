/**
 * Server entry for the terminal workflows. npm start, npm run dev:server, the
 * launcher (scripts/launch.js) and the smoke test all run this file, and it
 * listens as soon as it is loaded, which start.js relies on.
 *
 * The app itself, and the security posture that goes with it, is in app.js.
 * This file only decides where the client comes from (public/ on disk) and how
 * a failure to listen is reported (to a terminal).
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { HOST, INGEST_PORT, createApp, diskStatic, listen, listenIngest, retryIngest } from './app.js';
import { newRunKey, writeRunRecord } from './appdata.js';
import { homeDir, rootState, snapshotRoot } from './paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
// A fixed port only when asked for (--port N or PORT): otherwise Windows picks
// a free one at bind time (port 0), a new one every run (#198), so every run is
// a new browser origin and nothing a stranger planted under one origin (a
// script in the cache, a service worker, the stored key) reaches the next.
const portArg = process.argv.indexOf('--port');
const FIXED = portArg !== -1 ? Number(process.argv[portArg + 1]) : process.env.PORT ? Number(process.env.PORT) : null;
if (FIXED !== null && !(Number.isInteger(FIXED) && FIXED > 0 && FIXED < 65536)) {
  process.stderr.write(`\nNot a port: ${process.argv[portArg + 1] ?? process.env.PORT}\n\n`);
  process.exit(1);
}

// The page key for this run (#189, #198): /api needs it, and the page gets it
// only from the address printed below or from a launcher's window.
const key = newRunKey();
// Sessions it launches report on a fixed port of their own (#200), so they
// reach the next run too. Without it, only Start Claude here is unavailable.
const ingest = await listenIngest();
if (!ingest.port) {
  process.stderr.write(`\nReports from launched sessions: port ${INGEST_PORT ?? process.env.LAYERCAKE_INGEST_PORT} unavailable (${ingest.error}); Start Claude here is off until it frees.\n`);
  retryIngest(ingest);
}
const app = createApp({ staticFiles: diskStatic(PUBLIC_DIR), key, ingest });

let server;
try {
  server = await listen(app, FIXED ?? 0);
} catch (err) {
  // A busy fixed port is an ordinary condition, usually a previous instance
  // still running. Say what to do about it instead of dumping a stack trace.
  if (err.code === 'EADDRINUSE') {
    process.stderr.write(
      `\nPort ${FIXED} is already in use, most likely by an earlier LayerCake.\n\n` +
        `  Open the running one:   npm run app\n` +
        `  Or free the port:       Stop-Process -Id (Get-NetTCPConnection -LocalPort ${FIXED} -State Listen).OwningProcess -Force\n` +
        `  Or let Windows pick one: npm start, with PORT unset\n\n`
    );
  } else if (err.code === 'EACCES') {
    process.stderr.write(`\nNot allowed to bind port ${FIXED}. Leave PORT unset and Windows picks a free one.\n\n`);
  } else {
    process.stderr.write(`\nCould not start the server: ${err.message}\n\n`);
  }
  process.exit(1);
}
const PORT = server.address().port;

// How a launch finds this server and checks it is its user's (#198). A data
// folder that cannot hold it costs only that: the address below still works.
try {
  await writeRunRecord({ port: PORT, key, pid: process.pid, startedAt: new Date().toISOString() });
} catch (err) {
  process.stderr.write(`\nRun record not written, so npm run app cannot find this server: ${err.message}\n`);
}

// With the key in the fragment, which the browser keeps to itself: open this
// address, not a bare one. It is printed on this user's own console only.
process.stdout.write(`\nLayerCake  ->  http://${HOST}:${PORT}/#t=${key}\n`);
process.stdout.write(`Home: ${homeDir()}  Platform: ${process.platform}\n`);
const snaps = rootState(snapshotRoot);
process.stdout.write(snaps.error ? `Snapshots: REFUSED. ${snaps.error}\n\n` : `Snapshots: ${snaps.root}\n\n`);
