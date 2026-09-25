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
 *     window ends that Edge process (measured: about 0.5 s), which ends this,
 *     once any request still running has finished (see inflight.js).
 *  3. If Edge was already running for this profile, it takes the new window
 *     itself and the process we started exits at once (measured: about 0.2 s),
 *     so we can no longer see the window. Staying up is the safe side of that:
 *     a working window and an idle process, rather than a window whose server
 *     has just vanished. The next launch finds it on the port and reuses it.
 */

/* global __LAYERCAKE_ASSETS__ */

import { getAsset, isSea } from 'node:sea';

import { trackInflight } from './inflight.js';
import { HOST, openWindow, probe, showError } from './window.js';

// server/app.js is imported inside main(), not here. A static import runs every
// server module's top level before the uncaughtException handler below exists,
// so a throw there would end a console-less process without a word.

/**
 * How soon after launch the browser process may exit and still be read as a
 * hand-off rather than as the user closing the window. A hand-off takes about
 * 0.2 s; nobody opens and closes a window inside five.
 */
const HANDOFF_MS = 5000;

/**
 * The most the process waits, after its window has closed, for a handler that
 * is still running. Generous because nobody is watching by then, and a
 * snapshot touching a dead share can spend 3 s per file operation before each
 * one times out. The cap only exists so a stuck handler cannot keep an
 * invisible process alive forever.
 */
const DRAIN_MS = 30000;

/**
 * After a failed listen, how long to keep asking whether the port's owner is
 * LayerCake. Two launches in quick succession both probe before either listens,
 * and the loser must find the winner rather than report a stranger.
 */
const REPROBE_MS = 3000;
const REPROBE_INTERVAL_MS = 250;

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

/**
 * The exe's path as a PowerShell single-quoted literal. PowerShell treats the
 * typographic quotes U+2018 to U+201B as single quotes too, so a path such as
 * C:\Users\Sean O'Brien needs every one of them escaped, and the escape is the
 * same character doubled: replacing a curly one with an ASCII pair would change
 * the path. Checked with PowerShell's own parser for ', U+2018 and U+2019.
 */
function psQuote(text) {
  return `'${text.replace(/['\u2018\u2019\u201A\u201B]/g, (q) => q + q)}'`;
}

async function answersWithin(port, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await probe(port)) return true;
    await new Promise((resolve) => setTimeout(resolve, REPROBE_INTERVAL_MS));
  }
  return false;
}

function listenFailure(err, port) {
  const relaunch = `  $env:PORT = 5200; & ${psQuote(process.execPath)}`;
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

  const { createApp, listen, memoryStatic } = await import('../server/app.js');
  const app = createApp({ port, staticFiles: memoryStatic(embeddedClient()) });
  let server;
  try {
    server = await listen(app, port);
  } catch (err) {
    // Lost a race with another launch: it is LayerCake after all, so use it.
    if (err.code === 'EADDRINUSE' && (await answersWithin(port, REPROBE_MS))) {
      openWindow(url);
      process.exit(0);
    }
    showError(...listenFailure(err, port));
    process.exit(1);
  }
  const inflight = trackInflight(server);

  const launchedAt = Date.now();
  const { child } = openWindow(url);
  // No app-mode browser, so no process that tracks the window: stay up.
  if (!child) return;

  // A browser that cannot be started at all (blocked by AppLocker, say) fails
  // asynchronously. Without a listener that is an uncaught exception whose error
  // window would fail the same way; with one, at least no invisible server is
  // left holding the port.
  child.on('error', () => process.exit(1));

  child.on('exit', async () => {
    if (Date.now() - launchedAt < HANDOFF_MS) return;
    // Stop taking requests, then let the ones already running finish, so a save
    // or restore started just before the window closed is not cut off.
    server.close();
    await inflight.idle(DRAIN_MS);
    process.exit(0);
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
