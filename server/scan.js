/**
 * Lineage resolver.
 *
 * Produces an ordered list of levels, weakest precedence first:
 *   0  managed / enterprise settings
 *   1  user (~/.claude plus the two home-level strays)
 *   2  plugins (~/.claude/plugins)
 *   3  project memory (~/.claude/projects/<slug>/memory)
 *   4+ the directory walk, filesystem root down to the project directory
 *
 * Every level is emitted even when empty, and every probed-but-absent target is
 * recorded, so the UI can show absence as a fact rather than a blank.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import {
  DIR_FILE_TARGETS,
  CLAUDE_DIR_FILE_TARGETS,
  PLUGIN_MANIFEST_FILES,
  CLAUDE_DIR_TREES,
  ancestorChain,
  claudeHome,
  claudeHomeSource,
  globalConfigFile,
  legacyGlobalConfigFile,
  homeDir,
  isUncPath,
  managedCandidates,
  projectMemoryDir,
  projectSlug,
  samePathKey,
} from './paths.js';
import {
  describeError,
  isNonConfigDir,
  treeSkipsDir,
  treeTakesFile,
  isSecret,
  isSensitive,
} from './safety.js';
// Call the filesystem through timedFsCall, never a bare withTimeout: besides the
// timeout, it sends a network share one call at a time and none while an
// earlier one is stranded. Without that, a deep project on a dead share strands
// a threadpool thread per level and starves every other call (#55).
import { markNetworkRoot, timedFsCall } from './sharegate.js';
import { readForDisplay } from './readfile.js';

let entrySeq = 0;
function nextId(prefix) {
  entrySeq += 1;
  return `${prefix}-${entrySeq}`;
}

async function statOf(target) {
  try {
    const st = await timedFsCall(target, () => fs.stat(target));
    return { st, error: null };
  } catch (err) {
    return { st: null, error: err };
  }
}

/**
 * Drive letters found mapped to a network share, by upper-case letter.
 *
 * Only that verdict is kept. A stale "network" costs polling a folder that
 * could have been watched natively, a listing and a few stats every 5 s. A
 * stale "local" would bind fs.watch to a share, the event-loop stall #57 is
 * about, so a local drive is asked again on every scan: one sub-millisecond
 * call. A drive that timed out is kept too, so a dead one costs one stranded
 * threadpool call per process rather than one per scan.
 */
const networkDriveCache = new Map();

/**
 * Whether a drive letter is mapped to a network share (#57).
 *
 * Node has no GetDriveType, but its native realpath (the fs/promises one,
 * which Node documents as having fs.realpath.native's semantics) resolves a
 * mapped drive to the share behind it: `X:\` came back as `\\localhost\C$` for
 * a real `net use` mapping, while a local disk comes back as itself, in about
 * 0.2 ms. That answers the question with no process
 * spawned. The alternatives were worse: `net use` output is localised, and
 * HKCU\Network lists only persistent mappings (a `/persistent:no` mapping was
 * not in it), which is exactly what a login script tends to create.
 *
 * A root that fails with anything but ENOENT is treated as a network drive:
 * a disconnected mapping fails that way (UNKNOWN, or a timeout), and polling
 * is the side that can name it unreachable instead of stalling on it. ENOENT
 * is a letter that is not there, which leaves nothing on it to watch.
 */
async function networkDrive(root) {
  const letter = root[0].toUpperCase();
  if (networkDriveCache.has(letter)) return networkDriveCache.get(letter);
  let found = null;
  try {
    // Through the gate like every call here. After the #55 and #57 merges this
    // still named withTimeout, which scan.js no longer imports: the
    // ReferenceError was caught below as "not ENOENT", and every drive,
    // C: included, was then polled as a network drive.
    const real = await timedFsCall(root, () => fs.realpath(root));
    if (isUncPath(real)) found = { root, share: real, error: null };
  } catch (err) {
    if (err?.code !== 'ENOENT') found = { root, share: null, error: describeError(err) };
  }
  if (found) {
    networkDriveCache.set(letter, found);
    markNetworkRoot(root, found.share);
  }
  return found;
}

/**
 * The network drives among the drive letters a lineage touches. Recorded on
 * the lineage so the watcher can poll them the way it polls UNC paths; it
 * reads this rather than asking the filesystem a second time.
 */
async function networkDrives(levels) {
  if (process.platform !== 'win32') return [];
  const roots = new Map();
  for (const level of levels) {
    const paths = [level.dir, ...level.entries.map((e) => e.absPath), ...level.absent.map((a) => a.absPath)];
    for (const p of paths) {
      const m = /^([a-z]):[\\/]/i.exec(p || '');
      if (m) roots.set(m[1].toUpperCase(), `${m[1].toUpperCase()}:\\`);
    }
  }
  const found = [];
  // One at a time: a dead mapping strands the call it times out on, and the
  // threadpool it strands it in is the one the rest of the server uses.
  for (const root of roots.values()) {
    const drive = await networkDrive(root);
    if (drive) found.push(drive);
  }
  return found;
}

function makeEntry({ absPath, category, level, st, error, note }) {
  return {
    id: nextId('e'),
    name: path.basename(absPath),
    absPath,
    relPath: level?.dir ? path.relative(level.dir, absPath) || path.basename(absPath) : absPath,
    category,
    type: st ? (st.isDirectory() ? 'dir' : 'file') : 'missing',
    size: st && st.isFile() ? st.size : null,
    mtime: st ? st.mtime.toISOString() : null,
    sensitive: isSensitive(absPath),
    error: describeError(error),
    note: note || null,
  };
}

/** Probes one exact path. Returns an entry when present, records absence otherwise. */
async function probeFile(absPath, category, level, note) {
  if (isSecret(absPath)) {
    level.redacted.push({ absPath, reason: 'Credential file, never read' });
    return;
  }
  const { st, error } = await statOf(absPath);
  if (st && st.isFile()) {
    level.entries.push(makeEntry({ absPath, category, level, st, error: null, note }));
    return;
  }
  if (error && error.code !== 'ENOENT') {
    level.entries.push(makeEntry({ absPath, category, level, st: null, error, note }));
    level.errors.push({ path: absPath, ...describeError(error) });
    return;
  }
  level.absent.push({ absPath, name: path.basename(absPath), category });
}

/**
 * Depth-limited directory walk. Symlinks are stat'ed, not followed as trees:
 * a cycle would otherwise walk forever.
 */
async function walkTree(root, { maxDepth, exts, category, level, depth = 0, seen = new Set() }) {
  let dirents;
  try {
    dirents = await timedFsCall(root, () => fs.readdir(root, { withFileTypes: true }));
  } catch (err) {
    level.errors.push({ path: root, ...describeError(err) });
    level.entries.push(
      makeEntry({ absPath: root, category, level, st: null, error: err })
    );
    return;
  }

  const real = path.resolve(root);
  if (seen.has(real)) return;
  seen.add(real);

  for (const dirent of dirents) {
    const abs = path.join(root, dirent.name);
    if (isSecret(abs)) {
      level.redacted.push({ absPath: abs, reason: 'Credential file, never read' });
      continue;
    }
    if (dirent.isDirectory()) {
      // hooks/ takes files of any extension, so a hook's own logs/ or cache/
      // would read as hooks; there the .claude root's runtime names are skipped
      // too. In the other trees such a name is a skill or a command (#98, #104).
      // The rule is shared with the restore fence (#105).
      if (treeSkipsDir(category, dirent.name)) {
        const { st } = await statOf(abs);
        level.entries.push(
          makeEntry({
            absPath: abs,
            category: 'other',
            level,
            st,
            error: null,
            note: 'Runtime state, not scanned',
          })
        );
        continue;
      }
      if (depth + 1 <= maxDepth) {
        await walkTree(abs, { maxDepth, exts, category, level, depth: depth + 1, seen });
      }
      continue;
    }
    if (!dirent.isFile() && !dirent.isSymbolicLink()) continue;
    // Not a LayerCake temp file (a crash between write and rename; in hooks/,
    // which takes any extension, it read as a hook, #102), and of the tree's
    // extensions. Shared with the restore fence (#105).
    if (!treeTakesFile(exts, dirent.name)) continue;
    const { st, error } = await statOf(abs);
    level.entries.push({
      ...makeEntry({ absPath: abs, category, level, st, error }),
      isSkillManifest: dirent.name.toUpperCase() === 'SKILL.MD',
    });
  }
}

/**
 * A config subtree (agents/, skills/, ...) that is there but holds nothing the
 * scan counts as config. Recorded as an absence, because the config is absent,
 * with `dirExists` set because the folder is not: it is where the first agent
 * or skill will land, so the watcher has to watch it, and only the scan knows
 * it exists. Without this record a project level had no trace of such a
 * folder at all (#56).
 */
function emptyTree(absPath, tree) {
  return {
    absPath,
    name: `${tree.name}/`,
    category: tree.category,
    note: 'Directory exists but holds no config files',
    dirExists: true,
  };
}

function newLevel(fields) {
  return {
    id: nextId('lvl'),
    entries: [],
    absent: [],
    errors: [],
    redacted: [],
    other: [],
    note: null,
    ...fields,
  };
}

function finalizeLevel(level) {
  if (level.errors.length && level.entries.length === 0) level.status = 'error';
  else if (level.errors.length) level.status = 'partial';
  else if (level.entries.length) level.status = 'found';
  else level.status = 'empty';
  level.entries.sort(
    (a, b) => a.category.localeCompare(b.category) || a.relPath.localeCompare(b.relPath)
  );
  return level;
}

/** Managed / enterprise settings. Existence-probed on all platforms. */
async function scanManaged() {
  const level = newLevel({
    kind: 'managed',
    label: 'Managed / enterprise settings',
    dir: null,
    note: 'Highest real-world precedence in Claude Code: overrides every level below.',
  });
  for (const candidate of managedCandidates()) {
    const { st, error } = await statOf(candidate.file);
    if (st && st.isFile()) {
      level.entries.push(
        makeEntry({
          absPath: candidate.file,
          category: 'settings',
          level: { dir: path.dirname(candidate.file) },
          st,
          error: null,
          note: candidate.legacy ? `${candidate.platform} legacy location, which Claude Code no longer reads` : `${candidate.platform} location`,
        })
      );
    } else if (error && error.code !== 'ENOENT') {
      level.errors.push({ path: candidate.file, ...describeError(error) });
    } else {
      level.absent.push({
        absPath: candidate.file,
        name: path.basename(candidate.file),
        category: 'settings',
        note: candidate.legacy ? `${candidate.platform} legacy location, which Claude Code no longer reads` : `${candidate.platform} location`,
      });
    }
  }
  return finalizeLevel(level);
}

/**
 * Claude Code's configuration home (~/.claude, or CLAUDE_CONFIG_DIR) plus its
 * global config file and ~/CLAUDE.md. The first two follow CLAUDE_CONFIG_DIR;
 * ~/CLAUDE.md does not, because it is reached as a file in the home directory,
 * not as part of the configuration home (#7).
 */
async function scanUser() {
  const home = homeDir();
  const claudeDir = claudeHome();
  const source = claudeHomeSource();
  const level = newLevel({
    kind: 'user',
    label: 'User / home',
    dir: claudeDir,
    note:
      source === 'CLAUDE_CONFIG_DIR'
        ? 'Applies to every project for this OS user. Located by CLAUDE_CONFIG_DIR, as Claude Code does.'
        : `Applies to every project for this OS user. Location: ${source}.`,
  });

  // A config home that cannot be read at all (on a share that does not
  // answer, say) is an error on the level itself, so nothing is offered for
  // creation there (#108). Missing is not an error: a fresh home is fine.
  const homeStat = await statOf(claudeDir);
  if (!homeStat.st && homeStat.error && homeStat.error.code !== 'ENOENT') {
    level.errors.push({ path: claudeDir, ...describeError(homeStat.error) });
  }

  for (const target of CLAUDE_DIR_FILE_TARGETS) {
    await probeFile(path.join(claudeDir, target.name), target.category, level);
  }
  for (const tree of CLAUDE_DIR_TREES) {
    const abs = path.join(claudeDir, tree.name);
    const { st, error } = await statOf(abs);
    if (st && st.isDirectory()) {
      const before = level.entries.length;
      await walkTree(abs, {
        maxDepth: tree.maxDepth,
        exts: tree.exts,
        category: tree.category,
        level,
      });
      if (level.entries.length === before) level.absent.push(emptyTree(abs, tree));
    } else if (error && error.code !== 'ENOENT') {
      level.errors.push({ path: abs, ...describeError(error) });
    } else {
      level.absent.push({ absPath: abs, name: `${tree.name}/`, category: tree.category });
    }
  }

  await probeFile(
    legacyGlobalConfigFile(),
    'home-config',
    level,
    'Legacy global config. While it exists Claude Code reads it in place of .claude.json.'
  );
  const legacyInUse = level.entries.some((e) => samePathKey(e.absPath) === samePathKey(legacyGlobalConfigFile()));
  await probeFile(
    globalConfigFile(),
    'home-config',
    level,
    legacyInUse
      ? 'Not read by Claude Code while .config.json exists in the configuration home: that file takes its place (#87).'
      : 'Home config blob: per-project state and MCP servers. Often very large.'
  );
  // Flattened views leave it out while the legacy file is the one in use.
  if (legacyInUse) {
    const shadowed = level.entries.find((e) => samePathKey(e.absPath) === samePathKey(globalConfigFile()));
    if (shadowed) shadowed.inactive = true;
  }
  await probeFile(
    path.join(home, 'CLAUDE.md'),
    'memory',
    level,
    'Outside .claude. Only inherited when the project sits under the home directory.'
  );

  return finalizeLevel(level);
}

/** <config home>/plugins: marketplaces, installed set, and cached skill/agent trees. */
async function scanPlugins() {
  const pluginsDir = path.join(claudeHome(), 'plugins');
  const level = newLevel({
    kind: 'plugins',
    label: 'Plugins (user level)',
    dir: pluginsDir,
    note: 'Plugin-provided skills, agents and commands. Namespaced as plugin:skill at runtime.',
  });

  for (const name of PLUGIN_MANIFEST_FILES) {
    await probeFile(path.join(pluginsDir, name), 'plugin-manifest', level);
  }

  const cacheDir = path.join(pluginsDir, 'cache');
  const { st, error } = await statOf(cacheDir);
  if (!st) {
    if (error && error.code !== 'ENOENT') level.errors.push({ path: cacheDir, ...describeError(error) });
    else level.absent.push({ absPath: cacheDir, name: 'cache/', category: 'plugin' });
    return finalizeLevel(level);
  }

  // cache/<marketplace>/<plugin>/<version>/{agents,skills,commands,hooks}
  let marketplaces = [];
  try {
    marketplaces = await timedFsCall(cacheDir, () => fs.readdir(cacheDir, { withFileTypes: true }));
  } catch (err) {
    level.errors.push({ path: cacheDir, ...describeError(err) });
    return finalizeLevel(level);
  }

  for (const market of marketplaces.filter((d) => d.isDirectory())) {
    const marketPath = path.join(cacheDir, market.name);
    let plugins = [];
    try {
      plugins = await timedFsCall(marketPath, () => fs.readdir(marketPath, { withFileTypes: true }));
    } catch (err) {
      level.errors.push({ path: marketPath, ...describeError(err) });
      continue;
    }
    for (const plugin of plugins.filter((d) => d.isDirectory())) {
      const pluginPath = path.join(marketPath, plugin.name);
      let versions = [];
      try {
        versions = await timedFsCall(pluginPath, () => fs.readdir(pluginPath, { withFileTypes: true }));
      } catch (err) {
        level.errors.push({ path: pluginPath, ...describeError(err) });
        continue;
      }
      for (const version of versions.filter((d) => d.isDirectory())) {
        const versionPath = path.join(pluginPath, version.name);
        for (const tree of CLAUDE_DIR_TREES) {
          const abs = path.join(versionPath, tree.name);
          const probe = await statOf(abs);
          if (!probe.st || !probe.st.isDirectory()) continue;
          await walkTree(abs, {
            maxDepth: tree.maxDepth,
            exts: tree.exts,
            category: tree.category,
            level,
          });
        }
        await probeFile(
          path.join(versionPath, '.claude-plugin', 'plugin.json'),
          'plugin-manifest',
          level
        );
      }
    }
  }

  for (const entry of level.entries) {
    if (entry.absPath.startsWith(cacheDir)) {
      const rel = path.relative(cacheDir, entry.absPath).split(path.sep);
      entry.plugin = rel.length >= 2 ? `${rel[0]}/${rel[1]}` : null;
    }
  }

  return finalizeLevel(level);
}

/** ~/.claude/projects/<slug>/memory for the selected project. */
async function scanProjectMemory(projectDir) {
  const memDir = projectMemoryDir(projectDir);
  const level = newLevel({
    kind: 'project-memory',
    label: 'Project memory (home-stored)',
    dir: memDir,
    note:
      'File-based memory for this project, stored under home and keyed by the mangled path ' +
      `"${projectSlug(projectDir)}". Injected as context, not a settings-precedence level.`,
  });

  const { st, error } = await statOf(memDir);
  if (!st) {
    if (error && error.code !== 'ENOENT') level.errors.push({ path: memDir, ...describeError(error) });
    else level.absent.push({ absPath: memDir, name: 'memory/', category: 'memory' });
    return finalizeLevel(level);
  }
  await walkTree(memDir, { maxDepth: 2, exts: ['.md'], category: 'memory', level });
  return finalizeLevel(level);
}

/** One directory on the walk: root-level targets plus its .claude folder. */
async function scanDirectory(dir, label) {
  const notes = [];
  if (isUncPath(dir)) notes.push('Network path. Scanned with a per-operation timeout.');
  // Whenever the configuration home is this directory's own .claude folder:
  // the home directory by default, or any ancestor CLAUDE_CONFIG_DIR points
  // into (#91). With CLAUDE_CONFIG_DIR elsewhere, ~/.claude is an ordinary
  // folder here and gets no note.
  if (samePathKey(claudeHome()) === samePathKey(path.join(dir, '.claude'))) {
    notes.push(
      "This directory's .claude folder is Claude Code's configuration home, so its files also appear at the user level above. " +
        'The repetition is real: the same files are reached by two different routes.'
    );
  }
  const level = newLevel({
    kind: 'directory',
    label,
    dir,
    note: notes.length ? notes.join(' ') : null,
  });

  const dirStat = await statOf(dir);
  if (!dirStat.st) {
    level.errors.push({ path: dir, ...describeError(dirStat.error) });
    return finalizeLevel(level);
  }

  for (const target of DIR_FILE_TARGETS) {
    await probeFile(path.join(dir, target.name), target.category, level);
  }

  const claudeDir = path.join(dir, '.claude');
  const claudeStat = await statOf(claudeDir);
  if (!claudeStat.st) {
    if (claudeStat.error && claudeStat.error.code !== 'ENOENT') {
      level.errors.push({ path: claudeDir, ...describeError(claudeStat.error) });
    } else {
      level.absent.push({ absPath: claudeDir, name: '.claude/', category: 'settings' });
    }
    return finalizeLevel(level);
  }

  for (const target of CLAUDE_DIR_FILE_TARGETS) {
    await probeFile(path.join(claudeDir, target.name), target.category, level);
  }

  const known = new Set(CLAUDE_DIR_TREES.map((t) => t.name));
  for (const tree of CLAUDE_DIR_TREES) {
    const abs = path.join(claudeDir, tree.name);
    const probe = await statOf(abs);
    if (probe.st && probe.st.isDirectory()) {
      const before = level.entries.length;
      await walkTree(abs, {
        maxDepth: tree.maxDepth,
        exts: tree.exts,
        category: tree.category,
        level,
      });
      if (level.entries.length === before) level.absent.push(emptyTree(abs, tree));
    } else if (probe.error && probe.error.code !== 'ENOENT') {
      level.errors.push({ path: abs, ...describeError(probe.error) });
    } else {
      level.absent.push({ absPath: abs, name: `${tree.name}/`, category: tree.category });
    }
  }

  // Anything else inside .claude/ gets listed, never parsed. Surfacing it is how
  // a non-standard layout becomes visible instead of silently ignored.
  try {
    const dirents = await timedFsCall(claudeDir, () => fs.readdir(claudeDir, { withFileTypes: true }));
    const knownFiles = new Set(CLAUDE_DIR_FILE_TARGETS.map((t) => t.name));
    for (const dirent of dirents) {
      if (known.has(dirent.name) || knownFiles.has(dirent.name)) continue;
      const abs = path.join(claudeDir, dirent.name);
      if (isSecret(abs)) {
        level.redacted.push({ absPath: abs, reason: 'Credential file, never read' });
        continue;
      }
      const probe = await statOf(abs);
      level.other.push({
        id: nextId('o'),
        name: dirent.name,
        absPath: abs,
        type: dirent.isDirectory() ? 'dir' : 'file',
        size: probe.st && probe.st.isFile() ? probe.st.size : null,
        note: dirent.isDirectory() && isNonConfigDir(dirent.name) ? 'Runtime state' : null,
      });
    }
  } catch (err) {
    level.errors.push({ path: claudeDir, ...describeError(err) });
  }

  return finalizeLevel(level);
}

/**
 * The git repository root Claude Code keys the project by (#120).
 *
 * Measured on 2.1.283 (see projectConfigKey in paths.js): a subfolder of a
 * repository uses the repository's root, and a worktree uses the MAIN
 * repository's root. So: the nearest ancestor holding .git; when that .git is
 * a file (a worktree), follow its `gitdir:` line to the worktree's git folder,
 * whose `commondir` names the main .git, and take the folder holding that.
 * A .git file with no commondir (a submodule) keeps its own folder, which is
 * reasoned, not measured. Read from the filesystem through the share gate,
 * never by running git: the processes LayerCake starts are fixed.
 *
 * Errors are values: { dir: null, error } when a .git could not be looked at,
 * and the walk stops there rather than guess past it.
 */
async function findGitRoot(chain) {
  for (const dir of chain) {
    const dotGit = path.join(dir, '.git');
    const probe = await statOf(dotGit);
    if (!probe.st) {
      if (probe.error && probe.error.code !== 'ENOENT') return { dir: null, error: { path: dotGit, ...describeError(probe.error) } };
      continue;
    }
    if (probe.st.isDirectory()) return { dir, via: 'repository' };
    const pointer = await readForDisplay(dotGit);
    const gitdir = /^gitdir:\s*(.+?)\s*$/m.exec(pointer.content || '')?.[1];
    if (!gitdir) return { dir, via: 'git file' };
    const common = await readForDisplay(path.join(path.resolve(dir, gitdir), 'commondir'));
    const commonDir = common.content ? path.resolve(dir, gitdir, common.content.trim()) : null;
    if (commonDir && path.basename(commonDir).toLowerCase() === '.git') {
      return { dir: path.dirname(commonDir), via: 'worktree' };
    }
    return { dir, via: 'git file' };
  }
  return null;
}

/**
 * Full lineage for a project directory, ordered weakest precedence first.
 */
export async function resolveLineage(projectDir) {
  const resolved = path.resolve(projectDir);
  const chain = ancestorChain(resolved); // project first
  const walkLevels = [];

  // Emit root -> project so the tree reads top (weakest) to bottom (strongest).
  const reversed = [...chain].reverse();
  for (let i = 0; i < reversed.length; i += 1) {
    const dir = reversed[i];
    const isProject = i === reversed.length - 1;
    const isRoot = i === 0;
    const label = isProject ? 'Project directory' : isRoot ? 'Filesystem root' : 'Ancestor directory';
    walkLevels.push(await scanDirectory(dir, label));
  }

  const levels = [
    await scanManaged(),
    await scanUser(),
    await scanPlugins(),
    await scanProjectMemory(resolved),
    ...walkLevels,
  ];

  levels.forEach((level, index) => {
    level.precedence = index;
  });

  // Said on the level the way a UNC level says "Network path": a mapped drive
  // is one too, and it is why that level's changes arrive by polling.
  const onNetwork = await networkDrives(levels);
  for (const level of walkLevels) {
    const drive = onNetwork.find((d) => /^[a-z]:/i.test(level.dir) && level.dir[0].toUpperCase() === d.root[0]);
    if (!drive) continue;
    const letter = drive.root.slice(0, 2);
    const said = drive.share
      ? `Network drive: ${letter} maps ${drive.share}. Scanned with a per-operation timeout.`
      : `Treated as a network drive: ${letter} did not answer (${drive.error.message}).`;
    level.note = level.note ? `${level.note} ${said}` : said;
  }

  // The walk re-finds the user level's files when it passes through the folder
  // holding them: home, for ~/CLAUDE.md and a default ~/.claude, or wherever
  // CLAUDE_CONFIG_DIR points. The levels show both sightings; a count of files
  // is a count of distinct files, and says how many were seen twice (#125).
  // Redactions and errors are counted the same way, since the walk re-finds
  // those too. A record with no path counts on its own rather than throwing.
  const distinct = (paths) => new Set(paths.map((p) => (typeof p === 'string' ? samePathKey(p) : Symbol()))).size;
  const filePaths = levels.flatMap((l) => l.entries.filter((e) => e.type === 'file').map((e) => e.absPath));
  const fileCount = distinct(filePaths);

  return {
    projectDir: resolved,
    home: homeDir(),
    platform: process.platform,
    scannedAt: new Date().toISOString(),
    levels,
    networkDrives: onNetwork,
    gitRoot: await findGitRoot(chain),
    summary: {
      levelCount: levels.length,
      fileCount,
      repeatedFileCount: filePaths.length - fileCount,
      errorCount: distinct(levels.flatMap((l) => l.errors.map((e) => e.path))),
      redactedCount: distinct(levels.flatMap((l) => l.redacted.map((r) => r.absPath))),
    },
  };
}
