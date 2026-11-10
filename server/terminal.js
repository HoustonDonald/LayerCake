/* global __LAYERCAKE_PTY_FILES__, __LAYERCAKE_PTY_VERSION__ */

import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { getAsset, isSea } from 'node:sea';
import path from 'node:path';

import { installTerminalRuntime, writeTerminalLabel } from './appdata.js';
import { readGitState } from './gitstate.js';

const MAX_ACTIVE = 16;
const MAX_FINISHED = 8;
const MAX_OUTPUT = 256 * 1024;
const terminals = new Map();
const reserved = new Set();
let ptyModule;
let shuttingDown = false;

function problem(message, status, code) {
  return Object.assign(new Error(message), { status, code });
}

async function loadPty() {
  if (process.platform !== 'win32') throw new Error('Windows ConPTY is required.');
  if (isSea()) {
    const files = __LAYERCAKE_PTY_FILES__.map((name) => [name, Buffer.from(getAsset(`terminal-runtime/${name}`))]);
    const dir = await installTerminalRuntime(__LAYERCAKE_PTY_VERSION__, files);
    const entry = path.join(dir, 'lib', 'index.js');
    return createRequire(entry)(entry);
  }
  return import('node-pty');
}

function view(t) {
  const { id, tool, cwd, title, sessionId, startedAt, exitCode, launchId, reportsActivity, activitySeen, branch, lastOutputAt, keep } = t;
  return { id, tool, cwd, title, sessionId, startedAt, exitCode, launchId, reportsActivity, activitySeen, branch, lastOutputAt, keep, running: !t.finished };
}

export function listTerminals() {
  return [...terminals.values()].map(view).reverse();
}

function send(t, event, payload) {
  for (const listener of t.listeners) listener(event, payload);
}

function forgetFinished() {
  const finished = [...terminals.values()].filter((t) => t.finished);
  for (const t of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED))) {
    t.controller?.replace();
    t.dispose?.();
    terminals.delete(t.id);
  }
}

/** Prepare and spawn under a reservation so two Resume clicks cannot open the same chat. */
export async function startTerminal({ tool, cwd, resume, prepare, title }) {
  const key = resume ? `${tool}:${resume}` : randomUUID();
  if (reserved.has(key) || (resume && [...terminals.values()].some((t) => !t.finished && t.tool === tool && t.sessionId === resume))) {
    throw problem('This chat already has an open terminal.', 409, 'ERUNNING');
  }
  if (shuttingDown || reserved.size + [...terminals.values()].filter((t) => !t.finished).length >= MAX_ACTIVE) {
    throw problem('Close an embedded terminal before opening another.', 409, 'ETERMINALLIMIT');
  }
  reserved.add(key);
  try {
    let driver;
    try {
      ptyModule ??= loadPty().catch((error) => { ptyModule = null; throw error; });
      driver = await ptyModule;
    } catch {
      throw problem('Embedded terminal unavailable. Open the session in Windows Terminal instead.', 503, 'ENOPTY');
    }
    const plan = await prepare();
    const [exe, ...args] = plan.program;
    if (shuttingDown) {
      plan.dispose?.();
      throw problem('LayerCake is closing.', 503, 'ETERMINALCLOSED');
    }
    let pty;
    try {
      // Use the bundled ConPTY implementation. The alternative Windows
      // backend forks a Node helper via process.execPath, which in SEA is us.
      pty = driver.spawn(exe, args, { cwd, env: { ...process.env, ...plan.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
        cols: 100, rows: 28, useConpty: true, useConptyDll: true });
    } catch {
      plan.dispose?.();
      throw problem('Windows could not start this CLI in the embedded terminal.', 503, 'ENOPTY');
    }
    const t = {
      id: randomUUID(), tool, cwd, title, sessionId: plan.sessionId || resume || null, startedAt: new Date().toISOString(),
      launchId: plan.launchId || null, reportsActivity: Boolean(plan.reportsActivity),
      pty, output: '', listeners: new Set(), finished: false, exitCode: null, closing: false, labelQueue: Promise.resolve(),
      controller: null, attached: false, branch: null,
      activitySeen: false, dispose: plan.dispose, ended: plan.ended, exited: null, markExited: null,
      lastOutputAt: null,
      // "Keep on close" (#205): the user's mark that this session should move
      // to Windows Terminal when LayerCake closes. Memory only, like the terminal.
      keep: false,
    };
    t.exited = new Promise((resolve) => { t.markExited = resolve; });
    terminals.set(t.id, t);
    readGitState(cwd).then((git) => {
      t.branch = git.branch || git.detached || null;
      send(t, 'state', view(t));
    }).catch(() => {});
    pty.onData((data) => {
      t.output = (t.output + data).slice(-MAX_OUTPUT);
      // When it last printed: a tab reads a quiet Codex terminal with a call
      // open as an approval prompt (#207). A time, never the text.
      t.lastOutputAt = new Date().toISOString();
      send(t, 'output', { data });
    });
    pty.onExit(({ exitCode }) => {
      // node-pty 1.1's DLL backend leaves its conout listener running after
      // the pipe closes. Output has drained by onExit, so release it here.
      pty._agent?._conoutSocketWorker?.dispose();
      t.finished = true;
      t.exitCode = exitCode ?? null;
      t.pty = null;
      // The process is gone: say so to whatever tracks its sessions, before
      // anyone waiting on the exit asks whether they are still running (#205).
      try { t.ended?.(); } catch { /* the exit is still reported below */ }
      t.markExited();
      send(t, 'state', view(t));
      forgetFinished();
    });
    return view(t);
  } finally {
    reserved.delete(key);
  }
}

export function bindTerminalSession(launchId, sessionId, switchSession = false) {
  const terminal = [...terminals.values()].find((t) => t.launchId === launchId && !t.finished);
  if (!terminal) return;
  const first = !terminal.activitySeen;
  terminal.activitySeen = true;
  const changed = terminal.sessionId !== sessionId && (switchSession || !terminal.sessionId);
  if (changed) terminal.sessionId = sessionId;
  if (!first && !changed) return;
  send(terminal, 'state', view(terminal));
  if (changed && terminal.title) queueLabel(terminal, sessionId, terminal.title).catch(() => {});
}

function queueLabel(t, sessionId, title) {
  const save = t.labelQueue.then(() => writeTerminalLabel(t.tool, sessionId, title));
  t.labelQueue = save.catch(() => {});
  return save;
}

function stop(t) {
  if (t.finished || t.closing) return;
  t.closing = true;
  try {
    t.pty.kill();
  } catch {
    t.closing = false;
    throw problem('The terminal could not be closed.', 500, 'EPTYKILL');
  }
}

/** A running or recently finished terminal, as the list shows it, or null. */
export function findTerminal(id) {
  const t = terminals.get(id);
  return t ? view(t) : null;
}

/**
 * Ends a terminal's process and waits for the exit. False when it had not
 * exited within `ms`: the caller must then treat the session as still running.
 */
export async function endTerminal(id, ms) {
  const t = terminals.get(id);
  if (!t) return true;
  stop(t);
  let timer;
  const exited = await Promise.race([
    t.exited.then(() => true),
    new Promise((resolve) => { timer = setTimeout(() => resolve(false), ms); }),
  ]);
  clearTimeout(timer);
  return exited;
}

export function closeTerminals() {
  shuttingDown = true;
  for (const t of terminals.values()) {
    try { stop(t); } catch { /* finish closing the other terminals */ }
  }
}

export function registerTerminalRoutes(app, start, { states = async () => ({}), stateRules = [] } = {}) {
  const lookup = (req, res, next) => {
    const terminal = terminals.get(req.params.id);
    if (!terminal) return res.status(404).json({ message: 'This terminal has closed.', code: 'ENOTERMINAL' });
    req.terminal = terminal;
    next();
  };
  const route = (fn) => async (req, res) => {
    try { await fn(req, res); } catch (err) {
      res.status(err.status || 500).json({ message: err.message, code: err.code || null });
    }
  };
  const active = (t, controller) => {
    if (t.finished || t.closing) throw problem('This terminal has closed.', 409, 'ETERMINALCLOSED');
    if (!t.controller || t.controller.id !== controller) throw problem('Connect to this terminal before sending input.', 409, 'ECTRL');
  };
  // The list carries each running terminal's state (#207); the rules that
  // produce it are served beside it, so the page can show them.
  // A state that cannot be worked out costs only that state, never the list.
  app.get('/api/terminals', async (_req, res) => {
    const list = listTerminals();
    const found = await states(list).catch(() => ({}));
    res.json(list.map((t) => ({ ...t, activity: found[t.id] || null })));
  });
  app.get('/api/terminal-states', (_req, res) => res.json(stateRules));
  app.post('/api/terminals/:id/keep', lookup, route((req, res) => {
    if (typeof req.body?.keep !== 'boolean') throw problem('Say whether to keep this session.', 400, 'EBADKEEP');
    req.terminal.keep = req.body.keep;
    send(req.terminal, 'state', view(req.terminal));
    res.json(view(req.terminal));
  }));
  app.post('/api/terminals', route(async (req, res) => res.json(await start(req.body))));
  app.get('/api/terminals/:id/stream', lookup, (req, res) => {
    const t = req.terminal;
    t.controller?.replace();
    const controller = {
      id: randomUUID(),
      replace: () => { listener('replaced', {}); res.end(); },
    };
    t.controller = controller;
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    const listener = (event, data) => {
      if (res.writableLength > 2 * MAX_OUTPUT) return res.end();
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const heartbeat = setInterval(() => {
      if (res.writableLength > 2 * MAX_OUTPUT) res.end();
      else res.write(': keepalive\n\n');
    }, 15000);
    res.once('close', () => {
      clearInterval(heartbeat);
      t.listeners.delete(listener);
      if (t.controller === controller) t.controller = null;
      if (!res.writableEnded) res.end();
    });
    listener('ready', { controller: controller.id, first: !t.attached, data: t.output });
    t.attached = true;
    listener('state', view(t));
    t.listeners.add(listener);
  });
  app.post('/api/terminals/:id/input', lookup, route((req, res) => {
    const { data, controller } = req.body || {};
    if (typeof data !== 'string' || data.length > 32768) throw problem('Invalid terminal input.', 400, 'EBADINPUT');
    active(req.terminal, controller);
    req.terminal.pty.write(data);
    res.status(204).end();
  }));
  app.post('/api/terminals/:id/resize', lookup, route((req, res) => {
    const { cols, rows, controller } = req.body || {};
    if (!Number.isInteger(cols) || cols < 2 || cols > 500 || !Number.isInteger(rows) || rows < 2 || rows > 250) {
      throw problem('Invalid terminal size.', 400, 'EBADSIZE');
    }
    active(req.terminal, controller);
    req.terminal.pty.resize(cols, rows);
    res.status(204).end();
  }));
  app.post('/api/terminals/:id/rename', lookup, route(async (req, res) => {
    const { title } = req.body || {};
    if (typeof title !== 'string' || !title.trim() || title.length > 80 || /[\x00-\x1f\x7f]/.test(title)) {
      throw problem('Use a task name from 1 to 80 characters.', 400, 'EBADTITLE');
    }
    const t = req.terminal;
    t.title = title.trim();
    send(t, 'state', view(t));
    if (t.sessionId) await queueLabel(t, t.sessionId, t.title);
    res.json(view(t));
  }));
  app.post('/api/terminals/:id/close', lookup, route((req, res) => {
    stop(req.terminal);
    res.status(204).end();
  }));
}
