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

import { snapshotRoot } from './paths.js';
import { MAX_FILE_BYTES, describeError, isSecret, isSensitive } from './safety.js';

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
export async function atomicWrite(absPath, data) {
  const dir = path.dirname(absPath);
  const temp = path.join(dir, `.layercake-tmp-${crypto.randomBytes(6).toString('hex')}`);
  await fs.mkdir(dir, { recursive: true });
  try {
    await fs.writeFile(temp, data);
    await fs.rename(temp, absPath);
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
      st = await fs.stat(target.absPath);
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
      await fs.copyFile(target.absPath, dest);
      files.push({
        absPath: target.absPath,
        stored: stored.split(path.sep).join('/'),
        category: target.category,
        level: target.level,
        size: st.size,
        mtime: st.mtime.toISOString(),
        sha256: await sha256(target.absPath),
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
  const stored = path.join(snapshotRoot(), safeId(id), FILES_DIR, ...entry.stored.split('/'));
  return { entry, content: await fs.readFile(stored, 'utf8') };
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
      const current = await sha256(entry.absPath);
      rows.push({ ...entry, status: current === entry.sha256 ? 'same' : 'changed', currentSha256: current });
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
export async function restoreFiles(id, absPaths, lineage) {
  const manifest = await readManifest(id);
  const wanted = new Set(absPaths.map((p) => path.resolve(p)));
  const chosen = manifest.files.filter((f) => wanted.has(path.resolve(f.absPath)));

  if (chosen.length === 0) {
    const err = new Error('None of the requested files are in this snapshot.');
    err.status = 400;
    throw err;
  }

  const undo = await createSnapshot(lineage, { label: `Before restore from ${id}` });

  const restored = [];
  const failed = [];
  for (const entry of chosen) {
    const stored = path.join(snapshotRoot(), safeId(id), FILES_DIR, ...entry.stored.split('/'));
    try {
      const data = await fs.readFile(stored);
      await atomicWrite(entry.absPath, data);
      restored.push(entry.absPath);
    } catch (err) {
      failed.push({ absPath: entry.absPath, ...describeError(err) });
    }
  }
  return { restored, failed, undoSnapshotId: undo.id };
}
