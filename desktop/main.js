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
 *  1. Something already answers on the port: open a window on it, and keep
 *     checking for a few seconds that it still answers (REATTACH_MS). A second
 *     double-click never starts a second server. If it stops answering, it was
 *     a server whose last window had just closed, and this launch takes the
 *     port and serves the window it opened, or opens it again if the browser
 *     it was handed to has gone (#10).
 *  2. Otherwise serve the embedded client, open the window, and stay up exactly
 *     as long as a browser is running on the app window's profile. Closing the
 *     last LayerCake window ends that Edge process, which ends this, once any
 *     request still running has finished (see inflight.js).
 *  3. If Edge was already running for this profile, it takes the new window
 *     itself and the process we started exits at once (measured: about 0.2 s).
 *     We cannot watch that browser's process, so we watch its hold on the
 *     profile instead (profileInUse in window.js) and stop when it lets go.
 */

/* global __LAYERCAKE_ASSETS__ */

import { getAsset, isSea } from 'node:sea';

// The one server module imported statically: it imports nothing of the
// server's and does nothing at load, so it cannot throw before the handler.
import { psQuote } from '../server/powershell.js';

import { trackInflight } from './inflight.js';
import { appAddress, openWindow, probe, profileInUse, profileLock, showError, verifyServer } from './window.js';

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
 * How long a launch that found a server already answering keeps checking that
 * it still does (#10). A server whose last window has just closed answers for
 * as long as its browser takes to exit, and a window opened on it in that time
 * was left with nothing behind it: 4 of 4 relaunches 0 to 0.3 s after closing
 * the window, measured before this existed. Five seconds covers the browser's
 * exit and the new page's load several times over, and costs nothing visible,
 * because the window is already open.
 */
const REATTACH_MS = 5000;

/**
 * How often to look at the profile while a browser holds it that is not the
 * one we started. A stat each time, so the only cost of polling is latency.
 */
const PROFILE_POLL_MS = 500;

/** How often to look for the lockfile while our own browser starts (watchForLock). */
const LOCK_WATCH_MS = 100;

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

/**
 * A fixed port only when PORT is set (#198). Otherwise null, and Windows picks
 * a free port when the server binds, a new one every run, so every run is a new
 * browser origin and nothing planted under one (a cached script, a service
 * worker, a stored key) reaches the next.
 */
function readPort() {
  if (!process.env.PORT) return null;
  const port = Number(process.env.PORT);
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function answersWithin(port, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await probe(port)) return true;
    await sleep(REPROBE_INTERVAL_MS);
  }
  return false;
}

async function stopsAnsweringWithin(port, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    await sleep(REPROBE_INTERVAL_MS);
    if (!(await probe(port))) return true;
  }
  return false;
}

/**
 * Opens the app window. `exited` is made here, at spawn, rather than when the
 * lifecycle gets to it: a launch that attached to another server opens its
 * window seconds before it knows whether it will serve it, and a hand-off's
 * browser has exited long before then.
 */
function openAppWindow(url) {
  const launchedAt = Date.now();
  const { child } = openWindow(url);
  if (!child) return { child: null, exitedAt: null };
  // A browser that cannot be started at all (blocked by AppLocker, say) fails
  // asynchronously. Without a listener that is an uncaught exception whose error
  // window would fail the same way; with one, at least no invisible server is
  // left holding the port.
  child.on('error', () => process.exit(1));
  const appWindow = { child, launchedAt, exitedAt: null, lockSeen: false };
  appWindow.exited = new Promise((resolve) => {
    child.once('exit', () => {
      appWindow.exitedAt = Date.now();
      resolve(appWindow.exitedAt);
    });
  });
  watchForLock(appWindow);
  return appWindow;
}

function handedOff(appWindow) {
  return appWindow.exitedAt !== null && appWindow.exitedAt - appWindow.launchedAt < HANDOFF_MS;
}

/**
 * Looks at the profile while our browser is starting, to learn whether this
 * Chromium keeps the lockfile at all (#93). A browser exit inside HANDOFF_MS
 * is then either a hand-off or the user closing the window at once, and with
 * nothing holding the profile afterwards the two look alike; what separates
 * them is whether the lockfile can be trusted to show a browser that is there.
 * Only a successful stat counts, never an 'unknown'. It stops at the first
 * sighting (the lock appears within about 0.3 s of the spawn) or at
 * HANDOFF_MS, after which the answer no longer matters, so a Chromium without
 * the file costs 50 stats, not a poll for the life of the window.
 */
async function watchForLock(appWindow) {
  while (appWindow.exitedAt === null && Date.now() - appWindow.launchedAt < HANDOFF_MS) {
    if ((await profileLock()) === 'held') {
      appWindow.lockSeen = true;
      return;
    }
    await sleep(LOCK_WATCH_MS);
  }
}

/**
 * Serves until no LayerCake window is left, then stops.
 *
 * The browser we started exiting is the usual signal, and when nothing else
 * holds the profile it is the whole story. Two cases leave the window in a
 * browser we did not start, and both are followed through the profile instead:
 * a hand-off, where a browser already running on the profile took the window
 * and ours exited at once; and a relaunch just as our window closed, which can
 * start a new browser on the profile as ours exits (#10). Either way, stop when
 * no browser holds the profile any more.
 *
 * A browser exit inside HANDOFF_MS with nothing holding the profile is a quick
 * close when we saw the lockfile while our browser ran: this Chromium keeps it,
 * so an empty profile means no window is left (#93). If we never saw it, this
 * may be a Chromium that does not keep the file, where a hand-off also leaves
 * the profile looking empty, so wait for a browser to appear, which may be
 * never. Staying up is the safe side of not knowing, since a window whose
 * server has vanished is worse than an idle process.
 */
async function serveUntilWindowsClose(server, inflight, appWindow) {
  await appWindow.exited;
  if (handedOff(appWindow) && !appWindow.lockSeen) {
    while (!(await profileInUse())) await sleep(PROFILE_POLL_MS);
  }
  while (await profileInUse()) await sleep(PROFILE_POLL_MS);
  // Stop taking requests, then let the ones already running finish, so a save
  // or restore started just before the window closed is not cut off.
  server.close();
  await inflight.idle(DRAIN_MS);
  process.exit(0);
}

/** Something answers on the port and is not this user's LayerCake (#189, #190). */
function portTaken(port) {
  return [
    `Port ${port} is in use by something else`,
    `Something is answering on port ${port}, but it is not your LayerCake: another program, or ` +
      `LayerCake running for another person signed in to this computer. No window was opened on it.\n\n` +
      `See what holds it (PowerShell):\n` +
      `  Get-NetTCPConnection -LocalPort ${port} -State Listen\n\n` +
      `Or start LayerCake on another port:\n  $env:PORT = 5200; & ${psQuote(process.execPath)}`,
  ];
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
  const fixed = readPort();
  const { newRunKey, readRunRecord, writeRunRecord } = await import('../server/appdata.js');

  // Set when this launch opened its window on a server it did not start.
  let appWindow = null;

  // This user's running LayerCake, if there is one: its record names its port
  // and key (#198), and it must prove the key on that port before a window
  // opens on it (#189, #190, #197). With PORT set, only a server on that port.
  const record = await readRunRecord();
  const target = fixed ?? record?.port ?? null;
  if (target !== null && (await probe(target))) {
    const who = record && record.port === target ? await verifyServer(target, record.key) : 'foreign';
    if (who === 'foreign' && fixed !== null) {
      showError(...portTaken(fixed));
      process.exit(1);
    }
    // 'foreign' without PORT: the record is stale, and its port belongs to
    // something else now. It is not ours to open, and we start our own below.
    if (who === 'ours') {
      appWindow = openAppWindow(appAddress(target, record.key));
      if (!(await stopsAnsweringWithin(target, REATTACH_MS))) process.exit(0);
      // It went away: its last window had just closed. Start our own below
      // and open a window on it: the one just opened holds the old run's
      // address and key.
    }
  }

  const key = newRunKey();
  const { createApp, listen, listenIngest, memoryStatic } = await import('../server/app.js');
  // Sessions it launches report on a fixed port of their own (#200); without
  // it, only Start Claude here is unavailable, and it says why.
  const ingest = await listenIngest();
  const app = createApp({ staticFiles: memoryStatic(embeddedClient()), key, ingest });
  let server;
  try {
    server = await listen(app, fixed ?? 0);
  } catch (err) {
    // Lost a race for a fixed port: use it if it is this user's LayerCake.
    if (fixed !== null && err.code === 'EADDRINUSE' && (await answersWithin(fixed, REPROBE_MS))) {
      const now = await readRunRecord();
      if (!now || now.port !== fixed || (await verifyServer(fixed, now.key)) !== 'ours') {
        showError(...portTaken(fixed));
        process.exit(1);
      }
      if (!appWindow) openWindow(appAddress(fixed, now.key));
      process.exit(0);
    }
    showError(...listenFailure(err, fixed ?? 0));
    process.exit(1);
  }
  const port = server.address().port;
  try {
    await writeRunRecord({ port, key, pid: process.pid, startedAt: new Date().toISOString() });
  } catch {
    // The window below still gets its key; only a second launch cannot find
    // this server, and starts one of its own.
  }
  const inflight = trackInflight(server);

  // Our own window, on the first start and on a takeover alike. If a browser
  // already holds the profile (the takeover's earlier window), Edge takes this
  // window itself and ours exits; serveUntilWindowsClose follows the profile.
  appWindow = openAppWindow(appAddress(port, key));
  // No app-mode browser, so no process that tracks the window: stay up.
  if (!appWindow.child) return;
  await serveUntilWindowsClose(server, inflight, appWindow);
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
