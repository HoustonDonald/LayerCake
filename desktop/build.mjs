/**
 * Builds dist/LayerCake.exe: the server, the client and a Node runtime in one
 * file, using Node's single executable application (SEA) support.
 *
 *   npm run build:exe
 *
 * Each step feeds the next:
 *  1. vite build: client/ -> public/, so the exe never embeds a stale client.
 *  2. esbuild: desktop/main.js and everything it imports -> one CommonJS file.
 *     A SEA runs exactly one script, and its require() reaches only builtins,
 *     so express and js-yaml have to be inside that script.
 *  3. node --experimental-sea-config: that script plus public/ -> a blob.
 *  4. Copy the running node.exe and inject the blob with postject.
 *  5. Mark the copy a Windows GUI program, so a double-click opens no console.
 *
 * The exe embeds the Node that runs this script, and it is unsigned: fine on
 * the machine that built it, a SmartScreen prompt on any machine it is copied
 * to. Only this script writes, and only under public/ and dist/.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build as esbuild } from 'esbuild';
import postject from 'postject';
import { build as viteBuild } from 'vite';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const publicDir = path.join(root, 'public');
const distDir = path.join(root, 'dist');
const workDir = path.join(distDir, 'sea');
const exePath = path.join(distDir, 'LayerCake.exe');

// The sentinel Node's own SEA docs pass to postject. It marks the fuse inside
// node.exe that tells the runtime a blob has been injected.
const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

function step(text) {
  process.stdout.write(`\n== ${text}\n`);
}

/** Every file under dir, as forward-slash paths relative to it: the URL paths the server will match. */
function listFiles(dir, prefix = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(path.join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out;
}

/**
 * Sets the PE optional header's Subsystem field from CONSOLE (3) to WINDOWS_GUI
 * (2). This is what `editbin /SUBSYSTEM:WINDOWS` does; editbin ships only with
 * Visual Studio, and the change is one 16-bit field.
 *
 * Refuses anything it does not recognise, rather than writing two bytes into
 * an unknown layout. Subsystem sits at offset 68 into the optional header in
 * both PE32 and PE32+: PE32+ drops BaseOfData (4 bytes) and widens ImageBase
 * by the same 4, so everything after them lines up.
 */
function setGuiSubsystem(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt16LE(0) !== 0x5a4d) throw new Error(`${file}: no MZ header`);
  const pe = buf.readUInt32LE(0x3c);
  if (buf.readUInt32LE(pe) !== 0x00004550) throw new Error(`${file}: no PE signature`);
  const optional = pe + 4 + 20;
  const magic = buf.readUInt16LE(optional);
  if (magic !== 0x20b && magic !== 0x10b) throw new Error(`${file}: unknown optional header magic 0x${magic.toString(16)}`);
  const field = optional + 68;
  const current = buf.readUInt16LE(field);
  if (current !== 3) throw new Error(`${file}: expected the console subsystem (3), found ${current}`);
  buf.writeUInt16LE(2, field);
  fs.writeFileSync(file, buf);
}

if (process.platform !== 'win32') {
  process.stderr.write('build:exe produces a Windows executable and runs on Windows only.\n');
  process.exit(1);
}

step('1/5 client bundle (vite)');
// root is passed explicitly because vite.config.js gives it as 'client',
// which Vite resolves against the working directory rather than the config.
await viteBuild({ root: path.join(root, 'client'), configFile: path.join(root, 'vite.config.js'), logLevel: 'warn' });
const assets = listFiles(publicDir);
if (!assets.includes('index.html')) throw new Error('vite build produced no index.html');
process.stdout.write(`${assets.length} client files: ${assets.join(', ')}\n`);

step('2/5 bundle the server (esbuild)');
fs.mkdirSync(workDir, { recursive: true });
const bundlePath = path.join(workDir, 'main.cjs');
await esbuild({
  entryPoints: [path.join(root, 'desktop', 'main.js')],
  outfile: bundlePath,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: `node${process.versions.node.split('.')[0]}`,
  define: { __LAYERCAKE_ASSETS__: JSON.stringify(assets) },
  logLevel: 'warning',
  // In CommonJS output esbuild replaces import.meta with {} and only warns, so
  // fileURLToPath(import.meta.url) moved into a bundled module would throw at
  // startup in a program with no console. server/index.js uses exactly that and
  // is one refactor away from the bundle; make it a build failure instead.
  logOverride: { 'empty-import-meta': 'error' },
});
process.stdout.write(`${bundlePath} (${fs.statSync(bundlePath).size} bytes)\n`);

step('3/5 SEA blob');
const blobPath = path.join(workDir, 'sea-prep.blob');
const configPath = path.join(workDir, 'sea-config.json');
fs.writeFileSync(
  configPath,
  JSON.stringify(
    {
      main: bundlePath,
      output: blobPath,
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      useCodeCache: false,
      assets: Object.fromEntries(assets.map((key) => [key, path.join(publicDir, ...key.split('/'))])),
    },
    null,
    2
  )
);
execFileSync(process.execPath, ['--experimental-sea-config', configPath], { stdio: 'inherit' });

step('4/5 inject into a copy of node.exe (postject)');
const stagedExe = path.join(workDir, 'LayerCake.exe');
fs.copyFileSync(process.execPath, stagedExe);
// postject warns that the copied binary's Authenticode signature no longer
// matches. Expected: node.exe is signed, the edited copy cannot be.
await postject.inject(stagedExe, 'NODE_SEA_BLOB', fs.readFileSync(blobPath), { sentinelFuse: SEA_FUSE });

step('5/5 mark as a GUI program');
setGuiSubsystem(stagedExe);

try {
  fs.renameSync(stagedExe, exePath);
} catch (err) {
  if (err.code === 'EPERM' || err.code === 'EBUSY') {
    process.stderr.write(`\n${exePath} is in use. Close LayerCake (every window) and build again.\n`);
    process.exit(1);
  }
  throw err;
}

const mb = (fs.statSync(exePath).size / 1024 / 1024).toFixed(1);
process.stdout.write(`\nBuilt ${exePath} (${mb} MB, Node ${process.versions.node})\n`);
