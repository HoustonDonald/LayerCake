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
import { homeDir, snapshotRoot } from './paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PORT = Number(process.env.PORT || 5178);

const app = createApp({ port: PORT, staticFiles: diskStatic(PUBLIC_DIR) });

try {
  await listen(app, PORT);
} catch (err) {
  // A busy port is an ordinary condition, usually a previous instance still
  // running. Say what to do about it instead of dumping a stack trace.
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
}

process.stdout.write(`\nLayerCake  ->  http://${HOST}:${PORT}\n`);
process.stdout.write(`Home: ${homeDir()}  Platform: ${process.platform}\n`);
process.stdout.write(`Snapshots: ${snapshotRoot()}\n\n`);
