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
  // Listed because people put one here, and it does nothing: measured on
  // 2.1.283 with `claude mcp list` (#121), Claude Code reads .mcp.json in the
  // project folder and every folder above it, never inside .claude, the
  // configuration home's included. The scan marks it inactive with this note.
  {
    name: '.mcp.json',
    category: 'mcp',
    notRead:
      'Not read by Claude Code: it reads .mcp.json in the project folder and each folder above it, ' +
      'never inside .claude, so the servers here are not loaded (#121).',
  },
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

/** Files probed directly in <config home>/plugins. */
export const PLUGIN_MANIFEST_FILES = ['installed_plugins.json', 'known_marketplaces.json', 'blocklist.json'];

/** <config home>/plugins/cache: Claude Code's copy of each installed plugin version. */
export function pluginCacheDir() {
  return path.join(claudeHome(), 'plugins', 'cache');
}

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
 * The configuration home before any settings file moves it: CLAUDE_CONFIG_DIR
 * when set, else ~/.claude. Its settings.json is where a move is read (#64).
 */
export function defaultClaudeHome() {
  return claudeConfigDirEnv() || path.join(homeDir(), '.claude');
}

/**
 * A configuration home moved from inside settings (#64): { dir, file }, or
 * null. Claude Code applies a settings file's env block and then resolves its
 * home again, so a CLAUDE_CONFIG_DIR in the env block of the default home's
 * settings.json moves everything: measured on 2.1.284 (a scratch home, a stub
 * API), the other home's CLAUDE.md, agents and hooks were loaded and its
 * transcripts written, and nothing of the default home's was used, not even
 * that settings file's own hooks. A project's settings naming a home were
 * ignored. The one thing that stayed was .claude.json (globalConfigFile).
 *
 * Process-wide, like Claude Code's own home. Set by resolveConfigHome in
 * scan.js before every scan and at server start, so every caller of
 * claudeHome() sees the same answer.
 */
let movedHome = null;

export function setMovedClaudeHome(value) {
  movedHome = value;
}

export function movedClaudeHome() {
  return movedHome;
}

/**
 * Claude Code's configuration home: CLAUDE_CONFIG_DIR when set, else
 * ~/.claude, unless a settings file moved it (#64). Docs: "If you set
 * CLAUDE_CONFIG_DIR, every ~/.claude path lives under that directory
 * instead", which covers settings, CLAUDE.md, agents, skills, plugins,
 * projects/ (transcripts and auto memory), sessions/ and history.jsonl. Every
 * one of those is built from here, never from homeDir().
 */
export function claudeHome() {
  return movedHome?.dir || defaultClaudeHome();
}

/**
 * The global config file. It moves with CLAUDE_CONFIG_DIR too, into that
 * directory rather than beside it: read from the 2.1.28x bundle,
 * join(process.env.CLAUDE_CONFIG_DIR || homedir(), '.claude.json'). The docs
 * sentence above names ~/.claude paths only, so this was checked, not assumed.
 */
/**
 * The global config file's legacy name. Claude Code reads it IN PLACE OF
 * globalConfigFile() whenever it exists: To() in the 2.1.283 bundle returns
 * <config home>/.config.json if present, else .claude.json (checked in the
 * installed claude.exe, 2026-09-26; #87).
 */
export function legacyGlobalConfigFile() {
  // The home before a settings move, as for .claude.json, which measurably
  // stays put (#64): both are read before settings are. Reasoned for this
  // one; a .config.json was not part of the measurement.
  return path.join(defaultClaudeHome(), '.config.json');
}

export function globalConfigFile() {
  return path.join(claudeConfigDirEnv() || homeDir(), '.claude.json');
}

/** Where claudeHome() came from, for the UI to state rather than leave implied. */
export function claudeHomeSource() {
  if (movedHome) return `CLAUDE_CONFIG_DIR in the env block of ${movedHome.file}`;
  if (claudeConfigDirEnv()) return 'CLAUDE_CONFIG_DIR';
  if (String(process.env.CLAUDE_CONFIG_DIR || '').trim()) {
    return 'default (CLAUDE_CONFIG_DIR is set but not an absolute path, which Claude Code refuses)';
  }
  return 'default';
}

/**
 * The folder Claude Code reads managed policy from on a platform (#147).
 *
 * On Windows that is C:\Program Files\ClaudeCode as a literal, not
 * %ProgramFiles%: the 2.1.283 bundle returns the fixed string for "windows"
 * (and the docs name the same path), so on a machine whose Program Files is
 * elsewhere, reading the variable looked in a folder Claude Code never does.
 *
 * LAYERCAKE_MANAGED_DIR replaces this platform's folder, for smoke only:
 * the real one needs elevation to write, and smoke must never read the
 * machine's own policy.
 */
export function managedDir(platform = process.platform) {
  const override = String(process.env.LAYERCAKE_MANAGED_DIR || '').trim();
  if (override && platform === process.platform) return path.resolve(override);
  if (platform === 'win32') return 'C:\\Program Files\\ClaudeCode';
  if (platform === 'darwin') return '/Library/Application Support/ClaudeCode';
  return '/etc/claude-code';
}

/** A file in a platform's managed folder, in that platform's path form. */
function managedPath(platform, name) {
  return (platform === 'win32' ? path.win32 : path.posix).join(managedDir(platform), name);
}

/**
 * Managed / enterprise settings candidates for all three platforms.
 * Every candidate is probed for existence; none is assumed.
 *
 * `legacy` marks a location Claude Code no longer reads. The docs say so of
 * %ProgramData%\ClaudeCode ("doesn't read the legacy Windows path"), and
 * 2.1.283's debug log probes only C:\Program Files\ClaudeCode. Still probed,
 * because a policy left there is one its owner believes is in force (#119).
 */
export function managedCandidates() {
  const programData = process.env.ProgramData || 'C:\\ProgramData';
  return [
    { platform: 'win32', file: path.join(programData, 'ClaudeCode', 'managed-settings.json'), legacy: true },
    { platform: 'win32', file: path.join(programData, 'Claude Code', 'managed-settings.json'), legacy: true },
    { platform: 'win32', file: managedPath('win32', 'managed-settings.json') },
    { platform: 'darwin', file: managedPath('darwin', 'managed-settings.json') },
    { platform: 'linux', file: managedPath('linux', 'managed-settings.json') },
  ];
}

/**
 * The rest of this platform's managed folder (#147), from the docs and the
 * 2.1.283 bundle. Another OS's are not listed: its managed-settings.json
 * already says where that folder is.
 */
export function managedFolderTargets() {
  return [
    {
      file: path.join(managedDir(), 'CLAUDE.md'),
      category: 'memory',
      note: 'Managed policy instructions: loaded before every other CLAUDE.md, and they cannot be excluded.',
    },
    {
      file: managedMcpFile(),
      category: 'mcp',
      note:
        'Managed MCP servers. While this file exists it has exclusive control: Claude Code loads only its servers ' +
        'and those in managed settings\' managedMcpServers, even when the file does not parse.',
    },
  ];
}

/** The managed MCP file, whose existence alone gives it exclusive control of MCP servers. */
export function managedMcpFile() {
  return path.join(managedDir(), 'managed-mcp.json');
}

/**
 * Drop-in policy files: every *.json directly in this folder that is not
 * hidden, merged over managed-settings.json in name order (#147). The name
 * test is Claude Code's own, case included: `name.endsWith(".json") &&
 * !name.startsWith(".")`, files and links only, sorted with a plain sort.
 */
export function managedDropInDir() {
  return path.join(managedDir(), 'managed-settings.d');
}

export function isDropInName(name) {
  return name.endsWith('.json') && !name.startsWith('.');
}

/** Code-unit order, which is what Claude Code's plain .sort() gives: "B.json" before "a.json". */
export function dropInOrder(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Claude Code's cached copy of server-managed settings (#147), one of its own
 * state files in the configuration home. Listed, never merged: Claude Code
 * fetches the settings again at startup and can hold them back until they
 * are approved, so the cache says what was delivered, not what applies.
 */
export function remoteSettingsFile() {
  return path.join(claudeHome(), 'remote-settings.json');
}

/**
 * The settings files Claude Code reads for a session started in the project
 * directory, weakest first, as { source, file } (#119). There is NO ancestor
 * walk: a parent folder's .claude/settings.json is not inherited, unlike
 * CLAUDE.md. Observed on Claude Code 2.1.283 with a marker hook in every
 * candidate file, and stated in its docs. On Windows settings.local.json sits
 * beside settings.json in the starting folder; on macOS and Linux inside a git
 * repository it moves to the repository root, which is not modelled (#146).
 *
 * The user file and the project file are one file when the project is the
 * folder above the config home (a session started in the home folder), and
 * that is the only case in which the config home's settings.local.json is
 * read. The settings view merges these and nothing else, and create offers a
 * settings file only where it is one of them (#135).
 */
export function settingsSourceFiles(lineage) {
  const configHome = lineage.levels.find((l) => l.kind === 'user')?.dir || null;
  const projectClaude = path.join(lineage.projectDir, '.claude');
  // The drop-ins the scan found, in the order they apply (#147). The scan
  // keeps only names Claude Code reads, so this takes them as listed.
  const dropInKey = samePathKey(managedDropInDir());
  const dropIns = (lineage.levels.find((l) => l.kind === 'managed')?.entries || [])
    .filter((e) => e.type === 'file' && samePathKey(path.dirname(e.absPath)) === dropInKey)
    .sort((a, b) => dropInOrder(a.name, b.name));
  return [
    ...(configHome ? [{ source: 'user', file: path.join(configHome, 'settings.json') }] : []),
    { source: 'project', file: path.join(projectClaude, 'settings.json') },
    { source: 'local', file: path.join(projectClaude, 'settings.local.json') },
    ...managedCandidates()
      .filter((c) => c.platform === lineage.platform && !c.legacy)
      .map((c) => ({ source: 'managed', file: c.file })),
    ...dropIns.map((e) => ({ source: 'managed', file: e.absPath })),
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

/**
 * The key Claude Code files a project under in .claude.json's `projects` (#120).
 *
 * Measured on 2.1.283 with `claude mcp add --scope local` and `claude mcp list`,
 * which make no model call: the key is the git repository's root when there is
 * one (a worktree's is the MAIN repository's), else the directory itself, with
 * forward slashes on Windows, in the case the directory was typed. A backslash
 * key is never read, although .claude.json holds many (other data sits there).
 * The root comes from the scan (`lineage.gitRoot`); this only spells it.
 */
export function projectConfigKey(dir) {
  return process.platform === 'win32' ? dir.replace(/\\/g, '/') : dir;
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
 *   C:\dev\my-app\.claude\worktrees\x       -> C--dev-my-app--claude-worktrees-x
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
  const root = snapshotRootUnchecked();
  // The config tree is a restore target, and a backup the restore can
  // overwrite is not a backup. CLAUDE.md stated this; nothing enforced it (#88).
  for (const forbidden of claudeTrees()) {
    if (isInsideDir(root, forbidden)) {
      throw new Error(`Refusing to keep snapshots inside ${forbidden}, which a restore writes to; set LAYERCAKE_SNAPSHOT_DIR elsewhere.`);
    }
  }
  return root;
}

function snapshotRootUnchecked() {
  if (process.env.LAYERCAKE_SNAPSHOT_DIR) {
    return path.resolve(process.env.LAYERCAKE_SNAPSHOT_DIR);
  }
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(homeDir(), 'AppData', 'Local');
    return path.join(local, 'LayerCake', 'snapshots');
  }
  return path.join(homeDir(), '.layercake', 'snapshots');
}

/** The trees LayerCake's own stores must stay out of: Claude Code's data and config homes. */
export function claudeTrees() {
  return [claudeDataDir(), claudeHome(), defaultClaudeHome(), path.join(homeDir(), '.claude')];
}

/** Whether `child` is `parent` or inside it, folded the way the filesystem folds names. */
export function isInsideDir(child, parent) {
  const c = samePathKey(child);
  const p = samePathKey(parent);
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

/** A root, or why it was refused, for a payload that must not fail over it (#88). */
export function rootState(getRoot) {
  try {
    return { root: getRoot(), error: null };
  } catch (err) {
    return { root: null, error: err.message };
  }
}
