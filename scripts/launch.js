/**
 * Desktop launcher: build if stale, start the server, wait for it to actually
 * answer, then open a chromeless browser window pointed at it.
 *
 * Why this exists next to start.js rather than inside it: `npm start` is the
 * terminal workflow and should stay a terminal workflow. This is the
 * double-click workflow, and it has to do three things start.js deliberately
 * does not: prove the server is up before opening anything, avoid starting a
 * second server when one is already listening, and own the child process so
 * Ctrl+C shuts it down.
 *
 * The window itself (which browser, which profile, which flags) lives in
 * desktop/window.js, shared with the single executable in desktop/main.js.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { appAddress, openWindow, probe, verifyServer } from '../desktop/window.js';
import { ensurePageKey } from '../server/appdata.js';
import { buildClientIfStale } from './build-if-stale.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const serverEntry = path.join(root, 'server', 'index.js');

const READY_TIMEOUT_MS = 15000;
const PROBE_INTERVAL_MS = 250;

/* ---------------------------------------------------------------- arguments */

/**
 * Only two flags, because the server takes its configuration from the
 * environment and this script should not grow a second source of truth.
 * layercake.cmd forwards whatever it was given, so these are what that
 * forwarding is for.
 */
function parseArgs(argv) {
  const opts = { help: false, port: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h' || arg === '/?') opts.help = true;
    else if (arg.startsWith('--port=')) opts.port = arg.slice('--port='.length);
    else if (arg === '--port') {
      i += 1;
      opts.port = argv[i];
    } else {
      process.stderr.write(`Ignoring unrecognized argument: ${arg}\n`);
    }
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));

if (opts.help) {
  process.stdout.write(
    '\nLayerCake desktop launcher\n\n' +
      '  node scripts\\launch.js [--port <n>]\n\n' +
      '  --port <n>   Port to serve on. Defaults to $env:PORT, then 5178.\n' +
      '  --help       This text.\n\n' +
      'Builds the client if stale, starts the server, waits for it to answer,\n' +
      'then opens it in an app-mode browser window. If the port is already\n' +
      'serving, it opens that instance instead of starting a second one.\n\n'
  );
  process.exit(0);
}

const PORT = Number(opts.port || process.env.PORT || 5178);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  process.stderr.write(`\nNot a usable port: ${opts.port || process.env.PORT}\n\n`);
  process.exit(1);
}
// This user's page key (#189); the window gets it in its address.
const key = await ensurePageKey();
const appUrl = appAddress(PORT, key);

/** Something answers on the port and is not this user's LayerCake (#189, #190). */
function refuseForeign() {
  process.stderr.write(
    `\nSomething is answering on port ${PORT}, but it is not your LayerCake: another program, or ` +
      `LayerCake running for another person signed in to this computer. No window was opened on it.\n\n` +
      `  See what holds it:  Get-NetTCPConnection -LocalPort ${PORT} -State Listen\n` +
      `  Or use another port: node scripts\\launch.js --port 5200\n\n`
  );
  process.exit(1);
}

/* -------------------------------------------------------------- readiness wait */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Polls until the server answers or the deadline passes. Polling rather than a
 * fixed sleep because a cold first build and a warm restart differ by seconds,
 * and either guess would be wrong half the time. `isDead` lets the caller abort
 * early when the child process has already exited, so a server that dies on
 * startup reports its own error instead of stalling here for the full timeout.
 */
async function waitForServer(isDead) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (isDead && isDead()) return false;
    if (await probe(PORT)) return true;
    await sleep(PROBE_INTERVAL_MS);
  }
  return false;
}

/* ------------------------------------------------------------------------ main */

/** Already serving: attach to it rather than fighting it for the port. */
if (await probe(PORT)) {
  if ((await verifyServer(PORT, key)) !== 'ours') refuseForeign();
  process.stdout.write(
    `\nLayerCake is already running on port ${PORT}. Not starting a second server.\n`
  );
  process.stdout.write(`Opening the running instance in ${openWindow(appUrl).description}.\n\n`);
  process.stdout.write(
    `  To restart it instead, stop the other one first:\n` +
      `    Stop-Process -Id (Get-NetTCPConnection -LocalPort ${PORT} -State Listen).OwningProcess -Force\n\n`
  );
  process.exit(0);
}

await buildClientIfStale();

// Spawned rather than imported so this process keeps a handle on it. An import
// would put the listener inside this process, and Ctrl+C handling would then be
// a matter of hoping the server unwinds cleanly.
const server = spawn(process.execPath, [serverEntry], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, PORT: String(PORT) },
});

let serverExited = false;
let serverExitCode = null;
let shuttingDown = false;
let serving = false;

server.on('exit', (code) => {
  serverExited = true;
  serverExitCode = code;
  // Three ways to get here. During shutdown it is what we asked for and the
  // signal handler owns the exit code. After the window is open it is a crash,
  // so follow it out with the same code. Before then, say nothing: the wait
  // loop below is already watching and reports it with context.
  if (shuttingDown) return;
  if (serving) {
    process.stderr.write(`\nThe LayerCake server exited (code ${code}). Closing the launcher.\n\n`);
    process.exit(code === null ? 1 : code);
  }
});

server.on('error', (err) => {
  serverExited = true;
  process.stderr.write(`\nCould not start the server process: ${err.message}\n\n`);
  process.exit(1);
});

/** Ctrl+C: stop the server we started, then leave. */
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stdout.write('\nStopping LayerCake...\n');
  if (!serverExited) server.kill();
  // The browser window is deliberately left alone. It is detached, it holds no
  // state we own, and closing a window out from under someone is rude.
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGHUP', shutdown);

const ready = await waitForServer(() => serverExited);

if (!ready) {
  if (serverExited) {
    // The server diagnoses its own startup failures, busy port included, so
    // this only has to explain why the launcher is stopping too.
    process.stderr.write(`The server exited (code ${serverExitCode}) before it began serving, so no window was opened.\n\n`);
    process.exit(serverExitCode === null || serverExitCode === 0 ? 1 : serverExitCode);
  }
  process.stderr.write(
    `\nLayerCake did not answer on ${appUrl} within ${READY_TIMEOUT_MS / 1000} seconds.\n\n` +
      `  Check the server output above for the real error.\n` +
      `  See what holds the port:  Get-NetTCPConnection -LocalPort ${PORT} -State Listen\n` +
      `  Or try another port:      node scripts\\launch.js --port 5200\n\n`
  );
  shuttingDown = true;
  if (!serverExited) server.kill();
  process.exit(1);
}

// Our child answered, unless something took the port in the meantime and our
// child is failing to bind: open the window only on a server that proves it.
if ((await verifyServer(PORT, key)) !== 'ours') {
  shuttingDown = true;
  if (!serverExited) server.kill();
  refuseForeign();
}
serving = true;
process.stdout.write(`Opening LayerCake in ${openWindow(appUrl).description}.\n`);
process.stdout.write('Close this window or press Ctrl+C to stop the server.\n\n');
