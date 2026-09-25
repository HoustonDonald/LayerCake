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

export function homeDir() {
  return os.homedir();
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
 * the slug is the absolute path with separators and colons replaced by dashes.
 * C:\dev\LayerCake -> C--dev-LayerCake
 */
export function projectSlug(dir) {
  return path.resolve(dir).replace(/[\\/:]/g, '-');
}

export function projectMemoryDir(dir) {
  return path.join(homeDir(), '.claude', 'projects', projectSlug(dir), 'memory');
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
