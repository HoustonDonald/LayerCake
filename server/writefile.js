/**
 * The edit path. Single entry point for changing a file the scan discovered.
 *
 * Imports snapshot.js on purpose: "every edit is preceded by a snapshot" is a
 * property of the import graph here, not a step a route has to remember.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import yaml from 'js-yaml';

import { createSnapshot, atomicWrite } from './snapshot.js';
import {
  MAX_WRITE_BYTES,
  isEditableCategory,
  isExecutableCategory,
  isSecret,
} from './safety.js';
import { splitFrontmatter } from './readfile.js';

function refuse(message, code, status = 403) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
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
