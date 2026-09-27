/**
 * Derives the figures behind `layercake here`.
 *
 * Kept separate from rendering so the numbers can be reasoned about on their
 * own. Every count here comes from server/flatten.js or from the lineage
 * itself; nothing re-implements a merge rule. That matters because the settings
 * and shadowing models are this tool's own, and a second copy in the CLI would
 * drift from the one the web UI shows and quietly disagree with it.
 */

import { flatten } from '../server/flatten.js';

/** Categories that flatten('definitions') groups and shadows by declared name. */
const DEFINITION_CATEGORIES = ['agent', 'skill', 'command'];

/**
 * Categories counted straight off the lineage instead.
 *
 * Hooks and rules are deliberately NOT shadow-counted. A hook is wired up by a
 * settings.json entry rather than resolved by filename, so two hook files with
 * the same basename at different levels do not necessarily shadow each other.
 * Reporting a shadow count here would be a claim about Claude Code's behavior
 * that this tool has not established.
 */
const COUNTED_CATEGORIES = ['hook', 'rule'];

function countEntries(lineage, category) {
  let n = 0;
  for (const level of lineage.levels) {
    for (const entry of level.entries) {
      if (entry.type === 'file' && entry.category === category) n += 1;
    }
  }
  return n;
}

/** Highlights pulled from the computed settings merge, present keys only. */
function settingsHighlights(merged) {
  const rows = [];
  if (typeof merged.model === 'string') rows.push(['model', merged.model]);
  const perms = merged.permissions && typeof merged.permissions === 'object' ? merged.permissions : null;
  if (perms) {
    if (typeof perms.defaultMode === 'string') rows.push(['defaultMode', perms.defaultMode]);
    const parts = [];
    for (const key of ['allow', 'deny', 'ask', 'additionalDirectories']) {
      if (Array.isArray(perms[key])) parts.push(`${key} ${perms[key].length}`);
    }
    if (parts.length) rows.push(['permissions', parts.join('  ')]);
  }
  const extras = [];
  if (merged.env && typeof merged.env === 'object') {
    extras.push(`env ${Object.keys(merged.env).length}`);
  }
  if (merged.hooks && typeof merged.hooks === 'object') {
    extras.push(`hook events ${Object.keys(merged.hooks).length}`);
  }
  if (merged.statusLine) extras.push('statusLine set');
  if (merged.enableAllProjectMcpServers === true) extras.push('enableAllProjectMcpServers');
  if (extras.length) rows.push(['also', extras.join('  ')]);
  return rows;
}

/**
 * Everything `here` prints, in one pass over the lineage.
 *
 * The four flatten calls read file bodies (frontmatter for definition names,
 * JSON for settings and MCP), so this is the expensive part of the command. It
 * is still one scan and one read per config file, which is the same work the
 * web UI does to render the same answer.
 */
export async function buildSummary(lineage) {
  const [memory, settings, definitions, mcp] = await Promise.all([
    flatten(lineage, 'claude-md'),
    flatten(lineage, 'settings'),
    flatten(lineage, 'definitions'),
    flatten(lineage, 'mcp'),
  ]);

  // flattenMemory emits a repeated file once, at the weakest level where it is
  // first loaded, and records the later sightings in repeatedPaths. Both are
  // read straight from the payload: the CLI no longer dedupes.
  const instructions = [];
  let instructionsRepeated = 0;
  for (const section of memory.sections) {
    instructionsRepeated += section.repeatedPaths ? section.repeatedPaths.length : 0;
    for (const file of section.files) {
      instructions.push({
        path: file.path,
        precedence: section.precedence,
        error: file.error || null,
      });
    }
  }

  // `shadowed` counts NAMES with more than one distinct file behind them, which
  // is the question someone actually has: how many of my agents are being
  // overridden. flatten decides what counts as shadowed; this only tallies.
  const defs = DEFINITION_CATEGORIES.map((category) => {
    const groups = definitions.groups.filter((g) => g.category === category);
    return {
      category,
      active: groups.length,
      shadowed: groups.filter((g) => g.shadowed).length,
      repeated: groups.filter((g) => g.reachedByMultipleRoutes).length,
    };
  });

  const counted = COUNTED_CATEGORIES.map((category) => ({
    category,
    files: countEntries(lineage, category),
  }));

  // Merged means read by Claude Code (#119): a parent folder's settings file
  // is found, shown and counted apart, never merged.
  const allSettingsFiles = settings.sections.flatMap((s) => s.files);
  const readSettingsFiles = allSettingsFiles.filter((f) => f.sources.length);
  const settingsFiles = readSettingsFiles.length;
  const settingsNotRead = allSettingsFiles.length - readSettingsFiles.length;
  const settingsErrors = readSettingsFiles.filter((f) => f.error || f.jsonError).length;

  const levelsWithContent = lineage.levels.filter((l) => l.entries.length > 0).length;

  return {
    projectDir: lineage.projectDir,
    home: lineage.home,
    platform: lineage.platform,
    scannedAt: lineage.scannedAt,
    instructions,
    instructionsRepeated,
    definitions: defs,
    counted,
    mcp: {
      total: mcp.servers.length,
      shadowed: mcp.servers.filter((s) => s.shadowed).length,
      repeated: mcp.servers.filter((s) => s.reachedByMultipleRoutes).length,
      names: mcp.servers.map((s) => s.name),
      badSources: mcp.sources.filter((s) => s.error || s.jsonError).length,
    },
    settings: {
      files: settingsFiles,
      notRead: settingsNotRead,
      unreadable: settingsErrors,
      highlights: settingsHighlights(settings.merged),
      empty: Object.keys(settings.merged).length === 0,
    },
    levels: {
      total: lineage.levels.length,
      withContent: levelsWithContent,
      empty: lineage.levels.length - levelsWithContent,
      errored: lineage.levels.filter((l) => l.errors.length > 0).length,
    },
    errorCount: lineage.summary.errorCount,
    redactedCount: lineage.summary.redactedCount,
    fileCount: lineage.summary.fileCount,
  };
}
