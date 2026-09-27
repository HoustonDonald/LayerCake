/**
 * Snapshot capture and selective restore.
 *
 * A snapshot is a plain mirrored directory tree plus a manifest, not an archive
 * format. That is a supportability decision: if this tool is broken or gone, the
 * recovery path is File Explorer and copy/paste. An opaque blob would make the
 * backup depend on the thing it exists to survive.
 *
 * This module and writefile.js are the only places in server/ that call a
 * mutating fs API. writefile.js depends on THIS module rather than the reverse,
 * so "every edit is preceded by a snapshot" is enforced by the import graph
 * instead of by a route remembering to do it.
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { TEMP_PREFIX, samePathKey, snapshotRoot } from './paths.js';
import { FILE_TIMEOUT_MS, MAX_FILE_BYTES, describeError, isSecret, isSensitive } from './safety.js';
import { shareGatedCall } from './sharegate.js';

/** Manifest schema version. Bumped when the on-disk shape changes. */
const MANIFEST_VERSION = 1;
const MANIFEST_NAME = 'manifest.json';
const FILES_DIR = 'files';

/**
 * Writes via a temp file in the SAME directory, then renames over the target.
 *
 * Same directory matters: rename is only atomic within a volume, and a temp in
 * %TEMP% can land on a different one. On Windows, fs.rename maps to MoveFileEx
 * with MOVEFILE_REPLACE_EXISTING, so replacing an existing file is fine.
 *
 * A crash mid-write therefore leaves either the old file or the new one, never
 * a half-written config that Claude Code would fail to parse on next start.
 */
/**
 * Windows refuses to rename over a file another process has open (EPERM,
 * EACCES, EBUSY): antivirus, the search indexer, Claude Code reading a
 * settings file, LayerCake's own reads. Measured: 99 of 300 writes failed
 * with a reader polling the target, 0 of 300 without (#49). The rename is
 * retried with backoff, as graceful-fs does, which is safe because the temp
 * file still exists and the target is untouched until it succeeds. Windows
 * only: elsewhere those codes are real permission errors, not a race.
 *
 * A read-only target gives the same EPERM but will never succeed, so it fails
 * at once rather than after the whole window. That is what lets the window be
 * long: 2 s measured about 1 failure in 100 saves against a reader holding
 * the file ~70% of the time, and each doubling of attempts squares that.
 */
const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_RETRY_MS = 5000;

async function isReadOnly(p) {
  try {
    return ((await fs.stat(p)).mode & 0o200) === 0;
  } catch {
    return false;
  }
}

/** Runs `op` on `target`, retrying while another process holds it open (see above). */
async function retryingWhileLocked(op, target) {
  let waited = 0;
  for (let delay = 10; ; delay = Math.min(delay * 2, 200)) {
    try {
      return await op();
    } catch (err) {
      if (process.platform !== 'win32' || !RENAME_RETRY_CODES.has(err.code) || waited >= RENAME_RETRY_MS) throw err;
      if (await isReadOnly(target)) throw err;
      await new Promise((r) => setTimeout(r, delay));
      waited += delay;
    }
  }
}

async function renameRetrying(from, to, before = async () => {}) {
  return retryingWhileLocked(async () => {
    await before();
    return fs.rename(from, to);
  }, to);
}

/**
 * Refuses unless the file at absPath still holds exactly what the undo
 * snapshot copied (#100). Run before EVERY replace or unlink attempt, not once
 * before the retry loop: while Windows keeps the target locked the loop can
 * run for seconds, and a write landing then was replaced or deleted unseen.
 * The hash is of the stored copy, so a match means the snapshot has these
 * bytes. Without an expected hash (a file no snapshot was asked about) it
 * checks nothing.
 */
async function assertStillHeld(absPath, expectSha256) {
  if (!expectSha256) return;
  // Gated on a share (#66): a dead one fails here, before any write is made.
  if ((await shareGatedCall(absPath, () => sha256(absPath), absPath, FILE_TIMEOUT_MS)) !== expectSha256) {
    throw fail(
      'The file changed after the snapshot was taken, so the snapshot no longer holds what would be replaced. Nothing was changed; try again.',
      409,
      'ECONFLICT'
    );
  }
}

/**
 * Creates a file that must not exist yet (#15), and never replaces one that
 * does: a create that silently won a race with an editor would destroy a file
 * no snapshot holds, because it was not there when the scan ran.
 *
 * The content goes to a temp file first and is published with a hard link,
 * which fails with EEXIST instead of replacing, so the file appears whole or
 * not at all. A volume without hard links (FAT, some shares) gets an exclusive
 * create instead: still never a replacement, but a crash mid-write could leave
 * a partial new file there. Missing folders are made first, which is how a
 * level's .claude/agents/ comes to exist.
 */
export async function createExclusive(absPath, data) {
  const dir = path.dirname(absPath);
  await fs.mkdir(dir, { recursive: true });
  const temp = path.join(dir, `${TEMP_PREFIX}${crypto.randomBytes(6).toString('hex')}`);
  try {
    await fs.writeFile(temp, data);
    try {
      await fs.link(temp, absPath);
    } catch (err) {
      if (err.code === 'EEXIST') throw err;
      await fs.writeFile(absPath, data, { flag: 'wx' });
    }
  } finally {
    try {
      await fs.rm(temp, { force: true });
    } catch {
      /* an orphaned temp file; the target is either whole or absent */
    }
  }
}

/**
 * Deletes one file (#15). Only ever called by writefile.js after a snapshot
 * that holds the file, whose hash it passes as `expectSha256`. Retried like a
 * rename, because Windows refuses to delete a file another process has open.
 */
export async function removeFile(absPath, { expectSha256 = null } = {}) {
  return retryingWhileLocked(async () => {
    await assertStillHeld(absPath, expectSha256);
    return fs.unlink(absPath);
  }, absPath);
}

/**
 * `expectSha256`, when given, is the hash of the undo snapshot's copy of the
 * file being replaced: the rename happens only while the file still matches it.
 */
export async function atomicWrite(absPath, data, { expectSha256 = null } = {}) {
  const dir = path.dirname(absPath);
  const temp = path.join(dir, `${TEMP_PREFIX}${crypto.randomBytes(6).toString('hex')}`);
  await fs.mkdir(dir, { recursive: true });
  try {
    await fs.writeFile(temp, data);
    await renameRetrying(temp, absPath, () => assertStillHeld(absPath, expectSha256));
  } catch (err) {
    // Best effort cleanup. The original is untouched either way, because the
    // rename is what publishes the change.
    try {
      await fs.rm(temp, { force: true });
    } catch {
      /* the temp file is orphaned; the target is still intact, which is what matters */
    }
    throw err;
  }
}

/** Sortable, filesystem safe, and readable at a glance in Explorer. */
function newSnapshotId() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/**
 * Absolute path to a location under the snapshot's files/ mirror.
 * `C:\dev\x\CLAUDE.md` becomes `C/dev/x/CLAUDE.md`, and a UNC path
 * `\\host\share\x` becomes `UNC/host/share/x`.
 *
 * The manifest records this mapping per file, so restore never re-derives it.
 * That keeps a future change to this function from silently breaking old
 * snapshots.
 */
export function mirrorPath(absPath) {
  const resolved = path.resolve(absPath);
  if (/^[\\/]{2}/.test(resolved)) {
    return path.join('UNC', ...resolved.replace(/^[\\/]{2}/, '').split(/[\\/]+/).filter(Boolean));
  }
  const parts = resolved.split(/[\\/]+/).filter(Boolean);
  if (parts.length && /^[A-Za-z]:$/.test(parts[0])) parts[0] = parts[0][0];
  return path.join(...parts);
}

async function sha256(absPath) {
  const buf = await fs.readFile(absPath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Every file the scan found, level by level.
 * Secrets never reach here (the scan excludes them), but it is re-checked
 * because a backup silently containing credentials would be the worst possible
 * failure of this feature.
 */
function collectTargets(lineage) {
  const targets = [];
  // One physical file can legitimately appear at two levels: when the project
  // sits under the home directory, the directory walk passes through home and
  // re-finds everything the user level already reported. That duplication is
  // meaningful in the lineage view, but here it would copy and count the same
  // bytes twice, so the snapshot is keyed by path. First occurrence wins, which
  // is the weakest-precedence level; the content is identical either way.
  const seen = new Set();
  for (const level of lineage.levels) {
    for (const entry of level.entries) {
      if (entry.type !== 'file') continue;
      if (isSecret(entry.absPath)) continue;
      const key = process.platform === 'win32'
        ? path.resolve(entry.absPath).toLowerCase()
        : path.resolve(entry.absPath);
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push({
        absPath: entry.absPath,
        category: entry.category,
        level: { kind: level.kind, label: level.label, dir: level.dir || null },
      });
    }
  }
  return targets;
}

/**
 * Captures a snapshot of everything in a lineage.
 *
 * Oversized files are SKIPPED and recorded, never truncated. A truncated file in
 * a backup is worse than an absent one: restoring it would silently destroy the
 * tail of a config, and nothing downstream would report it.
 */
export async function createSnapshot(lineage, { label = '' } = {}) {
  const id = newSnapshotId();
  const root = path.join(snapshotRoot(), id);
  const filesRoot = path.join(root, FILES_DIR);
  await fs.mkdir(filesRoot, { recursive: true });

  const files = [];
  const errors = [];
  const skipped = [];

  for (const target of collectTargets(lineage)) {
    let st;
    try {
      // Reads of a scanned file are gated on a share (#66); the copy lands in
      // the local snapshot store.
      st = await shareGatedCall(target.absPath, () => fs.stat(target.absPath));
    } catch (err) {
      errors.push({ absPath: target.absPath, ...describeError(err) });
      continue;
    }
    if (st.size > MAX_FILE_BYTES) {
      skipped.push({
        absPath: target.absPath,
        size: st.size,
        reason: `Larger than the ${MAX_FILE_BYTES} byte cap. Skipped rather than truncated, because a truncated backup restores as data loss.`,
      });
      continue;
    }

    const stored = mirrorPath(target.absPath);
    const dest = path.join(filesRoot, stored);
    try {
      await fs.mkdir(path.dirname(dest), { recursive: true });
      // copyFile rather than a utf8 read/write round trip: hooks may be any
      // extension, including a binary, and a round trip would corrupt one.
      await shareGatedCall(target.absPath, () => fs.copyFile(target.absPath, dest), target.absPath, FILE_TIMEOUT_MS);
      files.push({
        absPath: target.absPath,
        stored: stored.split(path.sep).join('/'),
        category: target.category,
        level: target.level,
        size: st.size,
        mtime: st.mtime.toISOString(),
        // Of the stored copy, not the source: it is what a delete, save or
        // restore compares against to prove the snapshot holds the bytes it
        // is about to replace (#100).
        sha256: await sha256(dest),
        // ~/.claude.json, settings.local.json and .mcp.json are part of the
        // lineage and belong in a backup, but they can carry OAuth tokens and
        // machine-specific secrets. Flagged rather than excluded, because
        // dropping them would make a restore quietly incomplete. In place the
        // snapshot inherits the same user ACL as the original; the exposure
        // appears the moment someone copies it to a share, a USB stick or
        // another machine, which is exactly when a warning is worth having.
        sensitive: isSensitive(target.absPath),
      });
    } catch (err) {
      errors.push({ absPath: target.absPath, ...describeError(err) });
    }
  }

  const manifest = {
    version: MANIFEST_VERSION,
    id,
    label,
    createdAt: new Date().toISOString(),
    projectDir: lineage.projectDir,
    home: lineage.home,
    platform: lineage.platform,
    counts: {
      files: files.length,
      errors: errors.length,
      skipped: skipped.length,
      sensitive: files.filter((f) => f.sensitive).length,
    },
    files,
    errors,
    skipped,
  };
  await atomicWrite(path.join(root, MANIFEST_NAME), JSON.stringify(manifest, null, 2));
  return manifest;
}

/** Newest first. A snapshot whose manifest will not parse is reported, not hidden. */
export async function listSnapshots() {
  const root = snapshotRoot();
  let names;
  try {
    names = await fs.readdir(root, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  for (const dirent of names) {
    if (!dirent.isDirectory()) continue;
    try {
      const raw = await fs.readFile(path.join(root, dirent.name, MANIFEST_NAME), 'utf8');
      const m = JSON.parse(raw);
      out.push({
        id: m.id,
        label: m.label || '',
        createdAt: m.createdAt,
        projectDir: m.projectDir,
        platform: m.platform,
        counts: m.counts,
      });
    } catch (err) {
      out.push({ id: dirent.name, broken: true, ...describeError(err) });
    }
  }
  return out.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

export async function readManifest(id) {
  const raw = await fs.readFile(path.join(snapshotRoot(), safeId(id), MANIFEST_NAME), 'utf8');
  return JSON.parse(raw);
}

/**
 * A snapshot id is a path segment, so it is validated rather than trusted.
 * Ids are generated from an ISO timestamp, so this pattern is exact, not a
 * best-effort sanitizer.
 */
function safeId(id) {
  const value = String(id);
  if (!/^[0-9TZ-]+$/.test(value)) {
    const err = new Error('Invalid snapshot id.');
    err.status = 400;
    throw err;
  }
  return value;
}

/** The stored copy of one file, for the restore diff view. */
export async function readSnapshotFile(id, absPath) {
  const manifest = await readManifest(id);
  const entry = manifest.files.find((f) => f.absPath === absPath);
  if (!entry) {
    const err = new Error('That file is not in this snapshot.');
    err.status = 404;
    throw err;
  }
  return { entry, content: await fs.readFile(storedPathOf(id, entry), 'utf8') };
}

function fail(message, status, code) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

/**
 * Where a manifest entry's stored copy is, checked rather than trusted: the
 * manifest is a plain file in LayerCake's folder, and an edited `stored` of
 * ../../../x read any file on disk, credentials included (#101). The copy
 * must sit inside this snapshot's files/ folder, and neither it nor the file
 * it stands for may be a credential file. Equality with mirrorPath() is not
 * required, so a future change to that function cannot orphan old snapshots.
 */
function storedPathOf(id, entry) {
  const root = path.join(snapshotRoot(), safeId(id), FILES_DIR);
  const stored = path.join(root, ...String(entry.stored || '').split('/'));
  const rel = path.relative(root, stored);
  if (!entry.stored || !rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw fail('This snapshot entry points outside its snapshot.', 400, 'EBADMANIFEST');
  }
  if (isSecret(String(entry.absPath || '')) || isSecret(stored)) {
    throw fail('Credential file. Never read and never written by this tool.', 403, 'EREDACTED');
  }
  return stored;
}

/** Whether something is at `p`. Only "not there" says no; any other error counts as present. */
async function presentOnDisk(p) {
  try {
    await shareGatedCall(p, () => fs.stat(p));
    return true;
  } catch (err) {
    return err.code !== 'ENOENT';
  }
}

/**
 * Compares a snapshot against what is on disk right now.
 * Status is per file: `same`, `changed`, `missing` (gone from disk), or `error`.
 */
export async function compareSnapshot(id) {
  const manifest = await readManifest(id);
  const rows = [];
  for (const entry of manifest.files) {
    try {
      const { size } = await shareGatedCall(entry.absPath, () => fs.stat(entry.absPath));
      const current = await shareGatedCall(entry.absPath, () => sha256(entry.absPath), entry.absPath, FILE_TIMEOUT_MS);
      rows.push({ ...entry, status: current === entry.sha256 ? 'same' : 'changed', currentSha256: current, currentSize: size });
    } catch (err) {
      const described = describeError(err);
      rows.push({
        ...entry,
        status: described.code === 'ENOENT' ? 'missing' : 'error',
        error: described,
      });
    }
  }
  return { manifest, rows };
}

/**
 * Restores selected files from a snapshot.
 *
 * Takes its own snapshot of current state first, so a restore is itself
 * undoable. `lineage` is required for that reason and not optional.
 */
export async function restoreFiles(id, absPaths, lineage, { absentPaths = [] } = {}) {
  // Paths the current scan did not find (#92): gone from disk when it ran.
  // Those are created, never replaced, because the undo snapshot below is
  // taken from the scan and cannot hold a file that has appeared since.
  const absentKeys = new Set(absentPaths.map((p) => samePathKey(p)));
  const manifest = await readManifest(id);
  const wanted = new Set(absPaths.map((p) => path.resolve(p)));
  const chosen = manifest.files.filter((f) => wanted.has(path.resolve(f.absPath)));

  if (chosen.length === 0) {
    const err = new Error('None of the requested files are in this snapshot.');
    err.status = 400;
    throw err;
  }

  const undo = await createSnapshot(lineage, { label: `Before restore from ${id}` });
  const held = new Map(undo.files.map((f) => [samePathKey(f.absPath), f]));

  const restored = [];
  const failed = [];
  for (const entry of chosen) {
    try {
      const data = await fs.readFile(storedPathOf(id, entry));
      const key = samePathKey(entry.absPath);
      if (absentKeys.has(key) || !(await presentOnDisk(entry.absPath))) {
        // Nothing there to lose: created, and never over a file that has
        // appeared since, which no snapshot holds.
        await createExclusive(entry.absPath, data);
      } else if (!held.has(key)) {
        // There, but the undo snapshot could not hold it (over the 2 MB cap,
        // or unreadable): replacing it would leave no copy anywhere (#96).
        failed.push({
          absPath: entry.absPath,
          code: 'ENOBACKUP',
          message: 'Not restored: the snapshot taken first could not hold the current file (over the 2 MB cap, or unreadable), so replacing it would have no way back.',
        });
        continue;
      } else {
        await atomicWrite(entry.absPath, data, { expectSha256: held.get(key).sha256 });
      }
      restored.push(entry.absPath);
    } catch (err) {
      const described = describeError(err);
      if (err.code === 'EEXIST') {
        described.message = 'A file has appeared here since the scan. Re-scan and restore again, so it is snapshotted first.';
      }
      failed.push({ absPath: entry.absPath, ...described });
    }
  }
  return { restored, failed, undoSnapshotId: undo.id };
}
