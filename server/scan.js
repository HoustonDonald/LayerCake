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
  CLAUDE_DIR_TREES,
  ancestorChain,
  homeDir,
  isUncPath,
  managedCandidates,
  projectMemoryDir,
  projectSlug,
} from './paths.js';
import {
  DIR_TIMEOUT_MS,
  describeError,
  isNonConfigDir,
  isSecret,
  isSensitive,
  withTimeout,
} from './safety.js';

let entrySeq = 0;
function nextId(prefix) {
  entrySeq += 1;
  return `${prefix}-${entrySeq}`;
}

async function statOf(target) {
  try {
    const st = await withTimeout(fs.stat(target), DIR_TIMEOUT_MS, target);
    return { st, error: null };
  } catch (err) {
    return { st: null, error: err };
  }
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
    dirents = await withTimeout(
      fs.readdir(root, { withFileTypes: true }),
      DIR_TIMEOUT_MS,
      root
    );
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
      if (isNonConfigDir(dirent.name)) {
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
    if (exts && !exts.includes(path.extname(dirent.name).toLowerCase())) continue;
    const { st, error } = await statOf(abs);
    level.entries.push({
      ...makeEntry({ absPath: abs, category, level, st, error }),
      isSkillManifest: dirent.name.toUpperCase() === 'SKILL.MD',
    });
  }
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
          note: `${candidate.platform} location`,
        })
      );
    } else if (error && error.code !== 'ENOENT') {
      level.errors.push({ path: candidate.file, ...describeError(error) });
    } else {
      level.absent.push({
        absPath: candidate.file,
        name: path.basename(candidate.file),
        category: 'settings',
        note: `${candidate.platform} location`,
      });
    }
  }
  return finalizeLevel(level);
}

/** ~/.claude plus ~/.claude.json and ~/CLAUDE.md. */
async function scanUser() {
  const home = homeDir();
  const claudeDir = path.join(home, '.claude');
  const level = newLevel({
    kind: 'user',
    label: 'User / home',
    dir: claudeDir,
    note: 'Applies to every project for this OS user.',
  });

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
      if (level.entries.length === before) {
        level.absent.push({
          absPath: abs,
          name: `${tree.name}/`,
          category: tree.category,
          note: 'Directory exists but holds no config files',
        });
      }
    } else if (error && error.code !== 'ENOENT') {
      level.errors.push({ path: abs, ...describeError(error) });
    } else {
      level.absent.push({ absPath: abs, name: `${tree.name}/`, category: tree.category });
    }
  }

  await probeFile(
    path.join(home, '.claude.json'),
    'home-config',
    level,
    'Home config blob: per-project state and MCP servers. Often very large.'
  );
  await probeFile(
    path.join(home, 'CLAUDE.md'),
    'memory',
    level,
    'Outside .claude. Only inherited when the project sits under the home directory.'
  );

  return finalizeLevel(level);
}

/** ~/.claude/plugins: marketplaces, installed set, and cached skill/agent trees. */
async function scanPlugins() {
  const pluginsDir = path.join(homeDir(), '.claude', 'plugins');
  const level = newLevel({
    kind: 'plugins',
    label: 'Plugins (user level)',
    dir: pluginsDir,
    note: 'Plugin-provided skills, agents and commands. Namespaced as plugin:skill at runtime.',
  });

  for (const name of ['installed_plugins.json', 'known_marketplaces.json', 'blocklist.json']) {
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
    marketplaces = await withTimeout(
      fs.readdir(cacheDir, { withFileTypes: true }),
      DIR_TIMEOUT_MS,
      cacheDir
    );
  } catch (err) {
    level.errors.push({ path: cacheDir, ...describeError(err) });
    return finalizeLevel(level);
  }

  for (const market of marketplaces.filter((d) => d.isDirectory())) {
    const marketPath = path.join(cacheDir, market.name);
    let plugins = [];
    try {
      plugins = await withTimeout(
        fs.readdir(marketPath, { withFileTypes: true }),
        DIR_TIMEOUT_MS,
        marketPath
      );
    } catch (err) {
      level.errors.push({ path: marketPath, ...describeError(err) });
      continue;
    }
    for (const plugin of plugins.filter((d) => d.isDirectory())) {
      const pluginPath = path.join(marketPath, plugin.name);
      let versions = [];
      try {
        versions = await withTimeout(
          fs.readdir(pluginPath, { withFileTypes: true }),
          DIR_TIMEOUT_MS,
          pluginPath
        );
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
  if (path.resolve(dir) === path.resolve(homeDir())) {
    notes.push(
      'This is the home directory, so its files also appear at the user level above. ' +
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
      await walkTree(abs, {
        maxDepth: tree.maxDepth,
        exts: tree.exts,
        category: tree.category,
        level,
      });
    } else if (probe.error && probe.error.code !== 'ENOENT') {
      level.errors.push({ path: abs, ...describeError(probe.error) });
    } else {
      level.absent.push({ absPath: abs, name: `${tree.name}/`, category: tree.category });
    }
  }

  // Anything else inside .claude/ gets listed, never parsed. Surfacing it is how
  // a non-standard layout becomes visible instead of silently ignored.
  try {
    const dirents = await withTimeout(
      fs.readdir(claudeDir, { withFileTypes: true }),
      DIR_TIMEOUT_MS,
      claudeDir
    );
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

  const fileCount = levels.reduce(
    (n, l) => n + l.entries.filter((e) => e.type === 'file').length,
    0
  );

  return {
    projectDir: resolved,
    home: homeDir(),
    platform: process.platform,
    scannedAt: new Date().toISOString(),
    levels,
    summary: {
      levelCount: levels.length,
      fileCount,
      errorCount: levels.reduce((n, l) => n + l.errors.length, 0),
      redactedCount: levels.reduce((n, l) => n + l.redacted.length, 0),
    },
  };
}
