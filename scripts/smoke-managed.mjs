/**
 * Managed policy (#147) over the real HTTP API, on a server of its own: the
 * managed folder's CLAUDE.md, managed-mcp.json and managed-settings.d, the
 * server-managed cache, and the registry policy values, composed the way
 * Claude Code composes them.
 *
 * Its own server because the managed folder is fixed per process
 * (LAYERCAKE_MANAGED_DIR) and a managed-mcp.json takes over every MCP source,
 * which would change what the main run's MCP checks see.
 *
 * The registry values are real ones, read by the real reg.exe, under a key
 * this run makes in HKCU\Software (LayerCakeSmoke-<pid>-<random>, which is
 * all LAYERCAKE_POLICY_KEYS accepts) and deletes when it ends. HKLM cannot be
 * written without elevation, so the "HKLM" value is a second HKCU key the
 * server is told to read in its place. A killed run can leave the key behind;
 * it is read by nothing else.
 *
 * The sentences under test: the managed CLAUDE.md loads first; managed-mcp.json
 * shuts out every other MCP source; the drop-ins merge over
 * managed-settings.json in Claude Code's order; the highest admin source that
 * delivers a key is used alone unless it says "merge"; HKCU applies only when
 * no admin source does; the cache is shown, never merged; and a registry
 * value's content stays out of the scan.
 */

import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

import { projectConfigKey } from '../server/paths.js';

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

export async function runManagedChecks({ root, check, skip, smokeDir }) {
  const onWindows = process.platform === 'win32';
  const fx = path.join(smokeDir, 'managed');
  const managedDir = path.join(fx, 'ClaudeCode');
  const dropIns = path.join(managedDir, 'managed-settings.d');
  const configHome = path.join(fx, 'config-home');
  const fakeHome = path.join(fx, 'home');
  const proj = path.join(fx, 'proj');
  for (const d of [path.join(dropIns, 'sub'), configHome, fakeHome, proj, path.join(fx, 'programdata')]) {
    await fs.mkdir(d, { recursive: true });
  }
  const rand = crypto.randomBytes(4).toString('hex');
  const dropInSentinel = `SMOKE-DROPIN-${rand}`;
  const regSentinel = `SMOKE-REG-${rand}`;
  const json = (p, v) => fs.writeFile(p, JSON.stringify(v, null, 2));

  await fs.writeFile(path.join(managedDir, 'CLAUDE.md'), '# Managed policy instructions\nFrom the organisation.\n');
  await json(path.join(managedDir, 'managed-mcp.json'), { mcpServers: { 'corp-only': { command: 'corp-mcp' } } });
  await json(path.join(managedDir, 'managed-settings.json'), {
    model: 'base',
    availableModels: ['m1'],
    fallbackModel: ['x'],
    permissions: { deny: ['FromBase'] },
  });
  await json(path.join(dropIns, '10-a.json'), { model: 'ten', availableModels: ['m2'], fallbackModel: ['y'], permissions: { deny: ['From10'] } });
  await json(path.join(dropIns, '20-b.json'), { model: 'twenty', availableModels: ['m3'], permissions: { deny: ['From20'] }, env: { SMOKE_DROPIN: dropInSentinel } });
  // Code-unit order puts "B.json" before "a.json", locale order after it: the
  // last file to set model decides which order was used.
  await json(path.join(dropIns, 'B.json'), { model: 'upper-b' });
  await json(path.join(dropIns, 'a.json'), { model: 'lower-a' });
  // Not read by Claude Code: hidden, upper-case extension, not .json, a folder.
  await json(path.join(dropIns, '.hidden.json'), { hiddenRead: true });
  await json(path.join(dropIns, 'UPPER.JSON'), { upperRead: true });
  await fs.writeFile(path.join(dropIns, 'notes.txt'), 'not policy\n');
  await json(path.join(dropIns, 'sub', 'nested.json'), { nestedRead: true });
  // Deleted and restored below, then left as it was.
  await json(path.join(dropIns, '30-del.json'), { deleteMe: true });
  // The server-managed cache: shown, never merged.
  await json(path.join(configHome, 'remote-settings.json'), { remoteOnly: true });
  // modelPicker and extraKnownMarketplaces are the user's too, so the managed
  // value can be seen to replace them (whole, and entry by entry) rather than
  // merge into them, as Claude Code's merge customizer does in every tier.
  await json(path.join(configHome, 'settings.json'), {
    model: 'user',
    availableModels: ['u1'],
    claudeMd: 'ignored here',
    modelPicker: { options: ['user-pick'] },
    extraKnownMarketplaces: { corp: { source: { source: 'github', repo: 'user/fork' }, userOnly: true } },
  });
  // A local-scope server for the project, shut out by managed-mcp.json but
  // still named among what the file defines.
  await json(path.join(configHome, '.claude.json'), {
    projects: { [projectConfigKey(proj)]: { mcpServers: { 'local-shut-out': { command: 'local-mcp' } } } },
  });
  await json(path.join(proj, '.mcp.json'), { mcpServers: { 'project-server': { command: 'project-mcp' } } });

  // --- the registry, a key of this run's own ---------------------------------
  const keyRoot = `HKCU\\Software\\LayerCakeSmoke-${process.pid}-${rand}`;
  const keys = { hklm: `${keyRoot}\\HKLM`, hkcu: `${keyRoot}\\HKCU` };
  const reg = (...args) =>
    spawnSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe'), args, { windowsHide: true, encoding: 'utf8' });
  // Arguments go straight to reg.exe, never through a shell, so JSON quotes survive.
  const setValue = (which, value, type = 'REG_SZ') => {
    const r = reg('add', keys[which], '/v', 'Settings', '/t', type, '/d', typeof value === 'string' ? value : JSON.stringify(value), '/f');
    if (r.status !== 0) throw new Error(`reg add ${which} failed: ${r.stderr}`);
  };
  const dropValue = (which) => reg('delete', keys[which], '/v', 'Settings', '/f');

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
    PORT: String(port),
    CLAUDE_CONFIG_DIR: configHome,
    USERPROFILE: fakeHome,
    HOME: fakeHome,
    LAYERCAKE_MANAGED_DIR: managedDir,
    ProgramData: path.join(fx, 'programdata'),
    LAYERCAKE_POLICY_KEYS: JSON.stringify(keys),
    LAYERCAKE_SNAPSHOT_DIR: path.join(fx, 'snaps'),
    LAYERCAKE_APPDATA_DIR: path.join(fx, 'appdata'),
    LAYERCAKE_CLAUDE_DATA_DIR: path.join(fx, 'claude-data'),
    LAYERCAKE_LAUNCH_DRY_RUN: '1',
  };
  if (onWindows) {
    setValue('hklm', {
      model: 'hklm',
      env: { SMOKE_REG: regSentinel },
      permissions: { deny: ['FromHKLM'] },
      modelPicker: { options: ['corp-pick'] },
      extraKnownMarketplaces: { corp: { source: { source: 'github', repo: 'corp/plugins' } } },
    });
    setValue('hkcu', { model: 'hkcu', hkcuOnly: true });
  }
  const server = spawn(process.execPath, [path.join(root, 'server', 'index.js')], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let serverOut = '';
  server.stdout.setEncoding('utf8').on('data', (c) => (serverOut += c));
  server.stderr.setEncoding('utf8').on('data', (c) => (serverOut += c));

  try {
    let html = null;
    for (const until = Date.now() + 20000; Date.now() < until && !html; ) {
      html = await fetch(`${base}/`).then((r) => (r.ok ? r.text() : null), () => null);
      if (!html) await new Promise((r) => setTimeout(r, 200));
    }
    // The page key (#189) is in the address the server prints, never in its HTML.
    for (let i = 0; i < 100 && !/#t=[0-9a-f]{64}/.test(serverOut); i += 1) await new Promise((r) => setTimeout(r, 50));
    const token = /#t=([0-9a-f]{64})/.exec(serverOut)?.[1];
    check('managed policy: its own server comes up (#147)', Boolean(html && token), serverOut.slice(-2000));
    if (!token) return;
    const H = { 'X-LayerCake-Token': token, 'Content-Type': 'application/json' };
    const scanRaw = async () => {
      const res = await fetch(`${base}/api/scan`, { method: 'POST', headers: H, body: JSON.stringify({ dir: proj }) });
      return res.text();
    };
    const flat = async (scanId, kind) => (await fetch(`${base}/api/flatten?scanId=${scanId}&kind=${kind}`, { headers: H })).json();
    const settingsNow = async () => {
      const raw = await scanRaw();
      const lineage = JSON.parse(raw);
      return { raw, lineage, settings: await flat(lineage.scanId, 'settings') };
    };
    const post = async (pathname, body) => {
      const res = await fetch(`${base}${pathname}`, { method: 'POST', headers: H, body: JSON.stringify(body) });
      return { status: res.status, json: await res.json().catch(() => null) };
    };
    const exists = (p) => fs.access(p).then(() => true, () => false);

    // --- the scan -------------------------------------------------------------
    const raw = await scanRaw();
    const lineage = JSON.parse(raw);
    const managed = lineage.levels.find((l) => l.kind === 'managed');
    const entry = (p) => managed.entries.find((e) => same(e.absPath, p));
    const manifest = await (await fetch(`${base}/api/manifest`, { headers: H })).json();

    check('managed policy: the manifest names this platform\'s managed folder files, drop-in folder and cache (#147)',
      manifest.managedFolder?.some((t) => same(t.file, path.join(managedDir, 'CLAUDE.md')) && t.category === 'memory') &&
        manifest.managedFolder?.some((t) => same(t.file, path.join(managedDir, 'managed-mcp.json')) && t.category === 'mcp') &&
        same(manifest.managedDropInDir || '.', dropIns) && same(manifest.remoteSettingsFile || '.', path.join(configHome, 'remote-settings.json')),
      JSON.stringify({ f: manifest.managedFolder, d: manifest.managedDropInDir, r: manifest.remoteSettingsFile }));
    check('managed policy: the managed CLAUDE.md and managed-mcp.json are found, as instructions and MCP (#147)',
      entry(path.join(managedDir, 'CLAUDE.md'))?.category === 'memory' && entry(path.join(managedDir, 'managed-mcp.json'))?.category === 'mcp',
      JSON.stringify(managed.entries.map((e) => [e.name, e.category])));
    const dropInNames = managed.entries.filter((e) => same(path.dirname(e.absPath), dropIns)).map((e) => e.name).sort();
    check('managed policy: the drop-ins Claude Code reads are listed as settings, and only those (#147)',
      JSON.stringify(dropInNames) === JSON.stringify(['10-a.json', '20-b.json', '30-del.json', 'B.json', 'a.json'].sort()) &&
        managed.entries.filter((e) => same(path.dirname(e.absPath), dropIns)).every((e) => e.category === 'settings'),
      JSON.stringify(dropInNames));
    const otherNames = (managed.other || []).map((o) => path.basename(o.absPath)).sort();
    check('managed policy: a hidden, upper-case, non-JSON or nested file there is listed as not read (#147)',
      ['.hidden.json', 'UPPER.JSON', 'notes.txt', 'sub'].every((n) => otherNames.includes(n)) &&
        (managed.other || []).every((o) => /Not read by Claude Code/.test(o.note || '')),
      JSON.stringify(otherNames));
    check('managed policy: the server-managed cache is found in its own category, not an editable one, and flagged sensitive (#147)',
      entry(path.join(configHome, 'remote-settings.json'))?.category === 'remote-settings' &&
        entry(path.join(configHome, 'remote-settings.json'))?.sensitive === true &&
        Array.isArray(manifest.write?.editableCategories) && manifest.write.editableCategories.includes('settings') &&
        !manifest.write.editableCategories.includes('remote-settings'),
      JSON.stringify(entry(path.join(configHome, 'remote-settings.json'))));
    check('managed policy: the scan carries no drop-in or registry content (#147)',
      !raw.includes(dropInSentinel) && !raw.includes(regSentinel),
      `drop-in: ${raw.includes(dropInSentinel)}, registry: ${raw.includes(regSentinel)}`);

    // --- instructions and MCP ------------------------------------------------
    const chain = await flat(lineage.scanId, 'claude-md');
    const firstFile = chain.sections.flatMap((s) => s.files)[0];
    check('managed policy: the managed CLAUDE.md is the first instruction file loaded (#147)',
      firstFile && same(firstFile.path, path.join(managedDir, 'CLAUDE.md')) && /From the organisation/.test(firstFile.content),
      JSON.stringify(firstFile?.path));
    const mcp = await flat(lineage.scanId, 'mcp');
    const projSource = mcp.sources.find((s) => same(s.path, path.join(proj, '.mcp.json')));
    const homeSource = mcp.sources.find((s) => same(s.path, path.join(configHome, '.claude.json')));
    check('managed policy: managed-mcp.json shuts out every other MCP source (#147)',
      JSON.stringify(mcp.servers.map((s) => s.name)) === JSON.stringify(['corp-only']) &&
        /managed-mcp\.json/.test(projSource?.notRead || '') && projSource?.blocked === true && projSource?.serverNames?.includes('project-server') &&
        mcp.sources.find((s) => same(s.path, path.join(managedDir, 'managed-mcp.json')))?.exclusive === true,
      JSON.stringify({ servers: mcp.servers.map((s) => s.name), proj: projSource }));
    check('managed policy: a shut-out ~/.claude.json still names the project\'s local-scope servers (#147)',
      homeSource?.blocked === true && homeSource.serverNames.includes('local-shut-out'), JSON.stringify(homeSource));

    // A deleted drop-in comes back from its undo, after a rescan no longer lists it.
    const delPath = path.join(dropIns, '30-del.json');
    const delBytes = await fs.readFile(delPath);
    const del = await post('/api/delete', { scanId: lineage.scanId, path: delPath, expectedMtime: entry(delPath)?.mtime });
    const afterDel = JSON.parse(await scanRaw());
    const back = await post('/api/restore', { scanId: afterDel.scanId, id: del.json?.undoSnapshotId, paths: [delPath] });
    check('managed policy: a deleted drop-in can be restored from its undo (#147, #97)',
      del.status === 200 && back.status === 200 && back.json?.created?.length === 1 &&
        (await exists(delPath)) && (await fs.readFile(delPath)).equals(delBytes),
      JSON.stringify({ del, back }));

    // --- the settings view: the files, and the cache ---------------------------
    const noCacheOrStray = (merged) =>
      !('remoteOnly' in merged) && !('hiddenRead' in merged) && !('upperRead' in merged) && !('nestedRead' in merged);
    const writeTo = async (lin, target, content) => {
      const res = await fetch(`${base}/api/write`, { method: 'POST', headers: H, body: JSON.stringify({ scanId: lin.scanId, path: target, content }) });
      return { status: res.status, json: await res.json().catch(() => null) };
    };
    const arrayDropIn = await writeTo(lineage, path.join(dropIns, '10-a.json'), '[]');
    const arrayMcp = await writeTo(lineage, path.join(managedDir, 'managed-mcp.json'), '[]');
    check('managed policy: a drop-in or managed-mcp.json whose top level is not an object is refused (#147)',
      arrayDropIn.status === 400 && arrayDropIn.json?.code === 'EBADJSON' && arrayMcp.status === 400 && arrayMcp.json?.code === 'EBADJSON',
      JSON.stringify({ arrayDropIn, arrayMcp }));
    const cacheWrite = await writeTo(lineage, path.join(configHome, 'remote-settings.json'), '{}');
    check('managed policy: the server-managed cache cannot be edited (#147)',
      cacheWrite.status === 403 && cacheWrite.json?.code === 'ENOTEDITABLE', JSON.stringify(cacheWrite));

    if (!onWindows) {
      // No registry: the files are the only managed source.
      const { settings } = await settingsNow();
      check('managed policy: the drop-ins merge over managed-settings.json in code-unit name order (#147)',
        settings.merged.model === 'lower-a' && JSON.stringify(settings.merged.permissions?.deny) === JSON.stringify(['FromBase', 'From10', 'From20']),
        JSON.stringify(settings.merged));
      check('managed policy: the cache and unread drop-ins are never merged (#147)', noCacheOrStray(settings.merged), JSON.stringify(settings.merged));
      skip('managed policy: the registry sources and how the managed tier composes them', 'Windows only');
      return;
    }

    // --- 1. first-wins, HKLM delivers: it is used alone -----------------------
    let { lineage: lin, settings } = await settingsNow();
    const policies = lin.levels.find((l) => l.kind === 'managed').policies;
    const bySource = (s, id) => s.managed.sources.find((x) => x.id === id);
    check('managed policy: both registry values are read with reg.exe, as REG_SZ (#147)',
      policies.find((p) => p.id === 'hklm')?.state === 'set' && policies.find((p) => p.id === 'hklm')?.type === 'REG_SZ' &&
        policies.find((p) => p.id === 'hklm')?.topLevelKeys === 5 && policies.find((p) => p.id === 'hkcu')?.state === 'set' &&
        same(policies.find((p) => p.id === 'hklm')?.key, keys.hklm),
      JSON.stringify(policies));
    check('managed policy: first-wins uses the HKLM value alone over the managed files and HKCU (#147)',
      settings.merged.model === 'hklm' && settings.merged.env?.SMOKE_REG === regSentinel &&
        !settings.merged.env?.SMOKE_DROPIN && !('hkcuOnly' in settings.merged) &&
        bySource(settings, 'hklm')?.applied && !bySource(settings, 'file')?.applied && /Skipped/.test(bySource(settings, 'file')?.reason) &&
        !bySource(settings, 'hkcu')?.applied && settings.managed.behavior === 'first-wins',
      JSON.stringify({ merged: settings.merged, managed: settings.managed }));
    check('managed policy: modelPicker is taken whole and a marketplace entry replaced whole over the user\'s, as Claude Code merges them (#147)',
      JSON.stringify(settings.merged.modelPicker) === JSON.stringify({ options: ['corp-pick'] }) &&
        JSON.stringify(settings.merged.extraKnownMarketplaces) === JSON.stringify({ corp: { source: { source: 'github', repo: 'corp/plugins' } } }),
      JSON.stringify({ modelPicker: settings.merged.modelPicker, ekm: settings.merged.extraKnownMarketplaces }));
    check('managed policy: provenance names the registry value that supplied a key (#147)',
      same(settings.provenance.find((r) => r.keyPath === 'model')?.sources[0]?.file || '.', `${keys.hklm}\\Settings`),
      JSON.stringify(settings.provenance.find((r) => r.keyPath === 'model')));
    check('managed policy: the cache and unread drop-ins are never merged (#147)', noCacheOrStray(settings.merged), JSON.stringify(settings.merged));
    check('managed policy: claudeMd in user settings is listed as ignored, not merged (#147)',
      !('claudeMd' in settings.merged) && settings.ignored.some((r) => r.keyPath === 'claudeMd' && r.source === 'user'),
      JSON.stringify(settings.ignored));
    check('managed policy: the settings view says whether server-managed settings were cached (#147)',
      settings.managed.remoteCache?.present === true &&
        settings.sections.flatMap((s) => s.files).some((f) => same(f.path, path.join(configHome, 'remote-settings.json')) && /Server-managed/.test(f.notRead || '')),
      JSON.stringify(settings.managed.remoteCache));

    // The CLI says the same, from the same modules.
    const cli = spawnSync(process.execPath, [path.join(root, 'cli', 'index.js'), 'here', proj], { env, encoding: 'utf8', windowsHide: true });
    // The line wraps at the terminal's width, so it is read as one.
    const said = cli.stdout.replace(/\s+/g, ' ');
    check('managed policy: layercake here names the managed source that applies and the ones skipped (#147)',
      /managed policy: HKLM registry \(first-wins\); skipped: managed settings files, HKCU registry/.test(said) &&
        /server-managed settings cached/.test(said),
      cli.stdout.slice(-800) + cli.stderr);

    // --- 2. no HKLM: the files apply, merged in Claude Code's order -----------
    dropValue('hklm');
    ({ settings } = await settingsNow());
    const avail = settings.provenance.find((r) => r.keyPath === 'availableModels');
    check('managed policy: the drop-ins merge over managed-settings.json in code-unit name order (#147)',
      settings.merged.model === 'lower-a' && JSON.stringify(settings.merged.permissions?.deny) === JSON.stringify(['FromBase', 'From10', 'From20']) &&
        JSON.stringify(settings.merged.fallbackModel) === JSON.stringify(['y']) && settings.merged.env?.SMOKE_DROPIN === dropInSentinel,
      JSON.stringify(settings.merged));
    check('managed policy: a managed availableModels replaces the user\'s, then the drop-ins add to it (#147)',
      JSON.stringify(settings.merged.availableModels) === JSON.stringify(['m1', 'm2', 'm3']) &&
        avail?.mode === 'replace+concat' && avail.sources.length === 3,
      JSON.stringify(avail));
    check('managed policy: HKCU is skipped while an admin source delivers (#147)',
      !('hkcuOnly' in settings.merged) && /no admin source/.test(bySource(settings, 'hkcu')?.reason || ''),
      JSON.stringify(bySource(settings, 'hkcu')));

    // --- 3. no admin source and no managed file at all: HKCU applies ----------
    // The whole managed folder and the cache moved away, so the level's only
    // policy is a registry value: it must still read as found, not empty.
    const cacheFile = path.join(configHome, 'remote-settings.json');
    await fs.rename(managedDir, `${managedDir}.away`);
    await fs.rename(cacheFile, `${cacheFile}.away`);
    ({ lineage: lin, settings } = await settingsNow());
    await fs.rename(`${managedDir}.away`, managedDir);
    await fs.rename(`${cacheFile}.away`, cacheFile);
    const bare = lin.levels.find((l) => l.kind === 'managed');
    check('managed policy: with no admin source, the HKCU value applies (#147)',
      settings.merged.model === 'hkcu' && settings.merged.hkcuOnly === true && bySource(settings, 'hkcu')?.applied,
      JSON.stringify({ merged: settings.merged, managed: settings.managed }));
    check('managed policy: a managed level whose only policy is a registry value reads as found (#147)',
      bare.entries.length === 0 && bare.status === 'found', JSON.stringify({ status: bare.status, entries: bare.entries.length }));

    // --- 4. merge, said in the highest source: every admin source applies ------
    setValue('hklm', { managedSourcesBehavior: 'merge', model: 'hklm-merge', permissions: { deny: ['FromHKLM'] } });
    ({ settings } = await settingsNow());
    check('managed policy: managedSourcesBehavior "merge" in HKLM applies the files beneath it too, and never HKCU (#147)',
      settings.managed.behavior === 'merge' && settings.managed.behaviorFrom === 'HKLM registry' && settings.merged.model === 'hklm-merge' &&
        JSON.stringify(settings.merged.permissions?.deny) === JSON.stringify(['FromBase', 'From10', 'From20', 'FromHKLM']) &&
        !('hkcuOnly' in settings.merged) && /never takes part/.test(bySource(settings, 'hkcu')?.reason || ''),
      JSON.stringify({ merged: settings.merged, managed: settings.managed }));

    // --- 5. values Claude Code takes nothing from ------------------------------
    setValue('hklm', '1', 'REG_DWORD');
    // The parser's message quotes the text it could not parse, a value of up
    // to about 20 characters whole (measured on Node 24), so this one is
    // short: the sentinel must reach the settings view and never the scan.
    const badSentinel = `nj-${rand}`;
    setValue('hkcu', `${badSentinel}-café`);
    let raw5;
    ({ raw: raw5, lineage: lin, settings } = await settingsNow());
    const bad = lin.levels.find((l) => l.kind === 'managed').policies;
    const hkcuRow = settings.sections.flatMap((s) => s.files).find((f) => f.registry === 'hkcu');
    check('managed policy: a REG_DWORD value is said and delivers nothing, so the files apply (#147)',
      /REG_DWORD/.test(bad.find((p) => p.id === 'hklm')?.note || '') && settings.merged.model === 'lower-a',
      JSON.stringify(bad.find((p) => p.id === 'hklm')));
    check('managed policy: an HKCU value that is not JSON is shown as written, with the parser\'s words, and applies nothing (#147)',
      Boolean(bad.find((p) => p.id === 'hkcu')?.jsonError) && (hkcuRow?.content || '').startsWith(`${badSentinel}-caf`) &&
        hkcuRow?.jsonError?.includes(badSentinel) && hkcuRow?.managed?.applied === false && !('hkcuOnly' in settings.merged),
      JSON.stringify(hkcuRow));
    check('managed policy: the scan carries no text of a value that does not parse (#147)', !raw5.includes(badSentinel),
      JSON.stringify(bad.find((p) => p.id === 'hkcu')));
    check('managed policy: a value with characters outside ASCII says reg.exe may have lost them (#147)',
      /ASCII/.test(bad.find((p) => p.id === 'hkcu')?.note || ''), JSON.stringify(bad.find((p) => p.id === 'hkcu')));

    // --- 6. what Claude Code counts as present ---------------------------------
    // HKLM with only the meta keys is passed over: the files apply.
    setValue('hklm', { wslInheritsWindowsSettings: true, managedSourcesBehavior: 'first-wins' });
    setValue('hkcu', { model: 'hkcu', hkcuOnly: true });
    ({ settings } = await settingsNow());
    check('managed policy: an HKLM value holding only managedSourcesBehavior or wslInheritsWindowsSettings is passed over (#147)',
      settings.merged.model === 'lower-a' && bySource(settings, 'file')?.applied && !bySource(settings, 'hklm')?.applied &&
        /no policy key/.test(bySource(settings, 'hklm')?.reason || ''),
      JSON.stringify({ merged: settings.merged, managed: settings.managed }));
    // An HKLM that does not parse, and no managed file: fatal, and HKCU stays unread.
    setValue('hklm', '{"model": "typo",');
    await fs.rename(managedDir, `${managedDir}.away`);
    let cli6;
    try {
      ({ settings } = await settingsNow());
      cli6 = spawnSync(process.execPath, [path.join(root, 'cli', 'index.js'), 'here', proj], { env, encoding: 'utf8', windowsHide: true });
    } finally {
      await fs.rename(`${managedDir}.away`, managedDir);
    }
    check('managed policy: an admin value that does not parse is reported fatal, and keeps HKCU unread (#147)',
      settings.managed.fatal?.length === 1 && same(settings.managed.fatal[0].path, `${keys.hklm}\\Settings`) &&
        !('hkcuOnly' in settings.merged) && !bySource(settings, 'hkcu')?.applied && /admin source is present/.test(bySource(settings, 'hkcu')?.reason || ''),
      JSON.stringify({ merged: settings.merged, managed: settings.managed }));
    check('managed policy: layercake here says an admin document does not parse (#147)',
      /managed policy does not parse, which Claude Code treats as fatal/.test(cli6.stdout.replace(/\s+/g, ' ')), cli6.stdout.slice(-800));
    // A drop-in with a typo is fatal too, and the CLI still counts it as unreadable.
    dropValue('hklm');
    const typo = path.join(dropIns, '40-typo.json');
    await fs.writeFile(typo, '{ "model": ');
    let cli7;
    try {
      ({ settings } = await settingsNow());
      cli7 = spawnSync(process.execPath, [path.join(root, 'cli', 'index.js'), 'here', proj], { env, encoding: 'utf8', windowsHide: true });
    } finally {
      await fs.rm(typo, { force: true });
    }
    const typoRow = settings.sections.flatMap((s) => s.files).find((f) => same(f.path, typo));
    check('managed policy: a drop-in that does not parse is reported fatal and not applied, while the other files apply (#147)',
      settings.managed.fatal?.some((f) => same(f.path, typo)) && typoRow?.managed?.applied === false && settings.merged.model === 'lower-a',
      JSON.stringify({ fatal: settings.managed.fatal, typoRow: typoRow?.managed }));
    check('managed policy: layercake here counts a managed file that does not parse as unreadable (#147)',
      /1 unreadable/.test(cli7.stdout.replace(/\s+/g, ' ')), cli7.stdout.slice(-800));
  } finally {
    server.kill();
    if (onWindows) {
      const r = reg('delete', keyRoot, '/f');
      check('managed policy: the run\'s registry key is removed', r.status === 0 && reg('query', keyRoot).status !== 0, r.stderr);
    }
  }
}

/**
 * In-process, with the smoke process's own environment changed and put back:
 * the default managed folder is Claude Code's fixed path whatever
 * %ProgramFiles% says, and the smoke-only key override refuses any key
 * outside HKCU\Software\LayerCakeSmoke rather than reading it (#147).
 */
export async function runManagedDefaultsChecks({ check, skip }) {
  const saved = { pf: process.env.ProgramFiles, dir: process.env.LAYERCAKE_MANAGED_DIR, keys: process.env.LAYERCAKE_POLICY_KEYS };
  const put = (name, value) => (value === undefined ? delete process.env[name] : (process.env[name] = value));
  try {
    process.env.ProgramFiles = 'D:\\Somewhere Else';
    delete process.env.LAYERCAKE_MANAGED_DIR;
    const { managedCandidates, managedDir } = await import('../server/paths.js');
    const current = managedCandidates().find((c) => c.platform === 'win32' && !c.legacy);
    check('managed policy: the Windows managed folder is C:\\Program Files\\ClaudeCode, not %ProgramFiles% (#147)',
      managedDir('win32') === 'C:\\Program Files\\ClaudeCode' && current?.file === 'C:\\Program Files\\ClaudeCode\\managed-settings.json',
      JSON.stringify({ dir: managedDir('win32'), current }));
    if (process.platform !== 'win32') {
      skip('managed policy: the key override refuses a key outside HKCU\\Software\\LayerCakeSmoke', 'Windows only');
      return;
    }
    process.env.LAYERCAKE_POLICY_KEYS = JSON.stringify({ hklm: 'HKLM\\SOFTWARE\\Policies\\ClaudeCode', hkcu: 'HKCU\\Software\\LayerCakeSmoke-x\\HKCU' });
    const { readRegistryPolicy } = await import('../server/policy.js');
    const records = await readRegistryPolicy();
    check('managed policy: the key override refuses a key outside HKCU\\Software\\LayerCakeSmoke, reading neither (#147)',
      records.length === 2 && records.every((r) => r.state === 'error' && r.error?.code === 'EBADKEY'),
      JSON.stringify(records));
  } finally {
    put('ProgramFiles', saved.pf);
    put('LAYERCAKE_MANAGED_DIR', saved.dir);
    put('LAYERCAKE_POLICY_KEYS', saved.keys);
  }
}

/** A new drop-in raises a change event: the drop-in folder is an open tree (#147). In-process, like #65's. */
export async function runManagedWatchCheck({ check, smokeDir }) {
  const dropIns = path.join(smokeDir, 'managed-watch', 'ClaudeCode', 'managed-settings.d');
  await fs.mkdir(dropIns, { recursive: true });
  await fs.writeFile(path.join(dropIns, '10-a.json'), '{}');
  const saved = process.env.LAYERCAKE_MANAGED_DIR;
  process.env.LAYERCAKE_MANAGED_DIR = path.dirname(dropIns);
  const { watchLineage } = await import('../server/watch.js');
  const lin = {
    levels: [{ kind: 'managed', dir: null, entries: [{ absPath: path.join(dropIns, '10-a.json'), type: 'file', category: 'settings' }], absent: [], errors: [] }],
    networkDrives: [],
  };
  const seen = [];
  const w = watchLineage(lin, (batch) => seen.push(...batch));
  try {
    await new Promise((r) => setTimeout(r, 300));
    await fs.writeFile(path.join(dropIns, '30-new.json'), '{}');
    for (const until = Date.now() + 5000; Date.now() < until && !seen.some((c) => c.name === '30-new.json'); ) {
      await new Promise((r) => setTimeout(r, 100));
    }
    check('managed policy: a new drop-in raises a change event (#147)', seen.some((c) => c.name === '30-new.json'),
      JSON.stringify(seen.map((c) => c.name)));
  } finally {
    w.close();
    if (saved === undefined) delete process.env.LAYERCAKE_MANAGED_DIR;
    else process.env.LAYERCAKE_MANAGED_DIR = saved;
  }
}
