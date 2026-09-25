/**
 * The app window: find a Chromium browser, open LayerCake in app mode against a
 * profile of our own, and tell whether a server is already answering.
 *
 * Shared by scripts/launch.js (the node launcher) and desktop/main.js (the
 * single executable), so both open the same kind of window with the same flags.
 * Nothing here writes to disk; the browser creates its own profile directory.
 *
 * Windows first. It degrades on other platforms to "open the default browser",
 * because app mode and the install paths below are Windows-specific.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

export const HOST = '127.0.0.1';
const PROBE_TIMEOUT_MS = 1000;

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
export function probe(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: HOST, port, path: '/', timeout: PROBE_TIMEOUT_MS }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
  });
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
 * running browser process, so it inherits their session and closing their last
 * normal window can take the app window with it. And a separate profile gets a
 * separate taskbar identity, so LayerCake pins and alt-tabs as its own thing
 * rather than as another browser window.
 *
 * A separate profile is NOT, on its own, isolation. See APP_FLAGS.
 */
function userDataDir() {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(localAppData, 'LayerCake', 'browser');
}

/**
 * Flags for every window we open.
 *
 * --disable-sync and --disable-extensions are what make the profile actually
 * separate, and they were added after finding that it was not. On a machine
 * signed in to Windows with a Microsoft account, Edge signs a brand-new
 * --user-data-dir profile in to that account without asking and turns sync on.
 * Sync then installs the user's extensions into it. Measured 2026-09-25 on the
 * real profile: 4 synced extensions and 3 extension processes, one of them a
 * shopping extension with host access to every URL and <all_urls> content
 * scripts.
 * With both flags: 0 extension processes, and a fresh profile shows no sync
 * prompt and pulls no extensions.
 *
 * That matters more here than on an ordinary page. A content script can read
 * our DOM, and the DOM carries the session token that gates every write route
 * (security.js). The CSRF design rests on "a hostile page cannot read our
 * HTML"; an extension is not a page and is not bound by that.
 *
 * What the flags do NOT stop: Edge still attaches the Windows account identity
 * to the profile. Nothing syncs and no extension runs, but it is signed in.
 */
const APP_FLAGS = ['--no-first-run', '--no-default-browser-check', '--disable-sync', '--disable-extensions'];

/**
 * Opens an app window on `url`. Returns what was opened, plus the browser
 * process when there is one worth watching.
 *
 * Detached and unref'd: the window must not be killed because the process that
 * opened it went away, and the opener must not be kept alive by the window.
 * `child` still emits 'exit' for as long as the opener runs, which is what the
 * single executable uses to notice the window closing.
 *
 * `child` is null when the fallback opener was used, because that process exits
 * as soon as it has handed the URL on and says nothing about the window.
 */
export function openWindow(url) {
  const browser = findBrowser();

  if (browser) {
    const args = [`--app=${url}`, `--user-data-dir=${userDataDir()}`, ...APP_FLAGS];
    const child = spawn(browser.exe, args, { detached: true, stdio: 'ignore' });
    child.unref();
    return { child, description: `${browser.name} (app mode)` };
  }

  if (process.platform === 'win32') {
    // cmd's "start" builtin, with an empty title so a quoted URL is not eaten
    // as the window title. No shell:true, so nothing here needs escaping.
    const child = spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' });
    child.unref();
    return { child: null, description: 'default browser (no app mode: neither Edge nor Chrome was found)' };
  }

  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
  const child = spawn(opener, [url], { detached: true, stdio: 'ignore' });
  child.unref();
  return { child: null, description: `default browser via ${opener}` };
}

/* ------------------------------------------------------------------ error page */

const ERROR_DETAIL_MAX = 4000;

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * Shows an error in an app window, for a process that has no console to print
 * it to. The page is a data: URL, so it needs no server, which is the point:
 * this is how a server that failed to start says so.
 *
 * Escaped because the detail can carry a path or an error message, and neither
 * is ours to trust as markup. Truncated because the whole page rides on a
 * command line, and Windows caps those at 32767 characters.
 */
export function showError(title, detail) {
  const body = String(detail || '').slice(0, ERROR_DETAIL_MAX);
  const html =
    '<!doctype html><meta charset="utf-8">' +
    `<title>LayerCake: ${escapeHtml(title)}</title>` +
    '<body style="font:14px/1.5 system-ui,sans-serif;margin:24px;max-width:60em">' +
    `<h2 style="margin-top:0">${escapeHtml(title)}</h2>` +
    `<pre style="white-space:pre-wrap;background:#f4f4f4;padding:12px">${escapeHtml(body)}</pre>`;
  return openWindow(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
}
