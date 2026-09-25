/**
 * Entry point of the single executable, dist/LayerCake.exe, built by
 * desktop/build.mjs with Node's single executable application (SEA) support.
 *
 * The exe has no console. build.mjs marks it a Windows GUI program so that
 * double-clicking it does not leave a terminal window open, and Node gives a
 * GUI program stdout and stderr that discard everything. So nothing here
 * prints: whatever the user must see goes to a window, through showError when
 * there is no app to show.
 *
 * Lifecycle, in the order it happens:
 *  1. Something already answers on the port: open a window on it and exit. A
 *     second double-click never starts a second server.
 *  2. Otherwise serve the embedded client, open the window, and stay up exactly
 *     as long as the browser process that owns it. Closing the last LayerCake
 *     window ends that Edge process (measured: about 0.5 s), which ends this.
 *  3. If Edge was already running for this profile, it takes the new window
 *     itself and the process we started exits at once (measured: about 0.2 s),
 *     so we can no longer see the window. Staying up is the safe side of that:
 *     a working window and an idle process, rather than a window whose server
 *     has just vanished. The next launch finds it on the port and reuses it.
 */

/* global __LAYERCAKE_ASSETS__ */

import { getAsset, isSea } from 'node:sea';

import { createApp, listen, memoryStatic } from '../server/app.js';
import { HOST, openWindow, probe, showError } from './window.js';

/**
 * How soon after launch the browser process may exit and still be read as a
 * hand-off rather than as the user closing the window. A hand-off takes about
 * 0.2 s; nobody opens and closes a window inside five.
 */
const HANDOFF_MS = 5000;

/** How long in-flight requests get to finish once the window has closed. */
const DRAIN_MS = 5000;

function readPort() {
  const port = Number(process.env.PORT || 5178);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Not a usable port: ${process.env.PORT}`);
  }
  return port;
}

/**
 * The client bundle, as embedded by build.mjs. The key list is baked into this
 * script at build time because the asset API can fetch a key but not list them.
 */
function embeddedClient() {
  const files = new Map();
  for (const key of __LAYERCAKE_ASSETS__) files.set(key, Buffer.from(getAsset(key)));
  return files;
}

function listenFailure(err, port) {
  const relaunch = `  $env:PORT = 5200; & '${process.execPath}'`;
  if (err.code === 'EADDRINUSE') {
    return [
      `Port ${port} is in use by another program`,
      `LayerCake looked for a running copy of itself on port ${port} first and none answered, ` +
        `so something else holds the port.\n\n` +
        `See what holds it (PowerShell):\n` +
        `  Get-NetTCPConnection -LocalPort ${port} -State Listen\n\n` +
        `Or start LayerCake on another port:\n${relaunch}`,
    ];
  }
  if (err.code === 'EACCES') {
    // On Windows this is usually not a permissions problem at all: Hyper-V and
    // WinNAT reserve blocks of ports, and binding inside one fails this way.
    return [
      `Windows refused port ${port}`,
      `The port is most likely inside a range Windows has reserved (Hyper-V and WinNAT do this).\n\n` +
        `List the reserved ranges:\n` +
        `  netsh interface ipv4 show excludedportrange protocol=tcp\n\n` +
        `Start LayerCake on a port outside them:\n${relaunch}`,
    ];
  }
  return ['LayerCake could not start its server', err.stack || err.message];
}

async function main() {
  const port = readPort();
  const url = `http://${HOST}:${port}`;

  if (await probe(port)) {
    openWindow(url);
    process.exit(0);
  }

  const app = createApp({ port, staticFiles: memoryStatic(embeddedClient()) });
  let server;
  try {
    server = await listen(app, port);
  } catch (err) {
    showError(...listenFailure(err, port));
    process.exit(1);
  }

  const launchedAt = Date.now();
  const { child } = openWindow(url);
  // No app-mode browser, so no process that tracks the window: stay up.
  if (!child) return;

  child.on('exit', () => {
    if (Date.now() - launchedAt < HANDOFF_MS) return;
    // Let a request that was already running finish, so a save made just
    // before the window closed still completes its snapshot. The Edge sockets
    // died with Edge, so close() is waiting only on work, not on idle clients.
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), DRAIN_MS).unref();
  });
}

if (!isSea()) {
  // Run as a plain script there is a console, so say it there.
  process.stderr.write('desktop/main.js runs inside the built LayerCake.exe. From source, use: npm run app\n');
  process.exit(1);
}

process.on('uncaughtException', (err) => {
  showError('LayerCake stopped unexpectedly', err?.stack || String(err));
  process.exit(1);
});

main().catch((err) => {
  showError('LayerCake could not start', err?.stack || String(err));
  process.exit(1);
});
