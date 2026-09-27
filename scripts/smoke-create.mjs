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

const exists = (p) => fs.access(p).then(() => true, () => false);

export async function runCreateChecks({ base, token, check, smokeDir, configHome }) {
  const H = { 'X-LayerCake-Token': token, 'Content-Type': 'application/json' };
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
  await fs.writeFile(big, Buffer.alloc(2 * 1024 * 1024 + 1, 0x61));
  lin = await scan(proj);
  const bigDel = await post('/api/delete', { scanId: lin.scanId, path: big, expectedMtime: entriesOf(lin).find((e) => same(e.absPath, big))?.mtime });
  check('delete is refused when the snapshot could not hold the file, which stays',
    bigDel.status === 409 && bigDel.json?.code === 'ENOBACKUP' && (await exists(big)), `${bigDel.status} ${bigDel.json?.code}`);

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

  // A gone file that reappears after the scan is never written over: the
  // restore's own snapshot came from the scan and cannot hold it.
  lin = await scan(proj);
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
}
