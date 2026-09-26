/**
 * Guard rails.
 *
 * This module is the single place where "what may be touched" is decided.
 *
 * The app was read-only until write support landed. It is now read-write, but
 * narrowly: server/writefile.js and server/snapshot.js are the ONLY modules
 * permitted to call a mutating fs API, every write is preceded by an automatic
 * snapshot, and every write target must have been discovered by a prior scan.
 * See README "Write posture" for the audit command.
 */

import path from 'node:path';

/**
 * Never read, never listed, never acknowledged beyond a redaction marker.
 * Matched on basename, case-insensitively (Windows filesystems are case
 * insensitive, so a case variant must not slip past).
 */
const SECRET_BASENAMES = new Set([
  '.credentials.json',
  'credentials.json',
  '.env',
  '.env.local',
]);

/**
 * Config that legitimately belongs in the lineage but can carry tokens.
 * Displayed with a warning banner rather than hidden.
 */
const SENSITIVE_BASENAMES = new Set([
  'settings.local.json',
  '.claude.json',
  '.mcp.json',
]);

/**
 * Directories under a .claude/ folder that are runtime state, not config.
 * Listed as "other" at the level, but never recursed into: `worktrees` alone
 * can hold tens of full checkouts.
 */
const NON_CONFIG_DIRS = new Set([
  // Claude Code moves removed skills here (skills/.trash/<epoch>-<pid>-<id>/),
  // and nothing loads from it. Seen 2026-09-26; walking it listed dozens of
  // deleted skills as if they were live config.
  '.trash',
  'worktrees',
  'sessions',
  'projects',
  'shell-snapshots',
  'cache',
  'debug',
  'file-history',
  'backups',
  'paste-cache',
  'session-env',
  'tasks',
  'jobs',
  'ide',
  'daemon',
  'chrome',
  'statsig',
  'todos',
  'logs',
  'node_modules',
  '.git',
]);

/**
 * Scan categories that may be written back.
 *
 * `other` is absent deliberately: it is the bucket for things the scan listed
 * but does not understand, and editing a file we cannot classify is how you
 * corrupt something you did not know was structured.
 */
const EDITABLE_CATEGORIES = new Set([
  'memory',
  'settings',
  'mcp',
  'agent',
  'skill',
  'command',
  'rule',
  'hook',
]);

/**
 * Categories whose content Claude Code EXECUTES rather than reads.
 *
 * Editing one of these is a different act from editing a note, so the API makes
 * the caller acknowledge it explicitly and the UI turns that into a checkbox.
 *
 * Be honest about what this is worth: it is a speed bump, not a boundary.
 * settings.json can define hooks inline, and settings.json is an ordinary
 * editable file, so anyone who can write settings can arrange for execution
 * without touching a hook script. The acknowledgement exists to stop an absent
 * minded edit, not a determined one.
 */
const EXECUTABLE_CATEGORIES = new Set(['hook']);

/** Largest file body returned to the browser. Larger files are truncated. */
export const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** Largest body accepted on a write. Same cap, so a round trip cannot truncate. */
export const MAX_WRITE_BYTES = MAX_FILE_BYTES;

/** Per-directory filesystem timeout. Keeps a dead UNC share from hanging a scan. */
export const DIR_TIMEOUT_MS = Number(process.env.CLAUDE_EXPLORER_DIR_TIMEOUT_MS || 3000);

export function isSecret(filePath) {
  return SECRET_BASENAMES.has(path.basename(filePath).toLowerCase());
}

export function isSensitive(filePath) {
  return SENSITIVE_BASENAMES.has(path.basename(filePath).toLowerCase());
}

export function isNonConfigDir(name) {
  return NON_CONFIG_DIRS.has(name.toLowerCase());
}

export function isEditableCategory(category) {
  return EDITABLE_CATEGORIES.has(String(category));
}

export function isExecutableCategory(category) {
  return EXECUTABLE_CATEGORIES.has(String(category));
}

/**
 * The write policy, for /api/manifest.
 *
 * Derived from the sets the guards actually consult, never a hand-kept copy:
 * the manifest exists so the tool's stated behavior can be checked against its
 * real behavior, and a duplicated list would drift and quietly make that
 * check meaningless.
 */
export function writePolicy() {
  return {
    editableCategories: [...EDITABLE_CATEGORIES].sort(),
    requiresAcknowledgement: [...EXECUTABLE_CATEGORIES].sort(),
    maxWriteBytes: MAX_WRITE_BYTES,
    neverWritten: [...SECRET_BASENAMES].sort(),
  };
}

/**
 * Races a promise against a timer so an unresponsive network path degrades to
 * an error badge on one level instead of stalling the whole scan.
 *
 * It stops waiting; it cannot cancel. The call it gave up on still holds a
 * threadpool thread, which is why calls to a share go through sharegate.js.
 */
export function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`Timed out after ${ms}ms: ${label}`);
      err.code = 'ETIMEDOUT';
      reject(err);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Normalizes a filesystem error into something safe to show in the UI. */
export function describeError(err) {
  if (!err) return null;
  const code = err.code || 'EUNKNOWN';
  const messages = {
    EACCES: 'Permission denied',
    EPERM: 'Operation not permitted',
    ENOENT: 'Not found',
    ENOTDIR: 'Not a directory',
    EBUSY: 'Resource busy or locked',
    ELOOP: 'Symlink loop',
    ETIMEDOUT: 'Timed out (unresponsive path)',
    // Not an errno: sharegate.js refused the call without making it.
    ESHARESTUCK: 'Not tried: an earlier call to this network share timed out and has not returned yet',
    ENETUNREACH: 'Network unreachable',
    EHOSTUNREACH: 'Host unreachable',
    ENAMETOOLONG: 'Path too long',
    EINVAL: 'Invalid path',
    EIO: 'I/O error',
    // Windows reports a dead or disconnected UNC share as UNKNOWN rather than a
    // network errno, so the raw message is useless without this translation.
    UNKNOWN: 'Unreachable path (typical of a disconnected network share)',
  };
  return { code, message: messages[code] || err.message || String(err) };
}
