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
 * Windows first. It degrades on other platforms to "open the default browser",
 * because app mode and the install paths below are Windows-specific.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const bundle = path.join(root, 'public', 'index.html');
const serverEntry = path.join(root, 'server', 'index.js');

const HOST = '127.0.0.1';
const READY_TIMEOUT_MS = 15000;
const PROBE_INTERVAL_MS = 250;
const PROBE_TIMEOUT_MS = 1000;

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
const appUrl = `http://${HOST}:${PORT}`;

/* ------------------------------------------------------------- build if stale */

/**
 * Mirrored from scripts/start.js rather than imported.
 *
 * start.js does its work at module scope and ends by importing the server,
 * which starts listening as a side effect of the import. Importing it here
 * would start a server this script cannot own, cannot pass a port to, and
 * cannot shut down on Ctrl+C. Factoring the shared part out would mean editing
 * start.js, which is out of scope for this change. The duplicated part is the
 * mtime walk and the one comparison below; if either file's build rule changes,
 * change both.
 */
function newestMtime(dir) {
  let newest = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(abs);
      else {
        try {
          newest = Math.max(newest, fs.statSync(abs).mtimeMs);
        } catch {
          /* unreadable source file: ignore, the build will report it */
        }
      }
    }
  }
  return newest;
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`))));
    child.on('error', reject);
  });
}

async function buildIfStale() {
  const bundleMtime = fs.existsSync(bundle) ? fs.statSync(bundle).mtimeMs : 0;
  const sourceMtime = newestMtime(path.join(root, 'client'));
  if (bundleMtime < sourceMtime) {
    process.stdout.write('Building client bundle...\n');
    await run('npx', ['vite', 'build']);
  } else {
    process.stdout.write('Client bundle up to date.\n');
  }
}

/* -------------------------------------------------------------- readiness probe */

/**
 * True when something answers HTTP on the port.
 *
 * Any status counts, including the 503 the server returns when the bundle is
 * missing: the question here is "is it listening and speaking HTTP", not "is
 * it healthy". A dedicated health route would be a nicer signal, but adding an
 * endpoint to server/ for the launcher's convenience is not worth widening the
 * API surface of a tool whose API surface is a stated invariant.
 *
 * The GET carries no Origin header, so it passes the server's CSRF origin
 * guard the same way curl does. It hits "/" rather than "/api/...", which
 * would need the per-start session token the launcher has no way to know.
 */
function probe() {
  return new Promise((resolve) => {
    const req = http.get(
      { host: HOST, port: PORT, path: '/', timeout: PROBE_TIMEOUT_MS },
      (res) => {
        res.resume();
        resolve(true);
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
  });
}

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
    if (await probe()) return true;
    await sleep(PROBE_INTERVAL_MS);
  }
  return false;
}

/* ------------------------------------------------------------ browser location */

/**
 * The usual per-machine and per-user install locations, in the order we prefer
 * them. Edge first because it is present on every Windows 11 box, so the common
 * case needs no fallback at all. Chrome second. Both are Chromium, so both
 * understand --app.
 *
 * ProgramFiles(x86) has to be read off process.env by name: the parentheses
 * make it an invalid identifier, so the usual property access does not exist.
 */
function browserCandidates() {
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');

  return [
    { name: 'Microsoft Edge', exe: path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe') },
    { name: 'Microsoft Edge', exe: path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe') },
    { name: 'Microsoft Edge', exe: path.join(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe') },
    { name: 'Google Chrome', exe: path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe') },
    { name: 'Google Chrome', exe: path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe') },
    { name: 'Google Chrome', exe: path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe') },
  ];
}

function findBrowser() {
  for (const candidate of browserCandidates()) {
    try {
      if (fs.statSync(candidate.exe).isFile()) return candidate;
    } catch {
      /* not installed at this location, try the next one */
    }
  }
  return null;
}

/**
 * A profile directory of our own, under %LOCALAPPDATA%\LayerCake\browser.
 *
 * Two reasons, both user-visible. Without it the app window joins the user's
 * running browser process, so it inherits their extensions and session and
 * closing their last normal window can take the app window with it. And a
 * separate profile gets a separate taskbar identity, so LayerCake pins and
 * alt-tabs as its own thing rather than as another browser window.
 *
 * The directory is not created here. The browser creates it on first run, and
 * this launcher has no reason to be the thing that writes to disk.
 */
function userDataDir() {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(localAppData, 'LayerCake', 'browser');
}

/**
 * Opens the app window and returns a description of how it was opened.
 *
 * Detached and unref'd on purpose: the browser window outlives this process
 * only in the already-running case, but in both cases it must not be killed
 * just because the launcher's console closed.
 */
function openWindow() {
  const browser = findBrowser();

  if (browser) {
    const args = [
      `--app=${appUrl}`,
      `--user-data-dir=${userDataDir()}`,
      '--no-first-run',
      '--no-default-browser-check',
    ];
    const child = spawn(browser.exe, args, { detached: true, stdio: 'ignore' });
    child.unref();
    return `${browser.name} (app mode)`;
  }

  if (process.platform === 'win32') {
    // cmd's "start" builtin, with an empty title so a quoted URL is not eaten
    // as the window title. No shell:true, so nothing here needs escaping.
    const child = spawn('cmd', ['/c', 'start', '', appUrl], { detached: true, stdio: 'ignore' });
    child.unref();
    return 'default browser (no app mode: neither Edge nor Chrome was found)';
  }

  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
  const child = spawn(opener, [appUrl], { detached: true, stdio: 'ignore' });
  child.unref();
  return `default browser via ${opener}`;
}

/* ------------------------------------------------------------------------ main */

/** Already serving: attach to it rather than fighting it for the port. */
if (await probe()) {
  process.stdout.write(
    `\nLayerCake is already running on ${appUrl}. Not starting a second server.\n`
  );
  process.stdout.write(`Opening the running instance in ${openWindow()}.\n\n`);
  process.stdout.write(
    `  To restart it instead, stop the other one first:\n` +
      `    Stop-Process -Id (Get-NetTCPConnection -LocalPort ${PORT} -State Listen).OwningProcess -Force\n\n`
  );
  process.exit(0);
}

await buildIfStale();

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

serving = true;
process.stdout.write(`Opening LayerCake in ${openWindow()}.\n`);
process.stdout.write('Close this window or press Ctrl+C to stop the server.\n\n');
