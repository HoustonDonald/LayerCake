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
 *  4. Copy the running node.exe and give the copy LayerCake's icon and version
 *     resource with resedit, so Task Manager and Explorer name it LayerCake
 *     rather than "Node.js JavaScript Runtime".
 *  5. Inject the blob into the copy with postject.
 *  6. Mark the copy a Windows GUI program, so a double-click opens no console.
 *  Then read the copy back: postject rebuilds the resource tree to add its
 *  blob, so step 4's work is checked after it, not before.
 *
 * The exe embeds the Node that runs this script, and it is unsigned: fine on
 * the machine that built it, a SmartScreen prompt on any machine it is copied
 * to. Only this script writes, and only under public/ and dist/.
 * desktop/layercake.ico is committed; scripts/make-icon.mjs draws it.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build as esbuild } from 'esbuild';
import postject from 'postject';
import * as ResEdit from 'resedit';
import { build as viteBuild } from 'vite';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const publicDir = path.join(root, 'public');
const distDir = path.join(root, 'dist');
const workDir = path.join(distDir, 'sea');
const exePath = path.join(distDir, 'LayerCake.exe');
const iconPath = path.join(root, 'desktop', 'layercake.ico');

const NAME = 'LayerCake';
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
// A version resource holds four 16-bit numbers, packed two to a 32-bit field
// by setIdentity, where one too large would silently carry into its neighbour.
// So a version that does not fit fails the build instead.
const versionParts = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)?.slice(1).map(Number);
if (!versionParts || versionParts.some((n) => n > 0xffff)) {
  throw new Error(`package.json version "${version}" does not fit a Windows version resource (major.minor.patch, each 0-65535)`);
}
// The exe's copyright line (Properties > Details), taken from LICENSE so the
// two cannot drift. Node keeps a credit after it: most of the file is Node,
// and its MIT license asks for its notice to travel with copies (the full
// text ships beside the exe in the release's THIRD_PARTY_NOTICES.txt).
const holder = /^Copyright \(c\) .+$/m.exec(fs.readFileSync(path.join(root, 'LICENSE'), 'utf8'))?.[0];
if (!holder) throw new Error('LICENSE has no "Copyright (c) ..." line for the exe to carry');
const COPYRIGHT = `${holder.trim()}. MIT License. Includes Node.js, Copyright Node.js contributors, MIT License.`;

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

/**
 * Replaces node.exe's icon and version resource with LayerCake's, in place.
 * FileDescription is the name Task Manager's Processes tab shows.
 *
 * Runs on the plain copy, before postject. postject then adds NODE_SEA_BLOB to
 * the resource tree written here and flips the fuse, and nothing rewrites the
 * resources after that; the other order would rebuild the section holding the
 * blob after injection. node.exe is Authenticode signed, and resedit parses a
 * signed file only with `ignoreCert`, then writes it without the certificate,
 * which stopped matching the moment the file was edited anyway.
 *
 * Refuses a layout it does not expect, as setGuiSubsystem does: node.exe has
 * one icon group and one version resource, and if a Node release ships more,
 * which one Explorer shows is a question to answer, not to guess.
 */
function setIdentity(file) {
  const exe = ResEdit.NtExecutable.from(fs.readFileSync(file), { ignoreCert: true });
  const res = ResEdit.NtExecutableResource.from(exe);

  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
  if (groups.length !== 1) throw new Error(`${file}: expected one icon group, found ${groups.length}`);
  // Node's own group id and language, so resedit replaces that group and drops
  // Node's images instead of adding a second icon beside them.
  const icons = ResEdit.Data.IconFile.from(fs.readFileSync(iconPath)).icons.map((icon) => icon.data);
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, groups[0].id, groups[0].lang, icons);

  const infos = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
  if (infos.length !== 1) throw new Error(`${file}: expected one version resource, found ${infos.length}`);
  const [info] = infos;
  const tables = info.getAllLanguagesForStringValues();
  if (!tables.length) throw new Error(`${file}: its version resource has no string table`);
  // Set directly rather than through resedit's setFileVersion, which also
  // writes a string into a codepage 1200 table and would add a second table
  // beside one in any other codepage.
  const [major, minor, patch] = versionParts;
  const ms = major * 0x10000 + minor;
  const ls = patch * 0x10000;
  Object.assign(info.fixedInfo, { fileVersionMS: ms, fileVersionLS: ls, productVersionMS: ms, productVersionLS: ls });
  for (const table of tables) {
    info.setStringValues(table, {
      FileDescription: NAME,
      ProductName: NAME,
      InternalName: NAME,
      OriginalFilename: `${NAME}.exe`,
      FileVersion: version,
      ProductVersion: version,
      LegalCopyright: COPYRIGHT,
    });
    info.removeStringValue(table, 'CompanyName');
  }
  info.outputToResourceEntries(res.entries);
  // allowShrink (the third argument) is what keeps the file ordinary. Our
  // resources are far smaller than Node's, and without it pe-library keeps the
  // old raw size while shrinking the virtual one, moving .reloc down in memory
  // but not in the file. Windows loads that, but LIEF inside postject reports
  // it as "Relocation corrupted". With it, both sizes shrink together, postject
  // is silent, and .reloc's bytes stay identical to node.exe's.
  res.outputResource(exe, false, true);
  fs.writeFileSync(file, Buffer.from(exe.generate()));
}

/**
 * Reads the finished file back: the name, the copyright line, the icon and postject's blob.
 * postject rebuilds the whole resource tree to add the blob, so a postject
 * that dropped setIdentity's work, or a rewritten file that confused postject,
 * surfaces here. Otherwise it would ship silently, because the exe prints
 * nothing, and without its blob it is a node.exe with no console.
 */
function checkIdentity(file, iconCount, blobSize) {
  // ignoreCert so that a copy setIdentity never reached, still signed, fails
  // below on what is wrong with it rather than on the signature.
  const res = ResEdit.NtExecutableResource.from(ResEdit.NtExecutable.from(fs.readFileSync(file), { ignoreCert: true }));
  const infos = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
  const strings = infos.flatMap((info) => info.getAllLanguagesForStringValues().map((t) => info.getStringValues(t)));
  if (!strings.length || strings.some((s) => s.FileDescription !== NAME || s.ProductName !== NAME || s.FileVersion !== version || s.LegalCopyright !== COPYRIGHT)) {
    throw new Error(`${file}: version strings are not LayerCake's after injection: ${JSON.stringify(strings)}`);
  }
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
  if (groups.length !== 1 || groups[0].icons.length !== iconCount) {
    throw new Error(`${file}: expected one icon group of ${iconCount} images after injection, found ${groups.map((g) => g.icons.length)}`);
  }
  const blob = res.entries.find((e) => e.type === 10 && e.id === 'NODE_SEA_BLOB'); // 10: RT_RCDATA
  if (!blob || blob.bin.byteLength !== blobSize) {
    throw new Error(`${file}: NODE_SEA_BLOB is ${blob ? `${blob.bin.byteLength} bytes, expected ${blobSize}` : 'missing'}`);
  }
  return `${strings[0].FileDescription} ${strings[0].FileVersion}, ${iconCount} icon images, ${blobSize}-byte blob`;
}

if (process.platform !== 'win32') {
  process.stderr.write('build:exe produces a Windows executable and runs on Windows only.\n');
  process.exit(1);
}

step('1/6 client bundle (vite)');
// root is passed explicitly because vite.config.js gives it as 'client',
// which Vite resolves against the working directory rather than the config.
await viteBuild({ root: path.join(root, 'client'), configFile: path.join(root, 'vite.config.js'), logLevel: 'warn' });
const assets = listFiles(publicDir);
if (!assets.includes('index.html')) throw new Error('vite build produced no index.html');
process.stdout.write(`${assets.length} client files: ${assets.join(', ')}\n`);

step('2/6 bundle the server (esbuild)');
fs.mkdirSync(workDir, { recursive: true });
const bundlePath = path.join(workDir, 'main.cjs');
await esbuild({
  entryPoints: [path.join(root, 'desktop', 'main.js')],
  outfile: bundlePath,
  bundle: true,
  // Explicit because esbuild's default for platform 'node' has moved between
  // versions, and a package left external would build cleanly and then fail at
  // launch: a SEA's require() reaches builtins only.
  packages: 'bundle',
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

step('3/6 SEA blob');
const blobPath = path.join(workDir, 'sea-prep.blob');
const configPath = path.join(workDir, 'sea-config.json');
// `main` and `output` are relative, and the step runs in workDir: the blob
// stores `main` exactly as given, as the script's name in a stack trace, and an
// absolute one put the build folder into every exe. A build in a tree copy
// under the user's profile shipped that user's name (#187). Nothing at run
// time reads it.
fs.writeFileSync(
  configPath,
  JSON.stringify(
    {
      main: path.basename(bundlePath),
      output: path.basename(blobPath),
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      useCodeCache: false,
      assets: Object.fromEntries(assets.map((key) => [key, path.join(publicDir, ...key.split('/'))])),
    },
    null,
    2
  )
);
execFileSync(process.execPath, ['--experimental-sea-config', configPath], { stdio: 'inherit', cwd: workDir });

step('4/6 copy node.exe, then set its icon and version (resedit)');
const stagedExe = path.join(workDir, 'LayerCake.exe');
fs.copyFileSync(process.execPath, stagedExe);
setIdentity(stagedExe);

step('5/6 inject the blob (postject)');
// postject used to warn here that node.exe's Authenticode signature no longer
// matched. setIdentity has already dropped the certificate, so it no longer
// does; output from postject now is new and worth reading.
const blob = fs.readFileSync(blobPath);
await postject.inject(stagedExe, 'NODE_SEA_BLOB', blob, { sentinelFuse: SEA_FUSE });

step('6/6 mark as a GUI program');
setGuiSubsystem(stagedExe);
const iconCount = ResEdit.Data.IconFile.from(fs.readFileSync(iconPath)).icons.length;
process.stdout.write(`checked: ${checkIdentity(stagedExe, iconCount, blob.length)}\n`);

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
