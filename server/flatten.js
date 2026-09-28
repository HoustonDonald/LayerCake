/**
 * Flattened lineage views.
 *
 * Each view answers "what is the effective X, and which level supplied it?".
 * Merge rules are stated in the payload rather than implied, because they are
 * this tool's model of precedence, not something read out of Claude Code.
 */

import path from 'node:path';

import { managedMcpFile, projectConfigKey, remoteSettingsFile, samePathKey, settingsSourceFiles } from './paths.js';
import { policyParseError, policyText, policyValue } from './policy.js';
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
      'level\'s rules after its CLAUDE.md. A CLAUDE.md in the managed policy folder loads first and cannot ' +
      'be excluded; a claudeMd key in managed policy loads as managed instructions too, and is shown in the ' +
      'settings view rather than here. Later sections are closer to the project and, where ' +
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
  if (entry.category === 'remote-settings') {
    return (
      'Server-managed settings as Claude Code last cached them. Not merged here: Claude Code fetches them again ' +
      'at startup and can hold them back until they are approved. When they are in force they outrank every ' +
      'other source, managed ones included.'
    );
  }
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
 * Top-level keys Claude Code does not simply merge, in every file of every
 * tier: its merge customizer (kY in the 2.1.283 bundle; the docs state the
 * same rules for the managed drop-ins) takes these whole from the later file,
 * and these entry by entry, by name, a later entry replacing an earlier one.
 * Some keys are also ignored in some files. Not modelled: modelSettings,
 * resolved one model at a time together with effortLevel.
 */
const WHOLE_KEYS = new Set(['fallbackModel', 'modelPicker']);
const ENTRY_KEYS = new Set(['extraKnownMarketplaces', 'managedMcpServers']);
const IGNORED_IN = {
  modelPicker: new Set(['project', 'local']),
  // Docs: "Setting claudeMd in user, project, or local settings has no effect" (#147).
  claudeMd: new Set(['user', 'project', 'local']),
};

const plainRules = (key) => (WHOLE_KEYS.has(key) ? 'whole' : ENTRY_KEYS.has(key) ? 'entries' : null);

/**
 * The rules for one managed part: the first managed part to set
 * availableModels takes it as-is over the tiers below, and a later part
 * combines with it, as lists do between the managed files. Applying the parts
 * one by one this way gives what composing the tier first and laying it over
 * would, without losing which file set what.
 */
function managedRules(setByManaged) {
  return (key) => (key === 'availableModels' && !setByManaged.has(key) ? 'whole' : plainRules(key));
}

/**
 * Keys Claude Code does not count when it asks whether a managed source holds
 * policy (gft in the 2.1.283 bundle): a source with only these is passed over
 * as if absent.
 */
const POLICY_META_KEYS = new Set(['managedSourcesBehavior', 'wslInheritsWindowsSettings']);
const holdsPolicy = (parsed) => Boolean(parsed) && Object.keys(parsed).some((k) => !POLICY_META_KEYS.has(k));

/**
 * What Claude Code says of an admin policy document that is not a JSON
 * object: its bundle marks the message startupFatal. Read, not measured: a
 * real admin document needs elevation to write.
 */
const FATAL_PARSE =
  'Does not parse as a JSON object. Claude Code 2.1.283 marks that fatal at startup ("none of its settings are in ' +
  'effect. Fix or remove it."), so it will most likely not start while this is so (read from its bundle, not measured).';

const MANAGED_RANK = [
  { id: 'hklm', label: 'HKLM registry', admin: true },
  { id: 'file', label: 'managed settings files', admin: true },
  { id: 'hkcu', label: 'HKCU registry', admin: false },
];

/**
 * The managed tier as Claude Code composes it (#147; docs "How Claude Code
 * combines managed sources", with the 2.1.283 bundle). Highest first:
 * server-managed settings (not readable here; see remoteCache), the HKLM
 * registry value, the managed files (managed-settings.json, then the
 * drop-ins in name order), and the HKCU registry value.
 *
 * - A source "delivers" when it holds a policy key (not only the meta keys
 *   above). A document that does not parse is no policy, and an admin one
 *   is fatal at startup (FATAL_PARSE); it still counts as present, as one
 *   that cannot be read does, so HKCU stays unread (hft in the bundle).
 * - "first-wins", the default: the highest admin source (HKLM or the files)
 *   that delivers is the tier alone.
 * - "merge": every admin source that delivers applies, lowest first.
 * - managedSourcesBehavior counts only from the highest source that delivers.
 * - HKCU applies only when no admin source is present, and never in a merge.
 *
 * Not modelled, and said: a few keys (env per variable, deniedMcpServers and
 * others the docs list) that first-wins still reads from a skipped admin
 * source, the stricter "merge" rules, keys Claude Code drops from some
 * sources, and parent settings from a host.
 */
function composeManaged(lineage, readFiles) {
  const level = lineage.levels.find((l) => l.kind === 'managed');
  // A blank managed file is {} to Claude Code, not a parse error.
  const fileParts = settingsSourceFiles(lineage)
    .filter((s) => s.source === 'managed')
    .map((s) => readFiles.get(samePathKey(s.file)))
    .filter(Boolean)
    .map(({ entry, parsed, error, blank }) => ({
      path: entry.absPath,
      parsed: blank ? {} : parsed,
      problem: error ? 'read' : blank || parsed ? null : 'parse',
    }));
  const registryParts = (id) => {
    const record = (level?.policies || []).find((p) => p.id === id);
    if (!record) return [];
    const parsed = policyValue(record);
    const part = { path: record.location, parsed, registry: true, problem: null };
    if (record.state === 'error') return [{ ...part, problem: 'read' }];
    // A value of another type is invisible to Claude Code's reader.
    if (record.state !== 'set' || (record.type !== 'REG_SZ' && record.type !== 'REG_EXPAND_SZ')) return [];
    if (parsed) return [part];
    return record.chars ? [{ ...part, problem: 'parse' }] : [{ ...part, parsed: {} }];
  };
  // The registry exists on Windows only; macOS's managed plist is not modelled.
  const sources = MANAGED_RANK.filter((s) => s.id === 'file' || lineage.platform === 'win32').map((s) => {
    const parts = s.id === 'file' ? fileParts : registryParts(s.id);
    return { ...s, parts, delivers: parts.some((p) => holdsPolicy(p.parsed)), broken: parts.filter((p) => p.problem) };
  });

  const admin = sources.filter((s) => s.admin && s.delivers);
  const top = admin[0] || null;
  const present = sources.find((s) => s.admin && (s.delivers || s.broken.length)) || null;
  // The last part to set it wins, as a scalar does.
  const said = top ? top.parts.map((p) => p.parsed?.managedSourcesBehavior).filter((v) => v !== undefined).pop() : undefined;
  const behavior = said === 'merge' ? 'merge' : 'first-wins';
  const hkcu = sources.find((s) => s.id === 'hkcu');
  const applied = top ? (behavior === 'merge' ? admin : [top]) : !present && hkcu?.delivers ? [hkcu] : [];
  const are = (s) => (s.id === 'file' ? 'are' : 'is');

  for (const s of sources) {
    s.applied = applied.includes(s);
    const parse = s.broken.some((p) => p.problem === 'parse');
    if (s.applied) s.reason = null;
    else if (!s.parts.length) s.reason = 'Not present.';
    else if (parse && s.admin) s.reason = FATAL_PARSE;
    else if (parse) s.reason = 'Does not parse as a JSON object; Claude Code warns and takes nothing from it.';
    else if (s.broken.length) s.reason = 'Could not be read, so LayerCake cannot say what it holds. Claude Code does not read the HKCU value while an admin source fails to load.';
    else if (!s.delivers) {
      s.reason = 'Present but holds no policy key (managedSourcesBehavior and wslInheritsWindowsSettings do not count), so Claude Code passes over it.';
    } else if (!s.admin) {
      s.reason = behavior === 'merge'
        ? 'Skipped: the HKCU value never takes part in a merge.'
        : `Skipped: Claude Code reads the HKCU value only when no admin source is present, and the ${present.label} ${are(present)}.`;
    } else {
      s.reason =
        `Skipped: the ${top.label} ${top.id === 'file' ? 'rank' : 'ranks'} higher and ${top.id === 'file' ? 'hold' : 'holds'} policy, and managedSourcesBehavior ` +
        'is not "merge" there, so Claude Code uses that source alone. A few keys (env per variable, deniedMcpServers and ' +
        'others the docs list) are still read from here; LayerCake does not model those.';
    }
  }
  const cache = level?.entries.find((e) => e.category === 'remote-settings' && e.type === 'file') || null;
  return {
    sources,
    behavior,
    // Admin documents Claude Code will not start with.
    fatal: sources.filter((s) => s.admin).flatMap((s) => s.broken.filter((p) => p.problem === 'parse').map((p) => ({ source: s.label, path: p.path }))),
    behaviorFrom: said !== undefined ? top.label : null,
    // Weakest first, the order they are laid down in.
    applied: [...applied].reverse(),
    remoteCache: { path: remoteSettingsFile(), present: Boolean(cache) },
  };
}

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
 * notes each leaf and list this source touched; `ruleOf(topLevelKey)` says
 * which top-level keys this source replaces instead, 'whole' or by
 * 'entries'. A replaced value is a copy: the parsed file is also shown, and a
 * later merge into it must not change what the page displays.
 */
function mergeSettingsInto(target, source, record, ruleOf, prefix = '') {
  for (const [key, value] of Object.entries(source)) {
    const keyPath = prefix ? `${prefix}.${key}` : key;
    const rule = prefix === '' ? ruleOf(key) : null;
    if (rule === 'whole') {
      target[key] = structuredClone(value);
      record(keyPath, 'replace', Array.isArray(value) ? [...value] : null);
      continue;
    }
    if (rule === 'entries' && value && typeof value === 'object' && !Array.isArray(value)) {
      if (!target[key] || typeof target[key] !== 'object' || Array.isArray(target[key])) target[key] = {};
      for (const [name, item] of Object.entries(value)) {
        target[key][name] = structuredClone(item);
        record(`${keyPath}.${name}`, 'replace', null);
      }
      continue;
    }
    if (Array.isArray(value)) {
      const before = Array.isArray(target[key]) ? target[key] : [];
      const added = concatUnique(before, value);
      target[key] = [...before, ...added];
      record(keyPath, 'concat', added);
      continue;
    }
    if (value && typeof value === 'object') {
      if (!target[key] || typeof target[key] !== 'object' || Array.isArray(target[key])) target[key] = {};
      mergeSettingsInto(target[key], value, record, ruleOf, keyPath);
      continue;
    }
    target[key] = value;
    record(keyPath, 'override', null);
  }
}

/**
 * The managed section, as the managed tier sees it (#147): each file says
 * which source it belongs to and whether that source applies, the registry
 * values found (or failed) are listed beside the files, and the order is the
 * tier's, weakest first: HKCU, the files in the order they merge, HKLM, then
 * the server-managed cache and anything Claude Code does not read.
 */
function showManagedSources(lineage, sections, managed) {
  const level = lineage.levels.find((l) => l.kind === 'managed');
  const section = level && sections.find((s) => s.levelId === level.id);
  if (!section) return;
  const rank = new Map();
  /** samePathKey -> { source, part } for every managed file part. */
  const partOf = new Map();
  const fileSource = managed.sources.find((s) => s.id === 'file');
  fileSource.parts.forEach((p, i) => {
    rank.set(samePathKey(p.path), 1 + i);
    partOf.set(samePathKey(p.path), { s: fileSource, p });
  });
  // A part that does not parse or cannot be read contributes nothing, even
  // when its source applies, and says why.
  const said = (s, p) => ({
    source: s.label,
    applied: s.applied && !p.problem,
    reason: p.problem === 'parse' ? (s.admin ? FATAL_PARSE : s.reason) : p.problem ? 'Could not be read.' : s.reason,
  });
  for (const file of section.files) {
    const hit = partOf.get(samePathKey(file.path));
    if (hit) file.managed = said(hit.s, hit.p);
  }
  for (const record of level.policies || []) {
    if (record.state === 'absent') continue;
    const parsed = policyValue(record);
    const s = managed.sources.find((x) => x.id === record.id);
    const part = s?.parts[0];
    section.files.push({
      path: record.location,
      name: record.valueName,
      registry: record.id,
      sensitive: false,
      sources: part ? ['managed'] : [],
      notRead: part ? null : record.note || 'Holds no settings Claude Code reads.',
      managed: part ? said(s, part) : null,
      note: record.note,
      error: record.error,
      // The parser's own words, which quote the value, go here and not in
      // the scan (#147).
      jsonError: record.jsonError ? policyParseError(record) || record.jsonError : null,
      content: policyText(record) ?? '',
      parsed,
    });
  }
  const order = (file) =>
    file.registry === 'hkcu' ? 0 : file.registry === 'hklm' ? 1000 : rank.get(samePathKey(file.path)) ?? 2000;
  section.files.sort((a, b) => order(a) - order(b));
  section.empty = section.files.length === 0;
}

/** settings.json chain plus a computed effective merge. */
async function flattenSettings(lineage) {
  const { roles, configHome } = settingsSourcePaths(lineage);
  const sections = [];
  /** samePathKey -> { entry, parsed } of every file read. */
  const readFiles = new Map();

  for (const level of settingsOrder(lineage.levels)) {
    // The server-managed cache is listed with the managed files so its
    // content can be seen; it has no role, so it is never merged (#147).
    const all = level.entries.filter(
      (e) => (e.category === 'settings' || e.category === 'remote-settings') && e.type === 'file' && e.name.endsWith('.json')
    );
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
      // `error` and `blank` say what a managed part is to Claude Code (#147).
      readFiles.set(key, {
        entry,
        parsed: Array.isArray(parsed) ? null : parsed,
        error: read.error || null,
        blank: !read.error && String(read.content ?? '').trim() === '',
      });
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

  const managed = composeManaged(lineage, readFiles);
  showManagedSources(lineage, sections, managed);

  // Applied in Claude Code's order, not the display order: user, project,
  // local, managed. A file that is two sources is applied once.
  const merged = {};
  const byKeyPath = new Map();
  const ignored = [];
  const applied = new Set();
  const apply = (parsed, from, ruleOf) => {
    const kept = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (IGNORED_IN[k]?.has(from.source)) ignored.push({ keyPath: k, ...from, reason: `Claude Code ignores ${k} in ${from.source} settings.` });
      else kept[k] = v;
    }
    const record = (keyPath, mode, added) => {
      const row = byKeyPath.get(keyPath);
      // A value taken whole leaves nothing of what was under it.
      if (mode === 'replace') for (const k of byKeyPath.keys()) if (k.startsWith(`${keyPath}.`)) byKeyPath.delete(k);
      // A list the first managed file took whole, which later managed files
      // then combine into (availableModels), keeps every one of them (#147).
      if (mode === 'concat' && row && ['concat', 'replace', 'replace+concat'].includes(row.mode)) {
        row.sources.push({ ...from, added });
        if (row.mode === 'replace') row.mode = 'replace+concat';
      } else byKeyPath.set(keyPath, { keyPath, mode, sources: [mode === 'override' ? from : { ...from, added }] });
    };
    mergeSettingsInto(merged, kept, record, ruleOf);
  };
  for (const { source, label } of SETTINGS_SOURCES) {
    if (source === 'managed') {
      // The managed tier as composed: the applied sources weakest first, each
      // one's parts in their own order (#147).
      const setByManaged = new Set();
      for (const s of managed.applied) {
        for (const part of s.parts) {
          if (!part.parsed) continue;
          // `part` names the file or registry value in a line, for the CLI.
          const from = { source, label: `${label}: ${s.label}`, file: part.path, part: part.registry ? s.id.toUpperCase() : path.basename(part.path) };
          apply(part.parsed, from, managedRules(setByManaged));
          for (const k of Object.keys(part.parsed)) setByManaged.add(k);
        }
      }
      continue;
    }
    for (const [key, { entry, parsed }] of readFiles) {
      if (!parsed || applied.has(key) || !(roles.get(key) || []).includes(source)) continue;
      applied.add(key);
      apply(parsed, { source, label, file: entry.absPath }, plainRules);
    }
  }

  return {
    kind: 'settings',
    heading: 'Settings chain',
    rule:
      'The files Claude Code reads for a session started in this folder, applied weakest to strongest: ' +
      'user settings (settings.json in the config home), the project\'s .claude/settings.json, its ' +
      '.claude/settings.local.json, then managed policy, which wins. Settings in parent folders are not ' +
      'inherited (unlike CLAUDE.md) and are listed as not read. Objects merge key by key, env per variable. ' +
      'Lists are combined and de-duplicated. In every file, fallbackModel and modelPicker are taken whole from ' +
      'the stronger file, and extraKnownMarketplaces and managedMcpServers entry by entry. modelPicker is ' +
      'ignored in project and local files, claudeMd everywhere but managed policy, and a managed ' +
      'availableModels is taken as-is over the files below it. ' +
      'Managed policy is one source of four, highest first: server-managed settings, the HKLM registry value, ' +
      'the managed files (managed-settings.json, then managed-settings.d/*.json in name order, a later file ' +
      'winning), and the HKCU registry value. By default the highest source holding a policy key is used ' +
      'alone; with managedSourcesBehavior "merge" in that source, every admin source applies, combined as ' +
      'above; HKCU is used only when no admin source is present, one that fails to parse included. An admin ' +
      'document that does not parse is marked, since Claude Code treats it as fatal. ' +
      'Not modelled: server-managed settings (fetched from Anthropic, not read from disk; the cache Claude Code ' +
      'keeps is shown, not merged), the keys a skipped admin source still supplies, the stricter rules of ' +
      '"merge", keys Claude Code drops from some sources (managedMcpServers from user, project and local ' +
      'settings, and plugin keys from HKCU, among others), --settings for one session, modelSettings, the few ' +
      'security keys where a stricter lower value wins, and on macOS and Linux the git-root location of ' +
      'settings.local.json. Matches Claude Code 2.1.283 and its docs; computed by LayerCake, not read back ' +
      'from Claude Code.',
    sections,
    merged,
    // One row per leaf or list; a combined list names every file that added to it.
    provenance: [...byKeyPath.values()].sort((a, b) => a.keyPath.localeCompare(b.keyPath)),
    ignored,
    // Which managed source applies and why; the parsed values stay in the sections.
    managed: {
      behavior: managed.behavior,
      behaviorFrom: managed.behaviorFrom,
      fatal: managed.fatal,
      sources: managed.sources.map(({ id, label, admin, delivers, applied: used, reason, parts }) => ({
        id,
        label,
        admin,
        delivers,
        applied: used,
        reason,
        paths: parts.map((p) => p.path),
      })),
      remoteCache: managed.remoteCache,
    },
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

  // managed-mcp.json takes exclusive control of MCP servers while it exists,
  // parsed or not (docs, and the 2.1.283 bundle: "keeps exclusive control of
  // MCP servers while it exists"). Every other source is then listed with the
  // servers it defines and contributes none of them (#147).
  const exclusive =
    lineage.levels
      .find((l) => l.kind === 'managed')
      ?.entries.find((e) => e.type === 'file' && samePathKey(e.absPath) === samePathKey(managedMcpFile())) || null;
  const blockedNote = exclusive
    ? `Not loaded: ${exclusive.absPath} exists, and while it does Claude Code loads only the servers it defines ` +
      'and those in managed settings\' managedMcpServers.'
    : null;

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

      // A file Claude Code does not read (#121, #87), or whose servers the
      // managed file shuts out (#147), is listed with the servers it defines,
      // so they can be found, and contributes none of them.
      const blocked = exclusive && entry !== exclusive;
      if (entry.inactive || blocked) {
        source.notRead = entry.inactive ? entry.note || 'Not read by Claude Code.' : blockedNote;
        // Read, and shut out: the page says "not loaded", not "not read".
        if (!entry.inactive) source.blocked = true;
        const block = plugin ? pluginBlock : parsed?.mcpServers;
        if (block && typeof block === 'object' && !Array.isArray(block)) {
          source.serverNames.push(...Object.keys(block).map((n) => (plugin ? `plugin:${plugin}:${n}` : n)));
        }
        // ~/.claude.json's per-project block too: the local-scope servers are
        // the likeliest ones to be shut out, and were missing here (#147).
        for (const key of plugin ? [] : projectKeysFor(parsed?.projects, wantedKey)) {
          const projectBlock = parsed.projects[key]?.mcpServers;
          if (projectBlock && typeof projectBlock === 'object' && !Array.isArray(projectBlock)) {
            source.serverNames.push(...Object.keys(projectBlock));
          }
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
          scope: entry === exclusive ? 'managed, exclusive' : 'global',
        })
      );
      if (entry === exclusive) source.exclusive = true;

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
      (exclusive
        ? `${exclusive.absPath} exists, so it has exclusive control: only its servers are listed as loading, and ` +
          'every other source is listed as not read. Servers in managed settings\' managedMcpServers load beside ' +
          'them and are not listed here. '
        : 'A managed-mcp.json in the managed folder would take exclusive control; there is none. ') +
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
