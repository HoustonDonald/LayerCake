/**
 * The client build rule, in one place: rebuild public/ with Vite when it is
 * older than what it is built from. npm start, the desktop launcher and the
 * smoke test all run it (#94). The first two used to carry a copy each, and
 * smoke had none, so a public/ built before a client change failed smoke
 * instead of being rebuilt.
 *
 * "What it is built from" is everything under client/, plus vite.config.js and
 * desktop/layercake.ico, which the favicon plugin reads (#60). A change to
 * either of those alone used to leave public/ stale.
 *
 * Importing this runs nothing; start.js does its work at module scope, which
 * is why the rule could not simply be imported from there.
 */

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const bundle = path.join(root, 'public', 'index.html');
const INPUTS = [path.join(root, 'client'), path.join(root, 'vite.config.js'), path.join(root, 'desktop', 'layercake.ico')];

/** Newest mtime of a file, or of any file under a folder. Unreadable entries are skipped: the build reports them. */
function newestMtime(target) {
  let newest = 0;
  const stack = [target];
  while (stack.length) {
    const current = stack.pop();
    let st;
    try {
      st = fs.statSync(current);
    } catch {
      continue;
    }
    if (!st.isDirectory()) {
      newest = Math.max(newest, st.mtimeMs);
      continue;
    }
    let names;
    try {
      names = fs.readdirSync(current);
    } catch {
      continue;
    }
    for (const name of names) stack.push(path.join(current, name));
  }
  return newest;
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`))));
    child.on('error', reject);
  });
}

/**
 * Held from the staleness check to the end of the build, so two runs that
 * start together on a stale tree build once: a Vite build empties public/
 * first, and the other run's server was reading it (#95). The second waits,
 * then finds the bundle fresh.
 *
 * A named pipe rather than a lock file, because Windows releases it when its
 * process dies, so a build killed mid-way leaves no lock behind (measured: a
 * second listener gets EADDRINUSE, and gets the pipe once the holder is
 * killed). Keyed by this tree, so tree copies build side by side. Windows
 * only: elsewhere nothing is held, as before.
 */
async function holdBuildLock() {
  if (process.platform !== 'win32') return async () => {};
  const key = crypto.createHash('sha256').update(root.toLowerCase()).digest('hex').slice(0, 16);
  const name = `\\\\.\\pipe\\layercake-client-build-${key}`;
  let told = false;
  for (;;) {
    const server = net.createServer();
    const taken = await new Promise((resolve, reject) => {
      server.once('error', (err) => (err.code === 'EADDRINUSE' ? resolve(false) : reject(err)));
      server.listen(name, () => resolve(true));
    });
    if (taken) return () => new Promise((resolve) => server.close(() => resolve()));
    if (!told) {
      process.stdout.write('Waiting for another client build in this folder to finish...\n');
      told = true;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** Builds when stale, says which, and resolves true when it built. Rejects when the build fails. */
export async function buildClientIfStale() {
  const release = await holdBuildLock();
  try {
    const bundleMtime = fs.existsSync(bundle) ? fs.statSync(bundle).mtimeMs : 0;
    const sourceMtime = Math.max(...INPUTS.map(newestMtime));
    if (bundleMtime >= sourceMtime) {
      process.stdout.write('Client bundle up to date.\n');
      return false;
    }
    process.stdout.write('Building client bundle...\n');
    await run('npx', ['vite', 'build']);
    return true;
  } finally {
    await release();
  }
}
