/**
 * "Start Claude here": opens a Windows Terminal tab running Claude Code in a
 * scanned project, wired for that one session to report to LayerCake. Where
 * Windows Terminal is not installed, a console window instead (consoleStart).
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

import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';

import { writeLaunch } from './appdata.js';
import { STATUS_REFRESH_S, registerLaunch } from './ingest.js';
import { WINDOWS_POWERSHELL, encodeCommand, psQuote, psWildcardEscape, winArgQuote } from './powershell.js';
import { resolveClaudeCommand } from './summaries.js';

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
      // Re-run on a timer as well as on events (docs: status line,
      // refreshInterval), so a running session is never silent for long and
      // silence becomes evidence that it stopped (ingest.js, #31).
      refreshInterval: STATUS_REFRESH_S,
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
function refuseTerminalSeparator(value, what = 'the project path') {
  if (!value.includes(';')) return;
  const err = new Error(
    `Not started: ${what} contains ";", which Windows Terminal treats as a command separator. ` +
      `Rename the folder to start Claude here from LayerCake. (${value})`
  );
  err.status = 400;
  throw err;
}

/**
 * Where Windows Terminal is not installed (stock Windows 10, or removed from a
 * managed machine), Claude Code opens in a console window of its own instead:
 * the same program and arguments, with no tab name and no placement.
 *
 * Node cannot open one itself. A detached console program gets no console at
 * all (it never ran, measured), and one that is not detached is ended when
 * LayerCake exits. conhost.exe <program> lost programs whose path has a space.
 * So Windows PowerShell 5.1, hidden, runs Start-Process, a cmdlet, so it also
 * works where PowerShell is held to Constrained Language Mode (measured; a
 * .NET Process.Start is refused there). The script goes as -EncodedCommand, so
 * no command line parses it; each value is a single-quoted literal; the
 * working directory's wildcard characters are escaped; the argument string
 * follows the Windows rules. Measured with folder and file names holding
 * & % ; ^ ' ’ [ ] ` $ and non-ASCII: arguments and working directory arrived
 * intact, in a visible console.
 */
export function consoleStart(dir, program) {
  const [file, ...args] = program;
  const script =
    "$ProgressPreference = 'SilentlyContinue'; " +
    `Start-Process -FilePath ${psQuote(file)} -ArgumentList ${psQuote(args.map(winArgQuote).join(' '))} ` +
    `-WorkingDirectory ${psQuote(psWildcardEscape(dir))}`;
  return { file, args, dir, script };
}

/**
 * Only a guard against a PowerShell that never returns. The start usually takes
 * about 0.5 s, but a fresh Windows Sandbox once took over 10 s, and a start
 * cut off then may still open Claude Code after LayerCake has reported that it
 * failed, inviting a second click and a second session.
 */
const CONSOLE_START_TIMEOUT_MS = 60_000;

/**
 * PowerShell's own words for a failed start. With -EncodedCommand its errors
 * arrive on stderr as CLIXML: each line an <S S="Error"> element, line breaks
 * written _x000D__x000A_. The first line says what went wrong ("Start-Process
 * : This command cannot be run due to the error: The system cannot find the
 * file specified."); the rest is the position in the script.
 */
export function powershellError(stderr) {
  const lines = [...String(stderr || '').matchAll(/<S S="Error">([\s\S]*?)<\/S>/g)].map((m) =>
    m[1].replace(/_x000D__x000A_/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&').trim()
  );
  return lines.find(Boolean) || null;
}

function startInConsole(plan) {
  return new Promise((resolve, reject) => {
    execFile(
      WINDOWS_POWERSHELL,
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodeCommand(plan.script)],
      { windowsHide: true, timeout: CONSOLE_START_TIMEOUT_MS },
      (err, _stdout, stderr) => {
        if (!err) return resolve();
        const why = powershellError(stderr) || (err.killed ? `no answer in ${CONSOLE_START_TIMEOUT_MS / 1000} s` : `exit ${err.code ?? err.message}`);
        reject(new Error(`Windows Terminal was not found, and starting Claude Code in a console window failed: ${why}`));
      }
    );
  });
}

export async function launchClaude({ dir, port, screen }) {
  refuseTerminalSeparator(dir);
  // The program wt starts: 'claude' when claude.exe is on PATH, else node plus
  // the npm shim's script (#6). Resolved and checked before anything is
  // written, so a refused launch still leaves no record behind.
  const claude = await resolveClaudeCommand();
  for (const part of claude) refuseTerminalSeparator(part, "Claude Code's program path");
  const id = crypto.randomBytes(8).toString('hex');
  const secret = crypto.randomBytes(24).toString('hex');
  const sessionId = crypto.randomUUID();
  const base = `http://127.0.0.1:${port}/ingest/${id}/${secret}`;
  const settings = buildSettings(base);
  const record = { id, secret, dir, sessionId, createdAt: new Date().toISOString() };
  const settingsPath = await writeLaunch(record, settings);
  registerLaunch(record);

  const program = [...claude, '--session-id', sessionId, '--settings', settingsPath];
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
    ...program,
  ];
  const fallback = consoleStart(dir, program);

  // For the smoke test: everything but the process start, both ways.
  if (process.env.LAYERCAKE_LAUNCH_DRY_RUN === '1') {
    return { launchId: id, sessionId, dryRun: true, argv, console: fallback, settingsPath };
  }

  const started = await new Promise((resolve, reject) => {
    const child = spawn('wt.exe', argv, { detached: true, stdio: 'ignore' });
    child.once('error', (err) => (err.code === 'ENOENT' ? resolve(false) : reject(err)));
    child.once('spawn', () => {
      child.unref();
      resolve(true);
    });
  });
  if (!started) await startInConsole(fallback);
  return { launchId: id, sessionId, terminal: started ? 'windows-terminal' : 'console' };
}
