/**
 * npm start: build the client if the bundle is stale or missing, then serve.
 * Keeps the single-command promise without shipping a watcher dependency.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const bundle = path.join(root, 'public', 'index.html');

function newestMtime(dir) {
  let newest = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(abs);
      else {
        try {
          newest = Math.max(newest, fs.statSync(abs).mtimeMs);
        } catch {
          /* unreadable source file: ignore, the build will report it */
        }
      }
    }
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

const bundleMtime = fs.existsSync(bundle) ? fs.statSync(bundle).mtimeMs : 0;
const sourceMtime = newestMtime(path.join(root, 'client'));

if (bundleMtime < sourceMtime) {
  process.stdout.write('Building client bundle...\n');
  await run('npx', ['vite', 'build']);
} else {
  process.stdout.write('Client bundle up to date.\n');
}

await import('../server/index.js');
