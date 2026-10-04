/**
 * Session-history part of the smoke test: a synthetic Claude data folder, and
 * the assertions run against the real HTTP API over it.
 *
 * Synthetic on purpose. Real transcripts hold the owner's prompts, CLAUDE.md
 * bodies and account email, so none are ever used as fixtures. The record
 * shapes below mirror what Claude Code 2.1.282 writes (surveyed 2026-09-26).
 *
 * Sentinels mark content that must never leave the server: instruction bodies,
 * tool output, a pasted secret in history.jsonl, and the .key file beside a
 * running session's pid file. Every response is searched for all of them.
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

import { consoleStart } from '../server/launch.js';
import { projectSlug } from '../server/paths.js';

export const SENTINELS = {
  instructionBody: 'SMOKE-INSTRUCTION-BODY',
  nestedBody: 'SMOKE-NESTED-BODY',
  toolOutput: 'SMOKE-TOOL-OUTPUT',
  pasted: 'SMOKE-PASTED-SECRET',
  keyFile: 'SMOKE-KEY-FILE',
  hookToolInput: 'SMOKE-HOOK-TOOL-INPUT',
  hookContext: 'SMOKE-HOOK-CONTEXT',
};

/** A launch made before a (simulated) restart: on disk, never registered in memory. */
export const PRIOR_LAUNCH = { id: 'feedfacecafebeef', secret: 'a'.repeat(48) };
export const PRIOR_LAUNCH_B = { id: 'fffe0000fffe0000', secret: 'c'.repeat(48) };

/**
 * This process's creation time as a UTC FILETIME, the form Claude Code writes
 * into procStart. Windows only; elsewhere the pid file carries none.
 */
function ownProcStart() {
  return cimStart(process.pid, 'filetime');
}

/**
 * A process's creation time the way Claude Code writes procStart, from CIM:
 * 'filetime' (the native build uses GetProcessTimes, the same instant) or
 * 'ticks', its npm build's exact expression, CreationDate.Ticks (#82).
 * Deliberately NOT the product's Get-Process query: a fixture built by the
 * code it checks can only agree with it (3e).
 */
function cimStart(pid, form) {
  if (process.platform !== 'win32') return null;
  const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const expr = form === 'ticks' ? 'CreationDate.Ticks' : 'CreationDate.ToFileTimeUtc()';
  const r = spawnSync(ps, ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").${expr}`], { encoding: 'utf8', timeout: 15000, windowsHide: true });
  const v = String(r.stdout || '').trim();
  return /^\d+$/.test(v) ? v : null;
}

/** Idle processes standing in for running sessions; stopFixtureProcesses ends them. */
const fixtureChildren = [];
export function idleProcess() {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: 'ignore', windowsHide: true });
  fixtureChildren.push(child);
  return child;
}
export function stopFixtureProcesses() {
  for (const c of fixtureChildren) c.kill();
}

/** A two-record transcript (one prompt, one reply): enough for discovery and a session view. */
export async function minimalTranscript(projDir, sessionId, proj, text, { model = 'claude-opus-5', contextTokens = 1001 } = {}) {
  const at = (s) => new Date(Date.now() - 60_000 + s * 1000).toISOString();
  const base = { sessionId, cwd: proj, version: '2.1.282', entrypoint: 'cli' };
  await fs.writeFile(
    path.join(projDir, `${sessionId}.jsonl`),
    [
      { ...base, uuid: `${sessionId.slice(0, 24)}000000000001`, timestamp: at(0), type: 'user', origin: { kind: 'human' }, message: { role: 'user', content: text } },
      {
        ...base,
        uuid: `${sessionId.slice(0, 24)}000000000002`,
        timestamp: at(1),
        type: 'assistant',
        message: { id: `m_${sessionId.slice(0, 8)}`, model, role: 'assistant', content: [{ type: 'text', text: 'Ok.' }], usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: contextTokens - 1, output_tokens: 1 } },
      },
    ]
      .map((r) => JSON.stringify(r))
      .join('\n') + '\n'
  );
}

export const IDS = {
  onDisk: '11111111-1111-4111-8111-111111111111',
  historyOnly: '22222222-2222-4222-8222-222222222222',
  expired: '33333333-3333-4333-8333-333333333333',
  undiscovered: '44444444-4444-4444-8444-444444444444',
  // A launched session: transcript on disk but no pid file, as measured for a
  // real launch, so its liveness can only come from the hooks.
  launched: '55555555-5555-4555-8555-555555555555',
  // Another launched session with no pid file, left at a permission prompt.
  dialog: '99999999-9999-4999-8999-999999999999',
  // A model family the window table does not know, holding 350K of context.
  future: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  // npm-installed Claude Code: procStart in .NET ticks, running and reused (#82).
  npm: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  npmReused: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
};
const AGENT_BG = 'a0123456789abcdef';
const AGENT_HANDBACK = 'afedcba9876543210';
// Background agents that finish through queued_command attachments (#111).
const AGENT_Q1 = 'a1111111111111111';
const AGENT_Q2 = 'a2222222222222222';

let seq = 0;
function rec(fields, at) {
  seq += 1;
  return {
    uuid: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    sessionId: IDS.onDisk,
    timestamp: at || new Date(Date.UTC(2026, 8, 20, 10, 0, seq)).toISOString(),
    version: '2.1.282',
    entrypoint: 'cli',
    ...fields,
  };
}

function usage(input, cacheCreate, cacheRead, output) {
  return { input_tokens: input, cache_creation_input_tokens: cacheCreate, cache_read_input_tokens: cacheRead, output_tokens: output };
}

function assistant(id, block, u, extra = {}) {
  return { type: 'assistant', message: { id, role: 'assistant', model: 'claude-opus-5-5', content: [block], usage: u }, requestId: `req_${id}`, ...extra };
}

function human(text) {
  return { type: 'user', origin: { kind: 'human' }, promptSource: 'typed', message: { role: 'user', content: text } };
}

/** The transcript, record by record. Expected results are asserted in runSessionChecks. */
function transcript(proj) {
  const u1 = usage(10, 1000, 5000, 50);
  const u3 = usage(1, 0, 7000, 30);
  const records = [
    { type: 'mode', mode: 'normal' },
    { type: 'attachment', attachment: { type: 'instructions', files: [{ path: path.join(proj, 'CLAUDE.md'), type: 'Project', content: SENTINELS.instructionBody }] } },
    { type: 'attachment', attachment: { type: 'model', identity: { modelId: 'claude-opus-5-5[1m]', marketingName: 'Opus 5.5 (1M context)' } } },
    { type: 'user', isMeta: true, message: { role: 'user', content: '<local-command-caveat>Caveat</local-command-caveat>' } },
    { type: 'user', origin: { kind: 'human' }, message: { role: 'user', content: '<command-name>/clear</command-name>\n<command-args></command-args>' } },
    human('First prompt: fix the widget'),
    assistant('msg_1', { type: 'text', text: 'Looking at the widget.' }, u1),
    // Same message id, same usage: one API call written as two block records.
    assistant('msg_1', { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: path.join(proj, 'widget.js') } }, u1),
    { type: 'user', sourceToolAssistantUUID: 'x', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: SENTINELS.toolOutput }] }, toolUseResult: { type: 'text' } },
    assistant('msg_2', { type: 'text', text: 'Fixed it.' }, usage(5, 200, 6000, 80)),
    { type: 'system', subtype: 'turn_duration', durationMs: 4200, pendingBackgroundAgentCount: 1 },
    human('Second prompt: run the agents'),
    assistant('msg_3', { type: 'tool_use', id: 'toolu_2', name: 'Agent', input: { subagent_type: 'Explore', description: 'find tests', run_in_background: true, prompt: 'x' } }, u3),
    assistant('msg_3', { type: 'tool_use', id: 'toolu_3', name: 'Agent', input: { subagent_type: 'general-purpose', description: 'review', prompt: 'y' } }, u3),
    { type: 'user', sourceToolUseID: 'toolu_2', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: 'launched' }] }, toolUseResult: { agentId: AGENT_BG, status: 'async_launched' } },
    { type: 'user', sourceToolUseID: 'toolu_3', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_3', content: 'launched' }] }, toolUseResult: { agentId: AGENT_HANDBACK, status: 'async_launched' } },
    {
      type: 'user',
      origin: { kind: 'task-notification' },
      promptSource: 'system',
      message: {
        role: 'user',
        content: `<task-notification><task-id>${AGENT_BG}</task-id><tool-use-id>toolu_2</tool-use-id><status>completed</status><usage><subagent_tokens>1234</subagent_tokens><tool_uses>7</tool_uses><duration_ms>9000</duration_ms></usage></task-notification>`,
      },
    },
    { type: 'user', isMeta: true, origin: { kind: 'peer', from: AGENT_HANDBACK, handback: true }, message: { role: 'user', content: 'report' } },
    { type: 'attachment', attachment: { type: 'nested_memory', path: path.join(proj, 'sub', 'CLAUDE.md'), content: { path: path.join(proj, 'sub', 'CLAUDE.md'), type: 'Project', content: SENTINELS.nestedBody } } },
    assistant('msg_4', { type: 'tool_use', id: 'toolu_4', name: 'Bash', input: { command: 'rm -rf build', description: 'Remove build' } }, usage(2, 0, 7100, 10)),
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_4', is_error: true, content: 'Permission for this action was denied by the Claude Code auto mode classifier.' }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } },
    { type: 'assistant', isApiErrorMessage: true, error: 'rate_limit', apiErrorStatus: 429, message: { id: 'err_1', model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: 'Rate limited' }] } },
    { type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', compactMetadata: { trigger: 'auto', preTokens: 900000, postTokens: 30000, durationMs: 1000 } },
    { type: 'user', isCompactSummary: true, message: { role: 'user', content: 'This session is being continued from a previous conversation.' } },
    human('Third prompt after compaction'),
    assistant('msg_5', { type: 'text', text: 'Done.' }, usage(3, 100, 29000, 20)),
    // Two more background agents, finished the way Claude Code now often
    // reports it: a queued_command attachment, not a user record (#111). The
    // second notice carries only a task id, which is the agent id.
    assistant('msg_6', { type: 'tool_use', id: 'toolu_5', name: 'Agent', input: { subagent_type: 'Explore', description: 'scan logs', prompt: 'z' } }, usage(1, 0, 7200, 10)),
    assistant('msg_6', { type: 'tool_use', id: 'toolu_6', name: 'Agent', input: { subagent_type: 'general-purpose', description: 'draft', prompt: 'w' } }, usage(1, 0, 7200, 10)),
    { type: 'user', sourceToolUseID: 'toolu_5', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_5', content: 'launched' }] }, toolUseResult: { agentId: AGENT_Q1, status: 'async_launched' } },
    { type: 'user', sourceToolUseID: 'toolu_6', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_6', content: 'launched' }] }, toolUseResult: { agentId: AGENT_Q2, status: 'async_launched' } },
    { type: 'attachment', attachment: { type: 'queued_command', commandMode: 'task-notification', prompt: `<task-notification><task-id>${AGENT_Q1}</task-id><tool-use-id>toolu_5</tool-use-id><status>completed</status><usage><subagent_tokens>555</subagent_tokens><tool_uses>3</tool_uses><duration_ms>4000</duration_ms></usage></task-notification>` } },
    { type: 'attachment', attachment: { type: 'queued_command', commandMode: 'task-notification', prompt: `<task-notification><task-id>${AGENT_Q2}</task-id><status>killed</status></task-notification>` } },
    // A prompt typed while Claude worked: written ONLY as this attachment (#112).
    { type: 'attachment', attachment: { type: 'queued_command', commandMode: 'prompt', origin: { kind: 'human' }, humanTurn: true, prompt: 'Fourth prompt, typed while Claude was busy' } },
    // A peer message queued the same way is not the user's prompt.
    { type: 'attachment', attachment: { type: 'queued_command', commandMode: 'prompt', origin: { kind: 'peer', from: AGENT_Q1 }, isMeta: true, prompt: 'peer report' } },
    // An Agent call that failed: its subagent must not stay "starting" (#114).
    assistant('msg_7', { type: 'tool_use', id: 'toolu_7', name: 'Agent', input: { subagent_type: 'Explore', description: 'broken', prompt: 'v' } }, usage(1, 0, 7300, 10)),
    { type: 'user', sourceToolUseID: 'toolu_7', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_7', is_error: true, content: 'Agent type not found' }] }, toolUseResult: 'Error: Agent type not found' },
    // Drift inside attachments (#113): a known bookkeeping subtype is not
    // counted; an unknown subtype and an unknown queued mode are.
    { type: 'attachment', attachment: { type: 'total_tokens_reminder' } },
    { type: 'attachment', attachment: { type: 'future-attachment' } },
    { type: 'attachment', attachment: { type: 'queued_command', commandMode: 'future-mode', prompt: 'x' } },
    { type: 'ai-title', aiTitle: 'Fix the widget' },
    { type: 'system', subtype: 'away_summary', content: 'You were fixing the widget.' },
    { type: 'file-history-snapshot', snapshot: { trackedFileBackups: { 'widget.js': {} } } },
    { type: 'attachment', attachment: { type: 'hook_success', hookEvent: 'PostToolUse', exitCode: 0 } },
    // Claude Code 2.1.285's (#194): recognised, never counted as drift.
    { type: 'attachment', attachment: { type: 'hook_non_blocking_error', hookName: 'PreToolUse:Bash', hookEvent: 'PreToolUse', toolUseID: 'toolu_1', stderr: 'connect ECONNREFUSED 127.0.0.1:5178', stdout: '', exitCode: 1 } },
    { type: 'attachment', attachment: { type: 'hook_cancelled', hookName: 'PostToolUse:Edit', hookEvent: 'PostToolUse', toolUseID: 'toolu_1' } },
    { type: 'system', subtype: 'agents_killed' },
    // The user's own hook adding context: counted by name, its text never kept (#25).
    { type: 'attachment', attachment: { type: 'hook_additional_context', hookName: 'PostToolUse:Edit', hookEvent: 'PostToolUse', toolUseID: 'toolu_1', content: [SENTINELS.hookContext] } },
    { type: 'attachment', attachment: { type: 'deferred_tools_delta', failedMcpServers: ['broken-server'] } },
    // The drift canary: a record type this build has never seen.
    { type: 'future-record-type', payload: 1 },
    // Claude cd'd into a subfolder and the session ended there: the LAST
    // record's cwd is the subfolder, so "latest" and "first" genuinely differ.
    { type: 'mode', mode: 'normal', cwd: path.join(proj, 'sub') },
  ];
  const lines = records.map((r) => JSON.stringify(rec({ cwd: proj, gitBranch: 'main', ...r })));
  // A line written twice (same uuid) must not add a prompt, and a torn line
  // must be counted, not fatal.
  lines.splice(6, 0, lines[5]);
  lines.push('{"type": "user", "broken');
  return `${lines.join('\n')}\n`;
}

/** Builds the synthetic data folder and app-data folder under the smoke temp dir. */
export async function makeSessionFixture(smokeDir, proj) {
  const claudeData = path.join(smokeDir, 'claude-data');
  const appData = path.join(smokeDir, 'app-data');
  const projDir = path.join(claudeData, 'projects', projectSlug(proj));
  await fs.mkdir(path.join(projDir, IDS.onDisk, 'subagents'), { recursive: true });
  await fs.writeFile(path.join(projDir, `${IDS.onDisk}.jsonl`), transcript(proj));
  // The launched fixture also carries a mid-session model switch (a 1M model,
  // then Haiku at 200K) and a prompt over 64 KB, which is what broke the pipe
  // to a claude that exits without reading.
  const now = Date.now();
  const lrec = (i, fields) =>
    JSON.stringify({ uuid: `00000000-0000-4000-8000-99999999999${i}`, sessionId: IDS.launched, cwd: proj, timestamp: new Date(now + i * 1000).toISOString(), ...fields });
  await fs.writeFile(
    path.join(projDir, `${IDS.launched}.jsonl`),
    [
      lrec(0, { type: 'user', origin: { kind: 'human' }, message: { role: 'user', content: `A launched session ${'y'.repeat(120_000)}` } }),
      lrec(1, { type: 'assistant', message: { id: 'l1', model: 'claude-opus-5', role: 'assistant', content: [{ type: 'text', text: 'On Opus.' }], usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 150000, output_tokens: 1 } } }),
      lrec(2, { type: 'attachment', attachment: { type: 'model', identity: { modelId: 'claude-haiku-4-5', marketingName: 'Haiku 4.5' } } }),
      lrec(3, { type: 'assistant', message: { id: 'l2', model: 'claude-haiku-4-5', role: 'assistant', content: [{ type: 'text', text: 'On Haiku.' }], usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 170000, output_tokens: 1 } } }),
    ].join('\n') + '\n'
  );
  // An AI summary made while the expired session's transcript still existed.
  await fs.mkdir(path.join(appData, 'summaries'), { recursive: true });
  await fs.writeFile(
    path.join(appData, 'summaries', `${IDS.expired}.json`),
    JSON.stringify({ text: '- kept summary', at: '2026-08-01T00:00:00.000Z', model: 'claude-haiku-4-5', usage: {}, turns: 4 })
  );
  // Control folder for the stand-in claude (smoke-claude-stub.mjs).
  await fs.mkdir(path.join(smokeDir, 'claude-stub'), { recursive: true });
  await fs.writeFile(path.join(smokeDir, 'claude-stub', 'mode'), 'ok');
  await fs.writeFile(path.join(projDir, IDS.onDisk, 'subagents', `agent-${AGENT_BG}.jsonl`), '{"type":"user"}\n');

  // A running session: this smoke process's own pid is guaranteed alive. Its
  // procStart is this process's real creation time, as Claude Code writes it,
  // so the check that drops reused pids must keep this one (#1).
  await fs.mkdir(path.join(claudeData, 'sessions'), { recursive: true });
  const procStart = ownProcStart();
  await fs.writeFile(
    path.join(claudeData, 'sessions', `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, sessionId: IDS.onDisk, cwd: proj, status: 'busy', kind: 'interactive', version: '2.1.282', ...(procStart ? { procStart } : {}) })
  );
  // #82: an npm-installed Claude Code writes procStart as .NET ticks. One idle
  // process carries its true ticks and must stay live; another carries ticks
  // two seconds off (its pid reused, as far as the check can tell) and must not.
  if (process.platform === 'win32') {
    for (const [id, offset] of [[IDS.npm, 0n], [IDS.npmReused, 20_000_000n]]) {
      const child = idleProcess();
      const ticks = cimStart(child.pid, 'ticks');
      await minimalTranscript(projDir, id, proj, `A session of an npm-installed Claude Code (${offset ? 'pid reused' : 'running'})`);
      if (ticks) {
        await fs.writeFile(
          path.join(claudeData, 'sessions', `${child.pid}.json`),
          JSON.stringify({ pid: child.pid, sessionId: id, cwd: proj, status: 'idle', kind: 'interactive', version: '2.1.283', procStart: String(BigInt(ticks) + offset) })
        );
      }
    }
  }
  // A crashed session's pid file whose pid now belongs to another process:
  // the parent of this run is alive, but was not started at this procStart.
  await fs.writeFile(
    path.join(claudeData, 'sessions', `${process.ppid}.json`),
    JSON.stringify({ pid: process.ppid, sessionId: IDS.future, cwd: proj, status: 'busy', kind: 'interactive', version: '2.1.282', procStart: '116444736000000000' })
  );
  await fs.writeFile(path.join(claudeData, 'sessions', `${process.pid}.deadbeef.key`), SENTINELS.keyFile);

  await fs.writeFile(
    path.join(claudeData, 'history.jsonl'),
    [
      { display: 'First prompt: fix the widget', timestamp: Date.UTC(2026, 8, 20, 10), project: proj, sessionId: IDS.onDisk, pastedContents: {} },
      { display: 'An old prompt whose transcript is gone', timestamp: Date.UTC(2026, 6, 1, 9), project: proj, sessionId: IDS.historyOnly, pastedContents: { 1: { id: 1, type: 'text', content: SENTINELS.pasted } } },
    ]
      .map((r) => JSON.stringify(r))
      .join('\n') + '\n'
  );

  await fs.mkdir(path.join(appData, 'launches'), { recursive: true });
  await fs.writeFile(
    path.join(appData, 'launches', `${PRIOR_LAUNCH.id}.json`),
    // Written as by a previous run: it also carried the on-disk session,
    // taken on 2026-09-01, and never saw it end.
    JSON.stringify({
      ...PRIOR_LAUNCH,
      dir: proj,
      sessionId: IDS.launched,
      createdAt: '2026-09-01T00:00:00.000Z',
      sessionIds: [IDS.launched, IDS.onDisk],
      since: { [IDS.launched]: '2026-09-01T00:00:00.000Z', [IDS.onDisk]: '2026-09-01T00:00:01.000Z' },
    })
  );
  // A launch CREATED earlier that took the on-disk session on LATER
  // (2026-09-02, by /resume) and saw it end there. After a restart nothing
  // has been heard from either, so the session belongs to this one: the tie
  // key is when a launch took the session on, not when it was created (#35,
  // #46). Its id sorts after PRIOR_LAUNCH's, so "first launch found" picks
  // the wrong one too. Restoring must also keep the end (#40).
  await fs.writeFile(
    path.join(appData, 'launches', `${PRIOR_LAUNCH_B.id}.json`),
    JSON.stringify({
      ...PRIOR_LAUNCH_B,
      dir: proj,
      sessionId: IDS.onDisk,
      createdAt: '2026-08-31T00:00:00.000Z',
      sessionIds: [IDS.onDisk],
      ended: { [IDS.onDisk]: 'prompt_input_exit' },
      since: { [IDS.onDisk]: '2026-09-02T00:00:00.000Z' },
    })
  );
  // A launched session with a transcript and no pid file that will sit at a
  // permission prompt (#41).
  await minimalTranscript(projDir, IDS.dialog, proj, 'A session that will wait at a prompt');
  await minimalTranscript(projDir, IDS.future, proj, 'A session on a model the table does not know', { model: 'claude-future-9', contextTokens: 350_000 });

  // A card LayerCake kept for a session whose transcript has since been cleaned up.
  await fs.mkdir(path.join(appData, 'cards'), { recursive: true });
  await fs.writeFile(
    path.join(appData, 'cards', `${IDS.expired}.json`),
    JSON.stringify({ sessionId: IDS.expired, title: 'An expired session', cwd: proj, prompts: 4, lastAt: '2026-08-01T00:00:00.000Z', size: 1, mtimeMs: 1 })
  );
  return { claudeData, appData };
}

export function get(base, pathname, headers) {
  return new Promise((resolve, reject) => {
    http
      .get(`${base}${pathname}`, { headers }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      })
      .on('error', reject);
  });
}

/** Opens an SSE stream and resolves with its status once headers arrive; `close` ends it. */
function openStream(base, pathname, headers) {
  return new Promise((resolve) => {
    const req = http.get(`${base}${pathname}`, { headers }, (res) => {
      res.resume();
      resolve({ status: res.statusCode, close: () => req.destroy() });
    });
    req.on('error', (e) => resolve({ status: `error ${e.code || e.message}`, close: () => {} }));
  });
}

/** Polls `fn` until it returns true or `ms` runs out: for state the server writes after answering. */
async function until(fn, ms = 3000) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * Claude Code runs a status line command through Git Bash when it is
 * installed, otherwise PowerShell (docs: status line, Windows configuration).
 */
async function statusLineShell() {
  if (process.platform !== 'win32') return { file: 'sh', args: ['-c'], name: 'sh' };
  const candidates = [
    process.env.CLAUDE_CODE_GIT_BASH_PATH,
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
  ];
  for (const c of candidates) {
    if (c && (await fs.access(c).then(() => true, () => false))) return { file: c, args: ['-c'], name: 'Git Bash' };
  }
  return { file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command'], name: 'PowerShell' };
}

/** Runs a generated status line command with its JSON on stdin, as Claude Code would. */
async function runStatusLine(command, json) {
  const sh = await statusLineShell();
  const r = spawnSync(sh.file, [...sh.args, command], { input: JSON.stringify(json), encoding: 'utf8', timeout: 15000, windowsHide: true });
  return { shell: sh.name, status: r.status, stdout: r.stdout || '', stderr: r.stderr || r.error?.message || '' };
}

/** Reads an SSE stream for `ms` and returns the raw text. */
function readStream(base, pathname, headers, ms) {
  return new Promise((resolve) => {
    let body = '';
    const req = http.get(`${base}${pathname}`, { headers }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
    });
    req.on('error', () => resolve(body));
    setTimeout(() => {
      req.destroy();
      resolve(body);
    }, ms);
  });
}

export async function runSessionChecks({ base, token, check, skip, proj, appData }) {
  const H = { 'X-LayerCake-Token': token };
  const bodies = [];
  const json = async (pathname) => {
    const r = await get(base, pathname, H);
    bodies.push(r.body);
    return { status: r.status, data: r.status === 200 ? JSON.parse(r.body) : null };
  };

  const list = await json(`/api/sessions?dir=${encodeURIComponent(proj)}`);
  check('session list loads', list.status === 200, `got ${list.status}`);
  const card = list.data.sessions.find((s) => s.sessionId === IDS.onDisk);
  check('the on-disk session is listed', Boolean(card));
  check('its title comes from the AI title Claude Code wrote', card?.title === 'Fix the widget' && card.titleSource === 'ai');
  check('prompts exclude tool results, meta, notifications and the duplicated line, and include a queued prompt', card?.prompts === 4, `got ${card?.prompts}`);
  check('slash commands are counted apart from prompts', card?.commands === 1, `got ${card?.commands}`);
  // Seven calls: msg_1 to msg_7, each counted once however many block records it has.
  check('usage is counted once per API call, not once per block', card?.tokens.apiCalls === 7 && card.tokens.input === 23 && card.tokens.output === 210, JSON.stringify(card?.tokens));
  check('a running session is marked live', card?.live === true && card.status === 'busy');
  check('retention defaults to 30 days when unset', list.data.retentionDays === 30);
  check('a session known only from history is listed as prompt-only', list.data.promptOnly.some((p) => p.sessionId === IDS.historyOnly && p.prompts === 1));
  check('a kept card for a cleaned-up session is listed as expired', list.data.expired.some((e) => e.sessionId === IDS.expired));

  const detail = await json(`/api/session/${IDS.onDisk}`);
  const d = detail.data;
  check('session detail loads', detail.status === 200, `got ${detail.status}`);
  // msg_7, the last call: 1 + 0 + 7300.
  check('context is the last call: input + cache creation + cache read', d?.context?.tokens === 7301, `got ${d?.context?.tokens}`);
  check('a 1M model id gives a 1M window', d?.health.context.window === 1_000_000);
  // #12: the model table cannot know a family that shipped after it was written.
  const future = (await json(`/api/session/${IDS.future}`)).data;
  check('a model the table does not know, holding 350K of context, gets a 1M window from observed usage',
    future?.health.context.window === 1_000_000 && future.health.context.windowSource === 'observed usage' &&
      Math.abs(future.health.context.pct - 0.35) < 1e-9 && !future.health.flags.includes('warning'),
    JSON.stringify(future?.health.context && { window: future.health.context.window, source: future.health.context.windowSource, pct: future.health.context.pct }));
  // #1: a pid file whose pid is alive but whose process started at another time.
  if (process.platform === 'win32') {
    check('a reused pid (alive, but started at another time than procStart) does not make a session live',
      future?.live === null, JSON.stringify(future?.live));
    check('a running process that matches its procStart stays live', d?.live?.pid === process.pid, JSON.stringify(d?.live));
    // #82: procStart as .NET ticks, the form an npm-installed Claude Code writes.
    const npmRunning = (await json(`/api/session/${IDS.npm}`)).data;
    const npmReused = (await json(`/api/session/${IDS.npmReused}`)).data;
    check('an npm-installed session (procStart in .NET ticks) that is running stays live',
      Number.isInteger(npmRunning?.live?.pid), JSON.stringify(npmRunning?.live));
    check('an npm-format procStart two seconds off its process (a reused pid) is not live',
      npmReused?.live === null, JSON.stringify(npmReused?.live));
  } else {
    skip('process start times confirm a running session (4 checks)', 'start times are read with PowerShell, Windows only');
  }
  check('memory loaded at start and on nested traversal are both recorded',
    d?.instructions.length === 2 && d.instructions.some((i) => i.reason === 'session_start') && d.instructions.some((i) => i.reason === 'nested'));
  const bg = d?.subagents.find((s) => s.agentId === AGENT_BG);
  const hb = d?.subagents.find((s) => s.agentId === AGENT_HANDBACK);
  check('a background subagent completes through its task notification', bg?.status === 'completed' && bg.tokens === 1234, JSON.stringify(bg));
  check('a subagent completes through a peer hand-back', hb?.status === 'completed', JSON.stringify(hb));
  // The fixture's last turn_duration still says 1 pending; the subagents say done.
  // The fixture's last turn_duration still says 1 pending, a field no longer served (#115).
  check('running subagents come from their statuses, not the stale turn record', d?.runningSubagents === 0 && !('backgroundPending' in d), `running ${d?.runningSubagents}`);
  const bySub = (pred) => d?.subagents.find(pred);
  const q1 = bySub((s) => s.agentId === AGENT_Q1);
  const q2 = bySub((s) => s.agentId === AGENT_Q2);
  check('a subagent completes through a queued task notification (#111)', q1?.status === 'completed' && q1.tokens === 555, JSON.stringify(q1));
  check('a queued notice with only a task id finds its subagent by agent id', q2?.status === 'killed', JSON.stringify(q2));
  const failedAgent = bySub((s) => s.toolUseId === 'toolu_7');
  check('a failed Agent call ends its subagent as failed, not starting (#114)', failedAgent?.status === 'failed' && Boolean(failedAgent.endAt), JSON.stringify(failedAgent));
  const queuedTurn = d?.turns.find((t) => t.preview.startsWith('Fourth prompt'));
  check('a prompt typed while Claude was busy is a turn of its own, marked queued; a queued peer message is not (#112)',
    queuedTurn?.kind === 'prompt' && queuedTurn.queued === true && !d.turns.some((t) => t.preview.startsWith('peer report')),
    JSON.stringify(queuedTurn));
  check('an unknown attachment subtype and an unknown queued mode are counted; known bookkeeping is not (#113)',
    d?.parse.unknown['attachment:future-attachment'] === 1 && d.parse.unknown['attachment:queued_command:future-mode'] === 1 &&
      !('attachment:total_tokens_reminder' in d.parse.unknown),
    JSON.stringify(d?.parse.unknown));
  check('an API error is recorded', d?.errors.length === 1 && d.errors[0].code === 'rate_limit');
  check('a compaction is recorded with its token counts', d?.compactions.length === 1 && d.compactions[0].preTokens === 900000);
  // Two failures: the denied Bash call, and the failed Agent call (#114); one denial.
  check('a denied tool call counts as a failure and a denial', d?.toolFailures === 2 && d.permissionDenials === 1, `${d?.toolFailures} ${d?.permissionDenials}`);
  check('the interrupted turn is flagged', d?.turns.find((t) => t.kind === 'prompt' && t.preview.startsWith('Second'))?.interrupted === true);
  check('an unrecognised record type is counted, not ignored (drift canary)', d?.parse.unknown['future-record-type'] === 1, JSON.stringify(d?.parse.unknown));
  check('2.1.285 hook errors, cancelled hooks and killed agents are recognised: hook runs, one failure, no drift (#194)',
    !['attachment:hook_non_blocking_error', 'attachment:hook_cancelled', 'system:agents_killed'].some((k) => k in (d?.parse.unknown || {})) &&
      d?.hooks?.runs === 3 && d.hooks.failures === 1 && d.hooks.byEvent?.PreToolUse === 1,
    JSON.stringify({ unknown: d?.parse.unknown, hooks: d?.hooks }));
  check('a torn line is counted, not fatal', d?.parse.badLines === 1);
  check('failed MCP servers are reported', d?.mcp.failed.includes('broken-server'));
  // Busy and running is "working", but the recent rate-limit error outranks it.
  check('a recent API error outranks "working" in health', d?.health.state === 'error' && d.health.reasons.includes('Claude Code reports it busy'), JSON.stringify(d?.health.reasons));
  check('health ships its rules', Array.isArray(d?.health.states) && d.health.states.every((s) => s.rule));
  check('a subagent transcript on disk shows activity', Boolean(d?.activity?.[AGENT_BG]));

  const firstPrompt = d?.turns.find((t) => t.kind === 'prompt');
  const turn = await json(`/api/session/${IDS.onDisk}/turn/${firstPrompt?.n}`);
  check('a turn joins its reply blocks in order', turn.data?.responseText === 'Looking at the widget.\n\nFixed it.', JSON.stringify(turn.data?.responseText));
  check('a turn lists its tool calls with a summary, not their output', turn.data?.toolCalls.length === 1 && turn.data.toolCalls[0].summary.endsWith('widget.js'));

  const hist = await json(`/api/history/${IDS.historyOnly}`);
  check('prompt-only history returns the prompt text', hist.data?.prompts[0].text === 'An old prompt whose transcript is gone');

  check('an undiscovered session id is refused', (await get(base, `/api/session/${IDS.undiscovered}`, H)).status === 404);
  check('a non-uuid session id is refused', (await get(base, '/api/session/..%5C..%5Cetc', H)).status === 400);
  check('session routes refuse a request with no token', (await get(base, `/api/session/${IDS.onDisk}`, {})).status === 403);

  const stream = await readStream(base, `/api/session/${IDS.onDisk}/stream`, H, 1500);
  check('the live stream sends an update', /event: update\ndata: \{"lastAt"/.test(stream));
  bodies.push(stream);

  // #30: the slot is taken before the first await, so opens arriving together
  // cannot all pass the limit check.
  const opened = await Promise.all(Array.from({ length: 6 }, () => openStream(base, `/api/session/${IDS.onDisk}/stream`, H)));
  const statuses = opened.map((o) => o.status);
  check('six streams opened at once: four get a slot, two are refused',
    statuses.filter((s) => s === 200).length === 4 && statuses.filter((s) => s === 429).length === 2, statuses.join(','));
  for (const o of opened) o.close();
  // All four at once: reopening one would pass with three slots leaked (#40).
  const reopened = await until(async () => {
    const again = await Promise.all(Array.from({ length: 4 }, () => openStream(base, `/api/session/${IDS.onDisk}/stream`, H)));
    for (const o of again) o.close();
    await new Promise((r) => setTimeout(r, 150));
    return again.every((o) => o.status === 200);
  });
  check('closing them gives every slot back (all four reopen at once)', reopened);

  const detailRes = await json(`/api/session/${IDS.onDisk}`);
  check('context added by hooks is counted by hook name (#25)',
    detailRes.data?.hooks.contextInjections === 1 && detailRes.data?.hooks.contextByHook?.['PostToolUse:Edit'] === 1,
    JSON.stringify(detailRes.data?.hooks));

  const usageRes = await json('/api/usage');
  check('LayerCake usage starts empty (no feature spent usage)', usageRes.data?.totals.runs === 0);

  const all = bodies.join('\n');
  for (const [name, value] of Object.entries(SENTINELS)) {
    check(`no response contains the ${name} sentinel`, !all.includes(value));
  }
  const persisted = await fs.readFile(path.join(appData, 'cards', `${IDS.onDisk}.json`), 'utf8').catch(() => null);
  check('the session card is kept in LayerCake data', Boolean(persisted) && JSON.parse(persisted).title === 'Fix the widget');
}

/** A POST with a JSON body and headers of our choosing (Host and Origin included). */
export function postRaw(base, pathname, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request(
      `${base}${pathname}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': data.length, ...headers } },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode, body: text }));
      }
    );
    req.on('error', reject);
    req.end(data);
  });
}

/**
 * Launch and ingest, with the server in dry-run mode (LAYERCAKE_LAUNCH_DRY_RUN=1):
 * everything except starting Windows Terminal.
 */
export async function runLaunchChecks({ base, port, token, check, scanId, proj, appData, claudeData, reportWindowMs, serverStartedAt, claudeProgram }) {
  const H = { 'X-LayerCake-Token': token };
  const bodies = [];

  // #40 (M1) and #35: restored from two records that both carry the on-disk
  // session. It belongs to the launch that took it on last, which was
  // created first, and that record says it ended. First, before anything in
  // this run posts for that session.
  const restoredEnd = JSON.parse((await get(base, `/api/session/${IDS.onDisk}`, H)).body);
  check('after a restart a session belongs to the launch that took it on last, and its recorded end is kept',
    restoredEnd.wrapped?.launchId === PRIOR_LAUNCH_B.id && restoredEnd.wrapped.ended === true && restoredEnd.wrapped.endReason === 'prompt_input_exit',
    JSON.stringify({ launch: restoredEnd.wrapped?.launchId, ended: restoredEnd.wrapped?.ended, reason: restoredEnd.wrapped?.endReason }));

  check('launch refuses a request with no token', (await postRaw(base, '/api/launch', { scanId })).status === 403);
  check('launch refuses an unknown scan', (await postRaw(base, '/api/launch', { scanId: 'scan-nope' }, H)).status === 404);

  // #20: Windows Terminal splits on ";" even inside a quoted argument, so a
  // folder named like this would chain a second command after Claude's tab.
  const hostile = path.join(path.dirname(proj), 'evil;calc.exe');
  await fs.mkdir(hostile, { recursive: true });
  const hostileScan = await postRaw(base, '/api/scan', { dir: hostile }, H);
  const hostileScanId = hostileScan.status === 200 ? JSON.parse(hostileScan.body).scanId : null;
  const launchFiles = async () => (await fs.readdir(path.join(appData, 'launches')).catch(() => [])).length;
  const filesBefore = await launchFiles();
  const refused = await postRaw(base, '/api/launch', { scanId: hostileScanId }, H);
  const refusal = (() => { try { return JSON.parse(refused.body); } catch { return {}; } })();
  check('launch refuses a project path containing ";" (a Windows Terminal separator)',
    hostileScanId && refused.status === 400 && /contains ";"/.test(refusal.message || '') && !('argv' in refusal),
    `scan ${hostileScan.status}, launch ${refused.status}`);
  check('a refused launch writes no launch record or settings file', (await launchFiles()) === filesBefore);

  const launched = await postRaw(base, '/api/launch', { scanId, screen: { width: 2560, height: 1440 } }, H);
  const l = launched.status === 200 ? JSON.parse(launched.body) : null;
  check('launch (dry run) returns its argv', l?.dryRun === true && Array.isArray(l.argv), `status ${launched.status}`);
  const argv = l?.argv || [];
  const at = (flag) => argv[argv.indexOf(flag) + 1];
  check('it opens a named Windows Terminal window, in the scanned directory', argv[0] === '-w' && argv[1] === 'LayerCake' && at('-d') === proj);
  // By its full path on Windows, never a bare name (#191); elsewhere launch is not offered.
  const claudeNamed = process.platform === 'win32' ? argv.includes(claudeProgram) && !argv.includes('claude') : argv.includes('claude');
  check('it runs claude by its full path (#191), with a fresh session id and the per-session settings file',
    claudeNamed && /^[0-9a-f-]{36}$/.test(at('--session-id')) && at('--settings') === l.settingsPath, JSON.stringify(argv));
  check('the settings file is kept in LayerCake data, not in ~/.claude', l?.settingsPath?.startsWith(path.join(appData, 'launches')));
  check('placement puts the terminal on the right half of the screen', at('--pos') === '1280,0');
  // #157: where wt.exe is missing, the same program and arguments start in a
  // console window, in the same folder.
  const plan = l?.console;
  const program = argv.slice(argv.indexOf('-d') + 2);
  check('without Windows Terminal, the same program starts in a console window in the same folder (#157)',
    plan?.file === program[0] && JSON.stringify(plan?.args) === JSON.stringify(program.slice(1)) && plan?.dir === proj,
    JSON.stringify({ plan: plan && { file: plan.file, args: plan.args, dir: plan.dir }, program }));
  // Its quoting, read back with rules written here rather than the producer's:
  // a PowerShell single-quoted literal un-doubles each quote character, and a
  // Windows command line splits on unquoted spaces. The expected values are
  // written out by hand, the working directory with its brackets escaped.
  const literal = (script, name) => {
    const m = new RegExp(`-${name} '((?:[^'\u2018-\u201B]|(['\u2018-\u201B])\\2)*)'`).exec(script || '');
    return m ? m[1].replace(/(['\u2018-\u201B])\1/g, '$1') : null;
  };
  const winArgv = (line) => [...String(line).matchAll(/"((?:[^"\\]|\\+(?!"))*)(\\*)"|[^\s"]+/g)].map((m) => (m[1] !== undefined ? m[1] + m[2].slice(m[2].length / 2) : m[0]));
  const tricky = consoleStart('C:\\p [x] O\u2019Brien & 100%\\it\'s', ['C:\\Program Files\\n\\node.exe', 'C:\\a b\\cli.js', '--session-id', 'u-1', '--settings', 'C:\\x y\\l.json']);
  check('the console start quotes every value for PowerShell and for Windows (#157)',
    literal(tricky.script, 'FilePath') === 'C:\\Program Files\\n\\node.exe' &&
      JSON.stringify(winArgv(literal(tricky.script, 'ArgumentList'))) === JSON.stringify(['C:\\a b\\cli.js', '--session-id', 'u-1', '--settings', 'C:\\x y\\l.json']) &&
      literal(tricky.script, 'WorkingDirectory') === 'C:\\p `[x`] O\u2019Brien & 100%\\it\'s',
    tricky.script);

  const settings = JSON.parse(await fs.readFile(l.settingsPath, 'utf8'));
  const hookUrl = settings.hooks?.Notification?.[0]?.hooks?.[0]?.url || '';
  const m = new RegExp(`^http://127\\.0\\.0\\.1:${port}/ingest/([0-9a-f]{16})/([0-9a-f]{48})/hook$`).exec(hookUrl);
  check('hooks post to this server with a launch id and secret', Boolean(m), hookUrl);
  check('every hook is an http hook with a short timeout',
    Object.values(settings.hooks).every((groups) => groups[0].hooks[0].type === 'http' && groups[0].hooks[0].timeout === 3));
  check('the status line command is curl.exe posting to this launch',
    settings.statusLine.type === 'command' && /^curl\.exe /.test(settings.statusLine.command) && settings.statusLine.command.includes(`/ingest/${m?.[1]}/`));
  check('the status line re-runs on a timer shorter than the report window (#31)',
    Number.isInteger(settings.statusLine.refreshInterval) && settings.statusLine.refreshInterval >= 1 &&
      settings.statusLine.refreshInterval * 1000 < 45_000, `refreshInterval ${settings.statusLine.refreshInterval}`);

  const [launchId, secret] = m ? [m[1], m[2]] : ['0', '0'];
  const ingest = (kind, body, headers) => postRaw(base, `/ingest/${launchId}/${secret}/${kind}`, body, headers);
  const sid = IDS.onDisk;

  // #42: a launch whose status line and hooks never report (disableAllHooks,
  // a managed policy, an untrusted folder) while its session writes a
  // transcript. First, before anything posts for this launch.
  await minimalTranscript(path.join(claudeData, 'projects', projectSlug(proj)), l.sessionId, proj, 'A session whose channels are blocked');
  const blocked = JSON.parse((await get(base, `/api/session/${l.sessionId}`, H)).body);
  const blockedRow = JSON.parse((await get(base, `/api/sessions?dir=${encodeURIComponent(proj)}`, H)).body).sessions.find((x) => x.sessionId === l.sessionId);
  check('a launch that never reported says its channels are blocked, not that it crashed',
    blocked.live === null && blocked.wrapped?.neverReported === true && blocked.health.reasons.some((r) => /never reported/.test(r)) &&
      !blocked.health.reasons.some((r) => /crashed/.test(r)) && blockedRow?.quiet === 'blocked',
    JSON.stringify({ reasons: blocked.health?.reasons, quiet: blockedRow?.quiet }));

  // The generated command is RUN, the way Claude Code runs it, with the status
  // JSON on stdin, rather than posted for it: a command that sends nothing, or
  // sends it to the wrong route, fails here and in the exact-context check
  // below, which reads what the server recorded (#27).
  const sl = await runStatusLine(settings.statusLine.command, {
    session_id: sid,
    model: { id: 'claude-opus-5-5[1m]', display_name: 'Opus 5.5' },
    context_window: { used_percentage: 42.4, context_window_size: 1000000 },
    cost: { total_cost_usd: 1.234 },
    rate_limits: { five_hour: { used_percentage: 12, resets_at: 1790500000 } },
    prompt_cache: { warm: true, expires_at: 1790500000 },
  });
  check('the status line command, run in a shell, prints the line LayerCake returns',
    sl.status === 0 && /ctx 42%/.test(sl.stdout) && /\$1\.23/.test(sl.stdout) && /5h 12%/.test(sl.stdout), `${sl.shell}: ${sl.stdout || sl.stderr}`);

  const hooks = [
    { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' },
  ];
  let allEmpty = true;
  for (const h of hooks) {
    const r = await ingest('hook', { session_id: sid, ...h });
    allEmpty = allEmpty && r.status === 204 && r.body.length === 0;
  }
  let d = JSON.parse((await get(base, `/api/session/${sid}`, H)).body);
  bodies.push(JSON.stringify(d));
  check('a launched session reports exact context from its status line',
    d.health.context.source === 'status line (exact)' && Math.abs(d.health.context.pct - 0.424) < 1e-9, JSON.stringify(d.health.context));
  check('a permission prompt marks the session as waiting for you',
    d.health.flags.includes('waiting') && d.health.reasons.includes('Claude needs your permission to use Bash'), JSON.stringify(d.health.reasons));
  check('the session list marks it as launched by LayerCake',
    JSON.parse((await get(base, `/api/sessions?dir=${encodeURIComponent(proj)}`, H)).body).sessions.find((s) => s.sessionId === sid)?.launched === true);

  const more = [
    { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'toolu_live', tool_input: { command: SENTINELS.hookToolInput, description: 'Run the tests' } },
  ];
  for (const h of more) {
    const r = await ingest('hook', { session_id: sid, ...h });
    allEmpty = allEmpty && r.status === 204 && r.body.length === 0;
  }
  d = JSON.parse((await get(base, `/api/session/${sid}`, H)).body);
  bodies.push(JSON.stringify(d));
  check('a tool starting clears "waiting"', !d.health.flags.includes('waiting'));
  check('a running tool is shown by its summary', d.wrapped.running.length === 1 && d.wrapped.running[0].summary === 'Run the tests');

  const last = [
    { hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_use_id: 'toolu_live', error: 'exit 1' },
    { hook_event_name: 'InstructionsLoaded', file_path: path.join(proj, 'CLAUDE.md'), memory_type: 'Project', load_reason: 'include', parent_file_path: path.join(proj, 'x.md') },
  ];
  for (const h of last) {
    const r = await ingest('hook', { session_id: sid, ...h });
    allEmpty = allEmpty && r.status === 204 && r.body.length === 0;
  }
  d = JSON.parse((await get(base, `/api/session/${sid}`, H)).body);
  bodies.push(JSON.stringify(d));
  check('a failed tool is counted and no longer running', d.wrapped.running.length === 0 && d.wrapped.toolFailures === 1);
  check('InstructionsLoaded keeps its load reason', d.wrapped.instructionsLoaded.some((i) => i.reason === 'include'));

  check('ingest refuses a wrong secret', (await postRaw(base, `/ingest/${launchId}/${'0'.repeat(48)}/hook`, { session_id: sid })).status === 403);
  check('ingest refuses an unknown launch', (await postRaw(base, `/ingest/0123456789abcdef/${secret}/hook`, { session_id: sid })).status === 404);
  check('ingest refuses anything a browser sent (Origin present)', (await ingest('hook', { session_id: sid }, { Origin: `http://127.0.0.1:${port}` })).status === 403);
  check('ingest refuses a foreign Host', (await ingest('hook', { session_id: sid }, { Host: `rebind.example:${port}` })).status === 403);

  const session = async (id) => {
    const r = await get(base, `/api/session/${id}`, H);
    bodies.push(r.body);
    return JSON.parse(r.body);
  };
  const hookVia = async (post, h) => {
    const r = await post('hook', h);
    allEmpty = allEmpty && r.status === 204 && r.body.length === 0;
    return r;
  };
  const hook = (h) => hookVia(ingest, { session_id: sid, ...h });

  // --- #23: ends Claude Code never reports. toolu_4 has a result in the
  // fixture transcript (a denied Bash call); the hooks saw it start and ask
  // for permission, and no hook reported the answer.
  const rmBuild = { tool_name: 'Bash', tool_input: { command: 'rm -rf build', description: 'Remove build' } };
  await hook({ hook_event_name: 'PreToolUse', tool_use_id: 'toolu_4', ...rmBuild });
  await hook({ hook_event_name: 'PermissionRequest', ...rmBuild });
  d = await session(sid);
  check('a tool whose result is already in the transcript is not "running" (Esc and denials fire no hook)',
    !d.wrapped.running.some((t) => t.id === 'toolu_4'), JSON.stringify(d.wrapped.running));
  check('a permission wait ends once its tool has a result in the transcript',
    d.wrapped.waiting === null && !d.health.flags.includes('waiting'), JSON.stringify(d.wrapped.waiting));

  const npmTest = { tool_name: 'Bash', tool_input: { command: 'npm test', description: 'Run the tests' } };
  await hook({ hook_event_name: 'PreToolUse', tool_use_id: 'toolu_pending', ...npmTest });
  await hook({ hook_event_name: 'PermissionRequest', ...npmTest });
  d = await session(sid);
  check('an unanswered permission request shows as waiting, marked as a permission',
    d.health.flags.includes('waiting') && d.wrapped.waiting?.permission === true, JSON.stringify(d.wrapped.waiting));
  await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'next' });
  d = await session(sid);
  check('a new prompt clears tools that never reported finishing', d.wrapped.running.length === 0, JSON.stringify(d.wrapped.running));

  // --- #29: the other documented "waiting on you" notifications.
  for (const type of ['elicitation_url_dialog', 'quota_auto_resume_stale']) {
    await hook({ hook_event_name: 'Notification', notification_type: type, message: `smoke ${type}` });
    d = await session(sid);
    check(`a ${type} notification marks the session as waiting`, d.health.flags.includes('waiting') && d.wrapped.waiting?.kind === type);
    await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'next' });
  }

  // --- #24 and #27: a launch from before a restart. PRIOR_LAUNCH was written
  // to app data before this server started; its session has a transcript and
  // no pid file, as measured for a real launch.
  const lid = IDS.launched;
  const prior = (kind, body) => postRaw(base, `/ingest/${PRIOR_LAUNCH.id}/${PRIOR_LAUNCH.secret}/${kind}`, body);
  // Past the report window since the server started, so the reason must be
  // the "most likely stopped" one, not "moments ago" (#31, #46).
  const uptime = Date.now() - serverStartedAt;
  if (uptime < reportWindowMs + 300) await new Promise((r) => setTimeout(r, reportWindowMs + 300 - uptime));
  const before = await session(lid);
  const row = JSON.parse((await get(base, `/api/sessions?dir=${encodeURIComponent(proj)}`, H)).body).sessions.find((s) => s.sessionId === lid);
  check('a launch from before a restart is restored at startup: its session is still marked launched',
    before.wrapped?.launchId === PRIOR_LAUNCH.id && row?.launched === true, JSON.stringify(row));
  check('silent since a restart, past the window: neither "running" nor "No running process", but "most likely stopped"',
    before.live === null && before.wrapped.quiet === true && row?.quiet === 'restart' &&
      before.health.reasons.some((r) => /^No report since LayerCake restarted;.*most likely stopped/.test(r)) &&
      !before.health.reasons.includes('No running process'),
    JSON.stringify({ reasons: before.health.reasons, quiet: row?.quiet }));
  check('after a switch to Haiku the window is 200K, not the earlier 1M model\'s',
    before.health.context.window === 200_000, `window ${before.health.context.window}`);
  const priorSl = await prior('statusline', { session_id: lid, context_window: { used_percentage: 5, context_window_size: 200000 } });
  let ld = await session(lid);
  check('a restored launch\'s report reaches the session view, not just a 200',
    priorSl.status === 200 && ld.health.context.source === 'status line (exact)' && Math.abs(ld.health.context.pct - 0.05) < 1e-9,
    JSON.stringify(ld.health.context));
  await hookVia(prior, { session_id: lid, hook_event_name: 'PreToolUse', tool_use_id: 'toolu_lid', tool_name: 'Bash', tool_input: { command: 'make', description: 'Build' } });
  ld = await session(lid);
  check('once it reports, the launched session counts as running', ld.live?.source === 'hooks' && ld.health.state !== 'offline', JSON.stringify(ld.live));
  check('"busy" from hooks says so, rather than that Claude Code reported it',
    ld.health.reasons.includes('A tool is running (from its hooks)'), JSON.stringify(ld.health.reasons));
  await hookVia(prior, { session_id: lid, hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' });
  ld = await session(lid);
  check('its SessionEnd hook marks it not running', ld.live === null && ld.health.state === 'offline', JSON.stringify(ld.live));
  const recordFile = path.join(appData, 'launches', `${PRIOR_LAUNCH.id}.json`);
  const remembered = await until(async () => {
    const r = JSON.parse(await fs.readFile(recordFile, 'utf8'));
    return r.ended?.[lid] === 'prompt_input_exit' && r.secret === PRIOR_LAUNCH.secret;
  });
  check('the end is written to the launch record, so a restart remembers it', remembered);

  // --- #40 (M4): /resume away from sid and back, inside the same terminal.
  await hook({ hook_event_name: 'SessionEnd', reason: 'resume' });
  d = await session(sid);
  const endedByResume = d.wrapped.ended === true && d.wrapped.launchId === launchId;
  // The record's own value before the revival: comparing against this
  // process's clock failed 1 run in 6, because two processes on Windows can
  // read the time a millisecond apart.
  const dryRunRecord = path.join(appData, 'launches', `${launchId}.json`);
  const readSince = async () => JSON.parse(await fs.readFile(dryRunRecord, 'utf8')).since?.[sid] ?? null;
  let sinceBefore = null;
  await until(async () => Boolean((sinceBefore = await readSince())));
  await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'back again' });
  d = await session(sid);
  check('a session /resumed back into the same terminal is no longer ended',
    endedByResume && d.wrapped.ended === false && d.wrapped.launchId === launchId, JSON.stringify({ endedByResume, ended: d.wrapped.ended }));
  // #47: taken on again now, so the record's tie key moves with it.
  let lastSince = null;
  const retaken = await until(async () => {
    lastSince = await readSince();
    return typeof lastSince === 'string' && lastSince > sinceBefore;
  });
  const launchNow = JSON.parse((await get(base, '/api/launches', H)).body).launches.find((x) => x.id === launchId);
  check('reviving a session records when it was taken on again', retaken,
    JSON.stringify({ sinceBefore, lastSince, persistError: launchNow?.persistError, ended: launchNow?.sessions.find((x) => x.id === sid)?.ended }));

  // --- #22: one terminal, several sessions. /clear in the launched terminal
  // ends sid, and a new session reports 3%.
  const fresh = '66666666-6666-4666-8666-666666666666';
  await hook({ hook_event_name: 'SessionEnd', reason: 'clear' });
  await ingest('statusline', { session_id: fresh, context_window: { used_percentage: 3, context_window_size: 200000 }, cost: { total_cost_usd: 0.01 } });
  d = await session(sid);
  check('after /clear, the old session does not show the new one\'s context as exact',
    d.health.context.source === 'transcript (estimate)' && d.wrapped.ended === true && d.wrapped.statusline?.sessionId === sid,
    JSON.stringify({ context: d.health.context, ended: d.wrapped.ended, sl: d.wrapped.statusline?.sessionId }));

  // #44: a status line already in flight when the session ended lands after it.
  await ingest('statusline', { session_id: sid, context_window: { used_percentage: 50, context_window_size: 1000000 } });
  d = await session(sid);
  check('a status line landing just after SessionEnd does not revive the session', d.wrapped.ended === true, JSON.stringify({ ended: d.wrapped.ended }));

  // #36: an async event arriving after the end does not revive it.
  await hook({ hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'late' });
  await hook({ hook_event_name: 'InstructionsLoaded', file_path: path.join(proj, 'CLAUDE.md'), load_reason: 'session_start' });
  d = await session(sid);
  check('a late Notification or InstructionsLoaded does not revive an ended session', d.wrapped.ended === true && d.live?.source !== 'hooks');

  // #37: a post with no valid session id is answered and changes nothing.
  const launchesNow = async () => JSON.parse((await get(base, '/api/launches', H)).body).launches.find((x) => x.id === launchId);
  // The launch's own first session ends first: a fallback that pinned an
  // anonymous post on it would revive it, which is the defect (#37).
  await hookVia(ingest, { session_id: l.sessionId, hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' });
  const beforeAnon = await launchesNow();
  const anon = await postRaw(base, `/ingest/${launchId}/${secret}/hook`, { hook_event_name: 'UserPromptSubmit', prompt: 'who am I' });
  const anonSl = await postRaw(base, `/ingest/${launchId}/${secret}/statusline`, { session_id: 'not-a-uuid', context_window: { used_percentage: 9 } });
  const afterAnon = await launchesNow();
  d = await session(sid);
  check('a post without a valid session id is answered but changes nothing',
    anon.status === 204 && anon.body === '' && anonSl.status === 200 &&
      JSON.stringify(afterAnon.sessions.map((x) => [x.id, x.ended])) === JSON.stringify(beforeAnon.sessions.map((x) => [x.id, x.ended])) &&
      d.wrapped.ended === true,
    JSON.stringify({ before: beforeAnon.sessions.length, after: afterAnon.sessions.length, ended: d.wrapped.ended }));

  // #33: hostile bodies (a toString that is not a function) are answered and
  // do not take the server down. The fresh id has no transcript: nothing else
  // in this run reads it.
  const hostileBody = { toString: null };
  const hostileId = '77777777-7777-4777-8777-777777777777';
  const h1 = await postRaw(base, `/ingest/${launchId}/${secret}/hook`, { session_id: hostileBody, hook_event_name: hostileBody, tool_use_id: hostileBody });
  const h2 = await postRaw(base, `/ingest/${launchId}/${secret}/hook`, {
    session_id: hostileId, hook_event_name: 'PreToolUse', tool_use_id: hostileBody, tool_name: 'Bash', tool_input: { description: hostileBody, command: hostileBody },
  });
  const h3 = await postRaw(base, `/ingest/${launchId}/${secret}/hook`, {
    session_id: hostileId, hook_event_name: 'InstructionsLoaded', file_path: hostileBody, load_reason: hostileBody, notification_type: hostileBody,
  });
  const h4 = await postRaw(base, `/ingest/${launchId}/${secret}/statusline`, {
    session_id: hostileId, model: { id: hostileBody }, context_window: { used_percentage: hostileBody }, cost: { total_cost_usd: hostileBody }, rate_limits: hostileBody,
  });
  const stillUp = await get(base, '/', {}).catch((e) => ({ status: `request failed: ${e.code || e.message}` }));
  check('hostile ingest bodies get an empty 204 (or a status line) and the server stays up',
    [h1, h2, h3].every((r) => r.status === 204 && r.body === '') && h4.status === 200 && stillUp.status === 200,
    [h1, h2, h3, h4].map((r) => r.status).concat(stillUp.status).join(','));

  // #40 (M3): a record written after startup (so not restored) is read from
  // disk on its first post.
  const late = { id: 'decafbaddecafbad', secret: 'b'.repeat(48) };
  await fs.writeFile(path.join(appData, 'launches', `${late.id}.json`),
    JSON.stringify({ ...late, dir: proj, sessionId: fresh, createdAt: '2026-09-02T00:00:00.000Z' }));
  const lateSl = await postRaw(base, `/ingest/${late.id}/${late.secret}/statusline`, { session_id: fresh, context_window: { used_percentage: 12 } });
  const lateLaunch = JSON.parse((await get(base, '/api/launches', H)).body).launches.find((x) => x.id === late.id);
  check('a launch record written after startup is read from disk on its first post',
    lateSl.status === 200 && /ctx 12%/.test(lateSl.body) && lateLaunch?.sessionIds.includes(fresh), lateSl.body);
  // /resume of that session in another terminal LayerCake launched.
  await prior('statusline', { session_id: sid, context_window: { used_percentage: 61, context_window_size: 1000000 } });
  d = await session(sid);
  check('a session resumed in another launched terminal reports through that one',
    d.wrapped.launchId === PRIOR_LAUNCH.id && d.wrapped.ended === false && Math.abs(d.health.context.pct - 0.61) < 1e-9,
    JSON.stringify({ launch: d.wrapped.launchId, ended: d.wrapped.ended, context: d.health.context }));
  // The other direction too: PRIOR_LAUNCH was registered first, so the check
  // above cannot tell "latest to hear from it" from "first launch found".
  await ingest('statusline', { session_id: lid, context_window: { used_percentage: 44, context_window_size: 200000 } });
  ld = await session(lid);
  check('and the other way round: the restored launch\'s session, resumed in the newer one, reports through it',
    ld.wrapped.launchId === launchId && ld.wrapped.ended === false && Math.abs(ld.health.context.pct - 0.44) < 1e-9,
    JSON.stringify({ launch: ld.wrapped.launchId, ended: ld.wrapped.ended, context: ld.health.context }));

  // #34: a record write that fails is kept as an error, shown, and retried on
  // the next post. Read-only makes the atomic rename over it fail (EPERM).
  const lateFile = path.join(appData, 'launches', `${late.id}.json`);
  const retryId = '88888888-8888-4888-8888-888888888888';
  // Windows refuses a rename over a read-only file; POSIX allows it, and
  // refuses instead when the directory is read-only (#17, found running smoke
  // on Linux).
  const blockTarget = process.platform === 'win32' ? lateFile : path.dirname(lateFile);
  await fs.chmod(blockTarget, process.platform === 'win32' ? 0o444 : 0o555);
  await postRaw(base, `/ingest/${late.id}/${late.secret}/statusline`, { session_id: retryId });
  const failedShown = await until(async () =>
    Boolean(JSON.parse((await get(base, '/api/launches', H)).body).launches.find((x) => x.id === late.id)?.persistError));
  await fs.chmod(blockTarget, process.platform === 'win32' ? 0o644 : 0o755);
  await postRaw(base, `/ingest/${late.id}/${late.secret}/statusline`, { session_id: retryId });
  const recovered = await until(async () => {
    const rec = JSON.parse(await fs.readFile(lateFile, 'utf8'));
    const shown = JSON.parse((await get(base, '/api/launches', H)).body).launches.find((x) => x.id === late.id);
    // #46: the tie key is written too.
    return rec.sessionIds?.includes(retryId) && typeof rec.since?.[retryId] === 'string' && !shown?.persistError;
  });
  check('a failed record write is shown, then retried on the next post', failedShown && recovered, JSON.stringify({ failedShown, recovered }));

  // #41: another launched session, no pid file, reaches a permission prompt.
  // Claude Code hides the status line while a prompt is open and stops its
  // refresh, so it goes silent. One wait covers this and the next check.
  const dlg = IDS.dialog;
  await ingest('statusline', { session_id: dlg, context_window: { used_percentage: 20, context_window_size: 200000 } });
  await hookVia(ingest, { session_id: dlg, hook_event_name: 'PreToolUse', tool_use_id: 'toolu_dlg', ...npmTest });
  await hookVia(ingest, { session_id: dlg, hook_event_name: 'PermissionRequest', ...npmTest });

  // #31 and #4: silence past the report window reads as not running. lid last
  // reported through the dry-run launch above, with no prompt open.
  await new Promise((r) => setTimeout(r, reportWindowMs + 400));
  ld = await session(lid);
  check('a launched session that stops reporting with no prompt open reads as not running, not running forever',
    ld.live === null && ld.wrapped.quiet === true && ld.health.state === 'offline' && ld.health.reasons.some((r) => /No report for over .* most likely stopped/.test(r)),
    JSON.stringify({ live: ld.live, quiet: ld.wrapped.quiet, reasons: ld.health.reasons }));
  const dd = await session(dlg);
  check('silent at an open permission prompt: still running and still waiting for you',
    dd.live?.source === 'hooks' && dd.health.flags.includes('waiting') && dd.health.state === 'waiting' && dd.health.context.source === 'status line (exact)',
    JSON.stringify({ live: dd.live, state: dd.health.state, flags: dd.health.flags }));

  // #33 (#46): hostile fields with a VALID session id reach applyHook and
  // toolSummary, and what they record is checked, not just the answer: the
  // catch alone would also answer 204.
  const badField = { toString: null };
  await hookVia(ingest, { session_id: lid, hook_event_name: badField });
  await hookVia(ingest, { session_id: lid, hook_event_name: 'PreToolUse', tool_use_id: 'toolu_h', tool_name: 'Bash', tool_input: { description: badField, command: badField } });
  // #48: an event named after an Object.prototype member is just a name.
  await hookVia(ingest, { session_id: lid, hook_event_name: 'constructor' });
  ld = await session(lid);
  check('hostile hook fields are recorded as safe values, not dropped by a throw',
    ld.wrapped.hookCounts.unknown === 1 && ld.wrapped.running.some((t) => t.id === 'toolu_h' && t.summary === ''),
    JSON.stringify({ counts: ld.wrapped.hookCounts, running: ld.wrapped.running }));
  check('an event named "constructor" is counted as a number', ld.wrapped.hookCounts.constructor === 1, JSON.stringify(ld.wrapped.hookCounts));

  check('every hook answer is 204 with an EMPTY body, on every path above', allEmpty);
  check('no response carries a hook\'s tool input', !bodies.join('\n').includes(SENTINELS.hookToolInput));
}

/**
 * AI summaries against the stand-in claude (smoke-claude-stub.mjs): the crash
 * path, the exact stripped-down call, the ledger, and a summary outliving its
 * transcript. No usage is spent.
 */
/** npm's cmd-shim output for a package bin, as `npm install -g` writes claude.cmd. */
const NPM_SHIM = [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  '',
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ') ELSE (',
  '  SET "_prog=node"',
  '  SET PATHEXT=%PATHEXT:;.JS;=;%',
  ')',
  '',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*',
  '',
].join('\r\n');

export async function runSummaryChecks({ base, token, check, skip, proj, smokeDir, appData }) {
  const H = { 'X-LayerCake-Token': token };
  const stub = path.join(smokeDir, 'claude-stub');

  // #6: an npm global install provides claude.cmd, not claude.exe, and spawn
  // cannot start a .cmd without a shell. The shim is resolved to node plus its
  // script and run with no shell in between, so the argv (an empty --tools
  // value included) arrives exactly as given.
  if (process.platform === 'win32') {
    const { resolveClaudeCommand } = await import('../server/summaries.js');
    const prefix = path.join(smokeDir, 'npm-prefix');
    const pkg = path.join(prefix, 'node_modules', '@anthropic-ai', 'claude-code');
    await fs.mkdir(pkg, { recursive: true });
    await fs.writeFile(path.join(pkg, 'cli.js'), 'process.stdout.write(JSON.stringify({ shim: true, args: process.argv.slice(2) }));\n');
    await fs.writeFile(path.join(prefix, 'claude.cmd'), NPM_SHIM);
    const nodeDir = path.dirname(process.execPath);
    const resolved = await resolveClaudeCommand({ PATH: [prefix, nodeDir].join(path.delimiter) });
    // Run only what points into the synthetic prefix: a broken resolver falls
    // back to plain 'claude', and smoke must never start the real Claude Code.
    const intoPrefix = resolved.length === 2 && resolved[1].startsWith(prefix);
    const ran = intoPrefix
      ? spawnSync(resolved[0], [...resolved.slice(1), '-p', '--tools', ''], { encoding: 'utf8', timeout: 15000, windowsHide: true })
      : { stdout: '', stderr: `not run: resolved to ${JSON.stringify(resolved)}` };
    const said = (() => { try { return JSON.parse(ran.stdout); } catch { return null; } })();
    check('an npm-installed claude.cmd resolves to node plus its script, and runs with the argv intact',
      resolved.length === 2 && said?.shim === true && JSON.stringify(said.args) === JSON.stringify(['-p', '--tools', '']),
      JSON.stringify({ resolved, said, stderr: String(ran.stderr || '').slice(0, 200) }));
    const native = path.join(smokeDir, 'native-bin');
    await fs.mkdir(native, { recursive: true });
    await fs.writeFile(path.join(native, 'claude.exe'), '');
    const preferred = await resolveClaudeCommand({ PATH: [native, prefix, nodeDir].join(path.delimiter) });
    check('claude.exe on PATH is used by its full path, before any npm shim (#191)',
      JSON.stringify(preferred) === JSON.stringify([path.join(native, 'claude.exe')]), JSON.stringify(preferred));
    // #191: a relative PATH entry names a folder under whatever the current
    // directory is, so it is skipped even when it holds claude.exe; and with
    // nothing found there is no bare 'claude' to fall back on.
    const relative = await resolveClaudeCommand({ PATH: [path.relative(process.cwd(), native), nodeDir].join(path.delimiter) });
    check('a relative PATH entry is never searched for claude, and with none found the answer is null, not a bare name (#191)',
      !path.isAbsolute(path.relative(process.cwd(), native)) && relative === null, JSON.stringify(relative));

    // #89: yarn classic's global bin holds a shim that runs npm's shim in its
    // own global node_modules. Followed one level to the same script.
    const yarn = path.join(smokeDir, 'yarn');
    const yarnBin = path.join(yarn, 'bin');
    const yarnGlobalBin = path.join(yarn, 'Data', 'global', 'node_modules', '.bin');
    const yarnPkg = path.join(yarn, 'Data', 'global', 'node_modules', '@anthropic-ai', 'claude-code');
    await fs.mkdir(yarnBin, { recursive: true });
    await fs.mkdir(yarnGlobalBin, { recursive: true });
    await fs.mkdir(yarnPkg, { recursive: true });
    await fs.writeFile(path.join(yarnPkg, 'cli.js'), 'process.stdout.write(JSON.stringify({ shim: "yarn" }));\n');
    await fs.writeFile(path.join(yarnBin, 'claude.cmd'), '@"%~dp0\\..\\Data\\global\\node_modules\\.bin\\claude.cmd"   %*\r\n');
    await fs.writeFile(path.join(yarnGlobalBin, 'claude.cmd'), NPM_SHIM.replace('%dp0%\\node_modules\\@anthropic-ai', '%dp0%\\..\\@anthropic-ai'));
    const viaYarn = await resolveClaudeCommand({ PATH: [yarnBin, nodeDir].join(path.delimiter) });
    check('a yarn-classic claude.cmd, which runs another shim, resolves to node plus the same script',
      viaYarn.length === 2 && path.resolve(viaYarn[1]) === path.join(yarnPkg, 'cli.js'), JSON.stringify(viaYarn));
  } else {
    skip('an npm or yarn claude.cmd shim resolves to node plus its script (3 checks)', 'claude.cmd shims are a Windows form');
  }

  // A claude that exits without reading a >64 KB digest used to kill the server.
  await fs.writeFile(path.join(stub, 'mode'), 'exit-early');
  const crashed = await postRaw(base, `/api/session/${IDS.launched}/summarize`, {}, H).catch((e) => ({ status: `request failed: ${e.code || e.message}` }));
  check('a claude that exits without reading gives an error, not a dead server', crashed.status === 502, `status ${crashed.status}`);
  const alive = await get(base, '/', {}).catch((e) => ({ status: `request failed: ${e.code || e.message}` }));
  check('the server is still up afterwards', alive.status === 200, `status ${alive.status}`);
  if (alive.status !== 200) return;
  let usage = JSON.parse((await get(base, '/api/usage', H)).body);
  check('the failed run is in the ledger', usage.totals.runs === 1 && usage.totals.failed === 1, JSON.stringify(usage.totals));

  await fs.writeFile(path.join(stub, 'mode'), 'ok');
  const ok = await postRaw(base, `/api/session/${IDS.onDisk}/summarize`, {}, H);
  check('a summary run returns its text', ok.status === 200 && JSON.parse(ok.body).text === '- stub summary: the widget was fixed', ok.body.slice(0, 120));
  const run = JSON.parse(await fs.readFile(path.join(stub, 'last-run.json'), 'utf8'));
  const at = (flag) => run.args[run.args.indexOf(flag) + 1];
  check('it runs claude -p on Haiku, stripped down',
    run.args[0] === '-p' && at('--model') === 'haiku' && run.args.includes('--safe-mode') && at('--tools') === '' &&
      run.args.includes('--no-session-persistence') && run.args.includes('--strict-mcp-config') && at('--max-budget-usd') === '0.50',
    run.args.join(' '));
  check('the digest carries the prompts and replies, not tool output',
    run.input.includes('First prompt: fix the widget') && run.input.includes('Fixed it.') && !run.input.includes(SENTINELS.toolOutput));
  usage = JSON.parse((await get(base, '/api/usage', H)).body);
  check('the successful run is in the ledger with the usage claude reported', usage.totals.runs === 2 && usage.totals.outputTokens === 12);

  // #3: the entry is written as "running" BEFORE claude starts and replaced by
  // the result, so a run cut off by a shutdown still leaves a trace.
  await fs.writeFile(path.join(stub, 'mode'), 'slow-ok');
  const ledgerFile = path.join(appData, 'usage-ledger.json');
  const slow = postRaw(base, `/api/session/${IDS.onDisk}/summarize`, {}, H);
  const midRun = await until(async () =>
    JSON.parse(await fs.readFile(ledgerFile, 'utf8')).entries.some((e) => e.status === 'running' && e.sessionId === IDS.onDisk));
  const slowRes = await slow;
  const ledgerAfter = JSON.parse(await fs.readFile(ledgerFile, 'utf8')).entries;
  check('a summary run is in the ledger as "running" before it ends, then replaced by its result',
    midRun && slowRes.status === 200 && ledgerAfter.length === 3 && !ledgerAfter.some((e) => e.status === 'running') && ledgerAfter.every((e) => e.id),
    JSON.stringify({ midRun, status: slowRes.status, entries: ledgerAfter.map((e) => e.status) }));
  // A "running" entry older than any run can last is a run LayerCake never saw finish.
  await fs.writeFile(ledgerFile, JSON.stringify({
    entries: [...ledgerAfter, { id: 'stale-run', at: new Date(Date.now() - 3_600_000).toISOString(), feature: 'ai-summary', sessionId: IDS.onDisk, status: 'running', ok: false }],
  }));
  usage = JSON.parse((await get(base, '/api/usage', H)).body);
  check('a run LayerCake never saw finish reads as interrupted, usage unknown',
    usage.totals.interrupted === 1 && usage.entries.some((e) => e.id === 'stale-run' && e.status === 'interrupted'),
    JSON.stringify(usage.totals));
  const d = JSON.parse((await get(base, `/api/session/${IDS.onDisk}`, H)).body);
  check('the summary is kept and shown with the session', d.aiSummary?.text === '- stub summary: the widget was fixed');

  const list = JSON.parse((await get(base, `/api/sessions?dir=${encodeURIComponent(proj)}`, H)).body);
  check('a kept card still shows its AI summary after the transcript is gone',
    list.expired.find((e) => e.sessionId === IDS.expired)?.aiSummary?.text === '- kept summary');
  check('a session keeps the directory it started in after Claude cd\'s into a subfolder', d.cwd === proj, d.cwd);
  const page = await new Promise((resolve) => http.get(`${base}/`, (res) => { res.resume(); resolve(res.headers['content-security-policy'] || ''); }));
  check('the page forbids images from anywhere but itself (no outbound fetch from markdown)', /img-src 'self' data:/.test(page), page);
}
