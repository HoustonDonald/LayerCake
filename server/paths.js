/**
 * Platform path resolution. Windows first, POSIX handled.
 *
 * The scan manifest lives here so the UI can render "expected but absent"
 * entries: absence is information, and hiding it would be a lie of omission.
 */

import os from 'node:os';
import path from 'node:path';

/** Files probed directly inside every directory on the walk. */
export const DIR_FILE_TARGETS = [
  { name: 'CLAUDE.md', category: 'memory' },
  { name: 'CLAUDE.local.md', category: 'memory' },
  { name: 'AGENTS.md', category: 'memory' },
  { name: '.mcp.json', category: 'mcp' },
];

/** Files probed inside a <dir>/.claude/ folder. */
export const CLAUDE_DIR_FILE_TARGETS = [
  { name: 'settings.json', category: 'settings' },
  { name: 'settings.local.json', category: 'settings' },
  { name: 'CLAUDE.md', category: 'memory' },
  { name: 'CLAUDE.local.md', category: 'memory' },
  { name: '.mcp.json', category: 'mcp' },
  { name: 'keybindings.json', category: 'settings' },
];

/** Subtrees probed inside a <dir>/.claude/ folder. */
export const CLAUDE_DIR_TREES = [
  { name: 'agents', category: 'agent', maxDepth: 2, exts: ['.md'] },
  { name: 'skills', category: 'skill', maxDepth: 3, exts: ['.md', '.json', '.yaml', '.yml'] },
  { name: 'commands', category: 'command', maxDepth: 3, exts: ['.md'] },
  { name: 'hooks', category: 'hook', maxDepth: 2, exts: null },
  { name: 'rules', category: 'rule', maxDepth: 2, exts: ['.md'] },
  { name: 'memory', category: 'memory', maxDepth: 2, exts: ['.md'] },
];

/**
 * The name every LayerCake temp file starts with (snapshot.js writes them
 * beside their target, then renames or links them into place). One constant
 * for the writer, the watcher that must not report them, and the scan that
 * must not list an orphaned one as a hook (#102).
 */
export const TEMP_PREFIX = '.layercake-tmp-';

export function homeDir() {
  return os.homedir();
}

/**
 * CLAUDE_CONFIG_DIR as Claude Code reads it, or null. Claude Code requires an
 * absolute path and refuses to start with anything else, so an empty or
 * relative value is not a location to report: the reason is kept for the
 * manifest instead (#7).
 */
export function claudeConfigDirEnv() {
  const raw = String(process.env.CLAUDE_CONFIG_DIR || '').trim();
  return raw && path.isAbsolute(raw) ? path.resolve(raw) : null;
}

/**
 * Claude Code's configuration home: CLAUDE_CONFIG_DIR when set, else
 * ~/.claude. Docs: "If you set CLAUDE_CONFIG_DIR, every ~/.claude path lives
 * under that directory instead", which covers settings, CLAUDE.md, agents,
 * skills, plugins, projects/ (transcripts and auto memory), sessions/ and
 * history.jsonl. Every one of those is built from here, never from homeDir().
 */
export function claudeHome() {
  return claudeConfigDirEnv() || path.join(homeDir(), '.claude');
}

/**
 * The global config file. It moves with CLAUDE_CONFIG_DIR too, into that
 * directory rather than beside it: read from the 2.1.28x bundle,
 * join(process.env.CLAUDE_CONFIG_DIR || homedir(), '.claude.json'). The docs
 * sentence above names ~/.claude paths only, so this was checked, not assumed.
 */
export function globalConfigFile() {
  return path.join(claudeConfigDirEnv() || homeDir(), '.claude.json');
}

/** Where claudeHome() came from, for the UI to state rather than leave implied. */
export function claudeHomeSource() {
  if (claudeConfigDirEnv()) return 'CLAUDE_CONFIG_DIR';
  if (String(process.env.CLAUDE_CONFIG_DIR || '').trim()) {
    return 'default (CLAUDE_CONFIG_DIR is set but not an absolute path, which Claude Code refuses)';
  }
  return 'default';
}

/**
 * Managed / enterprise settings candidates for all three platforms.
 * Every candidate is probed for existence; none is assumed.
 */
export function managedCandidates() {
  const programData = process.env.ProgramData || 'C:\\ProgramData';
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  return [
    { platform: 'win32', file: path.join(programData, 'ClaudeCode', 'managed-settings.json') },
    { platform: 'win32', file: path.join(programData, 'Claude Code', 'managed-settings.json') },
    { platform: 'win32', file: path.join(programFiles, 'ClaudeCode', 'managed-settings.json') },
    { platform: 'darwin', file: '/Library/Application Support/ClaudeCode/managed-settings.json' },
    { platform: 'linux', file: '/etc/claude-code/managed-settings.json' },
  ];
}

/**
 * Ancestor chain for a directory, ordered project-first.
 * Terminates at the filesystem root, a UNC share root (\\server\share), or
 * after 64 hops, whichever comes first.
 */
export function ancestorChain(startDir) {
  const resolved = path.resolve(startDir);
  const chain = [];
  let current = resolved;
  for (let i = 0; i < 64; i += 1) {
    chain.push(current);
    const parent = path.dirname(current);
    if (!parent || parent === current) break;
    current = parent;
  }
  return chain;
}

/**
 * Identity key for "is this the same physical file".
 *
 * Needed because one file can legitimately appear at two levels: when the
 * project sits under the home directory, the directory walk passes through home
 * and re-finds everything the user level already reported. The lineage view
 * should show both sightings, but anything reasoning about distinct files must
 * not count them twice. NTFS is case insensitive, so win32 folds case.
 */
export function samePathKey(p) {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** True for \\server\share and //server/share style paths. */
export function isUncPath(p) {
  return /^[\\/]{2}[^\\/]+[\\/]+[^\\/]+/.test(p);
}

/**
 * Claude Code stores per-project state under ~/.claude/projects/<slug>, where
 * the slug is the absolute path with every character that is not an ASCII
 * letter or digit replaced by a dash. (Non-ASCII letters are assumed to be
 * replaced too; no such path existed to check against.)
 *   C:\dev\LayerCake                        -> C--dev-LayerCake
 *   C:\dev\beetle-etl\.claude\worktrees\x   -> C--dev-beetle-etl--claude-worktrees-x
 *   C:\Users\me\Finance Optimization        -> C--Users-me-Finance-Optimization
 *
 * An earlier rule replaced only separators and the colon. Checked 2026-09-26
 * against every project folder on a real machine, comparing each folder name
 * with the cwd its own transcripts record: that rule missed 3 of 7 (a dot in a
 * worktree path, a space in a folder name), this one matched all 7.
 */
export function projectSlug(dir) {
  return path.resolve(dir).replace(/[^a-zA-Z0-9]/g, '-');
}

export function projectMemoryDir(dir) {
  return path.join(claudeHome(), 'projects', projectSlug(dir), 'memory');
}

/**
 * Root of Claude Code's session data: projects/<slug>/<id>.jsonl transcripts,
 * sessions/<pid>.json for running sessions, history.jsonl for prompt history.
 * Claude Code keeps it in its configuration home, so it follows
 * CLAUDE_CONFIG_DIR (claudeHome).
 *
 * LAYERCAKE_CLAUDE_DATA_DIR overrides it, the same way LAYERCAKE_SNAPSHOT_DIR
 * does for snapshots, so the smoke test can point it at synthetic sessions and
 * never read the real ones.
 */
export function claudeDataDir() {
  if (process.env.LAYERCAKE_CLAUDE_DATA_DIR) {
    return path.resolve(process.env.LAYERCAKE_CLAUDE_DATA_DIR);
  }
  return claudeHome();
}

/**
 * LayerCake's own data: session summary cards and the usage ledger. Beside the
 * snapshot store, and for the same reason never under ~/.claude.
 */
export function appDataRoot() {
  if (process.env.LAYERCAKE_APPDATA_DIR) {
    return path.resolve(process.env.LAYERCAKE_APPDATA_DIR);
  }
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(homeDir(), 'AppData', 'Local');
    return path.join(local, 'LayerCake', 'data');
  }
  return path.join(homeDir(), '.layercake', 'data');
}

/**
 * Where snapshots live.
 *
 * Deliberately NOT under ~/.claude: that tree is a restore target, and a backup
 * that can be overwritten by the restore it is feeding is not a backup.
 */
export function snapshotRoot() {
  if (process.env.LAYERCAKE_SNAPSHOT_DIR) {
    return path.resolve(process.env.LAYERCAKE_SNAPSHOT_DIR);
  }
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(homeDir(), 'AppData', 'Local');
    return path.join(local, 'LayerCake', 'snapshots');
  }
  return path.join(homeDir(), '.layercake', 'snapshots');
}
