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

/**
 * Middle-elides a path at a separator (#124): the tail keeps whole trailing
 * segments, as many as still leave the head a third of the room (at most 10
 * characters), and the head takes what room is left, cut mid-segment if it
 * must. `elide` alone cuts both ends mid-segment. A tail that took all but a
 * few characters would drop the one segment that tells two paths apart, such
 * as the skill in skills\<skill>\references\details.md. A path whose last
 * segment alone is too long falls back to `elide`.
 */
export function elidePath(text, max) {
  const value = String(text);
  if (max < 8 || value.length <= max) return value;
  const minHead = Math.min(10, Math.floor(max / 3));
  let tail = '';
  for (let i = value.length - 1; i > 0; i -= 1) {
    if (value[i] !== '\\' && value[i] !== '/') continue;
    if (value.length - i + 3 + minHead > max) break;
    tail = value.slice(i);
  }
  if (!tail) return elide(value, max);
  return `${value.slice(0, max - 3 - tail.length)}...${tail}`;
}

/** Widest visible cell of each column. */
export function columnWidths(rows) {
  const count = Math.max(...rows.map((r) => r.length));
  const widths = [];
  for (let i = 0; i < count; i += 1) {
    widths[i] = Math.max(...rows.map((r) => (r[i] == null ? 0 : width(r[i]))));
  }
  return widths;
}

function joinRow(row, widths, gap, align) {
  return row
    .map((cell, i) => {
      const value = cell == null ? '' : cell;
      if (i === row.length - 1) return value;
      return align[i] === 'right' ? padStart(value, widths[i]) : padEnd(value, widths[i]);
    })
    .join(' '.repeat(gap))
    .replace(/\s+$/, '');
}

/** Aligns a list of rows into columns. Last cell is never padded. */
export function columns(rows, { gap = 2, align = [] } = {}) {
  if (rows.length === 0) return [];
  const widths = columnWidths(rows);
  return rows.map((row) => joinRow(row, widths, gap, align));
}

/**
 * columns(), fitted to `max` visible characters (#124). Only the `flex` column
 * (never the last) gives way; every other column keeps its full width, because
 * those hold the sizes, statuses and markers a reader must not lose. A flex
 * cell is a path, shortened with elidePath, or a function that is given the
 * width it may take and returns its text.
 *
 * With `spill`, a flex cell that does not fit is not shortened to the column:
 * it goes on a line of its own, where it has the whole width, and the rest of
 * its row goes on the line below, under its columns, the way a man page sets a
 * long option name. For tables whose path is the point, where the other
 * columns leave the path too little room to be recognisable once cut.
 */
export function fitColumns(rows, max, { flex = 0, spill = false, gap = 2, align = [] } = {}) {
  if (rows.length === 0) return [];
  const text = (cell, room) => (typeof cell === 'function' ? cell(room) : elidePath(cell ?? '', room));
  const full = rows.map((row) => row.map((cell, i) => (i === flex ? text(cell, Infinity) : cell)));
  const lines = columns(full, { gap, align });
  if (lines.every((line) => width(line) <= max)) return lines;

  const widths = columnWidths(full);
  const room = max - widths.reduce((sum, w, i) => (i === flex ? sum : sum + w), 0) - gap * (widths.length - 1);
  if (!spill) {
    return columns(
      rows.map((row) => row.map((cell, i) => (i === flex ? text(cell, room) : cell))),
      { gap, align }
    );
  }

  const spilled = full.map((row) => width(row[flex]) > room);
  // Widths from the rows that stay on one line, so one long path does not
  // push every other row's columns out to where it ends.
  const table = full.map((row, r) => (spilled[r] ? row.map((c, i) => (i === flex ? '' : c)) : row));
  const kept = columnWidths(table);
  const result = [];
  full.forEach((row, r) => {
    if (!spilled[r]) {
      result.push(joinRow(row, kept, gap, align));
      return;
    }
    const lead = row.slice(0, flex);
    const leadWidth = lead.reduce((sum, _, i) => sum + kept[i] + gap, 0);
    result.push(joinRow([...lead, text(rows[r][flex], max - leadWidth)], kept, gap, align));
    result.push(joinRow(row.map((c, i) => (i <= flex ? '' : c)), kept, gap, align));
  });
  return result;
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
