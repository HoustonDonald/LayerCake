/**
 * "Start Claude here": opens a Windows Terminal tab running Claude Code in a
 * scanned project, wired for that one session to report to LayerCake.
 *
 *   wt -w LayerCake [--pos x,y --size cols,rows] new-tab --title "Claude: <project>"
 *      --suppressApplicationTitle -d <project> claude --session-id <uuid> --settings <file>
 *
 * The settings file adds, for that session only (Claude Code documents
 * --settings as a settings level that "lasts one session and doesn't write to
 * any file"), a status line that forwards its JSON to LayerCake and prints the
 * line LayerCake returns, and http hooks for the documented events. Nothing is
 * written to the user's own settings. Both cost no Claude usage: a status line
 * is displayed, never sent to the model, and the hooks' responses are empty.
 *
 * A new capability, stated: this starts a process. The argv is fixed; the only
 * inputs are the project directory, which comes from a scan result and never
 * from the request, and screen dimensions, which are validated numbers. The
 * settings go in a file rather than on the command line because Windows
 * Terminal splits its arguments on ";" and re-quotes the rest, and a project
 * path containing ";" is refused for the same reason (refuseTerminalSeparator).
 */

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';

import { writeLaunch } from './appdata.js';
import { registerLaunch } from './ingest.js';

/** Documented hook events worth showing (docs: hooks, as of Claude Code 2.1.283). */
export const HOOK_EVENTS = [
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'PermissionDenied',
  'Notification',
  'Stop',
  'StopFailure',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'InstructionsLoaded',
  'SessionEnd',
];

/** Seconds. Short, because a hook that hangs holds up the tool call it belongs to. */
const HOOK_TIMEOUT_S = 3;

/**
 * The status line runs through Git Bash when it is installed, otherwise
 * PowerShell (docs: status line, "Windows configuration"). curl.exe ships with
 * Windows 10 and later; naming it with .exe avoids PowerShell 5.1's `curl`
 * alias for Invoke-WebRequest, and every argument is quoted the same way in
 * both shells. If LayerCake is not running, curl prints nothing and the status
 * line is simply blank.
 */
export function buildSettings(base) {
  const hook = [{ hooks: [{ type: 'http', url: `${base}/hook`, timeout: HOOK_TIMEOUT_S }] }];
  return {
    statusLine: {
      type: 'command',
      command: `curl.exe -s --max-time 1 -H "Content-Type: application/json" --data-binary "@-" "${base}/statusline"`,
      padding: 0,
    },
    hooks: Object.fromEntries(HOOK_EVENTS.map((event) => [event, hook])),
  };
}

/**
 * Where to put the terminal window, from the screen size the page reported:
 * the right half. --pos is in pixels; --size is in character cells, so the
 * cell size here is an assumption (Cascadia Mono 12pt at 100% scale, about
 * 9 x 20 px) and the result approximate. Anything implausible means no
 * placement at all rather than a wrong one.
 */
function placement(screen) {
  const w = Number(screen?.width);
  const h = Number(screen?.height);
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 800 || h < 500 || w > 20000 || h > 20000) return [];
  const half = Math.floor(w / 2);
  const cols = Math.max(60, Math.floor(half / 9));
  const rows = Math.max(20, Math.floor((h - 80) / 20));
  return ['--pos', `${half},0`, '--size', `${cols},${rows}`];
}

/**
 * Windows Terminal reads ";" in its own command line as the start of another
 * subcommand, inside a quoted argument too (a literal one must be written
 * "\;"). The project directory reaches wt twice, as -d and inside --title, and
 * its name is chosen by whoever made the folder: one unpacked from an archive
 * as "x;calc.exe" would start calc.exe from this button (#20). Refused, not
 * escaped: a real project path with ";" is rare, and a refusal cannot be got
 * subtly wrong the way an escaping rule can. Checked before anything is
 * written, so a refused launch leaves no record or settings file behind.
 */
function refuseTerminalSeparator(dir) {
  if (!dir.includes(';')) return;
  const err = new Error(
    `Not started: the project path contains ";", which Windows Terminal treats as a command separator. ` +
      `Rename the folder to start Claude here from LayerCake. (${dir})`
  );
  err.status = 400;
  throw err;
}

export async function launchClaude({ dir, port, screen }) {
  refuseTerminalSeparator(dir);
  const id = crypto.randomBytes(8).toString('hex');
  const secret = crypto.randomBytes(24).toString('hex');
  const sessionId = crypto.randomUUID();
  const base = `http://127.0.0.1:${port}/ingest/${id}/${secret}`;
  const settings = buildSettings(base);
  const record = { id, secret, dir, sessionId, createdAt: new Date().toISOString() };
  const settingsPath = await writeLaunch(record, settings);
  registerLaunch(record);

  const argv = [
    '-w',
    'LayerCake',
    ...placement(screen),
    'new-tab',
    '--title',
    `Claude: ${path.basename(dir) || dir}`,
    '--suppressApplicationTitle',
    '-d',
    dir,
    'claude',
    '--session-id',
    sessionId,
    '--settings',
    settingsPath,
  ];

  // For the smoke test: everything but the process start.
  if (process.env.LAYERCAKE_LAUNCH_DRY_RUN === '1') {
    return { launchId: id, sessionId, dryRun: true, argv, settingsPath };
  }

  await new Promise((resolve, reject) => {
    const child = spawn('wt.exe', argv, { detached: true, stdio: 'ignore' });
    child.once('error', (err) =>
      reject(err.code === 'ENOENT' ? new Error('Windows Terminal (wt.exe) was not found.') : err)
    );
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
  return { launchId: id, sessionId };
}
