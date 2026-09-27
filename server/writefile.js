/**
 * The edit path. Single entry point for changing a file the scan discovered,
 * deleting one, or creating one at a place the scan offered (#15).
 *
 * Imports snapshot.js on purpose: "every edit is preceded by a snapshot" is a
 * property of the import graph here, not a step a route has to remember.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import yaml from 'js-yaml';

import { createSnapshot, atomicWrite, createExclusive, removeFile } from './snapshot.js';
import {
  MAX_WRITE_BYTES,
  isEditableCategory,
  isExecutableCategory,
  isNonConfigDir,
  isSecret,
  commandKeysChanged,
  createFiles,
  createLevelAllowed,
  createNameProblem,
  createTrees,
} from './safety.js';
import { CLAUDE_DIR_FILE_TARGETS, CLAUDE_DIR_TREES, DIR_FILE_TARGETS, samePathKey } from './paths.js';
import { readForDisplay, splitFrontmatter } from './readfile.js';

function refuse(message, code, status = 403) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

/**
 * A settings or MCP file edit that adds or changes something Claude Code runs
 * (hooks, statusLine, apiKeyHelper, an MCP server command...) needs the same
 * acknowledgement as a hook script (#19). The category alone cannot say: the
 * same settings.json holds both a model name and a hook. So the parsed file on
 * disk is compared with the parsed new content, through readForDisplay, the
 * one producer of a file body. The refusal names the keys, for the UI to show.
 */
async function assertNoNewCommands(entry, content) {
  let after;
  try {
    after = JSON.parse(content);
  } catch {
    return; // not JSON: validateContent has already ruled on it
  }
  const before = (await readForDisplay(entry.absPath)).parsed ?? null;
  const keys = commandKeysChanged(entry.category, before, after);
  if (!keys.length) return;
  const err = refuse(
    `This edit adds or changes settings Claude Code runs as commands (${keys.join(', ')}). Re-send with acknowledgeExecutable to confirm.`,
    'EEXECUTABLE'
  );
  err.details = { commandKeys: keys };
  throw err;
}

/**
 * Rejects a write before anything touches the disk.
 *
 * `entry` is the scan entry for the target, which is how category is known.
 * A caller cannot supply its own category: it comes from the scan result, so a
 * request cannot relabel a hook as a note to dodge the acknowledgement.
 */
export function assertWritable(entry, { acknowledgeExecutable = false, content = '' } = {}) {
  if (!entry) {
    throw refuse('Path is not part of this scan result.', 'ENOTINSCAN');
  }
  if (isSecret(entry.absPath)) {
    throw refuse('Credential file. Never read and never written by this tool.', 'EREDACTED');
  }
  if (entry.type !== 'file') {
    throw refuse('Only files discovered as files can be edited.', 'ENOTFILE');
  }
  if (!isEditableCategory(entry.category)) {
    throw refuse(
      `Files in the "${entry.category}" category are not editable. That category is for things the scan lists but does not understand.`,
      'ENOTEDITABLE'
    );
  }
  if (isExecutableCategory(entry.category) && !acknowledgeExecutable) {
    throw refuse(
      'This file is executed by Claude Code, not just read. Re-send with acknowledgeExecutable to confirm.',
      'EEXECUTABLE'
    );
  }
  if (Buffer.byteLength(content, 'utf8') > MAX_WRITE_BYTES) {
    throw refuse(`Content exceeds the ${MAX_WRITE_BYTES} byte cap.`, 'ETOOLARGE', 413);
  }
}

/**
 * Structural checks, run before the write rather than discovered by Claude Code
 * at next start.
 *
 * The severity split is deliberate and asymmetric:
 *  - Broken JSON in settings.json degrades EVERY future session, so it is a
 *    hard refusal.
 *  - Broken YAML frontmatter breaks one agent or skill definition and leaves
 *    the rest working, so it is a warning and the write proceeds.
 */
export function validateContent(absPath, content) {
  const ext = path.extname(absPath).toLowerCase();
  const warnings = [];

  if (ext === '.json') {
    try {
      JSON.parse(content);
    } catch (err) {
      throw refuse(
        `Refusing to write invalid JSON: ${err.message}. A malformed settings file degrades every future Claude Code session.`,
        'EBADJSON',
        400
      );
    }
  }

  if (ext === '.md' || ext === '.markdown') {
    const fm = splitFrontmatter(content);
    if (fm.frontmatterError) {
      warnings.push(`YAML frontmatter did not parse: ${fm.frontmatterError}. The body will still load.`);
    }
  }

  if (ext === '.yaml' || ext === '.yml') {
    try {
      yaml.load(content, { schema: yaml.JSON_SCHEMA });
    } catch (err) {
      throw refuse(`Refusing to write invalid YAML: ${err.message}`, 'EBADYAML', 400);
    }
  }

  return warnings;
}

/**
 * Detects a concurrent change since the editor loaded the file.
 *
 * The realistic case is not two people, it is one person with the file open in
 * VS Code as well. Silently winning that race is how an edit disappears.
 */
async function assertUnchanged(absPath, expectedMtime) {
  if (!expectedMtime) return;
  const st = await fs.stat(absPath);
  if (st.mtime.toISOString() !== expectedMtime) {
    throw refuse(
      'The file changed on disk since it was opened here. Reload it and reapply the edit.',
      'ECONFLICT',
      409
    );
  }
}

/**
 * Writes a file. Snapshot first, then atomic replace.
 *
 * Returns the undo snapshot id, so the UI can offer a one-click revert rather
 * than making the user go hunting in the snapshot list.
 */
export async function editFile({
  entry,
  content,
  lineage,
  expectedMtime = null,
  acknowledgeExecutable = false,
}) {
  assertWritable(entry, { acknowledgeExecutable, content });
  const warnings = validateContent(entry.absPath, content);
  await assertUnchanged(entry.absPath, expectedMtime);
  if (!acknowledgeExecutable) await assertNoNewCommands(entry, content);

  const undo = await createSnapshot(lineage, {
    label: `Before editing ${path.basename(entry.absPath)}`,
  });

  await atomicWrite(entry.absPath, Buffer.from(content, 'utf8'));
  const st = await fs.stat(entry.absPath);

  return {
    absPath: entry.absPath,
    size: st.size,
    mtime: st.mtime.toISOString(),
    undoSnapshotId: undo.id,
    warnings,
    // Surfaced so the UI can say it rather than leaving the user to wonder why
    // an edit had no effect on a session that is already open.
    notice:
      'Claude Code loads memory and settings at session start. A session already running will not pick this up until it is restarted.',
  };
}

/* ------------------------------------------------------ create and delete */

// The create tables in safety.js must name scan manifest targets, so every
// file a create makes is one the next scan lists and a snapshot can hold. A
// drift here would make files LayerCake then cannot see; fail at load instead.
for (const f of createFiles()) {
  const targets = f.where === 'dir' ? DIR_FILE_TARGETS : CLAUDE_DIR_FILE_TARGETS;
  if (!targets.some((t) => t.name === f.name && t.category === f.category)) {
    throw new Error(`Create table names ${f.where}/${f.name}, which the scan manifest does not list as ${f.category}`);
  }
}
for (const t of createTrees()) {
  const tree = CLAUDE_DIR_TREES.find((x) => x.name === t.tree);
  if (!tree || tree.category !== t.category || (tree.exts && t.exts.some((e) => !tree.exts.includes(e)))) {
    throw new Error(`Create table names ${t.tree}/ in a way the scan manifest does not list`);
  }
}

/** The folder a level keeps its .claude files in: the configuration home itself at the user level. */
function claudeDirOf(level) {
  return level.kind === 'user' ? level.dir : path.join(level.dir, '.claude');
}

/**
 * What a scan offers to create, per level (#15). Built from the scan once and
 * kept with it, so a create request names an option by id and the server
 * builds the path; nothing in a request is ever a path. A fixed file that
 * already exists is not offered.
 */
export function createOptions(lineage) {
  const existing = new Set(
    lineage.levels.flatMap((l) => l.entries).filter((e) => e.type === 'file').map((e) => samePathKey(e.absPath))
  );
  const options = [];
  for (const level of lineage.levels) {
    if (!createLevelAllowed(level.kind) || !level.dir) continue;
    const claudeDir = claudeDirOf(level);
    const shown = (abs) => path.relative(level.dir, abs).split(path.sep).join('/');
    for (const f of createFiles()) {
      if (!f.levels.includes(level.kind)) continue;
      const absPath = path.join(f.where === 'dir' ? level.dir : claudeDir, f.name);
      if (existing.has(samePathKey(absPath))) continue;
      options.push({
        id: `${level.id}:file:${f.where}/${f.name}`,
        levelId: level.id,
        kind: 'file',
        category: f.category,
        label: shown(absPath),
        absPath,
        executable: isExecutableCategory(f.category),
      });
    }
    for (const t of createTrees()) {
      const folder = path.join(claudeDir, t.tree);
      options.push({
        id: `${level.id}:tree:${t.tree}`,
        levelId: level.id,
        kind: 'tree',
        category: t.category,
        label: `${shown(folder)}/`,
        folder,
        exts: t.exts,
        folderFile: t.folderFile || null,
        executable: isExecutableCategory(t.category),
      });
    }
  }
  return options;
}

/** The one path an option and a name produce, or a refusal. */
export function createTargetPath(option, { name, ext } = {}) {
  if (option.kind === 'file') return option.absPath;
  const problem = createNameProblem(name);
  if (problem) throw refuse(problem, 'EBADNAME', 400);
  const chosen = option.exts.length === 1 ? option.exts[0] : String(ext || '');
  if (!option.exts.includes(chosen)) {
    throw refuse(`Choose one of ${option.exts.join(', ')}.`, 'EBADEXT', 400);
  }
  const absPath = option.folderFile
    ? path.join(option.folder, name, option.folderFile)
    : path.join(option.folder, `${name}${chosen}`);
  // The name rule already makes this one segment; checked again because a
  // path outside the folder would be a general file writer.
  const rel = path.relative(option.folder, absPath);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw refuse('Name leaves its folder.', 'EBADNAME', 400);
  return absPath;
}

const HOOK_NOTE = 'Runs only once a hooks entry in settings.json names this file. The event arrives as JSON on stdin; exit code 0 is success, and 2 blocks the action for events that can be blocked.';

/** Starting content. Short on purpose: memory files are loaded into every session. */
function templateFor(option, name, ext) {
  const file = option.kind === 'file' ? path.basename(option.absPath) : null;
  if (file === 'settings.json' || file === 'settings.local.json') return '{\n}\n';
  if (file === '.mcp.json') return '{\n  "mcpServers": {}\n}\n';
  if (file === 'CLAUDE.md') return '# Instructions for Claude\n';
  switch (option.category) {
    case 'agent':
      return `---\nname: ${name}\ndescription: When Claude should hand work to this agent.\n---\n\nInstructions for the agent.\n`;
    case 'command':
      return `---\ndescription: What /${name} does.\n---\n\nThe prompt /${name} sends. $ARGUMENTS stands for anything typed after it.\n`;
    case 'skill':
      return `---\nname: ${name}\ndescription: What this skill does, and when Claude should use it.\n---\n\nInstructions for the skill.\n`;
    case 'rule':
      return `# ${name}\n\nThe rule.\n`;
    case 'hook':
      if (ext === '.sh') return `#!/bin/sh\n# ${HOOK_NOTE}\nexit 0\n`;
      if (ext === '.py') return `#!/usr/bin/env python3\n# ${HOOK_NOTE}\nimport sys\nsys.exit(0)\n`;
      if (ext === '.ps1') return `# ${HOOK_NOTE}\nexit 0\n`;
      return `// ${HOOK_NOTE}\nprocess.exit(0);\n`;
    default:
      throw refuse(`No template for ${option.category}.`, 'ENOTEMPLATE', 400);
  }
}

/**
 * Creates one file from a template (#15). No snapshot: a create never
 * replaces bytes (createExclusive refuses an existing file), so there is
 * nothing to back up, and its undo is a delete, which does snapshot.
 */
export async function createFile({ option, name, ext, acknowledgeExecutable = false }) {
  if (option.executable && !acknowledgeExecutable) {
    throw refuse(
      'This creates a file Claude Code executes, not just reads. Re-send with acknowledgeExecutable to confirm.',
      'EEXECUTABLE'
    );
  }
  const absPath = createTargetPath(option, { name, ext });
  if (isSecret(absPath)) throw refuse('Credential file. Never read and never written by this tool.', 'EREDACTED');
  const chosen = option.kind === 'tree' && option.exts.length === 1 ? option.exts[0] : ext;
  const content = templateFor(option, name, chosen);
  try {
    await createExclusive(absPath, Buffer.from(content, 'utf8'));
  } catch (err) {
    if (err.code === 'EEXIST') {
      throw refuse(`A file already exists at ${absPath}. Re-scan to see it.`, 'EEXISTS', 409);
    }
    throw err;
  }
  const st = await fs.stat(absPath);
  return {
    absPath,
    category: option.category,
    size: st.size,
    mtime: st.mtime.toISOString(),
    notice:
      option.category === 'hook'
        ? 'A hook script does nothing until a hooks entry in settings.json names it.'
        : 'Claude Code loads configuration at session start. A session already running will not pick this up until it is restarted.',
  };
}

/**
 * Deletes one scanned file (#15), after a snapshot that provably holds it. A
 * file the snapshot skipped (over the size cap) or could not read is refused:
 * deleting it would be the one write in this tool with no way back.
 */
export async function deleteFile({ entry, lineage, expectedMtime = null }) {
  // Deleting removes what runs rather than adding it, so no acknowledgement.
  assertWritable(entry, { acknowledgeExecutable: true });
  try {
    await assertUnchanged(entry.absPath, expectedMtime);
  } catch (err) {
    if (err.code === 'ENOENT') throw refuse('The file is already gone from disk. Re-scan.', 'EGONE', 404);
    throw err;
  }

  const undo = await createSnapshot(lineage, { label: `Before deleting ${path.basename(entry.absPath)}` });
  const key = samePathKey(entry.absPath);
  const held = undo.files.find((f) => samePathKey(f.absPath) === key);
  if (!held) {
    const why = [...undo.skipped, ...undo.errors].find((f) => samePathKey(f.absPath) === key);
    throw refuse(
      `Not deleted: the snapshot taken first could not hold this file${why ? ` (${why.reason || why.message})` : ''}, so there would be no way back.`,
      'ENOBACKUP',
      409
    );
  }
  // Changed between the snapshot and now: the snapshot would restore an
  // older version than the one being deleted.
  const st = await fs.stat(entry.absPath);
  if (st.mtime.toISOString() !== held.mtime) {
    throw refuse('The file changed while it was being snapshotted. Nothing was deleted; try again.', 'ECONFLICT', 409);
  }

  await removeFile(entry.absPath);
  return {
    absPath: entry.absPath,
    undoSnapshotId: undo.id,
    notice:
      entry.category === 'hook'
        ? 'A hooks entry in settings.json that names this script will now fail when its event fires.'
        : 'Claude Code loads configuration at session start. A session already running keeps what it loaded until it is restarted.',
  };
}

/**
 * Whether a restore may put back a file the current scan did not find (#92).
 * Inside a user or directory level's config folders, or one of a directory's
 * own config files, never a secret, never under runtime state. The route also
 * requires the file to be in the snapshot, which only ever holds scanned files.
 */
export function restorableWhenAbsent(lineage, absPath) {
  if (isSecret(absPath)) return false;
  const key = samePathKey(absPath);
  for (const level of lineage.levels) {
    if (!createLevelAllowed(level.kind) || !level.dir) continue;
    if (level.kind === 'directory' && DIR_FILE_TARGETS.some((t) => samePathKey(path.join(level.dir, t.name)) === key)) {
      return true;
    }
    const rel = path.relative(claudeDirOf(level), absPath);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
    if (!rel.split(/[\\/]/).slice(0, -1).some((segment) => isNonConfigDir(segment))) return true;
  }
  return false;
}
