/**
 * Flattened lineage views.
 *
 * Each view answers "what is the effective X, and which level supplied it?".
 * Merge rules are stated in the payload rather than implied, because they are
 * this tool's model of precedence, not something read out of Claude Code.
 */

import path from 'node:path';

import { projectConfigKey, samePathKey, settingsSourceFiles } from './paths.js';
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
 * One source reached by several routes, listed once.
 *
 * A project under the home folder makes the walk pass through `~/.claude` a
 * second time, so every file there is sighted twice. Each view used to keep
 * both sightings and leave the collapsing to its consumers; the CLI collapsed
 * them and the page did not, so the page showed an agent shadowing itself
 * (#117), the same bug CLAUDE.md records three times over. Collapsing here
 * leaves nothing for a consumer to get wrong. The first sighting in the
 * caller's order is kept, and the others' level titles go in `alsoReachedFrom`,
 * so the repeat is explained rather than silently dropped.
 */
function collapseRoutes(items, keyOf) {
  const byKey = new Map();
  for (const item of items) {
    const key = keyOf(item);
    const kept = byKey.get(key);
    if (kept) kept.alsoReachedFrom.push(item.levelTitle);
    else byKey.set(key, { ...item, alsoReachedFrom: [] });
  }
  return [...byKey.values()];
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

/** CLAUDE.md / CLAUDE.local.md / AGENTS.md / MEMORY.md and rules, in precedence order. */
async function flattenMemory(lineage) {
  const sections = [];
  // One physical file can be reported at two levels when the project sits under
  // the home directory. Claude Code loads it once, so concatenating it twice
  // would overstate the instruction set and show the same text repeated. The
  // first (weakest) sighting keeps it; later ones are recorded as a note so the
  // repetition is explained rather than silently dropped.
  const emitted = new Set();
  for (const level of lineage.levels) {
    const instructionFiles = level.entries.filter(
      (e) =>
        e.category === 'memory' &&
        e.type === 'file' &&
        !e.inactive &&
        INSTRUCTION_BASENAMES.has(e.name.toLowerCase())
    );
    // Rules load too (#123): measured on 2.1.283, .claude/rules/**/*.md from
    // the configuration home and every folder of the walk, after that level's
    // CLAUDE.md. A plugin's rules were not measured and are left out.
    const rules =
      level.kind === 'user' || level.kind === 'directory'
        ? level.entries.filter((e) => e.category === 'rule' && e.type === 'file' && !e.inactive)
        : [];
    const allMemoryFiles = [...instructionFiles, ...rules];
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
      // A rule with paths in its frontmatter did not load at session start
      // (measured): it is read when Claude reads a matching file.
      const paths = entry.category === 'rule' ? read.frontmatter?.paths : null;
      const globs = Array.isArray(paths) ? paths.map(String) : typeof paths === 'string' && paths.trim() ? [paths] : [];
      files.push({
        path: entry.absPath,
        name: entry.name,
        rule: entry.category === 'rule',
        conditional: globs.length ? `Loaded only when Claude reads a file matching ${globs.join(', ')}, not at session start.` : null,
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
  const agentsNotRead = lineage.levels
    .flatMap((l) => l.entries)
    .filter((e) => e.inactive && e.name.toLowerCase() === 'agents.md').length;
  return {
    kind: 'claude-md',
    heading: 'Effective instruction set',
    rule:
      'CLAUDE.md, CLAUDE.local.md, AGENTS.md, MEMORY.md and .claude/rules, read top to bottom, each ' +
      'level\'s rules after its CLAUDE.md. Later sections are closer to the project and, where ' +
      'instructions conflict, the project-level text is what Claude Code treats as more specific. ' +
      'A rule with paths in its frontmatter loads only when Claude reads a matching file, and is marked. ' +
      'AGENTS.md is read only when the project\'s folders hold no CLAUDE.md, .claude/CLAUDE.md or ' +
      'CLAUDE.local.md' +
      (agentsNotRead ? `; here they do, so ${agentsNotRead} AGENTS.md file(s) are left out` : '') +
      '. MEMORY.md comes from the project memory of the git repository\'s root when there is one. ' +
      'Individual files in the per-project memory directory are recalled on demand rather than loaded ' +
      'every session, so they are excluded here; browse them in the Explorer pane. A file reachable by ' +
      'two routes is shown once, where it is first loaded.',
    sections,
  };
}

/** Claude Code's settings sources, weakest first; which files they are is settingsSourceFiles (#119). */
const SETTINGS_SOURCES = [
  { source: 'user', label: 'User' },
  { source: 'project', label: 'Project' },
  { source: 'local', label: 'Local' },
  { source: 'managed', label: 'Managed' },
];

function settingsSourcePaths(lineage) {
  const configHome = lineage.levels.find((l) => l.kind === 'user')?.dir || null;
  /** samePathKey -> the sources it is, in application order. */
  const roles = new Map();
  for (const { source, file } of settingsSourceFiles(lineage)) {
    const key = samePathKey(file);
    roles.set(key, [...(roles.get(key) || []), source]);
  }
  return { roles, configHome };
}

/** Why a settings-category file found on the walk is not merged. */
function notReadReason(entry, level, lineage, configHome) {
  const name = entry.name.toLowerCase();
  if (level.kind === 'managed') {
    return 'A legacy managed location: Claude Code no longer reads it, so a policy here is not in force.';
  }
  if (name !== 'settings.json' && name !== 'settings.local.json') {
    return 'Not a settings file (key bindings and the like): Claude Code does not merge it into settings.';
  }
  if (configHome && samePathKey(path.dirname(entry.absPath)) === samePathKey(configHome)) {
    return `Read only by a session started in ${path.dirname(configHome)}, as that folder's local settings.`;
  }
  if (level.kind === 'directory' && name === 'settings.local.json' && lineage.platform !== 'win32') {
    return (
      'A parent folder\'s local settings. On macOS and Linux, Claude Code 2.1.211 and later reads ' +
      'settings.local.json at the git repository root; LayerCake does not find the repository root, ' +
      'so if this is it, this file is read but not merged here.'
    );
  }
  return 'A parent folder\'s settings: Claude Code reads settings from the folder it starts in, not from its parents (unlike CLAUDE.md).';
}

/**
 * Top-level keys Claude Code does not simply merge (docs, "Lists merge
 * instead of overriding"): taken whole from the strongest file that sets
 * them, or ignored in some files. Not modelled: modelSettings, resolved one
 * model at a time together with effortLevel.
 */
const WHOLE_VALUE_KEYS = new Set(['fallbackModel']);
const MANAGED_WHOLE_VALUE_KEYS = new Set(['fallbackModel', 'availableModels']);
const IGNORED_IN = { modelPicker: new Set(['project', 'local']) };

/** Array items de-duplicated as lodash uniq does: by value for primitives, never for objects. */
function concatUnique(before, value) {
  const seen = new Set(before);
  const added = [];
  for (const item of value) {
    if (item !== null && typeof item === 'object') added.push(item);
    else if (!seen.has(item)) {
      seen.add(item);
      added.push(item);
    }
  }
  return added;
}

/**
 * Merges one source into `target`, as Claude Code does: objects key by key
 * (so `env` merges per variable, measured), lists concatenated and
 * de-duplicated, anything else overridden. `record(keyPath, mode, added)`
 * notes each leaf and list this source touched; `whole` names the top-level
 * lists this source replaces instead.
 */
function mergeSettingsInto(target, source, record, whole, prefix = '') {
  for (const [key, value] of Object.entries(source)) {
    const keyPath = prefix ? `${prefix}.${key}` : key;
    if (Array.isArray(value)) {
      if (prefix === '' && whole.has(key)) {
        target[key] = [...value];
        record(keyPath, 'replace', [...value]);
      } else {
        const before = Array.isArray(target[key]) ? target[key] : [];
        const added = concatUnique(before, value);
        target[key] = [...before, ...added];
        record(keyPath, 'concat', added);
      }
      continue;
    }
    if (value && typeof value === 'object') {
      if (!target[key] || typeof target[key] !== 'object' || Array.isArray(target[key])) target[key] = {};
      mergeSettingsInto(target[key], value, record, whole, keyPath);
      continue;
    }
    target[key] = value;
    record(keyPath, 'override', null);
  }
}

/** settings.json chain plus a computed effective merge. */
async function flattenSettings(lineage) {
  const { roles, configHome } = settingsSourcePaths(lineage);
  const sections = [];
  /** samePathKey -> { entry, parsed } of every file read. */
  const readFiles = new Map();

  for (const level of settingsOrder(lineage.levels)) {
    const all = level.entries.filter((e) => e.category === 'settings' && e.type === 'file' && e.name.endsWith('.json'));
    // settings.json before settings.local.json, the order they apply in.
    all.sort((a, b) => a.name.length - b.name.length || a.name.localeCompare(b.name));
    // The config home is also the .claude folder of an ancestor when the
    // project is under home: its files are listed once, where first reached,
    // as the other views do (#118).
    const repeated = all.filter((e) => readFiles.has(samePathKey(e.absPath)));
    const settingsFiles = all.filter((e) => !readFiles.has(samePathKey(e.absPath)));

    const files = [];
    for (const entry of settingsFiles) {
      const key = samePathKey(entry.absPath);
      const read = await readForDisplay(entry.absPath);
      const parsed = read.parsed && typeof read.parsed === 'object' ? read.parsed : null;
      // Only an object merges; a list at the top (a key bindings file) is shown, not merged.
      readFiles.set(key, { entry, parsed: Array.isArray(parsed) ? null : parsed });
      const sources = roles.get(key) || [];
      files.push({
        path: entry.absPath,
        name: entry.name,
        sensitive: entry.sensitive,
        // The sources this file is, empty when Claude Code does not read it.
        sources,
        notRead: sources.length ? null : notReadReason(entry, level, lineage, configHome),
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
      empty: files.length === 0,
      files,
      repeatedNote: repeated.length
        ? `${repeated.length} file(s) here are the same files already shown above, reached again by the directory walk. Claude Code reads each once.`
        : null,
      repeatedPaths: repeated.map((e) => e.absPath),
    });
  }

  // Applied in Claude Code's order, not the display order: user, project,
  // local, managed. A file that is two sources is applied once.
  const merged = {};
  const byKeyPath = new Map();
  const ignored = [];
  const applied = new Set();
  for (const { source, label } of SETTINGS_SOURCES) {
    for (const [key, { entry, parsed }] of readFiles) {
      if (!parsed || applied.has(key) || !(roles.get(key) || []).includes(source)) continue;
      applied.add(key);
      const from = { source, label, file: entry.absPath };
      const kept = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (IGNORED_IN[k]?.has(source)) ignored.push({ keyPath: k, ...from, reason: `Claude Code ignores ${k} in ${source} settings.` });
        else kept[k] = v;
      }
      const record = (keyPath, mode, added) => {
        const row = byKeyPath.get(keyPath);
        if (mode === 'concat' && row?.mode === 'concat') row.sources.push({ ...from, added });
        else byKeyPath.set(keyPath, { keyPath, mode, sources: [mode === 'override' ? from : { ...from, added }] });
      };
      mergeSettingsInto(merged, kept, record, source === 'managed' ? MANAGED_WHOLE_VALUE_KEYS : WHOLE_VALUE_KEYS);
    }
  }

  return {
    kind: 'settings',
    heading: 'Settings chain',
    rule:
      'The files Claude Code reads for a session started in this folder, applied weakest to strongest: ' +
      'user settings (settings.json in the config home), the project\'s .claude/settings.json, its ' +
      '.claude/settings.local.json, then managed settings, which win. Settings in parent folders are not ' +
      'inherited (unlike CLAUDE.md) and are listed as not read. Objects merge key by key, env per variable. ' +
      'Lists are combined and de-duplicated, except fallbackModel (taken whole from the strongest file), ' +
      'modelPicker (ignored in project and local files) and a managed availableModels (taken as-is). ' +
      'Not modelled: --settings for one session, managed-settings.d, registry and server-managed policy, ' +
      'modelSettings, the few security keys where a stricter lower value wins, and on macOS and Linux the ' +
      'git-root location of settings.local.json. Matches Claude Code 2.1.283 and its docs; computed by ' +
      'LayerCake, not read back from Claude Code.',
    sections,
    merged,
    // One row per leaf or list; a combined list names every file that added to it.
    provenance: [...byKeyPath.values()].sort((a, b) => a.keyPath.localeCompare(b.keyPath)),
    ignored,
  };
}

function definitionName(entry, frontmatter) {
  if (frontmatter && typeof frontmatter.name === 'string' && frontmatter.name.trim()) {
    return frontmatter.name.trim();
  }
  if (entry.isSkillManifest) return path.basename(path.dirname(entry.absPath));
  return path.basename(entry.name, path.extname(entry.name));
}

/**
 * A plugin file's plugin name: from the install that holds it (plugins.js),
 * else from its cache folder (<marketplace>/<plugin>) when installed_plugins.json
 * could not be read.
 */
function pluginNameOf(entry) {
  return entry.pluginName || (entry.plugin ? entry.plugin.split('/')[1] : null) || null;
}

/** Agents, skills and commands grouped by name, strongest definition first. */
async function flattenDefinitions(lineage) {
  const groups = new Map();
  let notLoaded = 0;

  for (const level of lineage.levels) {
    const defs = level.entries.filter(
      (e) => ['agent', 'skill', 'command'].includes(e.category) && e.type === 'file'
    );
    for (const entry of defs) {
      if (entry.category === 'skill' && !entry.isSkillManifest) continue;
      // A plugin that does not load here (#122): its definitions are not in
      // play, so they neither count nor shadow. The Explorer marks each.
      if (entry.inactive) {
        notLoaded += 1;
        continue;
      }
      const read = await readForDisplay(entry.absPath);
      const fm = read.error ? null : read.frontmatter || splitFrontmatter(read.content || '').frontmatter;
      // Claude Code names a plugin's definitions <plugin>:<name> (measured,
      // #122), so one never shadows a project's definition of the same name.
      const plugin = level.kind === 'plugins' ? pluginNameOf(entry) : null;
      const name = plugin ? `${plugin}:${definitionName(entry, fm)}` : definitionName(entry, fm);
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
    // user an agent was being overridden by itself. It is kept at its strongest
    // sighting, which is where the winner has always been taken from.
    const definitions = collapseRoutes(group.definitions, (d) => samePathKey(d.path));
    return {
      ...group,
      definitions,
      shadowed: definitions.length > 1,
      reachedByMultipleRoutes: definitions.some((d) => d.alsoReachedFrom.length > 0),
      winner: definitions[0],
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
      'A plugin\'s are named plugin:name, as Claude Code names them, so they never shadow a project\'s. ' +
      (notLoaded
        ? `${notLoaded} definition(s) from plugins that do not load here are left out; the Plugins level says why. `
        : '') +
      'A file reachable by two routes is one definition, listed once.',
    notLoaded,
    groups: list,
  };
}

/** The `projects` keys naming this project: exactly, or ignoring case on Windows. */
function projectKeysFor(projects, wanted) {
  if (!projects || typeof projects !== 'object') return [];
  const fold = (k) => (process.platform === 'win32' ? k.toLowerCase() : k);
  return Object.keys(projects).filter((k) => fold(k) === fold(wanted));
}

/** MCP server definitions across the chain. */
async function flattenMcp(lineage) {
  const servers = new Map();
  const sources = [];

  const addServers = (block, meta, prefix = '') => {
    if (!block || typeof block !== 'object' || Array.isArray(block)) return [];
    const names = [];
    for (const [bare, def] of Object.entries(block)) {
      const name = prefix + bare;
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

  const keyDir = lineage.gitRoot?.dir || lineage.projectDir;
  const wantedKey = projectConfigKey(keyDir);

  for (const level of lineage.levels) {
    // .claude.json is included because servers added through the Claude app land
    // there, not in a .mcp.json. Leaving it out would make the view look complete
    // while missing the servers most likely to be in play.
    // A plugin's servers come from its .mcp.json or its plugin.json (#121).
    const mcpFiles = level.entries.filter(
      (e) =>
        e.type === 'file' &&
        (e.category === 'mcp' ||
          e.name === '.mcp.json' ||
          e.category === 'home-config' ||
          (level.kind === 'plugins' && e.name === 'plugin.json'))
    );
    for (const entry of mcpFiles) {
      const read = await readForDisplay(entry.absPath);
      const parsed = read.parsed && typeof read.parsed === 'object' ? read.parsed : null;
      const plugin = level.kind === 'plugins' ? pluginNameOf(entry) : null;
      // A plugin's .mcp.json may hold the servers at its top level (the
      // playwright plugin's does) or under mcpServers; plugin.json only under
      // mcpServers, as an object. A plugin.json without one is no MCP source.
      const pluginBlock = !plugin
        ? null
        : entry.name === 'plugin.json'
          ? parsed?.mcpServers && typeof parsed.mcpServers === 'object' ? parsed.mcpServers : null
          : parsed?.mcpServers ?? parsed;
      if (plugin && entry.name === 'plugin.json' && !pluginBlock) continue;
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

      // A file Claude Code does not read (#121, #87) is listed with the servers
      // it defines, so they can be found, and contributes none of them.
      if (entry.inactive) {
        source.notRead = entry.note || 'Not read by Claude Code.';
        const block = plugin ? pluginBlock : parsed?.mcpServers;
        if (block && typeof block === 'object' && !Array.isArray(block)) {
          source.serverNames.push(...Object.keys(block).map((n) => (plugin ? `plugin:${plugin}:${n}` : n)));
        }
        sources.push(source);
        continue;
      }

      // A loaded plugin's servers, named as Claude Code names them.
      if (plugin) {
        source.serverNames.push(
          ...addServers(
            pluginBlock,
            {
              levelTitle: levelTitle(level),
              precedence: level.precedence,
              path: entry.absPath,
              scope: `plugin ${entry.pluginId || plugin}`,
            },
            `plugin:${plugin}:`
          )
        );
        sources.push(source);
        continue;
      }

      source.serverNames.push(
        ...addServers(parsed?.mcpServers, {
          levelTitle: levelTitle(level),
          precedence: level.precedence,
          path: entry.absPath,
          scope: 'global',
        })
      );

      // ~/.claude.json also carries per-project blocks, keyed the way
      // projectConfigKey says (#120). Claude Code reads the one spelled like
      // the directory it was started in; a scan cannot know that spelling, so
      // on Windows every key equal to it ignoring case is read, each named.
      for (const key of projectKeysFor(parsed?.projects, wantedKey)) {
        const projectNames = addServers(parsed.projects[key]?.mcpServers, {
          levelTitle: levelTitle(level),
          precedence: level.precedence + 0.5, // project-scoped beats the global block
          path: entry.absPath,
          scope: `project block "${key}"`,
        });
        source.serverNames.push(...projectNames);
        if (projectNames.length) source.hasProjectBlock = true;
      }

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
    const definitions = collapseRoutes(server.definitions, (d) =>
      JSON.stringify([samePathKey(d.path), d.scope])
    );
    return {
      ...server,
      definitions,
      shadowed: definitions.length > 1,
      reachedByMultipleRoutes: definitions.some((d) => d.alsoReachedFrom.length > 0),
      winner: definitions[0],
    };
  });
  list.sort((a, b) => a.name.localeCompare(b.name));

  return {
    kind: 'mcp',
    heading: 'MCP servers',
    rule:
      'Collected from the .mcp.json in the project folder and every folder above it, plus the global and per-project mcpServers blocks ' +
      `in ~/.claude.json. The per-project block is the one keyed "${wantedKey}": ` +
      (lineage.gitRoot?.dir
        ? `the git repository's root${lineage.gitRoot.via === 'worktree' ? ' (the main repository, since this is a worktree)' : ''}, ` +
          'which is where Claude Code keeps local-scope servers for any folder inside it. '
        : lineage.gitRoot?.error
          ? `the project directory, since ${lineage.gitRoot.error.path} could not be read to find a git root. `
          : 'the project directory, which is in no git repository. ') +
      (process.platform === 'win32'
        ? 'Claude Code reads only the key spelled like the folder it was started in, forward slashes and ' +
          'letter case included; a key differing from this one only in case is listed too. '
        : '') +
      'A .mcp.json inside a .claude folder, the configuration home\'s included, is not read by Claude Code: ' +
      'it is listed among the sources as not read, and its servers are not. ' +
      'A plugin that loads here adds the servers of its installed version\'s .mcp.json or plugin.json, ' +
      'named plugin:<plugin>:<server>; one that does not load is listed as not read, with the reason. ' +
      'A server defined at more than one level is flagged; the definition closest to the project is shown ' +
      'as the winner. Servers still awaiting per-project approval are listed here even though Claude Code ' +
      'will not have loaded them. A file reachable by two routes is listed once.',
    projectKey: wantedKey,
    gitRoot: lineage.gitRoot,
    // Weakest first, so a file keeps its first sighting, as the chain view does.
    sources: collapseRoutes(sources, (s) => samePathKey(s.path)),
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
