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

import { createSnapshot, atomicWrite, createExclusive, removeFile, restoreFiles } from './snapshot.js';
import {
  MAX_FILE_BYTES,
  MAX_WRITE_BYTES,
  isEditableCategory,
  isExecutableCategory,
  treeSkipsDir,
  treeTakesFile,
  isSecret,
  commandKeysChanged,
  createFiles,
  createLevelAllowed,
  createNameProblem,
  createTrees,
} from './safety.js';
import { CLAUDE_DIR_FILE_TARGETS, CLAUDE_DIR_TREES, DIR_FILE_TARGETS, PLUGIN_MANIFEST_FILES, samePathKey, settingsSourceFiles } from './paths.js';
import { readForDisplay, splitFrontmatter } from './readfile.js';
import { shareGatedCall } from './sharegate.js';

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
 * The snapshot's record of `absPath`, or a refusal saying why it has none. Every
 * write that replaces or removes a file calls this after its undo snapshot, so
 * "undoable" is checked per file rather than assumed: a snapshot skips a file
 * over the 2 MB cap, and one it could not read (#96).
 */
function assertHeld(snapshot, absPath, verb) {
  const key = samePathKey(absPath);
  const held = snapshot.files.find((f) => samePathKey(f.absPath) === key);
  if (held) return held;
  const why = [...snapshot.skipped, ...snapshot.errors].find((f) => samePathKey(f.absPath) === key);
  throw refuse(
    `${verb}: the snapshot taken first could not hold this file${why ? ` (${why.reason || why.message})` : ''}, so there would be no way back.`,
    'ENOBACKUP',
    409
  );
}

/**
 * Refusals a stat can decide, made before the undo snapshot so a refused write
 * costs a stat and leaves no empty snapshot behind (#139, #141).
 * - Over the snapshot's size cap: the snapshot could not hold it. assertHeld
 *   still checks what the snapshot actually held, for a file that grows.
 * - Read-only: the save's rename would fail with a raw EPERM naming the temp
 *   file, and a delete would succeed anyway, because libuv clears the
 *   attribute on unlink. Someone marked the file to keep it as it is.
 * A file that cannot be stat'ed is left to the checks that follow.
 */
async function assertReplaceable(absPath, verb) {
  let st;
  try {
    st = await shareGatedCall(absPath, () => fs.stat(absPath));
  } catch {
    return;
  }
  if (st.size > MAX_FILE_BYTES) {
    throw refuse(
      `${verb}: the file is over the 2 MB snapshot cap, so the snapshot taken first could not hold it and there would be no way back.`,
      'ENOBACKUP',
      409
    );
  }
  if ((st.mode & 0o200) === 0) {
    throw refuse(`${verb}: the file is read-only. Clear its read-only attribute first if you mean to change it.`, 'EREADONLY', 409);
  }
}

/**
 * Detects a concurrent change since the editor loaded the file.
 *
 * The realistic case is not two people, it is one person with the file open in
 * VS Code as well. Silently winning that race is how an edit disappears.
 */
async function assertUnchanged(absPath, expectedMtime) {
  if (!expectedMtime) return;
  const st = await shareGatedCall(absPath, () => fs.stat(absPath));
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
  await assertReplaceable(entry.absPath, 'Not saved');

  // Only this file: automatic snapshots hold what the operation replaces
  // (owner decision, 2026-09-27; see createSnapshot).
  const undo = await createSnapshot(lineage, {
    label: `Before editing ${path.basename(entry.absPath)}`,
    paths: [entry.absPath],
  });
  // A file the snapshot could not hold (over the 2 MB cap, or unreadable) is
  // not replaced: the save would have no way back (#96). The editor never
  // offers such a file; the API used to accept it.
  const held = assertHeld(undo, entry.absPath, 'Not saved');

  // Replaced only while it still matches what the snapshot copied (#100).
  await atomicWrite(entry.absPath, Buffer.from(content, 'utf8'), { expectSha256: held.sha256 });
  const st = await shareGatedCall(entry.absPath, () => fs.stat(entry.absPath));

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
 * builds the path; nothing in a request is ever a path. Not offered:
 * - a fixed file that already exists;
 * - anything at a level whose folder the scan could not read: a mistyped
 *   directory, or a share that did not answer, where a create made the whole
 *   folder chain or hung for the share's timeout (#99);
 * - a target a weaker level already offered. When the configuration home is
 *   also a directory's .claude (~/.claude, walked through the home folder),
 *   the user level offers it, by the user level's table (#102).
 */
export function createOptions(lineage) {
  const existing = new Set(
    lineage.levels.flatMap((l) => l.entries).filter((e) => e.type === 'file').map((e) => samePathKey(e.absPath))
  );
  const offered = new Set();
  const offerOnce = (target) => {
    const key = samePathKey(target);
    if (offered.has(key)) return false;
    offered.add(key);
    return true;
  };
  // A settings file is offered only where Claude Code reads it for this
  // project (#135): a parent folder's .claude/settings.json is never read,
  // so creating one would make a file that changes nothing.
  const readSettings = new Set(settingsSourceFiles(lineage).map((s) => samePathKey(s.file)));
  const options = [];
  for (const level of lineage.levels) {
    if (!createLevelAllowed(level.kind) || !level.dir) continue;
    const claudeDir = claudeDirOf(level);
    const unread = new Set([samePathKey(level.dir), samePathKey(claudeDir)]);
    if (level.errors.some((e) => e.path && unread.has(samePathKey(e.path)))) continue;
    // A tree folder the scan could not list: a file made there would not be
    // listed by the next scan either (#108).
    const treeUnread = (folder) => level.errors.some((e) => e.path && samePathKey(e.path) === samePathKey(folder));
    const shown = (abs) => path.relative(level.dir, abs).split(path.sep).join('/');
    // This directory's .claude IS the configuration home: the user level has
    // offered its contents already, by its own table, so nothing more here.
    const isConfigHome =
      level.kind === 'directory' &&
      lineage.levels.some((l) => l.kind === 'user' && l.dir && samePathKey(l.dir) === samePathKey(claudeDir));
    for (const f of createFiles()) {
      if (!f.levels.includes(level.kind)) continue;
      if (isConfigHome && f.where === 'claude') continue;
      const absPath = path.join(f.where === 'dir' ? level.dir : claudeDir, f.name);
      if (existing.has(samePathKey(absPath))) continue;
      if (f.category === 'settings' && !readSettings.has(samePathKey(absPath))) continue;
      if (!offerOnce(absPath)) continue;
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
      if (isConfigHome || treeUnread(folder) || !offerOnce(folder)) continue;
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
  const st = await shareGatedCall(absPath, () => fs.stat(absPath));
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
  await assertReplaceable(entry.absPath, 'Not deleted');

  const undo = await createSnapshot(lineage, { label: `Before deleting ${path.basename(entry.absPath)}`, paths: [entry.absPath] });
  const held = assertHeld(undo, entry.absPath, 'Not deleted');
  // Changed between the snapshot and now: the snapshot would restore an
  // older version than the one being deleted.
  const st = await shareGatedCall(entry.absPath, () => fs.stat(entry.absPath));
  if (st.mtime.toISOString() !== held.mtime) {
    throw refuse('The file changed while it was being snapshotted. Nothing was deleted; try again.', 'ECONFLICT', 409);
  }

  // Checked again before every unlink attempt, not only once above: the
  // Windows retry can run for seconds, and a write landing then would be
  // deleted unseen (#100).
  await removeFile(entry.absPath, { expectSha256: held.sha256 });
  return {
    absPath: entry.absPath,
    undoSnapshotId: undo.id,
    notice:
      entry.category === 'hook'
        ? 'A hooks entry in settings.json that names this script will now fail when its event fires.'
        : 'Claude Code loads configuration at session start. A session already running keeps what it loaded until it is restarted.',
  };
}

/** absPath's segments below `base`, or null when it is not strictly inside it. */
function segmentsUnder(base, absPath) {
  const rel = path.relative(base, absPath);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(/[\\/]/);
}

const sameName = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

/**
 * Whether a scan would list `absPath` inside a .claude folder (or the
 * configuration home), read from the same manifest the scan walks: one of
 * the folder's own files, or a file in one of its trees, within the tree's
 * depth, with one of its extensions, and not under a folder the walk skips.
 */
function manifestShape(claudeDir, absPath) {
  const parts = segmentsUnder(claudeDir, absPath);
  if (!parts) return false;
  if (parts.length === 1) return CLAUDE_DIR_FILE_TARGETS.some((t) => sameName(t.name, parts[0]));
  const tree = CLAUDE_DIR_TREES.find((t) => sameName(t.name, parts[0]));
  return Boolean(tree) && treeShape(tree, parts.slice(1));
}

/**
 * Whether a walk of `tree` lists a file at `rest` (the segments below the tree
 * root): within its depth (walkTree lists files down to maxDepth folders
 * below the root), under no folder it skips, and a file it takes. The same
 * two rules walkTree applies (#105).
 */
function treeShape(tree, rest) {
  if (!rest.length || rest.length - 1 > tree.maxDepth) return false;
  if (rest.slice(0, -1).some((segment) => treeSkipsDir(tree.category, segment))) return false;
  return treeTakesFile(tree.exts, rest[rest.length - 1]);
}

/** The plugins folder's shapes: its manifest files, and a cached plugin version's trees and plugin.json. */
function pluginShape(level, absPath) {
  const parts = segmentsUnder(level.dir, absPath);
  if (!parts) return false;
  if (parts.length === 1) return PLUGIN_MANIFEST_FILES.some((n) => sameName(n, parts[0]));
  // cache/<marketplace>/<plugin>/<version>/...
  if (!sameName(parts[0], 'cache') || parts.length < 5) return false;
  // Only in a version installed_plugins.json names: the scan walks no other
  // (#122), so a file restored elsewhere would be one it never lists.
  const versionDir = path.join(level.dir, ...parts.slice(0, 4));
  if (level.installs && !level.installs.some((i) => samePathKey(i.installPath) === samePathKey(versionDir))) return false;
  const rest = parts.slice(4);
  if (rest.length === 1) return sameName(rest[0], '.mcp.json');
  if (rest.length === 2 && sameName(rest[0], '.claude-plugin') && sameName(rest[1], 'plugin.json')) return true;
  const tree = CLAUDE_DIR_TREES.find((t) => sameName(t.name, rest[0]));
  return Boolean(tree) && treeShape(tree, rest.slice(1));
}

/** Project memory as scanProjectMemory walks it: .md files, two folders deep. */
const MEMORY_TREE = { category: 'memory', maxDepth: 2, exts: ['.md'] };

/**
 * Whether a restore may put back a file the current scan did not find (#92):
 * a place the current scan would list it, so a delete's undo always works
 * (#97). The route also requires the file to be in the snapshot, which only
 * ever holds scanned files.
 *
 * - Any path the scan probed and recorded as absent: ~/CLAUDE.md, the global
 *   config file, managed files, a directory's fixed targets.
 * - A directory's own config files, and the manifest shapes under its .claude
 *   folder; the same under the configuration home at the user level.
 * - Anywhere in the project-memory and plugins folders, whose files the scan
 *   walks without a fixed shape, outside the folders a walk skips.
 *
 * Never a secret. It used to allow only the first two, while delete allowed
 * every editable file, so a deleted ~/CLAUDE.md or memory note could not come
 * back (#97).
 */
export function restorableWhenAbsent(lineage, absPath) {
  if (isSecret(absPath)) return false;
  const key = samePathKey(absPath);
  for (const level of lineage.levels) {
    // A probed FILE recorded absent. Folder records (".claude/", "agents/")
    // are not: restoring a file there broke the level (#105).
    if (level.absent.some((a) => !String(a.name || '').endsWith('/') && samePathKey(a.absPath) === key)) return true;
    if (!level.dir) continue;
    if (level.kind === 'directory') {
      if (DIR_FILE_TARGETS.some((t) => samePathKey(path.join(level.dir, t.name)) === key)) return true;
      if (manifestShape(path.join(level.dir, '.claude'), absPath)) return true;
    } else if (level.kind === 'user') {
      if (manifestShape(level.dir, absPath)) return true;
    } else if (level.kind === 'project-memory') {
      const parts = segmentsUnder(level.dir, absPath);
      if (parts && treeShape(MEMORY_TREE, parts)) return true;
    } else if (level.kind === 'plugins') {
      if (pluginShape(level, absPath)) return true;
    }
  }
  return false;
}

export const NOT_RESTORABLE =
  'Not restorable under this scan: it would not list this path. Scan the project the snapshot came from.';

/**
 * The one way to restore (#105): the fence applies to every caller, the HTTP
 * route and the CLI alike. The CLI used to call restoreFiles directly, with no
 * fence at all. A path the lineage lists is restored in place; a path it
 * would list but that is gone from disk is created (#92); anything else is
 * reported in `failed`, and a batch with nothing restorable is refused.
 */
export async function restoreSnapshotFiles({ id, paths, lineage }) {
  const listed = new Set(
    lineage.levels.flatMap((l) => l.entries).filter((e) => e.type === 'file').map((e) => samePathKey(e.absPath))
  );
  const accepted = [];
  const absentPaths = [];
  const refused = [];
  for (const p of paths) {
    if (listed.has(samePathKey(p))) accepted.push(p);
    else if (restorableWhenAbsent(lineage, p)) {
      accepted.push(p);
      absentPaths.push(p);
    } else refused.push({ absPath: p, code: 'ENOTINSCAN', message: NOT_RESTORABLE });
  }
  if (!accepted.length) {
    const err = refuse(NOT_RESTORABLE, 'ENOTINSCAN', 403);
    err.details = { refused };
    throw err;
  }
  const result = await restoreFiles(id, accepted, lineage, { absentPaths });
  result.failed.push(...refused);
  return result;
}
