/**
 * Terminal formatting helpers.
 *
 * Raw ANSI rather than a dependency. This project keeps its dependency list
 * deliberately short, and the CLI needs six escape codes, not a library.
 *
 * Everything here is presentation only. No helper in this file touches the
 * filesystem, which keeps the read-only posture of the CLI easy to audit: the
 * only writes the CLI can ever perform come from server/snapshot.js.
 */

import path from 'node:path';

/**
 * Color is opt-out, not opt-in.
 *
 * Disabled when stdout is not a TTY so a redirect to a file or a pipe into
 * findstr gets clean text, and when NO_COLOR is set, which is the cross-tool
 * convention. Windows Terminal and PowerShell 7 both handle these codes; the
 * legacy conhost that does not is also the one that reports isTTY false when
 * piped, so the common broken case is already covered.
 */
const COLOR = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

function wrap(open, close) {
  return (text) => (COLOR ? `\u001b[${open}m${text}\u001b[${close}m` : String(text));
}

export const paint = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  cyan: wrap(36, 39),
};

/** Visible width. Escape codes are zero width, so they must not count toward padding. */
export function width(text) {
  return String(text).replace(/\u001b\[[0-9;]*m/g, '').length;
}

/** Left-pads to `n` using the visible width, so a colored cell still lines up. */
export function padEnd(text, n) {
  const gap = n - width(text);
  return gap > 0 ? `${text}${' '.repeat(gap)}` : String(text);
}

export function padStart(text, n) {
  const gap = n - width(text);
  return gap > 0 ? `${' '.repeat(gap)}${text}` : String(text);
}

/** Usable terminal width. 100 when stdout is redirected and has no columns. */
export function termWidth() {
  return process.stdout.columns && process.stdout.columns > 40 ? process.stdout.columns : 100;
}

/**
 * Shortens a path for display by collapsing the home directory to `~`.
 *
 * Compared case-insensitively on win32 only: NTFS is case insensitive, so
 * `C:\Users\Donald` and `c:\users\donald` are the same directory and both must
 * collapse. On POSIX they are two different directories and must not.
 */
export function shortenPath(absPath, home) {
  if (!absPath || !home) return String(absPath ?? '');
  const value = String(absPath);
  const prefix = home.endsWith(path.sep) ? home : home + path.sep;
  const a = process.platform === 'win32' ? value.toLowerCase() : value;
  const b = process.platform === 'win32' ? prefix.toLowerCase() : prefix;
  if (a.startsWith(b)) return `~${path.sep}${value.slice(prefix.length)}`;
  if (a === b.slice(0, -1)) return '~';
  return value;
}

/** Middle-elides a path so the interesting tail survives a narrow terminal. */
export function elide(text, max) {
  const value = String(text);
  if (max < 8 || value.length <= max) return value;
  const tail = Math.max(4, max - 4 - Math.floor(max / 3));
  const head = max - 3 - tail;
  return `${value.slice(0, head)}...${value.slice(value.length - tail)}`;
}

/** Aligns a list of rows into columns. Last cell is never padded. */
export function columns(rows, { gap = 2, align = [] } = {}) {
  if (rows.length === 0) return [];
  const count = Math.max(...rows.map((r) => r.length));
  const widths = [];
  for (let i = 0; i < count; i += 1) {
    widths[i] = Math.max(...rows.map((r) => (r[i] == null ? 0 : width(r[i]))));
  }
  const pad = ' '.repeat(gap);
  return rows.map((row) =>
    row
      .map((cell, i) => {
        const value = cell == null ? '' : cell;
        if (i === row.length - 1) return value;
        return align[i] === 'right' ? padStart(value, widths[i]) : padEnd(value, widths[i]);
      })
      .join(pad)
      .replace(/\s+$/, '')
  );
}

export function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many || `${one}s`}`;
}

/** Human byte size. Config files are small, so one decimal place is plenty. */
export function bytes(n) {
  if (n == null) return '';
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`;
  return `${(n / (1024 * 1024)).toFixed(1)}M`;
}

/** Local wall-clock time, which is what a human comparing to Explorer sees. */
export function localTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const pad2 = (v) => String(v).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
  );
}

export function out(line = '') {
  process.stdout.write(`${line}\n`);
}

export function err(line = '') {
  process.stderr.write(`${line}\n`);
}
