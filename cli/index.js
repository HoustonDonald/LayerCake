#!/usr/bin/env node
/**
 * layercake: the command line face of Claude Explorer.
 *
 * This imports server/ directly and never speaks to the HTTP API. That is the
 * whole point: no server has to be running, no port has to be free, and there
 * is no session token to negotiate. The scan modules are plain functions over
 * the filesystem, so the web app and this CLI are two front ends over one
 * resolver rather than two implementations of the same rules.
 *
 * Read-only except for `backup` and `restore`, which go through
 * server/snapshot.js. That module is the only mutating fs caller the CLI can
 * reach, so the write posture is enforced by the import graph here exactly as
 * it is in the server.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { flatten } from '../server/flatten.js';
import { snapshotRoot } from '../server/paths.js';
import { resolveLineage } from '../server/scan.js';
import {
  compareSnapshot,
  createSnapshot,
  listSnapshots,
  readManifest,
  restoreFiles,
} from '../server/snapshot.js';
import { err, localTime, out, padEnd, paint, plural, shortenPath } from './format.js';
import {
  renderBackup,
  renderDiff,
  renderHere,
  renderSnapshotList,
  renderTree,
  renderView,
} from './render.js';
import { buildSummary } from './summary.js';

/** A failure worth exit 1, as opposed to a scan that merely found problems. */
class CliError extends Error {}

const VIEW_KINDS = ['claude-md', 'settings', 'definitions', 'mcp'];

const ROOT_HELP = `layercake  Claude Code configuration lineage, from the terminal

Usage
  layercake <command> [options]

Commands
  here [dir]                     compact summary of the effective environment
  tree [dir] [--all]             the full lineage, level by level
  show <kind> [dir]              one flattened view: ${VIEW_KINDS.join(', ')}
  backup [dir] [--label text]    snapshot every config file in the lineage
  snapshots                      list snapshots, newest first
  diff <snapshotId> [dir]        compare a snapshot against what is on disk now
  restore <snapshotId> [dir]     restore from a snapshot, dry run by default

  dir defaults to the current directory.
  Run layercake <command> --help for the options of one command.

Environment
  LAYERCAKE_SNAPSHOT_DIR              where snapshots live
  CLAUDE_EXPLORER_DIR_TIMEOUT_MS      per-operation filesystem timeout, default 3000
  NO_COLOR                            disable ANSI color

Exit codes
  0  the command ran, including a scan that reported per-level errors
  1  the command could not run: bad directory, unknown snapshot, failed write`;

const COMMAND_HELP = {
  here: `layercake here [dir]

Compact summary of the effective Claude Code environment for a directory: which
instruction files load and in what order, how many agents, skills and commands
are active or shadowed, which MCP servers are configured, and the highlights of
the merged settings.

Options
  -h, --help    this text`,

  tree: `layercake tree [dir] [--all]

The full lineage as an indented tree, weakest precedence level first. Errors are
always shown; absence is hidden by default only for brevity.

Options
      --all     also list every probed-but-absent path and every redacted
                credential file, which is what the scan actually looked for
  -h, --help    this text`,

  show: `layercake show <kind> [dir]

Print one flattened view together with the merge rule that produced it.

Kinds
  claude-md     the instruction set, concatenated in precedence order
  settings      every settings file, the effective merge, and the winning level
                for each key
  definitions   agents, skills and commands grouped by declared name
  mcp           MCP servers from every source on the chain

Options
  -h, --help    this text`,

  backup: `layercake backup [dir] [--label "text"]

Copy every config file the scan found into a snapshot directory, plus a manifest
recording each file's origin, size and SHA-256. The snapshot is a plain mirrored
tree, not an archive: recovering from it needs nothing but File Explorer.

Options
      --label   free text stored in the manifest, shown by layercake snapshots
  -h, --help    this text`,

  snapshots: `layercake snapshots

List snapshots newest first: id, creation time, file count and label. A snapshot
whose manifest will not parse is listed as unreadable rather than hidden.

Options
  -h, --help    this text`,

  diff: `layercake diff <snapshotId> [dir]

Compare every file in a snapshot against what is on disk now, by SHA-256. Status
is per file: same, changed, missing or error. Informational, so it always exits
0; pass dir only to be told when the snapshot belongs to a different project.

Options
  -h, --help    this text`,

  restore: `layercake restore <snapshotId> [dir] [--only text] [--yes]

Restore files from a snapshot. Dry run by default: it prints exactly which files
would be written and changes nothing. Files already identical to the snapshot are
never rewritten.

dir is the project directory whose lineage is captured as the undo snapshot. It
defaults to the project the snapshot was taken for, which is what makes the undo
cover the same set of files.

Options
      --only    restore only paths containing this substring
      --yes     actually write. An undo snapshot is taken first, always.
  -h, --help    this text`,
};

function parse(args, options = {}) {
  return parseArgs({
    args,
    options: { help: { type: 'boolean', short: 'h' }, ...options },
    allowPositionals: true,
    strict: true,
  });
}

/**
 * Resolves and validates the directory argument.
 *
 * A missing target directory is exit 1, which is not in tension with letting a
 * scan succeed while individual levels report errors. An unreadable ancestor is
 * a fact about the environment and the scan is still the right answer; a
 * project directory that does not exist means the argument was wrong and there
 * is no answer to give.
 */
async function targetDir(positional) {
  const dir = path.resolve(positional ?? process.cwd());
  let st;
  try {
    st = await fs.stat(dir);
  } catch (e) {
    throw new CliError(`Cannot read directory: ${dir} (${e.code || e.message})`);
  }
  if (!st.isDirectory()) throw new CliError(`Not a directory: ${dir}`);
  return dir;
}

/** readManifest throws a raw ENOENT for an id that does not exist. Translate it. */
async function manifestOrFail(id) {
  try {
    return await readManifest(id);
  } catch (e) {
    if (e.code === 'ENOENT') {
      throw new CliError(`Unknown snapshot: ${id}\nList them with: layercake snapshots`);
    }
    throw new CliError(`Cannot read snapshot ${id}: ${e.message}`);
  }
}

/* --------------------------------------------------------------- commands -- */

async function cmdHere(args) {
  const { values, positionals } = parse(args);
  if (values.help) return out(COMMAND_HELP.here);
  const dir = await targetDir(positionals[0]);
  renderHere(await buildSummary(await resolveLineage(dir)));
}

async function cmdTree(args) {
  const { values, positionals } = parse(args, { all: { type: 'boolean' } });
  if (values.help) return out(COMMAND_HELP.tree);
  const dir = await targetDir(positionals[0]);
  renderTree(await resolveLineage(dir), { all: Boolean(values.all) });
}

async function cmdShow(args) {
  const { values, positionals } = parse(args);
  if (values.help) return out(COMMAND_HELP.show);
  const kind = positionals[0];
  if (!kind) throw new CliError(`show needs a kind: ${VIEW_KINDS.join(', ')}`);
  if (!VIEW_KINDS.includes(kind)) {
    throw new CliError(`Unknown view kind: ${kind}\nPick one of: ${VIEW_KINDS.join(', ')}`);
  }
  const dir = await targetDir(positionals[1]);
  const lineage = await resolveLineage(dir);
  renderView(await flatten(lineage, kind), lineage);
}

async function cmdBackup(args) {
  const { values, positionals } = parse(args, { label: { type: 'string' } });
  if (values.help) return out(COMMAND_HELP.backup);
  const dir = await targetDir(positionals[0]);
  const lineage = await resolveLineage(dir);
  const manifest = await createSnapshot(lineage, { label: values.label || '' });
  renderBackup(manifest, snapshotRoot(), lineage.home);
}

async function cmdSnapshots(args) {
  const { values } = parse(args);
  if (values.help) return out(COMMAND_HELP.snapshots);
  renderSnapshotList(await listSnapshots(), snapshotRoot());
}

async function cmdDiff(args) {
  const { values, positionals } = parse(args);
  if (values.help) return out(COMMAND_HELP.diff);
  const id = positionals[0];
  if (!id) throw new CliError('diff needs a snapshot id. List them with: layercake snapshots');
  const manifest = await manifestOrFail(id);

  // The comparison is manifest-driven, so dir cannot change the answer. It is
  // still worth accepting: pointing diff at a project the snapshot was not
  // taken for is a mistake worth naming rather than silently ignoring.
  if (positionals[1]) {
    const dir = await targetDir(positionals[1]);
    if (path.resolve(dir).toLowerCase() !== path.resolve(manifest.projectDir).toLowerCase()) {
      err(paint.yellow(`Note: this snapshot was taken for ${manifest.projectDir}, not ${dir}.`));
    }
  }
  renderDiff(await compareSnapshot(id), manifest.home);
}

async function cmdRestore(args) {
  const { values, positionals } = parse(args, {
    only: { type: 'string' },
    yes: { type: 'boolean' },
  });
  if (values.help) return out(COMMAND_HELP.restore);
  const id = positionals[0];
  if (!id) throw new CliError('restore needs a snapshot id. List them with: layercake snapshots');
  const manifest = await manifestOrFail(id);
  const dir = await targetDir(positionals[1] ?? manifest.projectDir);

  const { rows } = await compareSnapshot(id);
  const needle = values.only ? values.only.toLowerCase() : null;
  const selected = needle ? rows.filter((r) => r.absPath.toLowerCase().includes(needle)) : rows;

  if (selected.length === 0) {
    throw new CliError(`No file in snapshot ${id} matches --only ${values.only}`);
  }

  // A file identical to the snapshot is left alone. Rewriting it would produce
  // no change but a new mtime, and an mtime is what tooling elsewhere uses to
  // decide something needs rebuilding or re-reading.
  const toWrite = selected.filter((r) => r.status !== 'same');
  const unchanged = selected.length - toWrite.length;

  out(paint.bold(`Snapshot ${id}`));
  out(paint.dim(`taken ${localTime(manifest.createdAt)}   ${manifest.label || '(no label)'}`));
  out(paint.dim(`undo snapshot will be taken of the lineage for ${dir}`));
  if (needle) out(paint.dim(`--only ${values.only}: ${selected.length} of ${rows.length} files match`));
  out();

  if (toWrite.length === 0) {
    out(paint.green(`Nothing to do: ${plural(selected.length, 'selected file')} already identical to the snapshot.`));
    return;
  }

  for (const row of toWrite) {
    const tag =
      row.status === 'missing' ? paint.red(padEnd('recreate', 9)) : paint.yellow(padEnd('overwrite', 9));
    out(`  ${tag}  ${row.absPath}${row.error ? paint.dim(`  (${row.error.message})`) : ''}`);
  }
  out();
  out(`${plural(toWrite.length, 'file')} to write, ${unchanged} already identical.`);

  if (!values.yes) {
    out(paint.bold('Dry run. Nothing has been written.'));
    out(`Re-run with --yes to apply. An undo snapshot is taken before the first write.`);
    return;
  }

  const result = await restoreFiles(id, toWrite.map((r) => r.absPath), await resolveLineage(dir));
  out(paint.green(`Restored ${plural(result.restored.length, 'file')}.`));
  for (const p of result.restored) out(paint.dim(`  ${shortenPath(p, manifest.home)}`));
  if (result.failed.length) {
    out(paint.red(`${plural(result.failed.length, 'file')} failed:`));
    for (const f of result.failed) out(paint.red(`  ${f.absPath}  ${f.code} ${f.message}`));
  }
  out();
  out(`Undo snapshot: ${paint.bold(result.undoSnapshotId)}`);
  out(paint.dim(`Undo with: layercake restore ${result.undoSnapshotId} --yes`));
  if (result.failed.length) process.exitCode = 1;
}

const COMMANDS = {
  here: cmdHere,
  tree: cmdTree,
  show: cmdShow,
  backup: cmdBackup,
  snapshots: cmdSnapshots,
  diff: cmdDiff,
  restore: cmdRestore,
};

async function main() {
  const argv = process.argv.slice(2);
  const name = argv[0];

  if (!name || name === '--help' || name === '-h' || name === 'help') {
    out(ROOT_HELP);
    return;
  }
  const command = COMMANDS[name];
  if (!command) {
    throw new CliError(`Unknown command: ${name}\nCommands: ${Object.keys(COMMANDS).join(', ')}`);
  }
  await command(argv.slice(1));
}

main().catch((e) => {
  // parseArgs throws for an unknown or malformed option. Its message already
  // names the offending token, so it is passed through rather than restated.
  err(paint.red(`layercake: ${e.message}`));
  process.exitCode = 1;
});
