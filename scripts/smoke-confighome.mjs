/**
 * A configuration home moved from inside settings (#64), over the real HTTP
 * API on a server of its own: no CLAUDE_CONFIG_DIR in its environment and a
 * home folder of its own, so the default home is the fixture's, and no
 * LAYERCAKE_CLAUDE_DATA_DIR, so the session data follows the home as it does
 * for a user.
 *
 * The sentences under test, each measured on Claude Code 2.1.284: a
 * CLAUDE_CONFIG_DIR in the env block of the default home's settings.json
 * moves the whole home, sessions included; nothing of the old home applies;
 * .claude.json stays where it was; a project's settings cannot move it.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

import { projectSlug } from '../server/paths.js';
import { minimalTranscript } from './smoke-sessions.mjs';

const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

export async function runConfigHomeChecks({ root, check, smokeDir }) {
  const fx = path.join(smokeDir, 'confighome');
  const fakeHome = path.join(fx, 'home');
  const homeA = path.join(fakeHome, '.claude');
  const homeB = path.join(fx, 'moved-home');
  const homeC = path.join(fx, 'project-named-home');
  const proj = path.join(fx, 'proj');
  const json = (p, v) => fs.writeFile(p, JSON.stringify(v, null, 2));
  for (const d of [homeA, homeB, homeC, path.join(proj, '.claude'), path.join(homeB, 'projects', projectSlug(proj))]) {
    await fs.mkdir(d, { recursive: true });
  }
  const settingsA = path.join(homeA, 'settings.json');
  await json(settingsA, { env: { CLAUDE_CONFIG_DIR: homeB }, model: 'from-a' });
  await fs.writeFile(path.join(homeA, 'CLAUDE.md'), '# in the default home\n');
  await json(path.join(homeB, 'settings.json'), { model: 'from-b' });
  await fs.writeFile(path.join(homeB, 'CLAUDE.md'), '# in the moved home\n');
  await fs.writeFile(path.join(homeC, 'CLAUDE.md'), '# named by the project\n');
  await json(path.join(proj, '.claude', 'settings.json'), { env: { CLAUDE_CONFIG_DIR: homeC } });
  await json(path.join(fakeHome, '.claude.json'), { projects: {} });
  const sessionId = '64646464-6464-4646-8646-646464646464';
  await minimalTranscript(path.join(homeB, 'projects', projectSlug(proj)), sessionId, proj, 'a prompt in the moved home');

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
    PORT: String(port),
    USERPROFILE: fakeHome,
    HOME: fakeHome,
    LAYERCAKE_SNAPSHOT_DIR: path.join(fx, 'snaps'),
    LAYERCAKE_APPDATA_DIR: path.join(fx, 'appdata'),
  };
  delete env.CLAUDE_CONFIG_DIR;
  delete env.LAYERCAKE_CLAUDE_DATA_DIR;
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
    const token = /name="layercake-token" content="([a-f0-9]+)"/.exec(html || '')?.[1];
    check('moved home: its own server comes up (#64)', Boolean(token), serverOut.slice(-2000));
    if (!token) return;
    const H = { 'X-LayerCake-Token': token, 'Content-Type': 'application/json' };
    const same = (a, b) => path.resolve(String(a)).toLowerCase() === path.resolve(String(b)).toLowerCase();
    const scan = async () => (await fetch(`${base}/api/scan`, { method: 'POST', headers: H, body: JSON.stringify({ dir: proj }) })).json();

    // Before any scan: the server resolves the home at startup for this.
    const sessions = await (await fetch(`${base}/api/sessions`, { headers: H })).json();
    check('session history follows the moved home, before any scan (#64)',
      (sessions.sessions || []).some((s) => s.sessionId === sessionId),
      JSON.stringify((sessions.sessions || []).map((s) => s.sessionId)));

    let lineage = await scan();
    let user = lineage.levels?.find((l) => l.kind === 'user');
    const has = (level, p) => (level?.entries || []).find((e) => same(e.absPath, p));
    check('a CLAUDE_CONFIG_DIR in the default home\'s settings env moves the user level there, and says which file did (#64)',
      same(user?.dir, homeB) && (user?.note || '').includes(settingsA) && /#64/.test(user?.note || ''),
      JSON.stringify({ dir: user?.dir, note: user?.note }));
    check('the moved home\'s files are listed, the default home\'s are not; a project\'s settings cannot move it (#64)',
      Boolean(has(user, path.join(homeB, 'CLAUDE.md'))) && !has(user, path.join(homeA, 'CLAUDE.md')) &&
        !lineage.levels.some((l) => (l.entries || []).some((e) => same(e.absPath, path.join(homeC, 'CLAUDE.md')))),
      JSON.stringify((user?.entries || []).map((e) => e.absPath)));
    const mover = has(user, settingsA);
    const settings = await (await fetch(`${base}/api/flatten?scanId=${lineage.scanId}&kind=settings`, { headers: H })).json();
    // The project's env block is merged as usual (its CLAUDE_CONFIG_DIR moves
    // nothing, but it is still a setting); the default home's is not.
    check('the file that moved the home is listed, inactive, and not merged (#64)',
      Boolean(mover?.inactive) && settings.merged?.model === 'from-b' && !same(settings.merged?.env?.CLAUDE_CONFIG_DIR || '', homeB),
      JSON.stringify({ mover, merged: settings.merged }));
    check('.claude.json stays in the home folder when the home moves (#64)',
      Boolean(has(user, path.join(fakeHome, '.claude.json'))) && !has(user, path.join(homeB, '.claude.json')),
      JSON.stringify((user?.entries || []).map((e) => e.absPath)));
    // Undone by editing that file: the next scan is back at the default home.
    await json(settingsA, { model: 'from-a' });
    lineage = await scan();
    user = lineage.levels?.find((l) => l.kind === 'user');
    check('removing the key moves the home back at the next scan (#64)',
      same(user?.dir, homeA) && Boolean(has(user, path.join(homeA, 'CLAUDE.md'))) && !/#64/.test(user?.note || ''),
      JSON.stringify({ dir: user?.dir, note: user?.note }));
  } finally {
    server.kill();
  }
}
