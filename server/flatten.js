/**
 * Flattened lineage views.
 *
 * Each view answers "what is the effective X, and which level supplied it?".
 * Merge rules are stated in the payload rather than implied, because they are
 * this tool's model of precedence, not something read out of Claude Code.
 */

import path from 'node:path';

import { samePathKey } from './paths.js';
import { readForDisplay, splitFrontmatter } from './readfile.js';

/** Levels ordered weakest to strongest for settings merging. */
function settingsOrder(levels) {
  const managed = levels.filter((l) => l.kind === 'managed');
  const rest = levels.filter((l) => l.kind !== 'managed');
  return [...rest, ...managed]; // managed applied last, so it wins
}

function levelTitle(level) {
  return level.dir ? `${level.label}: ${level.dir}` : level.label;
}

/**
 * Files that are loaded as instructions at session start.
 *
 * Deliberately narrower than category === 'memory': the per-project memory
 * directory holds dozens of files that are recalled on demand, not injected
 * every session. Sweeping those in would bury the actual inherited instruction
 * set under unrelated notes. MEMORY.md is the exception, since it is the index
 * that does get loaded.
 */
const INSTRUCTION_BASENAMES = new Set([
  'claude.md',
  'claude.local.md',
  'agents.md',
  'memory.md',
]);

/** CLAUDE.md / CLAUDE.local.md / AGENTS.md / MEMORY.md, in precedence order. */
async function flattenMemory(lineage) {
  const sections = [];
  // One physical file can be reported at two levels when the project sits under
  // the home directory. Claude Code loads it once, so concatenating it twice
  // would overstate the instruction set and show the same text repeated. The
  // first (weakest) sighting keeps it; later ones are recorded as a note so the
  // repetition is explained rather than silently dropped.
  const emitted = new Set();
  for (const level of lineage.levels) {
    const allMemoryFiles = level.entries.filter(
      (e) =>
        e.category === 'memory' &&
        e.type === 'file' &&
        INSTRUCTION_BASENAMES.has(e.name.toLowerCase())
    );
    const repeated = allMemoryFiles.filter((e) => emitted.has(samePathKey(e.absPath)));
    const memoryFiles = allMemoryFiles.filter((e) => !emitted.has(samePathKey(e.absPath)));
    for (const e of memoryFiles) emitted.add(samePathKey(e.absPath));
    const repeatedNote = repeated.length
      ? `${repeated.length} file(s) here are the same files already shown at a weaker level, reached again by the directory walk. Claude Code loads each once.`
      : null;

    if (memoryFiles.length === 0) {
      sections.push({
        levelId: level.id,
        title: levelTitle(level),
        precedence: level.precedence,
        empty: true,
        files: [],
        repeatedNote,
        repeatedPaths: repeated.map((e) => e.absPath),
      });
      continue;
    }
    const files = [];
    for (const entry of memoryFiles) {
      const read = await readForDisplay(entry.absPath);
      files.push({
        path: entry.absPath,
        name: entry.name,
        note: entry.note,
        error: read.error,
        truncated: read.truncated || false,
        content: read.error ? '' : read.body ?? read.content,
        frontmatter: read.frontmatter || null,
        bytes: read.size ?? null,
      });
    }
    sections.push({
      levelId: level.id,
      title: levelTitle(level),
      precedence: level.precedence,
      empty: false,
      files,
      repeatedNote,
      repeatedPaths: repeated.map((e) => e.absPath),
    });
  }
  return {
    kind: 'claude-md',
    heading: 'Effective instruction set',
    rule:
      'CLAUDE.md, CLAUDE.local.md, AGENTS.md and MEMORY.md only, read top to bottom. Later sections ' +
      'are closer to the project and, where instructions conflict, the project-level text is what ' +
      'Claude Code treats as more specific. Individual files in the per-project memory directory are ' +
      'recalled on demand rather than loaded every session, so they are excluded here; browse them in ' +
      'the Explorer pane. A file reachable by two routes is shown once, where it is first loaded.',
    sections,
  };
}

const PERMISSION_ARRAY_KEYS = new Set(['allow', 'deny', 'ask', 'additionalDirectories']);

function mergeInto(target, source, provenance, levelLabel, filePath, prefix = '') {
  for (const [key, value] of Object.entries(source)) {
    const keyPath = prefix ? `${prefix}.${key}` : key;
    if (Array.isArray(value)) {
      const isPermissionArray = PERMISSION_ARRAY_KEYS.has(key) && prefix.startsWith('permissions');
      if (isPermissionArray && Array.isArray(target[key])) {
        const before = new Set(target[key]);
        const added = value.filter((v) => !before.has(v));
        target[key] = [...target[key], ...added];
        provenance.push({ keyPath, level: levelLabel, file: filePath, mode: 'union', added });
      } else {
        target[key] = [...value];
        provenance.push({ keyPath, level: levelLabel, file: filePath, mode: 'replace' });
      }
      continue;
    }
    if (value && typeof value === 'object') {
      if (!target[key] || typeof target[key] !== 'object' || Array.isArray(target[key])) {
        target[key] = {};
      }
      mergeInto(target[key], value, provenance, levelLabel, filePath, keyPath);
      continue;
    }
    target[key] = value;
    provenance.push({ keyPath, level: levelLabel, file: filePath, mode: 'override' });
  }
}

/** settings.json chain plus a computed effective merge. */
async function flattenSettings(lineage) {
  const sections = [];
  const merged = {};
  const provenance = [];

  for (const level of settingsOrder(lineage.levels)) {
    const settingsFiles = level.entries.filter(
      (e) => e.category === 'settings' && e.type === 'file' && e.name.endsWith('.json')
    );
    // settings.json before settings.local.json: local overrides shared at the same level.
    settingsFiles.sort((a, b) => a.name.length - b.name.length || a.name.localeCompare(b.name));

    if (settingsFiles.length === 0) {
      sections.push({
        levelId: level.id,
        title: levelTitle(level),
        precedence: level.precedence,
        empty: true,
        files: [],
      });
      continue;
    }

    const files = [];
    for (const entry of settingsFiles) {
      const read = await readForDisplay(entry.absPath);
      const parsed = read.parsed && typeof read.parsed === 'object' ? read.parsed : null;
      if (parsed) mergeInto(merged, parsed, provenance, levelTitle(level), entry.absPath);
      files.push({
        path: entry.absPath,
        name: entry.name,
        sensitive: entry.sensitive,
        error: read.error,
        jsonError: read.jsonError || null,
        content: read.error ? '' : read.content,
        parsed,
      });
    }
    sections.push({
      levelId: level.id,
      title: levelTitle(level),
      precedence: level.precedence,
      empty: false,
      files,
    });
  }

  // Last writer per key path wins, which is what the merge already produced.
  const winners = new Map();
  for (const record of provenance) winners.set(record.keyPath, record);

  return {
    kind: 'settings',
    heading: 'Settings chain',
    rule:
      'Applied weakest to strongest: user, then each directory from filesystem root down to the project ' +
      '(settings.json before settings.local.json), then managed settings last so they win. ' +
      'permissions.allow / deny / ask / additionalDirectories are unioned; every other key is overridden. ' +
      'This merge is computed by this tool, not read back from Claude Code.',
    sections,
    merged,
    provenance: [...winners.values()].sort((a, b) => a.keyPath.localeCompare(b.keyPath)),
  };
}

function definitionName(entry, frontmatter) {
  if (frontmatter && typeof frontmatter.name === 'string' && frontmatter.name.trim()) {
    return frontmatter.name.trim();
  }
  if (entry.isSkillManifest) return path.basename(path.dirname(entry.absPath));
  return path.basename(entry.name, path.extname(entry.name));
}

/** Agents, skills and commands grouped by name, strongest definition first. */
async function flattenDefinitions(lineage) {
  const groups = new Map();

  for (const level of lineage.levels) {
    const defs = level.entries.filter(
      (e) => ['agent', 'skill', 'command'].includes(e.category) && e.type === 'file'
    );
    for (const entry of defs) {
      if (entry.category === 'skill' && !entry.isSkillManifest) continue;
      const read = await readForDisplay(entry.absPath);
      const fm = read.error ? null : read.frontmatter || splitFrontmatter(read.content || '').frontmatter;
      const name = definitionName(entry, fm);
      const key = `${entry.category}:${name}`;
      if (!groups.has(key)) groups.set(key, { key, category: entry.category, name, definitions: [] });
      groups.get(key).definitions.push({
        levelId: level.id,
        levelTitle: levelTitle(level),
        levelKind: level.kind,
        precedence: level.precedence,
        path: entry.absPath,
        plugin: entry.plugin || null,
        description:
          fm && typeof fm.description === 'string' ? fm.description : null,
        model: fm && typeof fm.model === 'string' ? fm.model : null,
        tools: fm && fm.tools != null ? fm.tools : null,
        error: read.error,
      });
    }
  }

  const list = [...groups.values()].map((group) => {
    group.definitions.sort((a, b) => b.precedence - a.precedence); // strongest first
    // Shadowing means two DIFFERENT files claiming one name. A single file
    // reached by two routes is not a shadow, and reporting it as one told the
    // user an agent was being overridden by itself.
    const distinctFiles = new Set(group.definitions.map((d) => samePathKey(d.path)));
    return {
      ...group,
      shadowed: distinctFiles.size > 1,
      // Kept so the UI can explain a repeated path rather than silently hiding
      // one of the two sightings.
      reachedByMultipleRoutes: group.definitions.length > distinctFiles.size,
      winner: group.definitions[0],
    };
  });

  list.sort(
    (a, b) =>
      a.category.localeCompare(b.category) ||
      Number(b.shadowed) - Number(a.shadowed) ||
      a.name.localeCompare(b.name)
  );

  return {
    kind: 'definitions',
    heading: 'Agents, skills and commands',
    rule:
      'Grouped by declared name (frontmatter name, else the filename or skill folder). ' +
      'The definition closest to the project shadows the ones above it. ' +
      'Plugin definitions are namespaced as plugin:skill at runtime, so they rarely collide.',
    groups: list,
  };
}

/** MCP server definitions across the chain. */
async function flattenMcp(lineage) {
  const servers = new Map();
  const sources = [];

  const addServers = (block, meta) => {
    if (!block || typeof block !== 'object') return [];
    const names = [];
    for (const [name, def] of Object.entries(block)) {
      names.push(name);
      if (!servers.has(name)) servers.set(name, { name, definitions: [] });
      servers.get(name).definitions.push({
        ...meta,
        transport: def && (def.type || (def.url ? 'http/sse' : def.command ? 'stdio' : null)),
        command: def && def.command ? def.command : null,
        url: def && def.url ? def.url : null,
        definition: def,
      });
    }
    return names;
  };

  for (const level of lineage.levels) {
    // .claude.json is included because servers added through the Claude app land
    // there, not in a .mcp.json. Leaving it out would make the view look complete
    // while missing the servers most likely to be in play.
    const mcpFiles = level.entries.filter(
      (e) =>
        e.type === 'file' &&
        !e.inactive &&
        (e.category === 'mcp' || e.name === '.mcp.json' || e.category === 'home-config')
    );
    for (const entry of mcpFiles) {
      const read = await readForDisplay(entry.absPath);
      const parsed = read.parsed && typeof read.parsed === 'object' ? read.parsed : null;
      const source = {
        levelId: level.id,
        levelTitle: levelTitle(level),
        precedence: level.precedence,
        path: entry.absPath,
        error: read.error,
        jsonError: read.jsonError || null,
        truncated: read.truncated || false,
        serverNames: [],
      };

      source.serverNames.push(
        ...addServers(parsed?.mcpServers, {
          levelTitle: levelTitle(level),
          precedence: level.precedence,
          path: entry.absPath,
          scope: 'global',
        })
      );

      // ~/.claude.json also carries a per-project block keyed by absolute path.
      const projectBlock = parsed?.projects?.[lineage.projectDir]?.mcpServers;
      const projectNames = addServers(projectBlock, {
        levelTitle: levelTitle(level),
        precedence: level.precedence + 0.5, // project-scoped beats the global block
        path: entry.absPath,
        scope: `project block for ${lineage.projectDir}`,
      });
      source.serverNames.push(...projectNames);
      if (projectNames.length) source.hasProjectBlock = true;

      if (read.truncated) {
        source.jsonError =
          source.jsonError || 'File exceeded the read cap, so its MCP block could not be parsed.';
      }
      sources.push(source);
    }
  }

  const list = [...servers.values()].map((server) => {
    server.definitions.sort((a, b) => b.precedence - a.precedence);
    // Same rule as flattenDefinitions: a shadow needs two DIFFERENT sources.
    // The key is path AND scope, not path alone, because ~/.claude.json
    // legitimately defines a server twice, once in its global mcpServers block
    // and once in the per-project block. Those are two real definitions of one
    // name and must keep counting as a shadow; only the same file reached twice
    // by the level walk is the duplicate being collapsed here.
    const distinctSources = new Set(
      server.definitions.map((d) => JSON.stringify([samePathKey(d.path), d.scope]))
    );
    return {
      ...server,
      shadowed: distinctSources.size > 1,
      reachedByMultipleRoutes: server.definitions.length > distinctSources.size,
      winner: server.definitions[0],
    };
  });
  list.sort((a, b) => a.name.localeCompare(b.name));

  return {
    kind: 'mcp',
    heading: 'MCP servers',
    rule:
      'Collected from every .mcp.json on the chain, plus the global and per-project mcpServers blocks ' +
      'in ~/.claude.json. A server defined at more than one level is flagged; the definition closest ' +
      'to the project is shown as the winner. Servers still awaiting per-project approval are listed ' +
      'here even though Claude Code will not have loaded them.',
    sources,
    servers: list,
  };
}

export async function flatten(lineage, kind) {
  switch (kind) {
    case 'claude-md':
      return flattenMemory(lineage);
    case 'settings':
      return flattenSettings(lineage);
    case 'definitions':
      return flattenDefinitions(lineage);
    case 'mcp':
      return flattenMcp(lineage);
    default:
      throw Object.assign(new Error(`Unknown flatten kind: ${kind}`), { status: 400 });
  }
}
