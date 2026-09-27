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
import fs from 'node:fs';
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

/** Builds when stale, says which, and resolves true when it built. Rejects when the build fails. */
export async function buildClientIfStale() {
  const bundleMtime = fs.existsSync(bundle) ? fs.statSync(bundle).mtimeMs : 0;
  const sourceMtime = Math.max(...INPUTS.map(newestMtime));
  if (bundleMtime >= sourceMtime) {
    process.stdout.write('Client bundle up to date.\n');
    return false;
  }
  process.stdout.write('Building client bundle...\n');
  await run('npx', ['vite', 'build']);
  return true;
}
