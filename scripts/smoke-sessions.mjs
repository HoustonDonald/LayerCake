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

import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

import { projectSlug } from '../server/paths.js';

export const SENTINELS = {
  instructionBody: 'SMOKE-INSTRUCTION-BODY',
  nestedBody: 'SMOKE-NESTED-BODY',
  toolOutput: 'SMOKE-TOOL-OUTPUT',
  pasted: 'SMOKE-PASTED-SECRET',
  keyFile: 'SMOKE-KEY-FILE',
};

export const IDS = {
  onDisk: '11111111-1111-4111-8111-111111111111',
  historyOnly: '22222222-2222-4222-8222-222222222222',
  expired: '33333333-3333-4333-8333-333333333333',
  undiscovered: '44444444-4444-4444-8444-444444444444',
};
const AGENT_BG = 'a0123456789abcdef';
const AGENT_HANDBACK = 'afedcba9876543210';

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
    { type: 'ai-title', aiTitle: 'Fix the widget' },
    { type: 'system', subtype: 'away_summary', content: 'You were fixing the widget.' },
    { type: 'file-history-snapshot', snapshot: { trackedFileBackups: { 'widget.js': {} } } },
    { type: 'attachment', attachment: { type: 'hook_success', hookEvent: 'PostToolUse', exitCode: 0 } },
    { type: 'attachment', attachment: { type: 'deferred_tools_delta', failedMcpServers: ['broken-server'] } },
    // The drift canary: a record type this build has never seen.
    { type: 'future-record-type', payload: 1 },
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
  await fs.writeFile(path.join(projDir, IDS.onDisk, 'subagents', `agent-${AGENT_BG}.jsonl`), '{"type":"user"}\n');

  // A running session: this smoke process's own pid is guaranteed alive.
  await fs.mkdir(path.join(claudeData, 'sessions'), { recursive: true });
  await fs.writeFile(
    path.join(claudeData, 'sessions', `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, sessionId: IDS.onDisk, cwd: proj, status: 'busy', kind: 'interactive', version: '2.1.282' })
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

  // A card LayerCake kept for a session whose transcript has since been cleaned up.
  await fs.mkdir(path.join(appData, 'cards'), { recursive: true });
  await fs.writeFile(
    path.join(appData, 'cards', `${IDS.expired}.json`),
    JSON.stringify({ sessionId: IDS.expired, title: 'An expired session', cwd: proj, prompts: 4, lastAt: '2026-08-01T00:00:00.000Z', size: 1, mtimeMs: 1 })
  );
  return { claudeData, appData };
}

function get(base, pathname, headers) {
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

export async function runSessionChecks({ base, token, check, proj, appData }) {
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
  check('prompts exclude tool results, meta, notifications and the duplicated line', card?.prompts === 3, `got ${card?.prompts}`);
  check('slash commands are counted apart from prompts', card?.commands === 1, `got ${card?.commands}`);
  check('usage is counted once per API call, not once per block', card?.tokens.apiCalls === 5 && card.tokens.input === 21 && card.tokens.output === 190, JSON.stringify(card?.tokens));
  check('a running session is marked live', card?.live === true && card.status === 'busy');
  check('retention defaults to 30 days when unset', list.data.retentionDays === 30);
  check('a session known only from history is listed as prompt-only', list.data.promptOnly.some((p) => p.sessionId === IDS.historyOnly && p.prompts === 1));
  check('a kept card for a cleaned-up session is listed as expired', list.data.expired.some((e) => e.sessionId === IDS.expired));

  const detail = await json(`/api/session/${IDS.onDisk}`);
  const d = detail.data;
  check('session detail loads', detail.status === 200, `got ${detail.status}`);
  check('context is the last call: input + cache creation + cache read', d?.context?.tokens === 29103, `got ${d?.context?.tokens}`);
  check('a 1M model id gives a 1M window', d?.health.context.window === 1_000_000);
  check('memory loaded at start and on nested traversal are both recorded',
    d?.instructions.length === 2 && d.instructions.some((i) => i.reason === 'session_start') && d.instructions.some((i) => i.reason === 'nested'));
  const bg = d?.subagents.find((s) => s.agentId === AGENT_BG);
  const hb = d?.subagents.find((s) => s.agentId === AGENT_HANDBACK);
  check('a background subagent completes through its task notification', bg?.status === 'completed' && bg.tokens === 1234, JSON.stringify(bg));
  check('a subagent completes through a peer hand-back', hb?.status === 'completed', JSON.stringify(hb));
  // The fixture's last turn_duration still says 1 pending; the subagents say done.
  check('running subagents come from their statuses, not the stale turn record', d?.runningSubagents === 0 && d.backgroundPending === 1, `running ${d?.runningSubagents}, pending ${d?.backgroundPending}`);
  check('an API error is recorded', d?.errors.length === 1 && d.errors[0].code === 'rate_limit');
  check('a compaction is recorded with its token counts', d?.compactions.length === 1 && d.compactions[0].preTokens === 900000);
  check('a denied tool call counts as a failure and a denial', d?.toolFailures === 1 && d.permissionDenials === 1);
  check('the interrupted turn is flagged', d?.turns.find((t) => t.kind === 'prompt' && t.preview.startsWith('Second'))?.interrupted === true);
  check('an unrecognised record type is counted, not ignored (drift canary)', d?.parse.unknown['future-record-type'] === 1, JSON.stringify(d?.parse.unknown));
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

  const usageRes = await json('/api/usage');
  check('LayerCake usage starts empty (no feature spent usage)', usageRes.data?.totals.runs === 0);

  const all = bodies.join('\n');
  for (const [name, value] of Object.entries(SENTINELS)) {
    check(`no response contains the ${name} sentinel`, !all.includes(value));
  }
  const persisted = await fs.readFile(path.join(appData, 'cards', `${IDS.onDisk}.json`), 'utf8').catch(() => null);
  check('the session card is kept in LayerCake data', Boolean(persisted) && JSON.parse(persisted).title === 'Fix the widget');
}
