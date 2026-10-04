/**
 * Create and delete (#15), and restoring a file that is gone from disk (#92),
 * over the real HTTP API against a project of their own, so nothing the other
 * checks look at changes under them. The one user-level file made here is
 * deleted again before the block ends.
 *
 * The sentences under test: a new file lands only where the scan offered, from
 * a template, never over an existing one; a delete can always be undone,
 * because it is refused unless the snapshot taken first holds the file; and
 * that undo works after a rescan no longer lists the file.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { TEMP_PREFIX, projectSlug } from '../server/paths.js';

const exists = (p) => fs.access(p).then(() => true, () => false);

export async function runCreateChecks({ base, token, check, skip, smokeDir, configHome, snaps, fakeHome }) {
  const H = { 'X-LayerCake-Token': token, 'Content-Type': 'application/json' };
  const get = async (pathname) => {
    const res = await fetch(`${base}${pathname}`, { headers: H });
    return { status: res.status, text: await res.text() };
  };
  const post = async (pathname, body) => {
    const res = await fetch(`${base}${pathname}`, { method: 'POST', headers: H, body: JSON.stringify(body) });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* a non-JSON answer fails whichever check reads it */
    }
    return { status: res.status, json };
  };
  const scan = async (dir) => (await post('/api/scan', { dir })).json;
  const entriesOf = (lineage) => lineage.levels.flatMap((l) => l.entries);
  const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

  const proj = path.join(smokeDir, 'create', 'proj');
  const other = path.join(smokeDir, 'create', 'other');
  await fs.mkdir(proj, { recursive: true });
  await fs.mkdir(other, { recursive: true });
  await fs.writeFile(path.join(proj, 'CLAUDE.md'), '# already here\n');
  const agents = path.join(proj, '.claude', 'agents');

  let lin = await scan(proj);
  const projLevel = lin.levels.find((l) => l.kind === 'directory' && same(l.dir, proj));
  const userLevel = lin.levels.find((l) => l.kind === 'user');
  const managedLevel = lin.levels.find((l) => l.kind === 'managed');
  const kindOf = new Map(lin.levels.map((l) => [l.id, l.kind]));
  // Level ids are per scan, so an option is found through its level in THAT scan.
  const levelIn = (lineage, which) =>
    which === 'user' ? lineage.levels.find((l) => l.kind === 'user') : lineage.levels.find((l) => l.kind === 'directory' && same(l.dir, proj));
  const option = (lineage, which, suffix) =>
    lineage.creatable.find((o) => o.levelId === levelIn(lineage, which)?.id && o.id.endsWith(suffix));

  check('create is offered only at user and directory levels',
    lin.creatable.length > 0 && lin.creatable.every((o) => ['user', 'directory'].includes(kindOf.get(o.levelId))) &&
      lin.creatable.some((o) => o.levelId === userLevel.id) && lin.creatable.some((o) => o.levelId === projLevel.id),
    JSON.stringify([...new Set(lin.creatable.map((o) => kindOf.get(o.levelId)))]));
  check('a fixed file that already exists is not offered; one that does not is',
    !lin.creatable.some((o) => o.absPath && same(o.absPath, path.join(proj, 'CLAUDE.md'))) &&
      Boolean(option(lin, 'proj', ':file:claude/settings.json')));

  // --- a new agent, from its template, where the scan offered it ------------
  const agentOpt = option(lin, 'proj', ':tree:agents');
  const made = await post('/api/create', { scanId: lin.scanId, createId: agentOpt?.id, name: 'smoke-agent' });
  const agentPath = path.join(agents, 'smoke-agent.md');
  const agentBody = await fs.readFile(agentPath, 'utf8').catch(() => '');
  check('create makes an agent from its template in the level\'s .claude/agents',
    made.status === 200 && same(made.json.absPath, agentPath) && /^---\nname: smoke-agent\n/.test(agentBody),
    `${made.status} ${JSON.stringify(made.json)}`);
  lin = await scan(proj);
  check('the next scan lists the new file as an agent at that level',
    lin.levels.find((l) => same(l.dir || '', proj))?.entries.some((e) => same(e.absPath, agentPath) && e.category === 'agent'));

  // --- names that must never become a path ------------------------------------
  const bad = ['../escape', 'a/b', 'a\\b', 'CON', 'nul', 'lpt1', 'Upper', '', '.hidden', '-x', 'x'.repeat(65), 'a.md'];
  const answers = [];
  for (const name of bad) {
    answers.push((await post('/api/create', { scanId: lin.scanId, createId: option(lin, 'proj', ':tree:agents').id, name })).status);
  }
  const listed = (await fs.readdir(agents)).sort();
  check('create refuses every name that is not one plain segment, and makes nothing',
    answers.every((s) => s === 400) && JSON.stringify(listed) === JSON.stringify(['smoke-agent.md']) &&
      !(await exists(path.join(proj, '.claude', 'escape.md'))) && !(await exists(path.join(agents, 'a'))),
    `${answers.join(',')} ${JSON.stringify(listed)}`);

  const forged = await post('/api/create', { scanId: lin.scanId, createId: `${managedLevel.id}:tree:agents`, name: 'x' });
  check('create refuses an option the scan did not offer (a managed level)', forged.status === 403, `${forged.status}`);

  // --- never over an existing file ------------------------------------------
  await fs.writeFile(agentPath, 'MARKER: written after the create\n');
  const again = await post('/api/create', { scanId: lin.scanId, createId: option(lin, 'proj', ':tree:agents').id, name: 'smoke-agent' });
  check('create never replaces an existing file',
    again.status === 409 && (await fs.readFile(agentPath, 'utf8')) === 'MARKER: written after the create\n',
    `${again.status}`);

  // --- hooks need the acknowledgement; only known extensions --------------
  const hookOpt = option(lin, 'proj', ':tree:hooks');
  const hookPath = path.join(proj, '.claude', 'hooks', 'smoke-hook.sh');
  const noAck = await post('/api/create', { scanId: lin.scanId, createId: hookOpt.id, name: 'smoke-hook', ext: '.sh' });
  const badExt = await post('/api/create', { scanId: lin.scanId, createId: hookOpt.id, name: 'smoke-hook', ext: '.exe', acknowledgeExecutable: true });
  check('a new hook needs the executable acknowledgement, and an unknown extension is refused',
    noAck.status === 403 && noAck.json?.code === 'EEXECUTABLE' && badExt.status === 400 && !(await exists(hookPath)),
    `${noAck.status} ${badExt.status}`);
  const withAck = await post('/api/create', { scanId: lin.scanId, createId: hookOpt.id, name: 'smoke-hook', ext: '.sh', acknowledgeExecutable: true });
  check('with the acknowledgement the hook is created', withAck.status === 200 && (await exists(hookPath)), `${withAck.status}`);

  const skill = await post('/api/create', { scanId: lin.scanId, createId: option(lin, 'proj', ':tree:skills').id, name: 'smoke-skill' });
  check('a new skill is a folder holding SKILL.md',
    skill.status === 200 && (await exists(path.join(proj, '.claude', 'skills', 'smoke-skill', 'SKILL.md'))), `${skill.status}`);

  const settings = await post('/api/create', { scanId: lin.scanId, createId: option(lin, 'proj', ':file:claude/settings.json').id });
  let parsed = null;
  try {
    parsed = JSON.parse(await fs.readFile(path.join(proj, '.claude', 'settings.json'), 'utf8'));
  } catch {
    /* stays null */
  }
  check('a fixed file is created from its template and parses', settings.status === 200 && parsed && typeof parsed === 'object', `${settings.status}`);

  const userAgent = path.join(configHome, 'agents', 'smoke-user-agent.md');
  const userMade = await post('/api/create', { scanId: lin.scanId, createId: option(lin, 'user', ':tree:agents').id, name: 'smoke-user-agent' });
  check('a user-level create lands in the configuration home itself', userMade.status === 200 && (await exists(userAgent)), `${userMade.status}`);

  // --- delete: snapshot first, and only if the snapshot holds the file ------
  lin = await scan(proj);
  const entry = (p) => entriesOf(lin).find((e) => same(e.absPath, p));
  const before = await fs.readFile(agentPath);
  const stale = await post('/api/delete', { scanId: lin.scanId, path: agentPath, expectedMtime: '2000-01-01T00:00:00.000Z' });
  check('a delete against a stale view of the file is refused, and the file stays',
    stale.status === 409 && (await exists(agentPath)), `${stale.status}`);
  const del = await post('/api/delete', { scanId: lin.scanId, path: agentPath, expectedMtime: entry(agentPath)?.mtime });
  check('delete removes a scanned file and names its undo snapshot',
    del.status === 200 && !(await exists(agentPath)) && Boolean(del.json?.undoSnapshotId), `${del.status} ${JSON.stringify(del.json)}`);

  const notScanned = path.join(agents, 'after-the-scan.md');
  await fs.writeFile(notScanned, 'x\n');
  const outside = await post('/api/delete', { scanId: lin.scanId, path: notScanned });
  check('delete refuses a file the scan did not find', outside.status === 403 && (await exists(notScanned)), `${outside.status}`);

  // Over the snapshot's size cap: the snapshot skips it, so a delete would
  // have no way back and must be refused.
  const big = path.join(proj, '.claude', 'rules', 'big.md');
  await fs.mkdir(path.dirname(big), { recursive: true });
  await fs.writeFile(big, '# small, when the snapshot is taken\n');
  lin = await scan(proj);
  const smallSnap = await post('/api/snapshot', { scanId: lin.scanId, label: 'big.md while small' });
  const BIG = 2 * 1024 * 1024 + 1;
  await fs.writeFile(big, Buffer.alloc(BIG, 0x61));
  lin = await scan(proj);
  // Snapshot folders in the store, to show a refusal takes none (#139).
  const snapFolders = async () => (await fs.readdir(snaps)).length;
  const foldersBeforeBigDel = await snapFolders();
  const bigDel = await post('/api/delete', { scanId: lin.scanId, path: big, expectedMtime: entriesOf(lin).find((e) => same(e.absPath, big))?.mtime });
  check('delete is refused when the snapshot could not hold the file, which stays',
    bigDel.status === 409 && bigDel.json?.code === 'ENOBACKUP' && (await exists(big)), `${bigDel.status} ${bigDel.json?.code}`);
  check('a delete refused for the size cap takes no snapshot first (#139)',
    (await snapFolders()) === foldersBeforeBigDel, `${foldersBeforeBigDel} -> ${await snapFolders()}`);

  // #96: the same holds for a restore or a save over it. Each used to replace
  // the file although its undo snapshot had skipped it, leaving no copy.
  const bigRestore = await post('/api/restore', { scanId: lin.scanId, id: smallSnap.json?.id, paths: [big] });
  const bigSize = async () => (await fs.stat(big)).size;
  check('a restore over a file the undo snapshot cannot hold is refused for that file, which stays',
    bigRestore.status === 200 && bigRestore.json?.failed?.[0]?.code === 'ENOBACKUP' && (await bigSize()) === BIG,
    `${bigRestore.status} ${JSON.stringify(bigRestore.json?.failed)} size ${await bigSize()}`);
  const foldersBeforeBigWrite = await snapFolders();
  const bigWrite = await post('/api/write', { scanId: lin.scanId, path: big, content: 'x' });
  check('a save over a file the undo snapshot cannot hold is refused, and it stays',
    bigWrite.status === 409 && bigWrite.json?.code === 'ENOBACKUP' && (await bigSize()) === BIG, `${bigWrite.status} ${bigWrite.json?.code}`);
  check('a save refused for the size cap takes no snapshot first (#139)',
    (await snapFolders()) === foldersBeforeBigWrite, `${foldersBeforeBigWrite} -> ${await snapFolders()}`);

  // #141: a read-only file is refused by delete, save and restore alike, with
  // a readable reason, and a refused delete or save takes no snapshot. Unlink
  // used to clear the attribute and delete it; a save failed with a raw EPERM
  // naming the temp file; a restore over it succeeds on POSIX.
  const ro = path.join(proj, '.claude', 'rules', 'readonly.md');
  await fs.writeFile(ro, '# before\n');
  lin = await scan(proj);
  const roSnap = await post('/api/snapshot', { scanId: lin.scanId, label: 'readonly.md as it was' });
  await fs.writeFile(ro, '# kept as it is\n');
  await fs.chmod(ro, 0o444);
  try {
    lin = await scan(proj);
    const roMtime = entriesOf(lin).find((e) => same(e.absPath, ro))?.mtime;
    const foldersBeforeRo = await snapFolders();
    const roDel = await post('/api/delete', { scanId: lin.scanId, path: ro, expectedMtime: roMtime });
    const roWrite = await post('/api/write', { scanId: lin.scanId, path: ro, content: '# changed\n' });
    const foldersAfterRo = await snapFolders();
    const roRestore = await post('/api/restore', { scanId: lin.scanId, id: roSnap.json?.id, paths: [ro] });
    check('a read-only file is refused by delete, save and restore, readably, and stays (#141)',
      roDel.status === 409 && roDel.json?.code === 'EREADONLY' && roWrite.status === 409 && roWrite.json?.code === 'EREADONLY' &&
        foldersAfterRo === foldersBeforeRo && roRestore.json?.failed?.[0]?.code === 'EREADONLY' &&
        // No answer names LayerCake's temp file, as the raw EPERM did. Not
        // "tmp": on Linux the fixture itself sits under /tmp.
        !JSON.stringify([roDel.json, roWrite.json, roRestore.json?.failed]).includes(TEMP_PREFIX) &&
        (await fs.readFile(ro, 'utf8')) === '# kept as it is\n',
      JSON.stringify({ del: roDel.json, write: roWrite.json, restore: roRestore.json?.failed, folders: [foldersBeforeRo, foldersAfterRo] }));
  } finally {
    await fs.chmod(ro, 0o644);
    await fs.rm(ro, { force: true });
  }

  // --- #92: restore a file that is gone, after a scan that no longer lists it
  const otherScan = await scan(other);
  const fenced = await post('/api/restore', { scanId: otherScan.scanId, id: del.json?.undoSnapshotId, paths: [agentPath] });
  check('restore of a gone file is refused under a scan that does not cover its folder',
    fenced.status === 403 && !(await exists(agentPath)), `${fenced.status}`);
  lin = await scan(proj);
  const back = await post('/api/restore', { scanId: lin.scanId, id: del.json?.undoSnapshotId, paths: [agentPath] });
  check('a deleted file comes back from its undo snapshot, byte for byte, after a rescan',
    back.status === 200 && back.json?.restored?.length === 1 && (await fs.readFile(agentPath).catch(() => Buffer.alloc(0))).equals(before),
    `${back.status} ${JSON.stringify(back.json)}`);
  // #136: the answer names it as recreated, which its undo cannot remove.
  check('a restore names the files it recreated (#136)',
    back.json?.created?.length === 1 && same(back.json.created[0], agentPath), JSON.stringify(back.json?.created));
  // #142: requested paths match as the fence does (case folded on Windows),
  // and one the snapshot does not hold is failed with a reason, never dropped;
  // when none matches, the refusal says so for each.
  lin = await scan(proj);
  const notHeld = path.join(proj, 'CLAUDE.md');
  const variant = process.platform === 'win32' ? agentPath.toUpperCase() : agentPath;
  const mixedRes = await post('/api/restore', { scanId: lin.scanId, id: del.json?.undoSnapshotId, paths: [variant, notHeld] });
  const noneRes = await post('/api/restore', { scanId: lin.scanId, id: del.json?.undoSnapshotId, paths: [notHeld] });
  // Restored, not merely matched. This file was just put back by a restore
  // that created it, and a restore over such a file used to fail with EPERM
  // under load, because the create published with a hard link (#150).
  check('a restore matches paths as the fence does, and fails one the snapshot does not hold (#142)',
    mixedRes.status === 200 && (mixedRes.json?.restored || []).some((p) => same(p, variant)) &&
      mixedRes.json?.failed?.some((f) => same(f.absPath, notHeld) && f.code === 'ENOTINSNAPSHOT') &&
      noneRes.status === 400 && noneRes.json?.details?.failed?.[0]?.code === 'ENOTINSNAPSHOT',
    JSON.stringify({ mixed: mixedRes.json, none: noneRes.json }));
  // #145: a settings file must be an object; every refusal carries a code.
  const settingsPath = path.join(proj, '.claude', 'settings.json');
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(settingsPath, '{}\n');
  lin = await scan(proj);
  const arrayRoot = await post('/api/write', { scanId: lin.scanId, path: settingsPath, content: '[1, 2]' });
  const outsideScan = await post('/api/write', { scanId: lin.scanId, path: path.join(proj, 'nope.md'), content: 'x' });
  check('a settings file with a list at its top is refused, and a refusal always has a code (#145)',
    arrayRoot.status === 400 && arrayRoot.json?.code === 'EBADJSON' && (await fs.readFile(settingsPath, 'utf8')) === '{}\n' &&
      outsideScan.status === 403 && outsideScan.json?.code === 'ENOTINSCAN',
    JSON.stringify({ arrayRoot: arrayRoot.json, outsideScan: outsideScan.json }));
  await fs.rm(settingsPath, { force: true });

  // A gone file that reappears after the scan is never written over: the
  // restore's own snapshot came from the scan and cannot hold it.
  lin = await scan(proj);
  // A full snapshot, taken by hand, for the mixed batch below: a delete's own
  // undo holds only the file it deleted (owner decision, 2026-09-27), and that
  // check needs two files in one snapshot.
  const both = await post('/api/snapshot', { scanId: lin.scanId, label: 'agent and home memory, for the mixed batch' });
  const del2 = await post('/api/delete', { scanId: lin.scanId, path: agentPath, expectedMtime: entriesOf(lin).find((e) => same(e.absPath, agentPath))?.mtime });
  lin = await scan(proj);
  await fs.writeFile(agentPath, 'REAPPEARED after the scan\n');
  const clobber = await post('/api/restore', { scanId: lin.scanId, id: del2.json?.undoSnapshotId, paths: [agentPath] });
  check('restore never writes over a file that appeared since the scan',
    del2.status === 200 && clobber.status === 200 && clobber.json?.failed?.length === 1 &&
      (await fs.readFile(agentPath, 'utf8')) === 'REAPPEARED after the scan\n',
    `${del2.status} ${clobber.status} ${JSON.stringify(clobber.json?.failed)}`);

  // Leave the shared configuration home as it was.
  lin = await scan(proj);
  const userDel = await post('/api/delete', { scanId: lin.scanId, path: userAgent, expectedMtime: entriesOf(lin).find((e) => same(e.absPath, userAgent))?.mtime });
  check('a user-level file is deleted the same way', userDel.status === 200 && !(await exists(userAgent)), `${userDel.status}`);

  // --- #97: every file delete accepts can come back, not only .claude ones --
  // A project-memory note, in the fixture's config home, used to delete fine
  // and then be refused by restore. A plugin file was the other such case until
  // the plugin cache became read only (#126, below).
  {
    const note = path.join(configHome, 'projects', projectSlug(proj), 'memory', 'smoke-note.md');
    await fs.mkdir(path.dirname(note), { recursive: true });
    await fs.writeFile(note, '# note\n');
    lin = await scan(proj);
    const d = await post('/api/delete', { scanId: lin.scanId, path: note, expectedMtime: entriesOf(lin).find((e) => same(e.absPath, note))?.mtime });
    lin = await scan(proj);
    const r = await post('/api/restore', { scanId: lin.scanId, id: d.json?.undoSnapshotId, paths: [note] });
    check('a project-memory note that was deleted can be restored',
      d.status === 200 && r.status === 200 && r.json?.restored?.length === 1 && (await fs.readFile(note, 'utf8').catch(() => '')) === '# note\n',
      `${d.status} ${r.status} ${JSON.stringify(r.json?.failed || r.json)}`);
  }

  // --- #126: the plugin cache is read only (owner decision, 2026-09-28) -----
  // Claude Code replaces a plugin's version folder when the plugin updates, so
  // no verb may change a file there. Every check reads the bytes on disk.
  {
    const version = path.join(configHome, 'plugins', 'cache', 'smoke-mkt', 'smoke-plugin', '1.0.0');
    const plug = path.join(version, 'agents', 'plug-agent.md');
    const gone = path.join(version, 'agents', 'gone-agent.md');
    const body = '---\nname: plug-agent\n---\n';
    await fs.mkdir(path.dirname(plug), { recursive: true });
    await fs.writeFile(plug, body);
    await fs.writeFile(gone, '---\nname: gone-agent\n---\n');
    const bytes = () => fs.readFile(plug, 'utf8').catch(() => null);

    lin = await scan(proj);
    const entry = entriesOf(lin).find((e) => same(e.absPath, plug));
    const w = await post('/api/write', { scanId: lin.scanId, path: plug, content: `${body}edited\n` });
    const d = await post('/api/delete', { scanId: lin.scanId, path: plug, expectedMtime: entry?.mtime });
    check('a plugin cache file is listed read only with the reason, and edit and delete are refused (#126)',
      entry?.category === 'agent' && /^Plugin cache/.test(entry?.readOnly || '') &&
        w.status === 403 && w.json?.code === 'ENOTEDITABLE' && d.status === 403 && d.json?.code === 'ENOTEDITABLE' &&
        (await bytes()) === body,
      `${JSON.stringify(entry?.readOnly)} write ${w.status} ${w.json?.code} delete ${d.status} ${d.json?.code}`);

    // A snapshot taken by hand holds both (taking one only reads). Then, outside
    // LayerCake, one changes and the other goes, as a plugin update would.
    const snap = await post('/api/snapshot', { scanId: lin.scanId, label: 'plugin cache, #126' });
    const updated = `${body}changed by a plugin update\n`;
    await fs.writeFile(plug, updated);
    await fs.rm(gone);
    lin = await scan(proj);
    const cmp = await get(`/api/snapshot/${encodeURIComponent(snap.json?.id)}/compare?scanId=${encodeURIComponent(lin.scanId)}`);
    const rows = cmp.status === 200 ? JSON.parse(cmp.text).rows : [];
    const rowOf = (p) => rows.find((x) => same(x.absPath, p));
    const r = await post('/api/restore', { scanId: lin.scanId, id: snap.json?.id, paths: [plug, gone] });
    check('a plugin cache file is never restored, changed or gone, and compare says why (#126)',
      rowOf(plug)?.status === 'changed' && rowOf(plug)?.restorable === false && /^Plugin cache/.test(rowOf(plug)?.notRestorable || '') &&
        rowOf(gone)?.status === 'missing' && rowOf(gone)?.restorable === false &&
        r.status === 403 && r.json?.code === 'ENOTEDITABLE' && (await bytes()) === updated && !(await exists(gone)),
      `compare ${cmp.status} ${JSON.stringify([rowOf(plug)?.restorable, rowOf(gone)?.restorable])} restore ${r.status} ${r.json?.code}`);

    // The CLI restore leaves them out and says so; asked for one by name, it
    // refuses with exit 1. Neither writes.
    const { spawnSync } = await import('node:child_process');
    const repoRoot = path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')));
    const cli = (...args) =>
      spawnSync(process.execPath, [path.join(repoRoot, 'cli', 'index.js'), 'restore', snap.json?.id, proj, ...args], {
        encoding: 'utf8',
        env: { ...process.env, LAYERCAKE_SNAPSHOT_DIR: snaps, CLAUDE_CONFIG_DIR: configHome },
      });
    const all = cli('--yes');
    const named = cli('--only', 'plug-agent.md', '--yes');
    check('the CLI restore leaves plugin cache files out and says so, and refuses one asked for by name (#126)',
      all.status === 0 && /Left out: 2 plugin cache files that differ\. Plugin cache/.test(all.stdout) &&
        named.status === 1 && /Left out: 1 plugin cache file that differs/.test(named.stdout) &&
        (await bytes()) === updated && !(await exists(gone)),
      `all exit ${all.status}, named exit ${named.status}: ${(all.stdout + all.stderr).replace(/\s+/g, ' ').slice(0, 200)}`);

    // A project scanned from inside the cache is offered nothing there, while
    // its parent folders, outside the cache, still are.
    // Where a created file would land, tested here by prefix rather than by the
    // server's own rule, so the check does not inherit a mistake in it.
    const cacheKey = path.resolve(configHome, 'plugins', 'cache').toLowerCase() + path.sep;
    const inCacheDir = (o) => path.resolve(o.absPath || path.join(o.folder, 'x')).toLowerCase().startsWith(cacheKey);
    const inCache = await scan(version);
    const offeredIn = inCache.creatable.filter(inCacheDir);
    const offeredOut = inCache.creatable.filter((o) => !inCacheDir(o));
    check('nothing inside the plugin cache is offered for create (#126)',
      offeredIn.length === 0 && offeredOut.length > 0 && inCache.levels.some((l) => l.kind === 'directory' && same(l.dir, version)),
      JSON.stringify({ inCache: offeredIn.map((o) => o.label), outside: offeredOut.length }));
  }

  // ~/CLAUDE.md, end to end in the server's own home (#78): outside the config
  // home, it comes back only through the fence's "probed and recorded absent"
  // rule, which the rescan after the delete supplies.
  if (fakeHome) {
    const homeMd = path.join(fakeHome, 'CLAUDE.md');
    await fs.writeFile(homeMd, '# home memory\n');
    lin = await scan(proj);
    const d = await post('/api/delete', { scanId: lin.scanId, path: homeMd, expectedMtime: entriesOf(lin).find((e) => same(e.absPath, homeMd))?.mtime });
    lin = await scan(proj);
    const r = await post('/api/restore', { scanId: lin.scanId, id: d.json?.undoSnapshotId, paths: [homeMd] });
    check('a deleted ~/CLAUDE.md can be restored',
      d.status === 200 && r.status === 200 && r.json?.restored?.length === 1 && (await fs.readFile(homeMd, 'utf8').catch(() => '')) === '# home memory\n',
      `${d.status} ${r.status} ${JSON.stringify(r.json?.failed || r.json)}`);
  } else {
    skip('a deleted ~/CLAUDE.md can be restored', 'no fixture home folder');
  }

  // One row that cannot be restored under this scan no longer blocks the rest.
  const homeMemo = path.join(configHome, 'CLAUDE.md');
  const otherLin = await scan(other);
  const mixed = await post('/api/restore', { scanId: otherLin.scanId, id: both.json?.id, paths: [homeMemo, agentPath] });
  check('a restore batch restores what this scan can take and reports the rest',
    mixed.status === 200 && mixed.json?.restored?.some((p) => same(p, homeMemo)) &&
      mixed.json?.failed?.some((x) => same(x.absPath, agentPath) && x.code === 'ENOTINSCAN'),
    `${mixed.status} ${JSON.stringify(mixed.json)}`);
  const cmp = await get(`/api/snapshot/${encodeURIComponent(both.json?.id)}/compare?scanId=${encodeURIComponent(otherLin.scanId)}`);
  const rows = cmp.status === 200 ? JSON.parse(cmp.text).rows : [];
  check('compare says, per row, whether this scan could restore it',
    rows.find((r) => same(r.absPath, agentPath))?.restorable === false && rows.find((r) => same(r.absPath, homeMemo))?.restorable === true,
    `${cmp.status}`);

  // The other half of #97: a file the scan probes by name, such as ~/CLAUDE.md
  // outside the config home, restores because the rescan records it absent.
  // End to end that means deleting the real ~/CLAUDE.md, which smoke never
  // touches, so this one asks the fence directly, over a synthetic lineage.
  {
    const { restorableWhenAbsent } = await import('../server/writefile.js');
    const fakeHome = path.join(smokeDir, 'fake-home');
    const lineage = {
      levels: [{ kind: 'user', dir: path.join(fakeHome, '.claude'), entries: [], absent: [{ absPath: path.join(fakeHome, 'CLAUDE.md') }] }],
    };
    check('a probed file the scan recorded absent is restorable; a neighbour it never probed is not',
      restorableWhenAbsent(lineage, path.join(fakeHome, 'CLAUDE.md')) === true &&
        restorableWhenAbsent(lineage, path.join(fakeHome, 'OTHER.md')) === false);
  }

  // --- #98: a skill named like runtime state is still a skill ----------------
  lin = await scan(proj);
  const debugSkill = await post('/api/create', { scanId: lin.scanId, createId: option(lin, 'proj', ':tree:skills')?.id, name: 'debug' });
  lin = await scan(proj);
  const debugPath = path.join(proj, '.claude', 'skills', 'debug', 'SKILL.md');
  check('a skill named debug is created and the next scan lists it as a skill',
    debugSkill.status === 200 && entriesOf(lin).some((e) => same(e.absPath, debugPath) && e.category === 'skill'),
    `${debugSkill.status}`);

  // --- #101: a manifest edited on disk cannot reach outside its snapshot -----
  await fs.writeFile(path.join(smokeDir, 'tamper-secret.txt'), 'SMOKE-TAMPER-SENTINEL\n');
  const t = await post('/api/snapshot', { scanId: lin.scanId, label: 'to be tampered with' });
  const manifestPath = path.join(snaps, t.json.id, 'manifest.json');
  const m = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const projMemo = path.join(proj, 'CLAUDE.md');
  m.files.find((x) => same(x.absPath, projMemo)).stored = '../../../tamper-secret.txt';
  await fs.mkdir(path.join(snaps, t.json.id, 'files', 'x'), { recursive: true });
  await fs.writeFile(path.join(snaps, t.json.id, 'files', 'x', '.credentials.json'), 'SMOKE-TAMPER-SENTINEL\n');
  m.files.find((x) => same(x.absPath, homeMemo)).stored = 'x/.credentials.json';
  await fs.writeFile(manifestPath, JSON.stringify(m, null, 2));
  const readOut = await get(`/api/snapshot/${t.json.id}/file?path=${encodeURIComponent(projMemo)}`);
  const readCred = await get(`/api/snapshot/${t.json.id}/file?path=${encodeURIComponent(homeMemo)}`);
  check('a tampered stored path cannot read a file outside the snapshot, nor a credential file inside it',
    readOut.status === 400 && readCred.status === 403 && !readOut.text.includes('SMOKE-TAMPER') && !readCred.text.includes('SMOKE-TAMPER'),
    `${readOut.status} ${readCred.status}`);
  const memoBefore = await fs.readFile(projMemo, 'utf8');
  const tamperRestore = await post('/api/restore', { scanId: lin.scanId, id: t.json.id, paths: [projMemo, homeMemo] });
  check('restoring from a tampered manifest writes nothing from outside it',
    tamperRestore.status === 200 && tamperRestore.json?.failed?.length === 2 && (await fs.readFile(projMemo, 'utf8')) === memoBefore &&
      !(await fs.readFile(homeMemo, 'utf8')).includes('SMOKE-TAMPER'),
    `${tamperRestore.status} ${JSON.stringify(tamperRestore.json?.failed?.map((x) => x.code))}`);

  // --- #99: nothing is offered where the scan could not read the folder -------
  const ghost = path.join(smokeDir, 'create', 'no-such-folder', 'proj');
  const ghostLin = await scan(ghost);
  const unreadLevels = new Set(
    ghostLin.levels.filter((l) => l.dir && l.errors.some((e) => same(e.path || '', l.dir))).map((l) => l.id)
  );
  check('create is not offered at a level whose folder the scan could not read',
    unreadLevels.size > 0 && !ghostLin.creatable.some((o) => unreadLevels.has(o.levelId)),
    `${unreadLevels.size} unread levels`);

  // --- #102: each target offered once ---------------------------------------
  const targets = lin.creatable.map((o) => (o.absPath || o.folder).toLowerCase());
  check('each create target is offered once',
    targets.length === new Set(targets).size,
    JSON.stringify(targets.filter((t, i) => targets.indexOf(t) !== i)));

  // --- #135: a settings file is offered only where Claude Code reads it -----
  // The main fixture has a settings.local.json in the config home (the settings
  // view checks need one), and a file that exists is never offered, so it is
  // set aside here: with it in place the checks below could not fail.
  const userLocal = path.join(configHome, 'settings.local.json');
  await fs.rename(userLocal, `${userLocal}.aside`);
  try {
    const fresh = await scan(proj);
    const settingsOffers = fresh.creatable.filter((o) => o.category === 'settings').map((o) => o.absPath);
    const readHere = [path.join(configHome, 'settings.json'), path.join(proj, '.claude', 'settings.json'), path.join(proj, '.claude', 'settings.local.json')];
    check("settings files are offered only where Claude Code reads them: never a parent folder's, never the config home's local file",
      settingsOffers.length > 0 && settingsOffers.every((p) => readHere.some((r) => same(p, r))),
      JSON.stringify(settingsOffers));
    const homeLin = await scan(path.dirname(configHome));
    check("a session in the folder above the config home is offered the config home's settings.local.json",
      homeLin.creatable.some((o) => o.absPath && same(o.absPath, userLocal)),
      JSON.stringify(homeLin.creatable.filter((o) => o.category === 'settings').map((o) => o.absPath)));
  } finally {
    await fs.rename(`${userLocal}.aside`, userLocal);
  }

  // --- #102: only a real true acknowledges; ids must be strings -------------
  const hookOpt2 = option(lin, 'proj', ':tree:hooks');
  const truthy = [];
  for (const ack of ['false', 'yes', 1, [], {}]) {
    truthy.push((await post('/api/create', { scanId: lin.scanId, createId: hookOpt2?.id, name: 'truthy-hook', ext: '.sh', acknowledgeExecutable: ack })).status);
  }
  const arrayId = await post('/api/create', { scanId: lin.scanId, createId: [hookOpt2?.id], name: 'array-id', ext: '.sh', acknowledgeExecutable: true });
  check('a create acknowledges only with a real true, and refuses an id that is not a string',
    truthy.every((st) => st === 403) && arrayId.status === 400 && !(await exists(path.join(proj, '.claude', 'hooks', 'truthy-hook.sh'))),
    `${truthy.join(',')} ${arrayId.status}`);
  const hookFile = path.join(proj, '.claude', 'hooks', 'smoke-hook.sh');
  const hookBefore = await fs.readFile(hookFile, 'utf8');
  const truthyWrite = await post('/api/write', { scanId: lin.scanId, path: hookFile, content: '#!/bin/sh\necho changed\n', acknowledgeExecutable: 'false' });
  check('a hook save with acknowledgeExecutable "false" is refused', truthyWrite.status === 403 && (await fs.readFile(hookFile, 'utf8')) === hookBefore, `${truthyWrite.status}`);

  // --- #102: an orphaned LayerCake temp file is not listed as a hook ---------
  const orphan = path.join(proj, '.claude', 'hooks', '.layercake-tmp-0123456789ab');
  await fs.writeFile(orphan, 'half a write\n');
  lin = await scan(proj);
  check('an orphaned LayerCake temp file in hooks/ is not listed', !entriesOf(lin).some((e) => same(e.absPath, orphan)));
  await fs.rm(orphan, { force: true });

  // --- #100: a replace or unlink happens only while the file matches the
  // snapshot. The replace path, asked directly: an expected hash that does
  // not match must refuse and leave the file alone.
  {
    const { atomicWrite, removeFile } = await import('../server/snapshot.js');
    const probe = path.join(smokeDir, 'held-probe.txt');
    await fs.writeFile(probe, 'ON DISK\n');
    const wrong = '0'.repeat(64);
    const w = await atomicWrite(probe, 'REPLACED\n', { expectSha256: wrong }).then(() => 'wrote', (e) => e.code);
    const r = await removeFile(probe, { expectSha256: wrong }).then(() => 'removed', (e) => e.code);
    check('a replace or unlink whose snapshot hash no longer matches the file is refused, and the file stays',
      w === 'ECONFLICT' && r === 'ECONFLICT' && (await fs.readFile(probe, 'utf8')) === 'ON DISK\n', `${w} ${r}`);
  }

  // The race itself (#100): the file is held open without delete sharing, as an
  // indexer or antivirus does, so the unlink retries; a write lands meanwhile.
  // Judged by outcome, since the snapshot's timing varies: either the delete is
  // refused and the edit survives, or the snapshot holds the edited bytes.
  if (process.platform === 'win32') {
    const { spawn } = await import('node:child_process');
    const raced = path.join(proj, '.claude', 'agents', 'raced.md');
    await fs.writeFile(raced, 'ORIGINAL CONTENT\n');
    const holder = path.join(smokeDir, 'hold.ps1');
    await fs.writeFile(holder, [
      'param([string]$Target)',
      '$h = [System.IO.File]::Open($Target, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)',
      "[Console]::Out.WriteLine('OPEN'); [Console]::Out.Flush()",
      'Start-Sleep -Milliseconds 1200',
      "[System.IO.File]::WriteAllText($Target, 'EDITED DURING DELETE')",
      "[Console]::Out.WriteLine('WROTE'); [Console]::Out.Flush()",
      'Start-Sleep -Milliseconds 1500',
      '$h.Close()',
      "[Console]::Out.WriteLine('CLOSED')",
    ].join('\r\n'));
    lin = await scan(proj);
    const ps = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', holder, '-Target', raced], { stdio: ['ignore', 'pipe', 'ignore'] });
    let said = '';
    ps.stdout.setEncoding('utf8').on('data', (c) => (said += c));
    const psDone = new Promise((r) => ps.once('exit', r));
    for (let i = 0; i < 150 && !said.includes('OPEN'); i += 1) await new Promise((r) => setTimeout(r, 100));
    const raceDel = await post('/api/delete', { scanId: lin.scanId, path: raced, expectedMtime: entriesOf(lin).find((e) => same(e.absPath, raced))?.mtime });
    await psDone;
    const onDisk = await fs.readFile(raced, 'utf8').catch(() => null);
    let held = null;
    if (raceDel.status === 200) {
      const got = await get(`/api/snapshot/${raceDel.json.undoSnapshotId}/file?path=${encodeURIComponent(raced)}`);
      held = got.status === 200 ? JSON.parse(got.text).content : null;
    }
    const kept = raceDel.status === 409 && onDisk === 'EDITED DURING DELETE';
    const backedUp = raceDel.status === 200 && onDisk === null && held === 'EDITED DURING DELETE';
    check('a write landing while a delete waits on a locked file is never deleted unseen',
      said.includes('WROTE') && (kept || backedUp),
      JSON.stringify({ status: raceDel.status, code: raceDel.json?.code, onDisk, held, said: said.trim().split(/\s+/) }));
  } else {
    skip('a write landing while a delete waits on a locked file is never deleted unseen', 'needs a Windows share-mode lock');
  }

  // --- #87: a legacy .config.json takes the place of .claude.json -----------
  // Last in the run, and undone at the end: it changes the shared config home.
  {
    const legacy = path.join(configHome, '.config.json');
    const modern = path.join(configHome, '.claude.json');
    const modernBefore = await fs.readFile(modern, 'utf8');
    await fs.writeFile(legacy, JSON.stringify({ mcpServers: { 'smoke-legacy-server': { command: 'legacy' } } }));
    await fs.writeFile(modern, JSON.stringify({ projects: {}, mcpServers: { 'smoke-modern-server': { command: 'modern' } } }));
    try {
      lin = await scan(proj);
      const user = lin.levels.find((l) => l.kind === 'user');
      const modernEntry = user.entries.find((e) => same(e.absPath, modern));
      const mcpView = await get(`/api/flatten?scanId=${lin.scanId}&kind=mcp`);
      const names = mcpView.status === 200 ? (JSON.parse(mcpView.text).servers || []).map((x) => x.name) : [];
      check('while a legacy .config.json exists it is the global config read, and .claude.json is marked not read',
        user.entries.some((e) => same(e.absPath, legacy)) && modernEntry?.inactive === true && /Not read by Claude Code/.test(modernEntry?.note || '') &&
          names.includes('smoke-legacy-server') && !names.includes('smoke-modern-server'),
        JSON.stringify({ names, inactive: modernEntry?.inactive }));
    } finally {
      await fs.rm(legacy, { force: true });
      await fs.writeFile(modern, modernBefore);
    }
  }

  // --- #88: LayerCake's stores are refused inside the config tree -------------
  {
    const { snapshotRoot } = await import('../server/paths.js');
    const saved = { cfg: process.env.CLAUDE_CONFIG_DIR, snaps: process.env.LAYERCAKE_SNAPSHOT_DIR };
    const fakeHome = path.join(smokeDir, 'refuse-home');
    const verdict = (dir) => {
      process.env.CLAUDE_CONFIG_DIR = fakeHome;
      process.env.LAYERCAKE_SNAPSHOT_DIR = dir;
      try {
        return snapshotRoot() ? 'allowed' : 'none';
      } catch {
        return 'refused';
      } finally {
        for (const [k, v] of [['CLAUDE_CONFIG_DIR', saved.cfg], ['LAYERCAKE_SNAPSHOT_DIR', saved.snaps]]) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      }
    };
    const inside = verdict(path.join(fakeHome, 'snaps'));
    const beside = verdict(path.join(smokeDir, 'refuse-snaps'));
    check('a snapshot store inside the config home is refused; one beside it is not', inside === 'refused' && beside === 'allowed', `${inside} ${beside}`);
  }

  // A data folder inside the config home no longer fails the session list and
  // the usage view: they answer and say why nothing is kept. Its own server,
  // because the data folder is fixed when the main one starts.
  {
    const { spawn } = await import('node:child_process');
    const net = await import('node:net');
    const port = await new Promise((resolve, reject) => {
      const probe = net.createServer();
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', () => {
        const { port: p } = probe.address();
        probe.close(() => resolve(p));
      });
    });
    const home2 = path.join(smokeDir, 'refuse-home2');
    await fs.mkdir(home2, { recursive: true });
    const second = spawn(process.execPath, [path.join(path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))), 'server', 'index.js')], {
      env: {
        ...process.env,
        PORT: String(port),
        CLAUDE_CONFIG_DIR: home2,
        LAYERCAKE_APPDATA_DIR: path.join(home2, 'layercake-data'),
        LAYERCAKE_SNAPSHOT_DIR: path.join(smokeDir, 'refuse-snaps2'),
        LAYERCAKE_CLAUDE_DATA_DIR: path.join(smokeDir, 'refuse-claudedata'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let said = '';
    second.stdout.setEncoding('utf8').on('data', (c) => (said += c));
    try {
      for (let i = 0; i < 200 && !said.includes('LayerCake  ->'); i += 1) await new Promise((r) => setTimeout(r, 50));
      const base2 = `http://127.0.0.1:${port}`;
      // Its data folder is refused, so its page key is for this run only, and
      // the address it prints is the one place to get it (#189).
      const token2 = /#t=([0-9a-f]{64})/.exec(said)?.[1];
      const h2 = { 'X-LayerCake-Token': token2 };
      const list = await fetch(`${base2}/api/sessions`, { headers: h2 });
      const usage = await fetch(`${base2}/api/usage`, { headers: h2 });
      const listJson = list.status === 200 ? await list.json() : null;
      const usageJson = usage.status === 200 ? await usage.json() : null;
      check('a data folder inside the config home is reported by the session list and usage, not a 500',
        Boolean(token2) && listJson?.dataRootError && usageJson?.dataRootError && /Refusing/.test(listJson.dataRootError),
        `${list.status} ${usage.status} ${JSON.stringify(listJson?.dataRootError)}`);
    } finally {
      second.kill();
    }
  }

  // --- #104: a hook's own runtime folders are not hooks ------------------------
  // hooks/ takes any extension, so hooks/logs/ and hooks/cache/ would list as
  // hooks and be copied into every snapshot. A helper folder is still walked.
  {
    const hooksDir = path.join(proj, '.claude', 'hooks');
    const logFile = path.join(hooksDir, 'logs', 'pre_tool_use.json');
    const cacheFile = path.join(hooksDir, 'cache', 'state.bin');
    const helper = path.join(hooksDir, 'lib', 'helper.sh');
    for (const p of [logFile, cacheFile, helper]) {
      await fs.mkdir(path.dirname(p), { recursive: true });
      await fs.writeFile(p, 'x\n');
    }
    lin = await scan(proj);
    const listed = (p) => entriesOf(lin).some((e) => same(e.absPath, p) && e.category === 'hook');
    check('a hook folder\'s logs/ and cache/ are not listed as hooks; a helper folder still is',
      !listed(logFile) && !listed(cacheFile) && listed(helper),
      JSON.stringify({ log: listed(logFile), cache: listed(cacheFile), helper: listed(helper) }));
    const nm = await post('/api/create', { scanId: lin.scanId, createId: option(lin, 'proj', ':tree:skills')?.id, name: 'node_modules' });
    check('a skill named node_modules is refused: the scan would never list it',
      nm.status === 400 && !(await exists(path.join(proj, '.claude', 'skills', 'node_modules'))), `${nm.status}`);
  }

  // --- #105: a restore puts a file only where the scan would list it --------
  // A manifest edited to name places the old fence allowed and the scan never
  // lists: a plugin marketplace script, a memory file of another extension, a
  // LayerCake temp name in hooks/, and a FILE where the scan recorded a folder.
  lin = await scan(proj);
  const fenceSnap = await post('/api/snapshot', { scanId: lin.scanId, label: 'fence shapes' });
  const fenceDir = path.join(snaps, fenceSnap.json.id);
  const fenceManifest = JSON.parse(await fs.readFile(path.join(fenceDir, 'manifest.json'), 'utf8'));
  const donor = fenceManifest.files.find((x) => same(x.absPath, path.join(proj, 'CLAUDE.md')));
  const outsidePath = path.join(smokeDir, 'outside', 'startup', 'evil.cmd');
  const unlisted = [
    // A cached version installed_plugins.json does not name: the scan does not
    // walk it (#122), and the whole cache is read only now anyway (#126).
    path.join(configHome, 'plugins', 'cache', 'smoke-mkt', 'on-plugin', '1.0.0', 'agents', 'planted.md'),
    path.join(configHome, 'plugins', 'marketplaces', 'smoke-mkt', 'evil.sh'),
    path.join(configHome, 'projects', projectSlug(proj), 'memory', 'notes.txt'),
    path.join(proj, '.claude', 'hooks', '.layercake-tmp-fence'),
    path.join(smokeDir, 'create', '.claude'),
    outsidePath,
  ];
  for (const p of unlisted) fenceManifest.files.push({ ...donor, absPath: p });
  await fs.writeFile(path.join(fenceDir, 'manifest.json'), JSON.stringify(fenceManifest, null, 2));
  const fenced2 = await post('/api/restore', { scanId: lin.scanId, id: fenceSnap.json.id, paths: unlisted.slice(0, 5) });
  const madeAny = (await Promise.all(unlisted.map((p) => exists(p)))).some(Boolean);
  check('a restore never creates a file where the scan would not list it',
    fenced2.status === 403 && !madeAny, `${fenced2.status} ${JSON.stringify(fenced2.json?.details?.refused?.map((x) => x.code))}`);

  // The CLI restores through the same fence: it used to call restoreFiles
  // directly and create the outside file.
  {
    const { spawnSync } = await import('node:child_process');
    const repoRoot = path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')));
    const cli = spawnSync(process.execPath, [path.join(repoRoot, 'cli', 'index.js'), 'restore', fenceSnap.json.id, proj, '--only', 'evil.cmd', '--yes'], {
      encoding: 'utf8',
      env: { ...process.env, LAYERCAKE_SNAPSHOT_DIR: snaps, CLAUDE_CONFIG_DIR: configHome },
    });
    check('the CLI restore refuses a path the scan would not list, and writes nothing',
      cli.status === 1 && !(await exists(outsidePath)) && /Not restorable/.test(cli.stderr + cli.stdout),
      `exit ${cli.status}: ${(cli.stderr || cli.stdout).trim().slice(0, 160)}`);
  }

  // --- #134: the CLI takes ~/.claude.json only by name, and its undo is exact --
  // Claude Code rewrites ~/.claude.json as it runs. The page never preselects
  // it; the CLI selected it by default and printed "restore <undo> --yes",
  // which rolled it back again, along with anything else changed since.
  {
    const { spawnSync } = await import('node:child_process');
    const repoRoot = path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')));
    const restoreCli = (...args) =>
      spawnSync(process.execPath, [path.join(repoRoot, 'cli', 'index.js'), 'restore', ...args], {
        encoding: 'utf8',
        env: { ...process.env, LAYERCAKE_SNAPSHOT_DIR: snaps, CLAUDE_CONFIG_DIR: configHome },
      });
    const claudeJson = path.join(configHome, '.claude.json');
    const memo = path.join(proj, 'CLAUDE.md');
    const saved = await Promise.all([claudeJson, memo, homeMemo].map((p) => fs.readFile(p, 'utf8').catch(() => null)));
    const read = (p) => fs.readFile(p, 'utf8').catch(() => null);
    try {
      await fs.writeFile(homeMemo, '# home memo at snapshot time\n');
      lin = await scan(proj);
      const snap = await post('/api/snapshot', { scanId: lin.scanId, label: 'cli #134' });
      const jsonAtSnap = await read(claudeJson);
      const memoAtSnap = await read(memo);
      const jsonByClaude = JSON.stringify({ projects: {}, rewrittenBy: 'claude code' });
      await fs.writeFile(claudeJson, jsonByClaude);
      await fs.writeFile(memo, '# edited after the snapshot\n');

      const run = restoreCli(snap.json.id, proj, '--yes');
      check('the CLI restore leaves ~/.claude.json out unless named, says so, and restores the rest (#134)',
        run.status === 0 && (await read(claudeJson)) === jsonByClaude && (await read(memo)) === memoAtSnap &&
          /Left out: Claude Code rewrites/.test(run.stdout),
        `exit ${run.status}: ${run.stdout.slice(0, 400)}`);

      // The printed undo, taken apart the way a shell would: it must name the
      // one file it replaced, and running it must touch nothing else.
      const undoLine = /Undo with: layercake restore (\S+) (.*) --yes/.exec(run.stdout);
      const undoOnly = undoLine ? [...undoLine[2].matchAll(/--only "([^"]+)"/g)].map((m) => m[1]) : [];
      check('the printed undo names exactly the file the restore replaced (#134)',
        undoOnly.length === 1 && same(undoOnly[0], memo), undoLine?.[0] || run.stdout.slice(-300));
      await fs.writeFile(homeMemo, '# home memo edited after the restore\n');
      const jsonLater = JSON.stringify({ projects: {}, rewrittenBy: 'claude code, later' });
      await fs.writeFile(claudeJson, jsonLater);
      const undo = undoLine ? restoreCli(undoLine[1], proj, ...undoOnly.flatMap((p) => ['--only', p]), '--yes') : { status: null, stdout: '' };
      check('running the printed undo puts the edit back and leaves later changes alone (#134)',
        undo.status === 0 && (await read(memo)) === '# edited after the snapshot\n' &&
          (await read(homeMemo)) === '# home memo edited after the restore\n' && (await read(claudeJson)) === jsonLater,
        `exit ${undo.status}: ${undo.stdout.slice(0, 300)}`);

      // A path prefix that happens to cover it does not name it: ~/.claude.json
      // sits in, or beside, the folder a user would name to restore config.
      const prefix = restoreCli(snap.json.id, proj, '--only', configHome);
      check('a folder prefix does not select ~/.claude.json; it is listed as left out (#134)',
        prefix.status === 0 && !/(overwrite|recreate)\s+\S*\.claude\.json/.test(prefix.stdout) && /Left out: Claude Code rewrites/.test(prefix.stdout),
        prefix.stdout.slice(0, 400));
      const named = restoreCli(snap.json.id, proj, '--only', '.claude.json', '--yes');
      check('named by its file name, ~/.claude.json is restored (#134)',
        named.status === 0 && (await read(claudeJson)) === jsonAtSnap, `exit ${named.status}: ${named.stdout.slice(0, 300)}`);

      // A file the restore recreates is not in the undo snapshot, which was
      // taken while it was missing (#136): the undo line must not claim it.
      await fs.rm(memo);
      const recreate = restoreCli(snap.json.id, proj, '--only', memo, '--yes');
      check('a recreated file is named as not covered by the undo, and no undo command claims it (#134)',
        recreate.status === 0 && (await read(memo)) === memoAtSnap && /Not covered by the undo/.test(recreate.stdout) &&
          !/Undo with:/.test(recreate.stdout),
        recreate.stdout.slice(0, 400));
    } finally {
      for (const [i, p] of [claudeJson, memo, homeMemo].entries()) {
        if (saved[i] === null) await fs.rm(p, { force: true });
        else await fs.writeFile(p, saved[i]);
      }
    }
  }

  // --- #106: a link planted in a snapshot's files/ is not a copy --------------
  {
    const outsideSecret = path.join(smokeDir, 'link-target-secret.txt');
    await fs.writeFile(outsideSecret, 'SMOKE-LINK-SENTINEL\n');
    const hard = path.join(fenceDir, 'files', 'linked', 'harmless.md');
    await fs.mkdir(path.dirname(hard), { recursive: true });
    await fs.link(outsideSecret, hard);
    const junctionTarget = path.join(smokeDir, 'junction-target');
    await fs.mkdir(junctionTarget, { recursive: true });
    await fs.writeFile(path.join(junctionTarget, 'inner.md'), 'SMOKE-LINK-SENTINEL\n');
    await fs.symlink(junctionTarget, path.join(fenceDir, 'files', 'jct'), 'junction');
    const m2 = JSON.parse(await fs.readFile(path.join(fenceDir, 'manifest.json'), 'utf8'));
    const agentEntry = m2.files.find((x) => same(x.absPath, path.join(proj, 'CLAUDE.md')));
    const other2 = m2.files.find((x) => same(x.absPath, homeMemo));
    agentEntry.stored = 'linked/harmless.md';
    other2.stored = 'jct/inner.md';
    await fs.writeFile(path.join(fenceDir, 'manifest.json'), JSON.stringify(m2, null, 2));
    const viaHard = await get(`/api/snapshot/${fenceSnap.json.id}/file?path=${encodeURIComponent(path.join(proj, 'CLAUDE.md'))}`);
    const viaJunction = await get(`/api/snapshot/${fenceSnap.json.id}/file?path=${encodeURIComponent(homeMemo)}`);
    check('a hard link or a junction planted in a snapshot is refused, and reads nothing',
      viaHard.status === 400 && viaJunction.status === 400 && !viaHard.text.includes('SMOKE-LINK') && !viaJunction.text.includes('SMOKE-LINK'),
      `${viaHard.status} ${viaJunction.status}`);
  }

  // --- #110: restore inputs are strings -----------------------------------------
  {
    const arrId = await post('/api/restore', { scanId: lin.scanId, id: [fenceSnap.json.id], paths: [path.join(proj, 'CLAUDE.md')] });
    const arrPath = await post('/api/restore', { scanId: lin.scanId, id: fenceSnap.json.id, paths: [[path.join(proj, 'CLAUDE.md')]] });
    const arrQuery = await get(`/api/snapshot/${fenceSnap.json.id}/file?path[]=${encodeURIComponent(path.join(proj, 'CLAUDE.md'))}`);
    check('a restore or snapshot read with an array where a string belongs is refused',
      arrId.status === 400 && arrPath.status === 400 && arrQuery.status === 400, `${arrId.status} ${arrPath.status} ${arrQuery.status}`);
  }

  // --- #108: nothing is offered where the scan could not read a folder --------
  // Asked of createOptions over a lineage with the errors a dead config home or
  // an unlistable tree folder produce, since smoke has no dead share.
  {
    const { createOptions } = await import('../server/writefile.js');
    const home = path.join(smokeDir, 'unread-home');
    const dir = path.join(smokeDir, 'unread-dir');
    // projectDir and platform as every scan result has them: createOptions
    // asks which settings files Claude Code reads for the project (#135).
    const lineage = {
      projectDir: dir,
      platform: process.platform,
      levels: [
        { id: 'u', kind: 'user', dir: home, entries: [], absent: [], errors: [{ path: home, code: 'ETIMEDOUT' }] },
        { id: 'd', kind: 'directory', dir, entries: [], absent: [], errors: [{ path: path.join(dir, '.claude', 'agents'), code: 'EPERM' }] },
      ],
    };
    const opts = createOptions(lineage);
    check('an unreadable config home offers nothing, and an unlistable tree folder is not offered',
      !opts.some((o) => o.levelId === 'u') && !opts.some((o) => o.id === 'd:tree:agents') && opts.some((o) => o.id === 'd:tree:skills'),
      JSON.stringify(opts.map((o) => o.id)));

    // And the scan records that error. A config home under a FILE fails its
    // stat with ENOTDIR on Linux, which stands in for a share that does not
    // answer: an error that is not "missing". Windows reports every local
    // stand-in tried (under a file, an over-long name, a bad character) as
    // ENOENT, so there the dead-share case rests on a manual measurement.
    if (process.platform === 'win32') {
      skip('a config home the scan cannot read is an error on the user level, which then offers nothing', 'Windows has no local stand-in for a non-ENOENT stat error');
    } else {
      const { resolveLineage } = await import('../server/scan.js');
      const blocker = path.join(smokeDir, 'not-a-folder.txt');
      await fs.writeFile(blocker, 'x\n');
      const saved = process.env.CLAUDE_CONFIG_DIR;
      process.env.CLAUDE_CONFIG_DIR = path.join(blocker, 'home');
      let scanned;
      try {
        scanned = await resolveLineage(proj);
      } finally {
        if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
        else process.env.CLAUDE_CONFIG_DIR = saved;
      }
      const userLvl = scanned.levels.find((l) => l.kind === 'user');
      check('a config home the scan cannot read is an error on the user level, which then offers nothing',
        userLvl.errors.some((e) => same(e.path || '', userLvl.dir)) && !createOptions(scanned).some((o) => o.levelId === userLvl.id),
        JSON.stringify(userLvl.errors.map((e) => e.code)));
    }
  }

  // --- #107: a brief exclusive lock no longer fails a save ----------------------
  // Another program holds the file with no sharing at all while the save's
  // snapshot copies it; the copy waits, as the rename does, instead of failing.
  if (process.platform === 'win32') {
    const { spawn } = await import('node:child_process');
    const locked = path.join(proj, '.claude', 'agents', 'locked.md');
    await fs.writeFile(locked, 'BEFORE\n');
    const holder = path.join(smokeDir, 'hold-exclusive.ps1');
    await fs.writeFile(holder, [
      'param([string]$Target)',
      '$h = [System.IO.File]::Open($Target, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::None)',
      "[Console]::Out.WriteLine('OPEN'); [Console]::Out.Flush()",
      'Start-Sleep -Milliseconds 900',
      '$h.Close()',
      "[Console]::Out.WriteLine('CLOSED')",
    ].join('\r\n'));
    lin = await scan(proj);
    const entry = entriesOf(lin).find((e) => same(e.absPath, locked));
    const ps = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', holder, '-Target', locked], { stdio: ['ignore', 'pipe', 'ignore'] });
    let said = '';
    ps.stdout.setEncoding('utf8').on('data', (c) => (said += c));
    const psDone = new Promise((r) => ps.once('exit', r));
    for (let i = 0; i < 150 && !said.includes('OPEN'); i += 1) await new Promise((r) => setTimeout(r, 100));
    const save = await post('/api/write', { scanId: lin.scanId, path: locked, content: 'AFTER\n', expectedMtime: entry?.mtime });
    await psDone;
    check('a save while another program briefly holds the file exclusively waits for it, and lands',
      said.includes('OPEN') && save.status === 200 && (await fs.readFile(locked, 'utf8')) === 'AFTER\n',
      `${save.status} ${save.json?.code || ''} ${JSON.stringify(said.trim().split(/\s+/))}`);
  } else {
    skip('a save while another program briefly holds the file exclusively waits for it, and lands', 'needs a Windows share-mode lock');
  }
}
