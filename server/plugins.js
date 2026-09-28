/**
 * Which installed plugins Claude Code loads for a project (#122, #121).
 *
 * Measured on Claude Code 2.1.283 with `claude plugin list --json`, `claude
 * mcp list` and a `claude -p` whose API was a local stub (no usage), from a
 * scratch config home holding a copy of this machine's plugins folder:
 * - Only the version installed_plugins.json names is used. Other cached
 *   versions (usually marked .orphaned_at) are not; the scan does not walk
 *   them (scan.js).
 * - A plugin loads only when the merged enabledPlugins of the settings Claude
 *   Code reads names it true. false is off, and so is a plugin not named at
 *   all.
 * - A `local` or `project` install loads only where the project's git root
 *   (the folder itself outside a repository) is its projectPath: from a
 *   subfolder of the repository it loads, from a subfolder of a plain folder
 *   it does not. `claude plugin list` still says enabled elsewhere; the MCP
 *   server is what shows it is not loaded.
 * - Its agents, skills and commands are named <plugin>:<name>, and its MCP
 *   servers plugin:<plugin>:<server>.
 *
 * The enabled set comes from the settings view's own merge (flatten.js), so
 * the rule that decides it is the one that view states. A file of a plugin
 * that does not load stays listed, marked inactive with the reason, as a
 * .mcp.json inside .claude is.
 */

import path from 'node:path';

import { flatten } from './flatten.js';
import { samePathKey } from './paths.js';
import { readForDisplay } from './readfile.js';

/**
 * installed_plugins.json as a list of installs, or null when it cannot be
 * read, which the scan answers by walking every cached version and saying so.
 * A missing file is an empty list: nothing is installed.
 */
export async function readInstalls(file) {
  const read = await readForDisplay(file);
  if (read.error) return read.error.code === 'ENOENT' ? { installs: [], error: null } : { installs: null, error: read.error };
  const plugins = read.parsed && typeof read.parsed === 'object' ? read.parsed.plugins : null;
  if (!plugins || typeof plugins !== 'object') {
    return { installs: null, error: { code: 'EFORMAT', message: read.jsonError || 'No "plugins" object in installed_plugins.json.' } };
  }
  const installs = [];
  for (const [id, value] of Object.entries(plugins)) {
    // Version 2 keeps a list of installs per plugin; version 1 kept one.
    for (const install of Array.isArray(value) ? value : [value]) {
      if (!install || typeof install !== 'object' || typeof install.installPath !== 'string') continue;
      installs.push({
        id,
        name: id.split('@')[0],
        scope: typeof install.scope === 'string' ? install.scope : 'user',
        installPath: install.installPath,
        version: typeof install.version === 'string' ? install.version : null,
        projectPath: typeof install.projectPath === 'string' ? install.projectPath : null,
      });
    }
  }
  return { installs, error: null };
}

/** The install whose folder holds `absPath`, if any. */
export function installHolding(installs, absPath) {
  const key = samePathKey(absPath);
  return installs.find((i) => {
    const root = samePathKey(i.installPath);
    return key === root || key.startsWith(root + path.sep);
  });
}

/** enabledPlugins as merged, as a map; a list (an older form) names the enabled ones. */
function enabledMap(value) {
  if (Array.isArray(value)) return Object.fromEntries(value.filter((v) => typeof v === 'string').map((v) => [v, true]));
  return value && typeof value === 'object' ? value : {};
}

/**
 * Decides, per install, whether it loads for this lineage, marks the files of
 * those that do not, and returns the summary the lineage carries as `plugins`.
 * Null when the scan could not read installed_plugins.json.
 */
export async function annotatePlugins(lineage) {
  const level = lineage.levels.find((l) => l.kind === 'plugins');
  if (!level || !level.installs) return null;
  const settings = await flatten(lineage, 'settings');
  const enabled = enabledMap(settings.merged.enabledPlugins);
  const projectRoot = lineage.gitRoot?.dir || lineage.projectDir;

  const installs = level.installs.map((install) => {
    let reason = null;
    if (install.scope === 'local' || install.scope === 'project') {
      if (!install.projectPath || samePathKey(install.projectPath) !== samePathKey(projectRoot)) {
        reason = `Installed for ${install.projectPath || 'another project'} (${install.scope} scope), so it does not load here.`;
      }
    }
    if (!reason && enabled[install.id] !== true) {
      reason =
        enabled[install.id] === false
          ? 'Disabled: enabledPlugins sets it to false in the settings Claude Code reads here.'
          : 'Not enabled: no settings file Claude Code reads here sets it true in enabledPlugins, and Claude Code treats that as off.';
    }
    return { ...install, loaded: !reason, reason };
  });

  // Two installs can share a folder (the same version at two scopes): it loads
  // if either does.
  const loadedRoots = new Set(installs.filter((i) => i.loaded).map((i) => samePathKey(i.installPath)));
  for (const entry of level.entries) {
    const install = installHolding(installs, entry.absPath);
    if (!install) continue;
    entry.pluginId = install.id;
    entry.pluginName = install.name;
    if (loadedRoots.has(samePathKey(install.installPath))) continue;
    entry.inactive = true;
    entry.note = `Plugin ${install.id}: ${install.reason}`;
  }

  const off = installs.filter((i) => !i.loaded);
  if (!installs.length && !level.uninstalledVersions) {
    return { installs, uninstalledVersions: 0, rule: null };
  }
  const said =
    `${installs.length} installed, ${installs.length - off.length} loaded here` +
    (off.length ? `; not loaded: ${off.map((i) => i.id).join(', ')}` : '') +
    (level.uninstalledVersions ? `. ${level.uninstalledVersions} cached version(s) not installed are listed under other, not scanned.` : '.');
  level.note = level.note ? `${level.note} ${said}` : said;

  return {
    installs,
    uninstalledVersions: level.uninstalledVersions || 0,
    rule:
      'A plugin loads when the settings Claude Code reads here set it true in enabledPlugins (false or ' +
      'missing is off), and a local or project install only where the git root, or the folder outside a ' +
      'repository, is its projectPath. Only the installed version is read. Its definitions are named ' +
      'plugin:name and its MCP servers plugin:<plugin>:<server>.',
  };
}
