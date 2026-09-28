/**
 * Rendering. Every line the CLI prints is produced here.
 *
 * Separated from cli/index.js so argument handling stays readable, and from
 * cli/summary.js so the numbers and their presentation can change
 * independently.
 *
 * A view that computes an effective value prints the rule that produced it,
 * because the merge and shadowing models are this tool's own rather than
 * something read back out of Claude Code. Dropping the rule to save two lines
 * would turn a stated model into an implied one, which is the failure mode the
 * project exists to avoid.
 */

import path from 'node:path';

import { CLAUDE_DIR_TREES } from '../server/paths.js';
import {
  bytes,
  columns,
  columnWidths,
  elide,
  elidePath,
  fitColumns,
  localTime,
  out,
  padEnd,
  padStart,
  paint,
  plural,
  shortenPath,
  termWidth,
  width,
} from './format.js';
/** How many extra routes reached the files behind one name (flatten's alsoReachedFrom). */
function otherRoutes(definitions) {
  return definitions.reduce((n, d) => n + (d.alsoReachedFrom?.length || 0), 0);
}

const LABEL = 15;

/** Tail-truncates. Prose reads better cut at the end than elided in the middle. */
function clamp(text, max) {
  const value = String(text).replace(/\s+/g, ' ').trim();
  return value.length <= max ? value : `${value.slice(0, Math.max(4, max - 3))}...`;
}

/**
 * Greedy wrap. Rule text is prose, so word boundaries are the only break points.
 * Measured by visible width, so text that was painted before it was wrapped
 * breaks where it looks as if it should (#124). A word longer than `max` is
 * left whole on a line of its own rather than cut.
 */
function wrapText(text, max, indent = '') {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    // A bare escape code (the tail of a painted run) joins its line unspaced.
    if (width(word) === 0) {
      line += word;
    } else if (width(line) && width(line) + 1 + width(word) > max) {
      lines.push(line);
      line = word;
    } else {
      line = width(line) ? `${line} ${word}` : `${line}${word}`;
    }
  }
  if (line) lines.push(line);
  return lines.map((l) => `${indent}${l}`);
}

/**
 * Prints `text` after `lead` on one line when it fits the terminal, else wraps
 * it at spaces, the first line after `lead` and the rest after `hang` (#124).
 * A line that fits is printed untouched, which keeps a padded column's spacing.
 */
function fitLine(lead, text, hang = lead) {
  const w = termWidth();
  if (width(lead) + width(text) <= w) {
    out(`${lead}${text}`);
    return;
  }
  wrapText(text, w - Math.max(width(lead), width(hang))).forEach((line, i) => out(`${i ? hang : lead}${line}`));
}

/**
 * A path, then a short note beside it (#124). The path gives way first, by
 * middle elision, down to half the line; past that the note goes on the lines
 * below, after `hang`, and the path keeps the whole line. Either way the note
 * is printed whole: it is a code, a scope or a reason, not decoration.
 */
function pathWithNote(lead, pathText, note, hang, painter = (t) => t) {
  const w = termWidth();
  const line = w - width(lead);
  const room = line - (note ? 2 + width(note) : 0);
  if (!note || pathText.length <= room || room >= line / 2) {
    out(`${lead}${painter(elidePath(pathText, Math.max(20, room)))}${note ? `  ${painter(note)}` : ''}`);
    return;
  }
  out(`${lead}${painter(elidePath(pathText, line))}`);
  for (const l of wrapText(note, w - width(hang))) out(`${hang}${painter(l)}`);
}

/**
 * Header fields, `sep` apart, on as few lines as the terminal allows (#124). A
 * field moves to the next line whole rather than being cut; one wider than the
 * terminal on its own is wrapped at its spaces.
 */
function packFields(fields, sep = '   ') {
  const w = termWidth();
  const lines = [];
  let line = '';
  for (const field of fields.filter(Boolean)) {
    if (line && width(line) + sep.length + width(field) <= w) {
      line = `${line}${sep}${field}`;
      continue;
    }
    if (line) lines.push(line);
    const parts = width(field) > w ? wrapText(field, w) : [field];
    lines.push(...parts.slice(0, -1));
    line = parts[parts.length - 1];
  }
  if (line) lines.push(line);
  return lines;
}

function printRule(rule) {
  const max = Math.max(40, termWidth() - 4);
  for (const line of wrapText(rule, max, '  ')) out(paint.dim(line));
}

function statusPaint(status) {
  if (status === 'error') return paint.red(`[${status}]`);
  if (status === 'partial') return paint.yellow(`[${status}]`);
  if (status === 'found') return paint.green(`[${status}]`);
  return paint.dim(`[${status}]`);
}

function labelled(label, value) {
  fitLine(padEnd(paint.bold(label), LABEL), value, ' '.repeat(LABEL));
}

function continued(value) {
  fitLine(' '.repeat(LABEL), value);
}

/**
 * The file count is of distinct files; this says how many of them the directory
 * walk reached a second time, so the levels' own lists add up (#125).
 */
function reachedTwice(n) {
  return n ? ` (${n} reached twice)` : '';
}

/* ------------------------------------------------------------------ here -- */

export function renderHere(summary) {
  const home = summary.home;
  const w = termWidth();

  out(paint.bold(summary.projectDir));
  const header = packFields([
    summary.platform,
    `home ${home}`,
    `scanned ${localTime(summary.scannedAt)}`,
    `${plural(summary.fileCount, 'config file')}${reachedTwice(summary.repeatedFileCount)} ` +
      `across ${plural(summary.levels.total, 'level')}`,
  ]);
  for (const line of header) out(paint.dim(line));
  out();

  // Weakest first, which is the order Claude Code reads them and therefore the
  // order in which a later file wins a conflict.
  const shown = summary.instructions.slice(0, 5);
  labelled('Instructions', `${plural(summary.instructions.length, 'file')}, weakest first`);
  shown.forEach((file, i) => {
    const flag = file.error ? `  ${file.error.code}` : '';
    const room = w - LABEL - 3 - flag.length;
    continued(
      `${paint.dim(String(i + 1).padStart(2))} ${elidePath(shortenPath(file.path, home), room)}${flag ? paint.red(flag) : ''}`
    );
  });
  if (summary.instructions.length > shown.length) {
    continued(paint.dim(`   +${summary.instructions.length - shown.length} more, see: layercake show claude-md`));
  }
  if (summary.instructionsRepeated) {
    continued(
      paint.dim(
        `   ${plural(summary.instructionsRepeated, 'file')} reached again by the directory walk, loaded once`
      )
    );
  }
  if (summary.instructionsConditional) {
    continued(
      paint.dim(`   ${plural(summary.instructionsConditional, 'rule')} loaded only when a matching file is read`)
    );
  }

  const defRows = summary.definitions.map((d) => [
    `${d.category}s`,
    `${d.active} active`,
    d.shadowed ? paint.yellow(`${d.shadowed} shadowed`) : paint.dim('0 shadowed'),
  ]);
  const defLines = columns(defRows);
  labelled('Definitions', defLines[0] || paint.dim('none'));
  for (const line of defLines.slice(1)) continued(line);
  continued(
    paint.dim(
      summary.counted.map((c) => `${c.category}s ${c.files} ${c.files === 1 ? 'file' : 'files'}`).join('   ')
    )
  );

  const mcpHead = summary.mcp.total
    ? `${plural(summary.mcp.total, 'server')} configured` +
      (summary.mcp.shadowed ? paint.yellow(`, ${summary.mcp.shadowed} shadowed`) : '')
    : paint.dim('none configured');
  labelled('MCP servers', mcpHead);
  if (summary.mcp.names.length) {
    continued(paint.dim(elide(summary.mcp.names.join(', '), w - LABEL - 1)));
  }
  if (summary.mcp.repeated) {
    continued(
      paint.dim(`${plural(summary.mcp.repeated, 'server')} reached again by the directory walk, defined once`)
    );
  }
  if (summary.mcp.badSources) {
    continued(paint.yellow(`${plural(summary.mcp.badSources, 'source')} unreadable or unparseable`));
  }
  if (summary.mcp.notRead.length) {
    continued(
      paint.yellow(
        `${plural(summary.mcp.notRead.length, 'file')} found but not read by Claude Code, see: layercake show mcp`
      )
    );
  }
  if (summary.mcp.exclusive) {
    continued(
      paint.yellow(
        `managed-mcp.json has exclusive control: ${plural(summary.mcp.blocked, 'other source')} not loaded, see: layercake show mcp`
      )
    );
  }

  labelled(
    'Settings',
    summary.settings.empty
      ? paint.dim(
          summary.settings.notRead
            ? `nothing merged; ${summary.settings.notRead} found but not read by Claude Code`
            : 'no settings files on this chain'
        )
      : `${plural(summary.settings.files, 'file')} merged` +
          (summary.settings.unreadable ? paint.yellow(`, ${summary.settings.unreadable} unreadable`) : '') +
          (summary.settings.notRead ? paint.dim(`, ${summary.settings.notRead} found but not read by Claude Code`) : '')
  );
  for (const [key, value] of summary.settings.highlights) {
    fitLine(`${' '.repeat(LABEL)}${paint.dim(padEnd(key, 14))} `, value, ' '.repeat(LABEL + 15));
  }
  // Which managed source applies (#147), said only when there is one to say.
  const managed = summary.managed;
  for (const file of managed.fatal) {
    continued(paint.red(`managed policy does not parse, which Claude Code treats as fatal: ${file}`));
  }
  if (managed.used.length || managed.skipped.length || managed.remoteCache) {
    continued(
      `managed policy: ${managed.used.length ? managed.used.join(' + ') : 'none applies'} (${managed.behavior})` +
        (managed.skipped.length ? paint.yellow(`; skipped: ${managed.skipped.join(', ')}`) : '')
    );
    if (managed.remoteCache) {
      continued(paint.yellow('server-managed settings cached: they outrank the above and are not merged here'));
    }
  }

  labelled(
    'Levels',
    `${summary.levels.total} scanned, ${summary.levels.withContent} with content, ` +
      `${summary.levels.empty} empty` +
      (summary.levels.errored ? paint.yellow(`, ${summary.levels.errored} with errors`) : '')
  );
  labelled(
    'Health',
    (summary.errorCount ? paint.yellow(plural(summary.errorCount, 'error')) : paint.green('0 errors')) +
      paint.dim(`   ${plural(summary.redactedCount, 'credential file')} never opened`)
  );
}

/* ------------------------------------------------------------------ tree -- */

/**
 * The name cell of a tree row: its path relative to the level, or, for a
 * plugin's file, the plugin's name and then its path inside the installed
 * version, as the page labels it (#124). The cache\<marketplace>\<plugin>\
 * <version> folders above it are the part a narrow terminal elided, and two
 * plugins' agents\frontend-developer.md then read the same. The name is never
 * elided, only the path after it, so a plugin row is a function of its room.
 * The category's own folder (agents\, skills\) is left off too, since the
 * category heads the group: it is the room a skill's folder name needs to
 * tell two skills' references\details.md apart.
 */
function entryLabel(entry, home) {
  // relPath is relative to the level's directory, so a target that sits
  // beside that directory rather than inside it (~/.claude.json against the
  // ~/.claude level) comes back as `..\name`. Show those absolute instead:
  // a leading `..` reads as a mistake when the point is where the file is.
  if (entry.relPath.startsWith('..')) return shortenPath(entry.absPath, home);
  if (!entry.plugin) return entry.relPath;
  // scan.js sets `plugin` to <marketplace>/<plugin> for a file under
  // cache\<marketplace>\<plugin>\<version>\. A path of any other shape is
  // shown as scanned rather than guessed at.
  const [market, folder] = entry.plugin.split('/');
  const parts = entry.relPath.split(/[\\/]/);
  if (parts.length < 5 || parts[1] !== market || parts[2] !== folder) return entry.relPath;
  const tree = CLAUDE_DIR_TREES.find((t) => t.category === entry.category);
  const inside = parts.slice(tree && parts.length > 5 && parts[4] === tree.name ? 5 : 4).join(path.sep);
  const lead = `${entry.pluginName || folder} > `;
  return (room) => `${lead}${elidePath(inside, room - lead.length)}`;
}

export function renderTree(lineage, { all }) {
  const home = lineage.home;
  const w = termWidth();
  out(paint.bold(lineage.projectDir));
  const header = packFields([
    `${plural(lineage.summary.levelCount, 'level')}, ` +
      `${plural(lineage.summary.fileCount, 'file')}${reachedTwice(lineage.summary.repeatedFileCount)}, ` +
      `${plural(lineage.summary.errorCount, 'error')}, ${lineage.summary.redactedCount} redacted`,
    lineage.platform,
    `scanned ${localTime(lineage.scannedAt)}`,
  ]);
  for (const line of header) out(paint.dim(line));
  if (!all) out(paint.dim('probed-but-absent paths hidden, pass --all to show them'));
  out();

  // The label and status columns are as wide as this lineage needs, and the
  // directory takes the rest of the line (#124); a fixed 34 and 48 let a
  // header reach 98 characters whatever the terminal.
  const labelWidth = Math.max(...lineage.levels.map((l) => l.label.length));
  const statusWidth = Math.max(...lineage.levels.map((l) => l.status.length + 2));
  for (const level of lineage.levels) {
    const index = paint.dim(String(level.precedence).padStart(2, '0'));
    const lead = `${index}  ${padEnd(paint.bold(level.label), labelWidth)}  ${padEnd(statusPaint(level.status), statusWidth)}  `;
    const dir = level.dir ? paint.dim(elidePath(shortenPath(level.dir, home), Math.max(20, w - width(lead)))) : '';
    out(`${lead}${dir}`.replace(/\s+$/, ''));
    if (all && level.note) {
      for (const line of wrapText(level.note, Math.max(40, w - 8), '      ')) out(paint.dim(line));
    }

    // Entries arrive sorted by category then relative path, so grouping is a
    // single pass rather than a re-sort.
    const groups = new Map();
    for (const entry of level.entries) {
      if (!groups.has(entry.category)) groups.set(entry.category, []);
      groups.get(entry.category).push(entry);
    }
    for (const [category, entries] of groups) {
      out(`    ${paint.cyan(category)} ${paint.dim(`(${entries.length})`)}`);
      const rows = entries.map((entry) => [
        entryLabel(entry, home),
        entry.type === 'dir' ? paint.dim('dir') : paint.dim(bytes(entry.size)),
        entry.error
          ? paint.red(entry.error.code)
          : entry.inactive
            ? paint.yellow(entry.pluginId ? 'not loaded' : 'not read')
            : entry.sensitive
              ? paint.yellow('sensitive')
              : '',
      ]);
      for (const line of fitColumns(rows, w - 6)) out(`      ${line}`);
    }

    // Errors are never hidden. A level that half-scanned is a fact about the
    // environment, not noise, and --all is about absence rather than failure.
    if (level.errors.length) {
      out(`    ${paint.red('errors')} ${paint.dim(`(${level.errors.length})`)}`);
      for (const e of level.errors) {
        const where = shortenPath(e.path, home);
        const code = String(e.code ?? '');
        const message = String(e.message ?? '');
        if (6 + where.length + 2 + code.length + 1 + message.length <= w) {
          out(`      ${where}  ${paint.red(code)} ${paint.dim(message)}`);
          continue;
        }
        // A system message often repeats the path, so it gets lines of its own.
        pathWithNote('      ', where, code, '        ', paint.red);
        for (const line of wrapText(message, w - 8, '        ')) out(paint.dim(line));
      }
    }

    if (level.other.length) {
      out(`    ${paint.dim('other')} ${paint.dim(`(${level.other.length})`)}`);
      const name = (o) => o.name + (o.type === 'dir' ? path.sep : '');
      const lines = level.other.map((o) => `      ${padEnd(name(o), 28)} ${paint.dim(o.note || '')}`);
      if (lines.every((line) => width(line) <= w)) {
        for (const line of lines) out(line);
      } else {
        // Too wide to sit beside the names (a plugin's uninstalled cached
        // versions carry a sentence each): the names one per line and each
        // note wrapped under the run of names it applies to, once, as the MCP
        // view gives a repeated reason once (#121).
        level.other.forEach((o, i) => {
          out(`      ${elidePath(name(o), w - 6)}`);
          const next = level.other[i + 1];
          if (o.note && next?.note !== o.note) {
            for (const line of wrapText(o.note, w - 8, '        ')) out(paint.dim(line));
          }
        });
      }
    }

    if (all) {
      if (level.absent.length) {
        out(`    ${paint.dim('absent')} ${paint.dim(`(${level.absent.length})`)}`);
        for (const a of level.absent) {
          out(paint.dim(`      ${elidePath(shortenPath(a.absPath, home), w - 6)}`));
        }
      }
      if (level.redacted.length) {
        out(`    ${paint.yellow('redacted')} ${paint.dim(`(${level.redacted.length})`)}`);
        for (const r of level.redacted) {
          pathWithNote('      ', shortenPath(r.absPath, home), r.reason, '        ', paint.dim);
        }
      }
    }
    out();
  }
}

/* ------------------------------------------------------------------ show -- */

function renderMemoryView(view, lineage) {
  out(paint.bold(view.heading));
  printRule(view.rule);
  out();
  // flattenMemory already emits a repeated file once, at the weakest level
  // where it is first loaded, so there is nothing to suppress here. A level
  // whose only instruction files were repeats still carries repeatedNote, so
  // print those levels too: the repetition is worth explaining, and dropping
  // the note would leave a gap in the chain with no reason given.
  const shown = view.sections.filter((s) => !s.empty || s.repeatedNote);
  for (const section of shown) {
    // Not a markdown heading: the file bodies below are markdown and routinely
    // contain their own ### headings, so a marker that could be mistaken for
    // one would make the level boundaries invisible in a piped, colorless read.
    // The closing marker is dropped when it would not fit (#124); the opening
    // one is what marks the boundary, and the title holds a directory.
    const marker = `===== ${shortenTitle(section.title, lineage.home)}`;
    out(paint.cyan(marker.length + 6 <= termWidth() ? `${marker} =====` : marker));
    if (section.repeatedNote) {
      out(paint.dim(`  ${section.repeatedNote}`));
      for (const repeated of section.repeatedPaths || []) {
        out(paint.dim(`    ${shortenPath(repeated, lineage.home)}`));
      }
    }
    for (const file of section.files) {
      out(paint.dim(`# ${shortenPath(file.path, lineage.home)}${file.truncated ? '  (truncated at the read cap)' : ''}`));
      if (file.conditional) out(paint.yellow(`  ${file.conditional}`));
      if (file.error) {
        out(paint.red(`  ${file.error.code}: ${file.error.message}`));
        continue;
      }
      out();
      out(file.content.replace(/\s+$/, ''));
      out();
    }
  }
  const skipped = view.sections.length - shown.length;
  if (skipped) out(paint.dim(`${plural(skipped, 'level')} contributed no instruction file.`));
}

/** Level titles embed a directory; collapse home in it the same way paths get collapsed. */
function shortenTitle(title, home) {
  const text = String(title);
  return home ? text.replace(home, shortenPath(home, home)) : text;
}

/** One string value on a line of JSON.stringify(value, null, 2): indent, optional key, the string, a comma. */
const JSON_STRING_LINE = /^(\s*(?:"(?:[^"\\]|\\.)*": )?)"((?:[^"\\]|\\.)*)"(,?)$/;

/**
 * One line of the merge dump, cut to `max` when a long string value is what
 * makes it wide: #124 met a 9,811-character allow rule with a newline in it.
 * The value keeps its opening, the cut is marked with an ellipsis, and the
 * note beside it gives the value's real length and, when it holds newlines,
 * its line count, so a cut value is never taken for the whole one.
 * JSON.stringify has already escaped every newline, so a line of the dump is
 * one line on the terminal. A line that is not a string value, or whose width
 * comes from its key rather than its value, is left as is.
 */
function clampJsonLine(line, max) {
  if (line.length <= max) return line;
  const match = JSON_STRING_LINE.exec(line);
  if (!match) return line;
  const [, lead, body, comma] = match;
  const value = JSON.parse(`"${body}"`);
  const lines = value.split(/\r\n|\r|\n/).length;
  const note = `(${plural(value.length, 'character')}${lines > 1 ? `, ${lines} lines` : ''})`;
  // Quote, ellipsis, quote, the comma, two spaces, the note.
  const room = Math.max(8, max - lead.length - 5 - comma.length - 2 - note.length);
  if (body.length <= room) return line;
  // Never end inside an escape: half of \" or \u0000 would print as a stray backslash.
  let head = body.slice(0, room).replace(/\\u[0-9a-fA-F]{0,3}$/, '');
  if ((/\\+$/.exec(head)?.[0].length ?? 0) % 2) head = head.slice(0, -1);
  return `${lead}"${head}..."${comma}  ${paint.dim(note)}`;
}

/**
 * A dotted key in lines of at most `max`, broken after a dot as the page breaks
 * it (#129), a part longer than a line cut where it must be. Lines after the
 * first are indented two, so a continuation does not read as a key of its own.
 */
function breakKey(key, max) {
  if (key.length <= max) return [key];
  const lines = [];
  let line = '';
  const room = () => Math.max(8, lines.length ? max - 2 : max);
  for (const part of key.split(/(?<=\.)/)) {
    if (line && line.length + part.length > room()) {
      lines.push(line);
      line = '';
    }
    line += part;
    while (line.length > room()) {
      const cut = room();
      lines.push(line.slice(0, cut));
      line = line.slice(cut);
    }
  }
  if (line) lines.push(line);
  return lines.map((l, i) => (i ? `  ${l}` : l));
}

/**
 * The provenance table (#124): each key, how it merged, and the settings level
 * (user, project, local, managed) it came from, whose file Sources names. A
 * combined list names every level that added to it with its count, on one line
 * when they fit and one per line when not, so a count is never elided away. A
 * key too long for its column breaks after a dot onto the lines below.
 */
function provenanceLines(provenance, max) {
  const MODES = { concat: 'combined', replace: 'taken whole', 'replace+concat': 'taken whole, then combined' };
  const mode = (p) => (MODES[p.mode] ? paint.yellow(MODES[p.mode]) : paint.dim(p.mode));
  // A managed source names its file or registry value: there can be several (#147).
  const name = (s) => (s.part ? `${s.source}:${s.part}` : s.source);
  const froms = (p) => p.sources.map((s) => (Array.isArray(s.added) && p.mode !== 'replace' ? `${name(s)} +${s.added.length}` : name(s)));
  const modeWidth = Math.max(...provenance.map((p) => width(mode(p))));
  const fromWidth = Math.max(...provenance.flatMap((p) => froms(p).map((f) => f.length)));
  const keyWidth = Math.min(
    Math.max(...provenance.map((p) => p.keyPath.length)),
    Math.max(20, max - modeWidth - fromWidth - 4)
  );
  const lines = [];
  for (const p of provenance) {
    const keys = breakKey(p.keyPath, keyWidth);
    const joined = froms(p).join(', ');
    const from = keyWidth + modeWidth + 4 + joined.length <= max ? [joined] : froms(p);
    for (let i = 0; i < Math.max(keys.length, from.length); i += 1) {
      const line = `${padEnd(keys[i] || '', keyWidth)}  ${padEnd(i === 0 ? mode(p) : '', modeWidth)}  ${from[i] || ''}`;
      lines.push(line.replace(/\s+$/, ''));
    }
  }
  return lines;
}

function renderSettingsView(view, lineage) {
  const w = termWidth();
  out(paint.bold(view.heading));
  printRule(view.rule);
  out();

  const files = view.sections.flatMap((section) => section.files);
  const status = (file) =>
    file.error ? paint.red(file.error.code) : file.jsonError ? paint.red('parse error') : paint.green('ok');

  out(paint.cyan('Sources, weakest first'));
  const sourceRows = files
    .filter((file) => file.sources.length)
    .map((file) => [
      file.sources.join('+'),
      shortenPath(file.path, lineage.home),
      file.managed && !file.managed.applied ? paint.yellow('skipped') : file.sensitive ? paint.yellow('sensitive') : '',
      status(file),
    ]);
  if (sourceRows.length === 0) out(paint.dim('  none'));
  for (const line of fitColumns(sourceRows, w - 2, { flex: 1, spill: true })) out(`  ${line}`);

  // Which managed source applies, and why the others do not (#147).
  if (view.managed) {
    out();
    out(paint.cyan(`Managed policy, highest first (${view.managed.behavior})`));
    for (const f of view.managed.fatal) {
      fitLine('  ', paint.red(`does not parse, which Claude Code treats as fatal at startup: ${shortenPath(f.path, lineage.home)}`), '    ');
    }
    const cache = view.managed.remoteCache;
    fitLine('  ', `${padEnd('server-managed', 24)} ${cache.present ? paint.yellow('cached, not merged: outranks the rest') : paint.dim('no cache, most likely none')}`);
    for (const s of view.managed.sources) {
      fitLine('  ', `${padEnd(s.label, 24)} ${s.applied ? paint.green('applied') : paint.dim(s.paths.length ? 'not used' : 'not present')}`);
      if (!s.applied && s.reason && s.paths.length) for (const line of wrapText(s.reason, w - 4, '    ')) out(paint.dim(line));
    }
  }

  const notRead = files.filter((file) => !file.sources.length);
  if (notRead.length) {
    out();
    out(paint.cyan('Found but not read by Claude Code'));
    for (const file of notRead) {
      out(`  ${elidePath(shortenPath(file.path, lineage.home), w - 2)}`);
      for (const line of wrapText(file.notRead, w - 4, '    ')) out(paint.dim(line));
    }
  }
  const repeated = view.sections.flatMap((section) => section.repeatedPaths || []);
  if (repeated.length) {
    fitLine('  ', paint.dim(`${plural(repeated.length, 'file')} reached again by the directory walk, listed once above.`));
  }
  out();

  out(paint.cyan('Effective merge'));
  // Cut only on a terminal, where the reader is a person: redirected to a file
  // or a pipe the merge is data, and a cut value would silently lose it.
  for (const line of JSON.stringify(view.merged, null, 2).split('\n')) {
    out(process.stdout.isTTY ? clampJsonLine(line, w) : line);
  }
  out();

  out(paint.cyan('Which file supplied each key'));
  if (view.provenance.length === 0) out(paint.dim('  nothing merged'));
  else for (const line of provenanceLines(view.provenance, w - 2)) out(`  ${line}`);
  for (const row of view.ignored || []) {
    // The path sized so "key in path:" stays on the first line and the reason wraps below.
    const where = elidePath(shortenPath(row.file, lineage.home), Math.max(20, w - 9 - row.keyPath.length));
    fitLine('  ', paint.yellow(`${row.keyPath} in ${where}: ${row.reason}`), '    ');
  }
}

function renderDefinitionsView(view, lineage) {
  out(paint.bold(view.heading));
  printRule(view.rule);
  out();
  const w = termWidth();
  let current = null;
  for (const group of view.groups) {
    if (group.category !== current) {
      if (current) out();
      current = group.category;
      out(paint.cyan(`${current}s`));
    }
    // flatten lists each distinct file once, winner first, and decides whether
    // it is shadowed; this only presents that (#117).
    const others = group.definitions.slice(1);
    const routes = otherRoutes(group.definitions);
    const flag = group.shadowed ? paint.yellow(`  shadows ${others.length}`) : '';
    const dup = routes ? paint.dim(`  (also reached by ${plural(routes, 'other route')})`) : '';
    fitLine('  ', `${paint.bold(group.name)}${flag}${dup}`, '    ');
    out(paint.dim(`    ${elidePath(shortenPath(group.winner.path, lineage.home), w - 4)}`));
    if (group.winner.description) {
      out(paint.dim(`    ${clamp(group.winner.description, Math.max(30, w - 6))}`));
    }
    for (const def of others) {
      out(paint.dim(`    shadowed: ${elidePath(shortenPath(def.path, lineage.home), w - 14)}`));
    }
  }
  if (view.groups.length === 0) out(paint.dim('  none found'));
}

function renderMcpView(view, lineage) {
  const w = termWidth();
  out(paint.bold(view.heading));
  printRule(view.rule);
  out();

  out(paint.cyan('Sources'));
  const rows = view.sources.map((s) => [
    shortenPath(s.path, lineage.home),
    `${s.serverNames.length} ${s.serverNames.length === 1 ? 'server' : 'servers'}`,
    s.error
      ? paint.red(s.error.code)
      : s.jsonError
        ? paint.red('parse error')
        : s.blocked
          ? paint.yellow('not loaded: managed-mcp.json has exclusive control')
          : s.notRead
            ? paint.yellow('not read by Claude Code, not loaded')
            : s.exclusive
              ? paint.green('managed, exclusive control')
              : '',
  ]);
  if (rows.length === 0) out(paint.dim('  none'));
  // The path is what a source is, so a long one spills onto its own line
  // rather than being cut down to the room the status leaves it (#124).
  for (const line of fitColumns(rows, w - 2, { spill: true })) out(`  ${line}`);
  // The reason once per distinct note, since it is usually the same one (#121).
  for (const note of new Set(view.sources.filter((s) => s.notRead).map((s) => s.notRead))) {
    for (const line of wrapText(note, Math.max(40, w - 4), '  ')) out(paint.dim(line));
  }
  out();

  out(paint.cyan('Servers'));
  for (const server of view.servers) {
    // As with definitions, flatten lists each distinct source once (path and
    // scope), winner first; this only presents that.
    const winner = server.winner;
    const others = server.definitions.slice(1);
    const routes = otherRoutes(server.definitions);
    const target = winner.command || winner.url || '';
    const lead = `  ${padEnd(paint.bold(server.name), 28)} ${padEnd(winner.transport || paint.dim('unknown'), 10)} `;
    const flags = [
      server.shadowed ? paint.yellow(`shadows ${others.length}`) : '',
      routes ? paint.dim(`(also reached by ${plural(routes, 'other route')})`) : '',
    ]
      .filter(Boolean)
      .join('  ');
    // The flags go below the target when beside it they would leave it under 20.
    const room = w - width(lead) - (flags ? 2 + width(flags) : 0);
    if (!flags || room >= 20) {
      out(`${lead}${paint.dim(elidePath(target, Math.max(20, room)))}${flags ? `  ${flags}` : ''}`);
    } else {
      out(`${lead}${paint.dim(elidePath(target, Math.max(20, w - width(lead))))}`);
      fitLine('    ', flags);
    }
    pathWithNote('    ', shortenPath(winner.path, lineage.home), `(${winner.scope})`, '      ', paint.dim);
    for (const def of others) {
      pathWithNote(paint.dim('    shadowed: '), shortenPath(def.path, lineage.home), `(${def.scope})`, '      ', paint.dim);
    }
  }
  if (view.servers.length === 0) out(paint.dim('  none found'));
}

export function renderView(view, lineage) {
  switch (view.kind) {
    case 'claude-md':
      return renderMemoryView(view, lineage);
    case 'settings':
      return renderSettingsView(view, lineage);
    case 'definitions':
      return renderDefinitionsView(view, lineage);
    case 'mcp':
      return renderMcpView(view, lineage);
    default:
      throw new Error(`No renderer for view kind: ${view.kind}`);
  }
}

/* -------------------------------------------------------------- snapshots -- */

export function renderBackup(manifest, root, home) {
  out(paint.green('Snapshot created'));
  const rows = [
    ['id', manifest.id],
    ['label', manifest.label || paint.dim('(none)')],
    ['files', String(manifest.counts.files)],
    ['path', path.join(root, manifest.id)],
    ['project', manifest.projectDir],
  ];
  for (const line of columns(rows)) out(`  ${line}`);

  if (manifest.counts.skipped) {
    out();
    out(paint.yellow(`${plural(manifest.counts.skipped, 'file')} skipped for size, not truncated:`));
    for (const s of manifest.skipped) {
      out(`  ${shortenPath(s.absPath, home)}  ${paint.dim(bytes(s.size))}`);
    }
  }
  if (manifest.counts.errors) {
    out();
    out(paint.red(`${plural(manifest.counts.errors, 'file')} could not be copied:`));
    for (const e of manifest.errors) {
      out(`  ${shortenPath(e.absPath, home)}  ${paint.red(e.code)} ${paint.dim(e.message)}`);
    }
  }

  if (manifest.counts.sensitive > 0) {
    out();
    out(paint.yellow(`WARNING: ${plural(manifest.counts.sensitive, 'file')} in this snapshot may hold OAuth tokens or machine-specific secrets.`));
    for (const file of manifest.files.filter((f) => f.sensitive)) {
      out(paint.yellow(`  ${file.absPath}`));
    }
    for (const line of wrapText(
      'In place the snapshot inherits the same user ACL as the originals, so it is no more exposed ' +
        'than they are. The exposure starts the moment it is copied to a share, a USB stick, a backup ' +
        'set or another machine. Do not copy this directory around casually.',
      Math.max(40, termWidth() - 2),
      '  '
    )) {
      out(paint.yellow(line));
    }
  }
}

export function renderSnapshotList(snapshots, root, retentionDays) {
  const header = packFields([root, retentionDays ? `kept ${retentionDays} days, then deleted when the next snapshot is taken` : '']);
  for (const line of header) out(paint.dim(line));
  if (snapshots.length === 0) {
    out(paint.dim('No snapshots yet. Create one with: layercake backup'));
    return;
  }
  const rows = [[paint.bold('ID'), paint.bold('CREATED'), paint.bold('FILES'), paint.bold('LABEL')]];
  for (const snap of snapshots) {
    if (snap.broken) {
      rows.push([snap.id, paint.red('unreadable'), '', paint.red(`${snap.code}: ${snap.message}`)]);
      continue;
    }
    rows.push([
      snap.id,
      localTime(snap.createdAt),
      String(snap.counts?.files ?? ''),
      snap.label || paint.dim('(none)'),
    ]);
  }
  // A label is free text and an unreadable manifest's message can be long:
  // either wraps under its own column rather than running off the line (#124).
  const widths = columnWidths(rows);
  for (const row of rows) {
    const lead = `${padEnd(row[0], widths[0])}  ${padEnd(row[1], widths[1])}  ${padStart(row[2], widths[2])}  `;
    fitLine(lead, row[3], ' '.repeat(width(lead)));
  }
}

const DIFF_PAINT = {
  same: (t) => paint.dim(t),
  changed: (t) => paint.yellow(t),
  missing: (t) => paint.red(t),
  error: (t) => paint.red(t),
};

export function renderDiff(result, home) {
  const { manifest, rows } = result;
  out(paint.bold(`Snapshot ${manifest.id}`));
  out(
    paint.dim(
      `taken ${localTime(manifest.createdAt)}   ${manifest.label || '(no label)'}   ` +
        `project ${manifest.projectDir}`
    )
  );
  out();

  const table = rows.map((row) => [
    (DIFF_PAINT[row.status] || ((t) => t))(padEnd(row.status, 8)),
    shortenPath(row.absPath, home),
    row.error ? paint.dim(row.error.message) : '',
  ]);
  for (const line of columns(table)) out(line);

  const tally = { same: 0, changed: 0, missing: 0, error: 0 };
  for (const row of rows) tally[row.status] = (tally[row.status] || 0) + 1;
  out();
  out(
    `${plural(rows.length, 'file')}: ${tally.same} same, ` +
      `${tally.changed ? paint.yellow(`${tally.changed} changed`) : '0 changed'}, ` +
      `${tally.missing ? paint.red(`${tally.missing} missing`) : '0 missing'}, ` +
      `${tally.error ? paint.red(`${tally.error} error`) : '0 error'}`
  );
  return tally;
}
