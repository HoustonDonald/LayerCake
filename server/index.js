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

import { HOST, createApp, diskStatic, listen } from './app.js';
import { pageKeyOrRunKey } from './appdata.js';
import { homeDir, rootState, snapshotRoot } from './paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PORT = Number(process.env.PORT || 5178);

// The page key (#189): /api needs it, and the page gets it only from the
// address printed below or from a launcher's window.
const { key, kept, reason } = await pageKeyOrRunKey();
if (!kept) process.stderr.write(`\nPage key for this run only: ${reason}\n`);
const app = createApp({ port: PORT, staticFiles: diskStatic(PUBLIC_DIR), key });

try {
  await listen(app, PORT);
} catch (err) {
  // A busy port is an ordinary condition, usually a previous instance still
  // running. Say what to do about it instead of dumping a stack trace.
  if (err.code === 'EADDRINUSE') {
    process.stderr.write(
      `\nPort ${PORT} is already in use, most likely by an earlier LayerCake.\n\n` +
        `  Open the running one:   npm run app\n` +
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
}

// With the key in the fragment, which the browser keeps to itself: open this
// address, not a bare one. It is printed on this user's own console only.
process.stdout.write(`\nLayerCake  ->  http://${HOST}:${PORT}/#t=${key}\n`);
process.stdout.write(`Home: ${homeDir()}  Platform: ${process.platform}\n`);
const snaps = rootState(snapshotRoot);
process.stdout.write(snaps.error ? `Snapshots: REFUSED. ${snaps.error}\n\n` : `Snapshots: ${snaps.root}\n\n`);
