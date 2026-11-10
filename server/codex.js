import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { readTerminalLabel } from './appdata.js';
import { registerLaunch, unregisterCodexLaunch } from './ingest.js';
import { homeDir, isInsideDir, samePathKey } from './paths.js';
import { WINDOWS_POWERSHELL, encodeCommand } from './powershell.js';
import { readForDisplay } from './readfile.js';
import { timedFsCall } from './sharegate.js';
import { resolveAgentCommand } from './summaries.js';
import { listTerminals } from './terminal.js';

const ID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const MAX_REPLY = 8 * 1024 * 1024;
const DEADLINE = 12000;
const NOT_INSTALLED = 'LayerCake could not find the ChatGPT Windows app or a Codex CLI on PATH. Install Codex CLI or reopen LayerCake after updating PATH.';
let runningReads = 0;
let readQueue = Promise.resolve();

const error = (message, status, code) => Object.assign(new Error(message), { status, code });
const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const text = (value, max = 400) => typeof value === 'string' ? value.slice(0, max) : null;
const localPath = (value) => typeof value === 'string' && path.isAbsolute(value) && !/^[\\/]{2}/.test(value);

export function codexHome() {
  return process.env.CODEX_HOME ? path.resolve(process.env.CODEX_HOME) : path.join(homeDir(), '.codex');
}

async function command() {
  const program = (await resolveAgentCommand('codex')) || (await desktopCommand());
  if (!program) throw error(NOT_INSTALLED, 503, 'ENOCODEX');
  return program;
}

/** Use the current user's registered Store package when Explorer's PATH has no CLI. */
async function desktopCommand() {
  if (process.platform !== 'win32') return null;
  // Query the specific signed package, never a project path or a versioned
  // copy in the desktop app's cache. Windows resolves the current version.
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
    "$package = Get-AppxPackage -Name 'OpenAI.Codex' | Where-Object { $_.PackageFamilyName -eq 'OpenAI.Codex_2p2nqsd0c76g0' } | Sort-Object Version -Descending | Select-Object -First 1",
    'if ($package) { [Console]::Write($package.InstallLocation) }',
  ].join('\n');
  const folder = await new Promise((resolve) => {
    execFile(WINDOWS_POWERSHELL, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodeCommand(script)],
      { cwd: homeDir(), windowsHide: true, timeout: 5000, maxBuffer: 4096, encoding: 'utf8' },
      (err, output) => resolve(err ? null : output.trim()));
  });
  if (!localPath(folder)) return null;
  const executable = path.join(folder, 'app', 'resources', 'codex.exe');
  const stat = await timedFsCall(executable, () => fs.stat(executable)).catch(() => null);
  return stat?.isFile() ? [executable] : null;
}

/**
 * A short-lived, bounded stdio client. It never sends a turn, a config write,
 * or a request to resume a thread. Only the projections below reach the UI.
 */
async function withCodex(work) {
  if (runningReads >= 4) throw error('Codex is busy reading settings or history. Try again shortly.', 429, 'ECODEXBUSY');
  runningReads += 1;
  const previous = readQueue;
  let release;
  readQueue = new Promise((resolve) => { release = resolve; });
  await previous;
  let child;
  let closed;
  let timer;
  const pending = new Map();
  try {
    const [exe, ...args] = await command();
    child = spawn(exe, [...args, 'app-server', '--listen', 'stdio://'], {
      cwd: homeDir(), windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
    });
    closed = new Promise((resolve) => child.once('close', resolve));
    let stopped;
    const fail = (err) => {
      stopped ??= err;
      for (const p of pending.values()) p.reject(stopped);
      pending.clear();
    };
    child.once('error', () => fail(error('Could not start Codex App Server.', 503, 'ECODEXSTART')));
    child.once('exit', () => fail(error('Codex App Server closed before replying.', 503, 'ECODEXEXIT')));
    child.stdin.on('error', () => fail(error('Codex App Server closed its input.', 503, 'ECODEXEXIT')));
    child.stdout.on('error', () => fail(error('Codex App Server closed its output.', 503, 'ECODEXEXIT')));
    timer = setTimeout(() => fail(error('Codex App Server did not reply in time.', 504, 'ECODEXTIMEOUT')), DEADLINE);
    child.stdout.setEncoding('utf8');
    let buffer = '';
    child.stdout.on('data', (chunk) => {
      if (stopped) return;
      buffer += chunk;
      if (buffer.length > MAX_REPLY) return fail(error('Codex reply was too large.', 502, 'ECODEXSIZE'));
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        const p = pending.get(message?.id);
        if (!p) continue;
        pending.delete(message.id);
        if (message.error) p.reject(error(`Codex could not complete ${p.method}.`, 502, 'ECODEXRPC'));
        else p.resolve(message.result);
      }
    });
    let id = 0;
    function call(method, params) {
      if (stopped) return Promise.reject(stopped);
      return new Promise((resolve, reject) => {
        const next = ++id;
        pending.set(next, { resolve, reject, method });
        child.stdin.write(`${JSON.stringify({ id: next, method, params })}\n`);
      });
    }
    await call('initialize', { clientInfo: { name: 'layercake', version: '1.1.0' } });
    child.stdin.write('{"method":"initialized"}\n');
    return await work(call);
  } finally {
    clearTimeout(timer);
    try {
      if (child) {
        // Closing stdin lets Codex finish initializing its local databases.
        // Killing after every successful response can race the CLI's startup.
        child.stdin.end();
        const force = setTimeout(() => { if (child.exitCode === null) child.kill(); }, 2500);
        await closed;
        clearTimeout(force);
      }
    } finally {
      runningReads -= 1;
      release();
    }
  }
}

const scalarKeys = [
  'model', 'model_provider', 'model_reasoning_effort', 'model_verbosity', 'approval_policy',
  'approvals_reviewer', 'sandbox_mode', 'web_search', 'project_doc_max_bytes',
];

function displayConfig(raw) {
  const c = object(raw);
  const out = {};
  for (const key of scalarKeys) {
    const value = c[key];
    if (typeof value === 'boolean' || typeof value === 'number') out[key] = value;
    if (typeof value === 'string') out[key] = value.slice(0, 240);
  }
  for (const [key, value] of Object.entries(object(c.features)).slice(0, 100)) {
    if (typeof value === 'boolean') (out.features ??= {})[key] = value;
  }
  for (const key of ['mcp_servers', 'plugins']) {
    if (Object.keys(object(c[key])).length) {
      out[key] = Object.fromEntries(Object.entries(c[key]).slice(0, 100).map(([name, v]) => [name, { enabled: v?.enabled !== false }]));
    }
  }
  return out;
}

function origin(value) {
  const o = object(value?.name ?? value);
  return { type: text(o.type, 40) || 'unknown', path: text(o.file ?? o.dotCodexFolder ?? o.path, 2048) };
}

async function instructionChain(config, cwd, gitRoot) {
  const home = codexHome();
  const files = [];
  let bytesLeft = Math.min(256 * 1024, Number.isInteger(config.project_doc_max_bytes) ? Math.max(0, config.project_doc_max_bytes) : 32768);
  async function first(dir, names, scope) {
    if (!bytesLeft) return;
    for (const name of names) {
      const file = await readForDisplay(path.join(dir, name));
      if (file.error?.code === 'ENOENT') continue;
      if (file.error) {
        files.push({ path: file.path, scope, error: file.error.message });
        continue;
      }
      if (!file.content?.trim()) continue;
      const bytes = Buffer.from(file.content);
      const kept = bytes.subarray(0, bytesLeft);
      bytesLeft -= kept.length;
      files.push({ path: file.path, scope, content: kept.toString('utf8'), truncated: file.truncated || kept.length < bytes.length });
      break;
    }
  }
  if (localPath(home)) await first(home, ['AGENTS.override.md', 'AGENTS.md'], 'User');
  if (!cwd) return files;
  const dirs = [cwd];
  const markers = Array.isArray(config.project_root_markers)
    ? config.project_root_markers.filter((name) => typeof name === 'string' && /^[.\w-]+$/.test(name) && !/^\.{1,2}$/.test(name)).slice(0, 16)
    : null;
  if (markers?.length) {
    const up = [cwd];
    for (let current = cwd;; current = path.dirname(current)) {
      const hits = await Promise.all(markers.map((name) => {
        const file = path.join(current, name);
        return timedFsCall(file, () => fs.stat(file)).then(() => true, () => false);
      }));
      if (hits.some(Boolean)) { dirs.splice(0, dirs.length, ...up); break; }
      const parent = path.dirname(current);
      if (parent === current) break;
      up.push(parent);
    }
  } else if (!markers && gitRoot && isInsideDir(cwd, gitRoot)) {
    while (samePathKey(dirs.at(-1)) !== samePathKey(gitRoot)) dirs.push(path.dirname(dirs.at(-1)));
  }
  const fallback = Array.isArray(config.project_doc_fallback_filenames)
    ? config.project_doc_fallback_filenames.filter((name) => typeof name === 'string' && /^[\w.-]+\.md$/i.test(name)).slice(0, 16)
    : [];
  for (const dir of dirs.reverse()) await first(dir, ['AGENTS.override.md', 'AGENTS.md', ...fallback], 'Project');
  return files;
}

export async function codexConfig(cwd, gitRoot) {
  if (cwd && !localPath(cwd)) throw error('Choose a project on a local drive for Codex.', 400, 'ECODEXDIR');
  const data = await withCodex(async (call) => {
    const result = await call('config/read', { includeLayers: true, ...(cwd ? { cwd } : {}) });
    const requirements = await call('configRequirements/read', {}).catch(() => null);
    const skills = await call('skills/list', { cwds: [cwd || homeDir()] }).catch(() => null);
    const hooks = await call('hooks/list', { cwds: [cwd || homeDir()] }).catch(() => null);
    return { result, requirements, skills, hooks };
  });
  const { result, requirements, skills, hooks } = data;
  const raw = object(result?.config);
  const config = displayConfig(raw);
  const origins = Object.fromEntries(Object.entries(object(result?.origins))
    .filter(([key]) => Object.hasOwn(config, key.split('.')[0])).map(([key, value]) => [key, origin(value)]));
  return {
    cwd, home: codexHome(), config, origins,
    layers: (result?.layers || []).map((layer) => ({ ...origin(layer), disabled: Boolean(layer.disabledReason), config: displayConfig(layer.config) })),
    requirements: requirements?.requirements ? {
      approvalPolicies: requirements.requirements.allowedApprovalPolicies,
      sandboxModes: requirements.requirements.allowedSandboxModes,
    } : null,
    instructions: await instructionChain(raw, cwd, gitRoot),
    skills: (skills?.data || []).flatMap((entry) => (entry.skills || []).map((s) => ({
      name: text(s.name, 120), description: text(s.description), path: text(s.path, 2048), scope: text(s.scope, 40), enabled: s.enabled !== false,
    }))),
    hooks: (hooks?.data || []).flatMap((entry) => (entry.hooks || []).map((h) => ({
      event: text(h.eventName ?? h.event, 80), path: text(h.sourcePath ?? h.path, 2048),
      status: h.enabled === false ? 'Disabled' : text(h.trustStatus, 80),
    }))),
  };
}

async function threadView(t) {
  if (!ID.test(t?.id || '') || !localPath(t.cwd)) return null;
  const sessionId = t.id.toLowerCase();
  return {
    sessionId, tool: 'codex', cwd: t.cwd, title: await readTerminalLabel('codex', sessionId).catch(() => null) || text(t.name, 120),
    preview: text(t.preview, 200), branch: text(t.gitInfo?.branch, 120), updatedAt: t.updatedAt,
  };
}

export async function codexThreads(cwd, cursor) {
  const result = await withCodex((call) => call('thread/list', {
    sortKey: 'updated_at', limit: 50, useStateDbOnly: true, ...(cursor ? { cursor } : {}),
    ...(cwd ? { cwd } : {}),
  }));
  const sessions = (await Promise.all((result?.data || []).filter((t) => !cwd || (t.cwd && isInsideDir(t.cwd, cwd))).map(threadView))).filter(Boolean);
  return { sessions, nextCursor: text(result?.nextCursor, 2048) };
}

export async function codexResume(sessionId, cwd) {
  if (typeof sessionId !== 'string' || !ID.test(sessionId)) throw error('Choose a saved Codex session.', 400, 'EBADSESSION');
  const result = await withCodex((call) => call('thread/read', { threadId: sessionId }));
  const t = await threadView(result?.thread);
  if (!t || samePathKey(t.cwd) !== samePathKey(cwd)) {
    throw error('Scan the working directory shown on the saved chat to resume it.', 409, 'ENOTHERE');
  }
  if (result.thread.status?.type === 'active' || listTerminals().some((entry) => entry.tool === 'codex' && entry.sessionId === t.sessionId && entry.running)) {
    throw error('This Codex chat is already running.', 409, 'ERUNNING');
  }
  return t;
}

const CODEX_HOOKS = ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'SubagentStart', 'SubagentStop', 'PreCompact', 'PostCompact', 'Stop', 'Interrupt'];

export async function prepareCodex({ port, dir, resume, report }) {
  await readQueue;
  const program = await command();
  // Sessions own their launch environment. The desktop-bundled CLI
  // also needs this when it has no separately installed daemon package.
  program.push('--no-daemon');
  if (resume) program.push('resume', resume);
  if (!report) return { program, sessionId: resume };
  if (!port) throw error('Castle reporting is unavailable. Clear Share Codex activity to open the terminal.', 409, 'ENOINGEST');
  const launchId = randomBytes(8).toString('hex');
  const secret = randomBytes(24).toString('hex');
  // A fixed hook definition keeps its trust hash independent of the launch.
  // The reporting capability belongs to the process environment and has no
  // access to LayerCake's page API. The hook never emits model context.
  const script = '$u=$env:LAYERCAKE_CODEX_REPORT; if ($u -match "^http://127\\.0\\.0\\.1:[0-9]+/ingest/[0-9a-f]+/[0-9a-f]+/hook$") { try { $b=[Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd()); Invoke-WebRequest -UseBasicParsing -Uri $u -Method Post -ContentType "application/json" -Body $b -TimeoutSec 2 -ErrorAction Stop | Out-Null } catch {} }';
  const exe = /^[A-Za-z]:[\\\w.-]+$/.test(WINDOWS_POWERSHELL)
    ? WINDOWS_POWERSHELL : `& '${WINDOWS_POWERSHELL.replaceAll("'", "''")}'`;
  const reporter = `${exe} -NoLogo -NoProfile -NonInteractive -EncodedCommand ${encodeCommand(script)}`;
  for (const event of CODEX_HOOKS) {
    const definition = `[{hooks=[{type="command",command=${JSON.stringify(reporter)},statusMessage="Report activity to LayerCake",timeout=3}]}]`;
    program.push('-c', `hooks.${event}=${definition}`);
  }
  registerLaunch({ id: launchId, secret, dir, provider: 'codex', sessionId: resume, createdAt: new Date().toISOString() });
  return { program, sessionId: resume, launchId, reportsActivity: true, dispose: () => unregisterCodexLaunch(launchId),
    env: { LAYERCAKE_CODEX_REPORT: `http://127.0.0.1:${port}/ingest/${launchId}/${secret}/hook` } };
}
