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

import {
  bytes,
  columns,
  elide,
  localTime,
  out,
  padEnd,
  paint,
  plural,
  shortenPath,
  termWidth,
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

/** Greedy wrap. Rule text is prose, so word boundaries are the only break points. */
function wrapText(text, max, indent = '') {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    if (line && line.length + 1 + word.length > max) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines.map((l) => `${indent}${l}`);
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
  out(`${padEnd(paint.bold(label), LABEL)}${value}`);
}

function continued(value) {
  out(`${' '.repeat(LABEL)}${value}`);
}

/* ------------------------------------------------------------------ here -- */

export function renderHere(summary) {
  const home = summary.home;
  const w = termWidth();

  out(paint.bold(summary.projectDir));
  out(
    paint.dim(
      `${summary.platform}   home ${home}   scanned ${localTime(summary.scannedAt)}   ` +
        `${plural(summary.fileCount, 'config file')} across ${plural(summary.levels.total, 'level')}`
    )
  );
  out();

  // Weakest first, which is the order Claude Code reads them and therefore the
  // order in which a later file wins a conflict.
  const shown = summary.instructions.slice(0, 5);
  labelled('Instructions', `${plural(summary.instructions.length, 'file')}, weakest first`);
  shown.forEach((file, i) => {
    const flag = file.error ? paint.red(`  ${file.error.code}`) : '';
    continued(`${paint.dim(String(i + 1).padStart(2))} ${elide(shortenPath(file.path, home), w - LABEL - 6)}${flag}`);
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

  labelled(
    'Settings',
    summary.settings.empty
      ? paint.dim('no settings files on this chain')
      : `${plural(summary.settings.files, 'file')} merged` +
          (summary.settings.unreadable ? paint.yellow(`, ${summary.settings.unreadable} unreadable`) : '')
  );
  for (const [key, value] of summary.settings.highlights) {
    continued(`${paint.dim(padEnd(key, 14))} ${value}`);
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

export function renderTree(lineage, { all }) {
  const home = lineage.home;
  const w = termWidth();
  out(paint.bold(lineage.projectDir));
  out(
    paint.dim(
      `${plural(lineage.summary.levelCount, 'level')}, ${plural(lineage.summary.fileCount, 'file')}, ` +
        `${plural(lineage.summary.errorCount, 'error')}, ${lineage.summary.redactedCount} redacted   ` +
        `${lineage.platform}   scanned ${localTime(lineage.scannedAt)}`
    )
  );
  if (!all) out(paint.dim('probed-but-absent paths hidden, pass --all to show them'));
  out();

  for (const level of lineage.levels) {
    const index = paint.dim(String(level.precedence).padStart(2, '0'));
    const dir = level.dir ? paint.dim(elide(shortenPath(level.dir, home), 48)) : '';
    out(`${index}  ${padEnd(paint.bold(level.label), 34)} ${padEnd(statusPaint(level.status), 10)} ${dir}`);
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
      // relPath is relative to the level's directory, so a target that sits
      // beside that directory rather than inside it (~/.claude.json against the
      // ~/.claude level) comes back as `..\name`. Show those absolute instead:
      // a leading `..` reads as a mistake when the point is where the file is.
      const rows = entries.map((entry) => [
        elide(
          entry.relPath.startsWith('..') ? shortenPath(entry.absPath, home) : entry.relPath,
          Math.max(20, w - 26)
        ),
        entry.type === 'dir' ? paint.dim('dir') : paint.dim(bytes(entry.size)),
        entry.error ? paint.red(entry.error.code) : entry.sensitive ? paint.yellow('sensitive') : '',
      ]);
      for (const line of columns(rows)) out(`      ${line}`);
    }

    // Errors are never hidden. A level that half-scanned is a fact about the
    // environment, not noise, and --all is about absence rather than failure.
    if (level.errors.length) {
      out(`    ${paint.red('errors')} ${paint.dim(`(${level.errors.length})`)}`);
      for (const e of level.errors) {
        out(`      ${elide(shortenPath(e.path, home), Math.max(20, w - 30))}  ${paint.red(e.code)} ${paint.dim(e.message)}`);
      }
    }

    if (level.other.length) {
      out(`    ${paint.dim('other')} ${paint.dim(`(${level.other.length})`)}`);
      for (const o of level.other) {
        out(`      ${padEnd(o.name + (o.type === 'dir' ? path.sep : ''), 28)} ${paint.dim(o.note || '')}`);
      }
    }

    if (all) {
      if (level.absent.length) {
        out(`    ${paint.dim('absent')} ${paint.dim(`(${level.absent.length})`)}`);
        for (const a of level.absent) {
          out(paint.dim(`      ${elide(shortenPath(a.absPath, home), Math.max(20, w - 20))}`));
        }
      }
      if (level.redacted.length) {
        out(`    ${paint.yellow('redacted')} ${paint.dim(`(${level.redacted.length})`)}`);
        for (const r of level.redacted) {
          out(`      ${paint.dim(elide(shortenPath(r.absPath, home), 60))}  ${paint.dim(r.reason)}`);
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
    out(paint.cyan(`===== ${shortenTitle(section.title, lineage.home)} =====`));
    if (section.repeatedNote) {
      out(paint.dim(`  ${section.repeatedNote}`));
      for (const repeated of section.repeatedPaths || []) {
        out(paint.dim(`    ${shortenPath(repeated, lineage.home)}`));
      }
    }
    for (const file of section.files) {
      out(paint.dim(`# ${shortenPath(file.path, lineage.home)}${file.truncated ? '  (truncated at the read cap)' : ''}`));
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

function renderSettingsView(view, lineage) {
  const w = termWidth();
  out(paint.bold(view.heading));
  printRule(view.rule);
  out();

  out(paint.cyan('Sources, weakest first'));
  const sourceRows = [];
  for (const section of view.sections) {
    for (const file of section.files) {
      sourceRows.push([
        shortenPath(file.path, lineage.home),
        file.sensitive ? paint.yellow('sensitive') : '',
        file.error ? paint.red(file.error.code) : file.jsonError ? paint.red('parse error') : paint.green('ok'),
      ]);
    }
  }
  if (sourceRows.length === 0) out(paint.dim('  none'));
  for (const line of columns(sourceRows)) out(`  ${line}`);
  out();

  out(paint.cyan('Effective merge'));
  out(JSON.stringify(view.merged, null, 2));
  out();

  out(paint.cyan('Which level supplied each key'));
  const provRows = view.provenance.map((p) => [
    p.keyPath,
    p.mode === 'union' ? paint.yellow(p.mode) : paint.dim(p.mode),
    elide(shortenPath(p.file, lineage.home), Math.max(24, w - 60)),
  ]);
  if (provRows.length === 0) out(paint.dim('  nothing merged'));
  for (const line of columns(provRows)) out(`  ${line}`);
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
    out(`  ${paint.bold(group.name)}${flag}${dup}`);
    out(paint.dim(`    ${shortenPath(group.winner.path, lineage.home)}`));
    if (group.winner.description) {
      out(paint.dim(`    ${clamp(group.winner.description, Math.max(30, w - 6))}`));
    }
    for (const def of others) {
      out(paint.dim(`    shadowed: ${shortenPath(def.path, lineage.home)}`));
    }
  }
  if (view.groups.length === 0) out(paint.dim('  none found'));
}

function renderMcpView(view, lineage) {
  out(paint.bold(view.heading));
  printRule(view.rule);
  out();

  out(paint.cyan('Sources'));
  const rows = view.sources.map((s) => [
    shortenPath(s.path, lineage.home),
    `${s.serverNames.length} ${s.serverNames.length === 1 ? 'server' : 'servers'}`,
    s.error ? paint.red(s.error.code) : s.jsonError ? paint.red('parse error') : '',
  ]);
  if (rows.length === 0) out(paint.dim('  none'));
  for (const line of columns(rows)) out(`  ${line}`);
  out();

  out(paint.cyan('Servers'));
  for (const server of view.servers) {
    // As with definitions, flatten lists each distinct source once (path and
    // scope), winner first; this only presents that.
    const winner = server.winner;
    const others = server.definitions.slice(1);
    const routes = otherRoutes(server.definitions);
    const target = winner.command || winner.url || '';
    out(
      `  ${padEnd(paint.bold(server.name), 28)} ${padEnd(winner.transport || paint.dim('unknown'), 10)} ` +
        `${paint.dim(elide(target, Math.max(20, termWidth() - 60)))}` +
        (server.shadowed ? paint.yellow(`  shadows ${others.length}`) : '') +
        (routes ? paint.dim(`  (also reached by ${plural(routes, 'other route')})`) : '')
    );
    out(paint.dim(`    ${shortenPath(winner.path, lineage.home)}  (${winner.scope})`));
    for (const def of others) {
      out(paint.dim(`    shadowed: ${shortenPath(def.path, lineage.home)}  (${def.scope})`));
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

export function renderSnapshotList(snapshots, root) {
  out(paint.dim(root));
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
  for (const line of columns(rows, { align: [null, null, 'right'] })) out(line);
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
