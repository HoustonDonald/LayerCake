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
import { readRunRecord } from '../server/appdata.js';
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
      '  --port <n>   Port to serve on. Defaults to $env:PORT; unset, Windows picks a free one.\n' +
      '  --help       This text.\n\n' +
      'Builds the client if stale, starts the server, waits for it to answer,\n' +
      'then opens it in an app-mode browser window. If your LayerCake is already\n' +
      'running, it opens a window on that one instead of starting a second.\n\n'
  );
  process.exit(0);
}

// A fixed port only when asked for (--port or PORT). Otherwise the server
// lets Windows pick a free one, a new one every run (#198), and says which in
// its run record, with the key for that run.
const FIXED = opts.port || process.env.PORT ? Number(opts.port || process.env.PORT) : null;
if (FIXED !== null && !(Number.isInteger(FIXED) && FIXED > 0 && FIXED < 65536)) {
  process.stderr.write(`\nNot a usable port: ${opts.port || process.env.PORT}\n\n`);
  process.exit(1);
}

/** Something answers on the port and is not this user's LayerCake (#189, #190). */
function refuseForeign(port) {
  process.stderr.write(
    `\nSomething is answering on port ${port}, but it is not your LayerCake: another program, or ` +
      `LayerCake running for another person signed in to this computer. No window was opened on it.\n\n` +
      `  See what holds it:  Get-NetTCPConnection -LocalPort ${port} -State Listen\n` +
      `  Or leave the port to Windows: node scripts\\launch.js, with no --port and PORT unset\n\n`
  );
  process.exit(1);
}

/* -------------------------------------------------------------- readiness wait */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Polls until the server we started has written its run record and answers on
 * the port it names, or the deadline passes. Polling rather than a fixed sleep
 * because a cold first build and a warm restart differ by seconds. `isDead`
 * lets the caller abort early when the child process has already exited, so a
 * server that dies on startup reports its own error instead of stalling here.
 */
async function waitForServer(pid, isDead) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (isDead && isDead()) return null;
    const record = await readRunRecord();
    if (record && record.pid === pid && (await probe(record.port))) return record;
    await sleep(PROBE_INTERVAL_MS);
  }
  return null;
}

/* ------------------------------------------------------------------------ main */

// This user's running LayerCake, if there is one: its record names its port
// and key, and it must prove the key on that port before a window opens on it
// (#189, #190, #197). With a fixed port, only a server on that port.
const running = await readRunRecord();
const target = FIXED ?? running?.port ?? null;
if (target !== null && (await probe(target))) {
  const who = running && running.port === target ? await verifyServer(target, running.key) : 'foreign';
  if (who === 'ours') {
    process.stdout.write(`\nLayerCake is already running on port ${target}. Not starting a second server.\n`);
    process.stdout.write(`Opening the running instance in ${openWindow(appAddress(target, running.key)).description}.\n\n`);
    process.stdout.write(
      `  To restart it instead, stop the other one first:\n` +
        `    Stop-Process -Id ${running.pid} -Force\n\n`
    );
    process.exit(0);
  }
  if (FIXED !== null) refuseForeign(FIXED);
  // No fixed port: the record is stale and its port belongs to something else
  // now. Not ours to open; start our own below.
}

await buildClientIfStale();

// Spawned rather than imported so this process keeps a handle on it. An import
// would put the listener inside this process, and Ctrl+C handling would then be
// a matter of hoping the server unwinds cleanly. PORT is passed only when one
// was asked for; otherwise it is removed, so the server lets Windows choose.
const childEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toUpperCase() !== 'PORT'));
if (FIXED !== null) childEnv.PORT = String(FIXED);
const server = spawn(process.execPath, [serverEntry], { cwd: root, stdio: 'inherit', env: childEnv });

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

const ours = await waitForServer(server.pid, () => serverExited);

if (!ours) {
  if (serverExited) {
    // The server diagnoses its own startup failures, busy port included, so
    // this only has to explain why the launcher is stopping too.
    process.stderr.write(`The server exited (code ${serverExitCode}) before it began serving, so no window was opened.\n\n`);
    process.exit(serverExitCode === null || serverExitCode === 0 ? 1 : serverExitCode);
  }
  process.stderr.write(
    `\nThe server did not report itself ready within ${READY_TIMEOUT_MS / 1000} seconds.\n\n` +
      `  Check its output above: if it printed a LayerCake address, open that one.\n` +
      `  If its run record could not be written (its data folder refused), this launcher cannot find it.\n\n`
  );
  shuttingDown = true;
  if (!serverExited) server.kill();
  process.exit(1);
}

// Our child's record and answer, but only a server that proves the key on that
// port gets a window, whatever took the port in between.
if ((await verifyServer(ours.port, ours.key)) !== 'ours') {
  shuttingDown = true;
  if (!serverExited) server.kill();
  refuseForeign(ours.port);
}
serving = true;
process.stdout.write(`Opening LayerCake in ${openWindow(appAddress(ours.port, ours.key)).description}.\n`);
process.stdout.write('Close this window or press Ctrl+C to stop the server.\n\n');
