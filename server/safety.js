/**
 * Guard rails.
 *
 * This module is the single place where "what may be touched" is decided.
 *
 * The app was read-only until write support landed. It is now read-write, but
 * narrowly: server/writefile.js and server/snapshot.js are the ONLY modules
 * permitted to call a mutating fs API, every write that replaces or removes a
 * file is preceded by an automatic snapshot, and every such target must have
 * been discovered by a prior scan. A new file goes only where the create
 * tables below allow (#15). See README "Write posture" for the audit command.
 */

import path from 'node:path';

import { TEMP_PREFIX, pluginCacheDir, samePathKey } from './paths.js';

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
  // Claude Code's cache of server-managed settings, which it writes readable
  // by its owner only (mode 0600 in the 2.1.283 bundle) (#147).
  'remote-settings.json',
]);

/**
 * Directories under a .claude/ folder that are runtime state, not config.
 * Listed as "other" at the level, but never recursed into: `worktrees` alone
 * can hold tens of full checkouts.
 */
const NON_CONFIG_DIRS = new Set([
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

/**
 * Settings keys whose value Claude Code RUNS, and the categories that hold
 * them (#19; owner decision, 2026-09-26). An edit that adds or changes one of
 * these needs the same acknowledgement as a hook script: it is the inline
 * route to execution the comment above describes. Removing one does not.
 * Source: the settings reference, keys "with your own command" or that launch
 * a program, plus statusLine and subagentStatusLine (a command the status
 * line runs) and the MCP server tables (each entry names a command).
 *
 * Not covered, and said so: `env`. It can arrange execution indirectly
 * (NODE_OPTIONS, PATH), but it is edited routinely, and the owner chose
 * ordinary settings edits to stay free of the acknowledgement.
 */
const COMMAND_KEYS = [
  'hooks',
  'statusLine',
  'subagentStatusLine',
  'apiKeyHelper',
  'awsAuthRefresh',
  'awsCredentialExport',
  'gcpAuthRefresh',
  'otelHeadersHelper',
  'fileSuggestion',
  'policyHelper',
  'processWrapper',
  'mcpServers',
  'managedMcpServers',
];
const COMMAND_KEY_CATEGORIES = new Set(['settings', 'mcp']);

/** Stable text for a JSON value, so key order alone never reads as a change. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * The command keys an edit adds or changes, comparing the parsed file before
 * and after. Empty for any category that cannot hold them, and for content
 * that is not a JSON object (validation refuses that separately).
 */
export function commandKeysChanged(category, before, after) {
  if (!COMMAND_KEY_CATEGORIES.has(String(category))) return [];
  const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  const was = obj(before);
  const now = obj(after);
  return COMMAND_KEYS.filter((k) => Object.hasOwn(now, k) && canonical(now[k]) !== canonical(was[k]));
}

/**
 * What may be CREATED (#15; owner decision 9, 2026-09-26): fenced, from a
 * template, never at a path the request names. Only a user level or a
 * directory level of a scan; managed policy, plugins and Claude Code's own
 * project memory are not LayerCake's to add to.
 *
 * `where` is relative to the level: 'dir' is the directory itself, 'claude' is
 * its .claude folder, which at the user level is the configuration home. Every
 * name must also be a scan manifest target (writefile.js checks that at load),
 * so a created file is always one the next scan lists. Kept to the files
 * Claude Code documents at each place; keybindings.json has no template here
 * because its format is not one this tool knows.
 */
const CREATE_LEVEL_KINDS = new Set(['user', 'directory']);
const CREATE_FILES = [
  { where: 'dir', name: 'CLAUDE.md', category: 'memory', levels: ['directory'] },
  { where: 'dir', name: '.mcp.json', category: 'mcp', levels: ['directory'] },
  { where: 'claude', name: 'CLAUDE.md', category: 'memory', levels: ['user', 'directory'] },
  { where: 'claude', name: 'settings.json', category: 'settings', levels: ['user', 'directory'] },
  // At the user level only for a session started in the folder above the
  // config home, the one place Claude Code reads it (createOptions, #135).
  { where: 'claude', name: 'settings.local.json', category: 'settings', levels: ['user', 'directory'] },
];
/** Named files in a .claude subtree. A skill is a folder holding SKILL.md. */
const CREATE_TREES = [
  { tree: 'agents', category: 'agent', exts: ['.md'] },
  { tree: 'commands', category: 'command', exts: ['.md'] },
  { tree: 'rules', category: 'rule', exts: ['.md'] },
  { tree: 'skills', category: 'skill', exts: ['.md'], folderFile: 'SKILL.md' },
  { tree: 'hooks', category: 'hook', exts: ['.sh', '.ps1', '.py', '.js', '.mjs'] },
];
/**
 * A created name is one path segment by construction: lowercase letters,
 * digits, - and _, no dot, so no "..", no extension trick and no separator.
 * Lowercase because agent and skill names must be, and so a case-only
 * variant of an existing file cannot be made on a case-sensitive volume.
 * Windows device names are refused whatever the extension (con.md is CON).
 */
const CREATE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const WINDOWS_DEVICE_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/;

export function createLevelAllowed(kind) {
  return CREATE_LEVEL_KINDS.has(String(kind));
}

export function createFiles() {
  return CREATE_FILES.map((f) => ({ ...f, levels: [...f.levels] }));
}

export function createTrees() {
  return CREATE_TREES.map((t) => ({ ...t, exts: [...t.exts] }));
}

/** Null when the name may be created, else the reason, for the UI to show. */
export function createNameProblem(name) {
  const value = String(name ?? '');
  if (!CREATE_NAME_RE.test(value)) {
    return 'Use 1 to 64 lowercase letters, digits, - or _, starting with a letter or digit.';
  }
  if (WINDOWS_DEVICE_RE.test(value)) return `"${value}" is a reserved device name on Windows.`;
  // A folder the scan skips inside a tree would be created and never listed (#104).
  if (isTreeSkipDir(value)) return `"${value}" is a folder name the scan skips.`;
  return null;
}

/** Largest file body returned to the browser. Larger files are truncated. */
export const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** Largest body accepted on a write. Same cap, so a round trip cannot truncate. */
export const MAX_WRITE_BYTES = MAX_FILE_BYTES;

/** Per-directory filesystem timeout. Keeps a dead UNC share from hanging a scan. */
export const DIR_TIMEOUT_MS = Number(process.env.CLAUDE_EXPLORER_DIR_TIMEOUT_MS || 3000);

/**
 * Budget for reading a file whole (a copy, a hash, a read of up to 2 MB). Longer
 * than DIR_TIMEOUT_MS because over a slow share the transfer itself takes time;
 * still bounded, because a dead share otherwise hangs for 21 s per call (#66).
 */
export const FILE_TIMEOUT_MS = 15000;

export function isSecret(filePath) {
  return SECRET_BASENAMES.has(path.basename(filePath).toLowerCase());
}

export function isSensitive(filePath) {
  return SENSITIVE_BASENAMES.has(path.basename(filePath).toLowerCase());
}

/**
 * Categories of file Claude Code itself rewrites as it runs: `~/.claude.json`,
 * the plugin manifests and its cache of server-managed settings (#147). They
 * nearly always differ from a snapshot, and
 * rolling one back rolls back Claude Code's own state, so no restore selects
 * them unless asked by name (#96, #109). One list for the page and the CLI:
 * the CLI once selected `~/.claude.json` by default and printed an undo that
 * did it again (#134).
 */
const CLAUDE_REWRITES = new Set(['home-config', 'plugin-manifest', 'remote-settings']);

export function rewrittenByClaudeCode(category) {
  return CLAUDE_REWRITES.has(category);
}

export function isNonConfigDir(name) {
  return NON_CONFIG_DIRS.has(name.toLowerCase());
}

/**
 * Folders skipped INSIDE a config tree (agents/, skills/, ...), a much shorter
 * list than the one above, which describes the .claude root. Inside a tree a
 * folder called debug, tasks or logs is a skill or a command namespace, and
 * applying the root's list there hid it (#98).
 *
 * `.trash`: Claude Code moves removed skills to skills/.trash/<epoch>-<pid>-<id>/
 * and nothing loads from there. Seen 2026-09-26; walking it listed dozens of
 * deleted skills as if they were live config.
 */
const TREE_SKIP_DIRS = new Set(['.trash', 'node_modules', '.git']);

export function isTreeSkipDir(name) {
  return TREE_SKIP_DIRS.has(String(name).toLowerCase());
}

/**
 * The walk's two rules, in one place for the scan and for the restore fence,
 * so a restore can only put a file where the next scan lists it (#105).
 *
 * A folder inside a tree is skipped when it is tree-level runtime state, and
 * in hooks/, which takes any extension, when it is .claude-root runtime state
 * too (#104). A file is taken when its extension fits the tree, it is not a
 * LayerCake temp file, and it is not a credential file.
 */
export function treeSkipsDir(category, name) {
  return isTreeSkipDir(name) || (category === 'hook' && isNonConfigDir(name));
}

export function treeTakesFile(exts, name) {
  const lower = String(name).toLowerCase();
  if (lower.startsWith(TEMP_PREFIX) || isSecret(name)) return false;
  return !exts || exts.includes(path.extname(lower));
}

export function isEditableCategory(category) {
  return EDITABLE_CATEGORIES.has(String(category));
}

/**
 * Read only wherever it sits, whatever its category (#126; owner decision,
 * 2026-09-28): the plugin cache. Claude Code replaces a plugin's version
 * folder when the plugin updates, so an edit, delete, create or restore there
 * would be undone without warning. Decided by path, not by the level that
 * listed the file, so a second route to the same file cannot make it editable.
 * Lexical, like every fence here: a junction into the cache is followed.
 */
const PLUGIN_CACHE_READ_ONLY =
  'Plugin cache: Claude Code keeps its own copy of each installed plugin here and replaces it when the plugin updates, ' +
  'so a change made here would be lost without warning. Read only in LayerCake; change the plugin at its source.';

/** The reason `absPath` is read only, or null when the ordinary rules apply. */
export function readOnlyReason(absPath) {
  const rel = path.relative(samePathKey(pluginCacheDir()), samePathKey(absPath));
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? PLUGIN_CACHE_READ_ONLY : null;
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
    // Whatever the category (#126): no edit, delete, create or restore inside it.
    readOnly: [{ dir: pluginCacheDir(), reason: PLUGIN_CACHE_READ_ONLY }],
    requiresAcknowledgement: [...EXECUTABLE_CATEGORIES].sort(),
    // Content-dependent: an edit to one of these categories that adds or
    // changes one of these keys needs the same acknowledgement (#19).
    acknowledgeCommandKeys: { categories: [...COMMAND_KEY_CATEGORIES].sort(), keys: [...COMMAND_KEYS] },
    maxWriteBytes: MAX_WRITE_BYTES,
    neverWritten: [...SECRET_BASENAMES].sort(),
    // Never selected for a restore unless named (#134); compare rows carry it.
    restoreOnlyByName: [...CLAUDE_REWRITES].sort(),
    // #15: what a create may add, and where. The per-level options a scan
    // offers are built from exactly these tables.
    create: {
      levels: [...CREATE_LEVEL_KINDS].sort(),
      files: createFiles(),
      trees: createTrees(),
      namePattern: CREATE_NAME_RE.source,
    },
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
