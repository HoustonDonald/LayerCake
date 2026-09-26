/**
 * The ONLY reader of Claude Code session transcripts
 * (<claudeDataDir>/projects/<slug>/<sessionId>.jsonl).
 *
 * Why one module: Anthropic documents the transcript format as internal ("the
 * entry format is internal to Claude Code and changes between versions, so
 * scripts that parse these files directly can break on any release"). Every
 * field name the product relies on lives here, and every record type this
 * module does not recognise is counted and shown, so a format change surfaces
 * as a number in the UI instead of as quietly empty panels.
 *
 * Read-only (through jsonl.js: stat and fs.open(path, "r") with timeouts). The caller
 * passes a file that sessions.js discovered; no path is ever taken from inside
 * a record.
 *
 * The output keeps prompt and response text, because that is the feature. It
 * deliberately drops what the product neither needs nor should hold: CLAUDE.md
 * bodies from instruction attachments (paths only), the system prompt
 * snapshot, the account email, and tool input and output bodies (a one-line
 * summary per tool call instead).
 *
 * Field meanings were established from a survey of 44 real sessions written by
 * Claude Code 2.1.197 to 2.1.282 on 2026-09-26.
 */

import { JsonlTail } from './jsonl.js';

/** Per-field cap on text handed to a client. A pasted log can be megabytes. */
export const MAX_TEXT_CHARS = 200_000;
const SUMMARY_CHARS = 160;

/**
 * Top-level record types known to carry nothing the product shows. Listed so
 * they are not counted as unrecognised; anything absent from this list and
 * from the handlers below is.
 */
const IGNORED_TYPES = new Set([
  'last-prompt',
  'queue-operation',
  'atis-latch',
  'bridge-session',
  'pr-link',
  'frame-link',
  'artifact-comment-monitor',
  'artifact-autoreact-ledger',
  'summary',
  'progress',
]);

const SYSTEM_SUBTYPES = new Set([
  'compact_boundary',
  'turn_duration',
  'away_summary',
  'local_command',
  'stop_hook_summary',
  'model_refusal_fallback',
  'informational',
  'api_error',
]);

function emptyModel(sessionId) {
  return {
    sessionId,
    cwd: null,
    lastCwd: null,
    lastModel: null,
    gitBranch: null,
    version: null,
    entrypoint: null,
    firstAt: null,
    lastAt: null,
    aiTitle: null,
    customTitle: null,
    agentName: null,
    awaySummaries: [],
    modelId: null,
    modelName: null,
    models: {},
    effort: null,
    permissionMode: null,
    planMode: false,
    turns: [],
    totals: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, apiCalls: 0 },
    context: null,
    compactions: [],
    errors: [],
    notices: [],
    subagents: [],
    instructions: [],
    skills: { listed: 0, invoked: [] },
    mcp: { servers: [], failed: [], pending: [] },
    hooks: { runs: 0, failures: 0, contextInjections: 0, byEvent: {} },
    filesEdited: [],
    toolFailures: 0,
    permissionDenials: 0,
    backgroundPending: 0,
    costState: null,
    continuedIn: null,
    unknown: {},
    lines: 0,
    badLines: 0,
  };
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
}

function clip(text, max) {
  if (typeof text !== 'string') return '';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * What a `user` record is. Only `prompt`, `command` and `bash` start a turn.
 *
 * A real prompt carries origin.kind "human" (2.1.2xx) and is not isMeta.
 * Records older than that field fall back to "string content that does not
 * start with < or [", which is how harness-injected text is shaped.
 */
export function classifyUser(r) {
  const content = r.message?.content;
  if (Array.isArray(content) && content.some((b) => b?.type === 'tool_result')) return { kind: 'tool_result' };
  if (r.isCompactSummary) return { kind: 'ignore' };
  const origin = r.origin?.kind;
  if (origin === 'task-notification') return { kind: 'task_notification', text: textOf(content) };
  // A subagent can also finish by handing its report back as a peer message
  // (seen in 2.1.282 alongside task-notification). `from` is its agentId.
  if (origin === 'peer' && r.origin.handback) {
    return { kind: 'handback', agentId: r.origin.from || r.origin.senderTaskId || null };
  }
  if (origin && origin !== 'human') return { kind: 'ignore' };
  if (r.isMeta) return { kind: 'ignore' };

  const text = textOf(content);
  const trimmed = text.trim();
  if (/^\[Request interrupted by user/.test(trimmed)) return { kind: 'interrupt' };

  const command = /<command-name>([^<]*)<\/command-name>/.exec(text);
  if (command) {
    const args = /<command-args>([^<]*)<\/command-args>/.exec(text);
    const argText = args ? args[1].trim() : '';
    return { kind: 'command', text: argText ? `${command[1].trim()} ${argText}` : command[1].trim() };
  }
  const bash = /<bash-input>([\s\S]*?)<\/bash-input>/.exec(text);
  if (bash) return { kind: 'bash', text: `! ${bash[1].trim()}` };
  if (/^<(local-command|bash-stdout|bash-stderr|system-reminder|task-notification|command-message)/.test(trimmed)) {
    return { kind: 'ignore' };
  }
  if (!origin && /^[<[]/.test(trimmed)) return { kind: 'ignore' };

  const images = Array.isArray(content) ? content.filter((b) => b?.type === 'image').length : 0;
  if (!trimmed && !images) return { kind: 'ignore' };
  return { kind: 'prompt', text, images, source: r.promptSource || null };
}

/** One line describing a tool call, from its input. Never the input body itself. */
export function toolSummary(name, input) {
  const i = input && typeof input === 'object' ? input : {};
  let s = '';
  if (name === 'Bash' || name === 'PowerShell') s = i.description || i.command || '';
  else if (name === 'Read' || name === 'Write' || name === 'Edit' || name === 'NotebookEdit') s = i.file_path || i.notebook_path || '';
  else if (name === 'Grep' || name === 'Glob') s = i.pattern || '';
  else if (name === 'Agent' || name === 'Task') s = [i.subagent_type, i.description].filter(Boolean).join(': ');
  else if (name === 'Skill') s = i.skill || '';
  else if (name === 'WebFetch') s = i.url || '';
  else if (name === 'WebSearch') s = i.query || '';
  else if (name.startsWith('mcp__')) s = name.split('__')[1] || '';
  else s = i.description || i.file_path || i.path || i.query || '';
  return clip(String(s).replace(/\s+/g, ' '), SUMMARY_CHARS);
}

function newTurn(model, at, cls) {
  const turn = {
    n: model.turns.length + 1,
    at,
    kind: cls.kind,
    text: cls.text || '',
    images: cls.images || 0,
    source: cls.source || null,
    interrupted: false,
    responseText: '',
    tools: [],
    apiCalls: 0,
    usage: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 },
    contextTokens: null,
    durationMs: null,
    endAt: at,
  };
  model.turns.push(turn);
  return turn;
}

/** The turn records attach to. Records before the first prompt get a start turn. */
function currentTurn(model, at) {
  const last = model.turns[model.turns.length - 1];
  if (last) return last;
  return newTurn(model, at, { kind: 'start', text: '' });
}

function addUnique(list, value) {
  if (value && !list.includes(value)) list.push(value);
}

/**
 * Applies one parsed record to the model. Exported for the fixture checks; the
 * reader below is the production caller.
 */
export function applyRecord(model, r, state) {
  model.lines += 1;
  if (!r || typeof r !== 'object') return;
  if (r.uuid) {
    // A line written twice (it happens after a crash and resume) must not
    // double a prompt or a token count.
    if (state.uuids.has(r.uuid)) return;
    state.uuids.add(r.uuid);
  }
  if (r.isSidechain) return; // subagent records live in their own files
  const at = r.timestamp || null;
  if (at) {
    if (!model.firstAt) model.firstAt = at;
    model.lastAt = at;
  }
  // A session's directory is where it started. Claude can cd into a subfolder
  // mid-session (15 of 44 real sessions did), and taking the latest cwd made a
  // running session vanish from its own project's overlay and CLI.
  if (r.cwd) {
    if (!model.cwd) model.cwd = r.cwd;
    model.lastCwd = r.cwd;
  }
  if (r.gitBranch) model.gitBranch = r.gitBranch;
  if (r.version) model.version = r.version;
  if (r.entrypoint) model.entrypoint = r.entrypoint;

  switch (r.type) {
    case 'user':
      return applyUser(model, r, at, state);
    case 'assistant':
      return applyAssistant(model, r, at, state);
    case 'attachment':
      return applyAttachment(model, r.attachment || {}, at);
    case 'system':
      return applySystem(model, r, at);
    case 'ai-title':
      model.aiTitle = r.aiTitle || model.aiTitle;
      return undefined;
    case 'custom-title':
      model.customTitle = r.customTitle || model.customTitle;
      return undefined;
    case 'agent-name':
      model.agentName = r.agentName || model.agentName;
      return undefined;
    case 'permission-mode':
      model.permissionMode = r.permissionMode || model.permissionMode;
      return undefined;
    case 'mode':
      return undefined;
    case 'file-history-snapshot':
      for (const p of Object.keys(r.snapshot?.trackedFileBackups || {})) addUnique(model.filesEdited, p);
      return undefined;
    case 'file-history-delta':
      addUnique(model.filesEdited, r.trackingPath);
      return undefined;
    case 'cost-state':
      model.costState = {
        totalCostUSD: typeof r.totalCostUSD === 'number' ? r.totalCostUSD : null,
        totalDurationMs: r.totalDuration ?? null,
        linesAdded: r.totalLinesAdded ?? null,
        linesRemoved: r.totalLinesRemoved ?? null,
      };
      return undefined;
    case 'continued-in':
      model.continuedIn = r.continuedInSessionId || null;
      return undefined;
    default:
      if (!IGNORED_TYPES.has(r.type)) model.unknown[r.type || '(none)'] = (model.unknown[r.type || '(none)'] || 0) + 1;
      return undefined;
  }
}

function applyUser(model, r, at, state) {
  const cls = classifyUser(r);
  if (cls.kind === 'prompt' || cls.kind === 'command' || cls.kind === 'bash') {
    newTurn(model, at, cls);
    return;
  }
  if (cls.kind === 'interrupt') {
    currentTurn(model, at).interrupted = true;
    return;
  }
  if (cls.kind === 'task_notification') {
    const id = /<tool-use-id>([^<]+)<\/tool-use-id>/.exec(cls.text)?.[1];
    const sub = id && state.subagentsByToolUse.get(id.trim());
    if (sub) {
      sub.status = /<status>([^<]+)<\/status>/.exec(cls.text)?.[1]?.trim() || 'completed';
      sub.endAt = at;
      const tokens = /<subagent_tokens>(\d+)/.exec(cls.text)?.[1];
      const toolUses = /<tool_uses>(\d+)/.exec(cls.text)?.[1];
      const duration = /<duration_ms>(\d+)/.exec(cls.text)?.[1];
      if (tokens) sub.tokens = Number(tokens);
      if (toolUses) sub.toolUses = Number(toolUses);
      if (duration) sub.durationMs = Number(duration);
    }
    return;
  }
  if (cls.kind === 'handback') {
    const sub = cls.agentId && model.subagents.find((s) => s.agentId === cls.agentId);
    if (sub) {
      sub.status = 'completed';
      sub.endAt = at;
    }
    return;
  }
  if (cls.kind !== 'tool_result') return;

  for (const block of r.message.content) {
    if (block?.type !== 'tool_result') continue;
    const tool = state.toolsById.get(block.tool_use_id);
    if (!tool) continue;
    tool.done = true;
    tool.endAt = at;
    if (block.is_error) {
      tool.error = true;
      model.toolFailures += 1;
      if (/Permission for this action was denied|doesn't want to proceed/.test(textOf(block.content))) {
        model.permissionDenials += 1;
      }
    }
  }
  const result = r.toolUseResult;
  const toolUseId = r.sourceToolUseID || r.message.content.find((b) => b?.type === 'tool_result')?.tool_use_id;
  const sub = toolUseId && state.subagentsByToolUse.get(toolUseId);
  if (sub && result && typeof result === 'object' && !Array.isArray(result)) {
    if (result.agentId) sub.agentId = result.agentId;
    if (result.agentType) sub.type = result.agentType;
    if (result.status === 'async_launched') sub.status = 'running';
    else if (result.status) sub.status = result.status;
    if (typeof result.totalTokens === 'number') sub.tokens = result.totalTokens;
    if (typeof result.totalToolUseCount === 'number') sub.toolUses = result.totalToolUseCount;
    if (typeof result.totalDurationMs === 'number') sub.durationMs = result.totalDurationMs;
    if (result.status && result.status !== 'async_launched') sub.endAt = at;
  }
}

function applyAssistant(model, r, at, state) {
  const m = r.message || {};
  const turn = currentTurn(model, at);
  turn.endAt = at || turn.endAt;
  if (r.isApiErrorMessage) {
    model.errors.push({
      at,
      kind: 'api',
      code: r.error || null,
      status: r.apiErrorStatus || null,
      message: clip(textOf(m.content), 300),
    });
    return;
  }
  if (r.effort) model.effort = r.effort;

  // Every content block is its own record, and each repeats the message's usage.
  // Count usage once per message id or every figure is multiplied by its block count.
  if (m.id && !state.messageIds.has(m.id)) {
    state.messageIds.add(m.id);
    const u = m.usage || {};
    const input = u.input_tokens || 0;
    const cacheCreate = u.cache_creation_input_tokens || 0;
    const cacheRead = u.cache_read_input_tokens || 0;
    const output = u.output_tokens || 0;
    model.totals.input += input;
    model.totals.cacheCreate += cacheCreate;
    model.totals.cacheRead += cacheRead;
    model.totals.output += output;
    model.totals.apiCalls += 1;
    turn.usage.input += input;
    turn.usage.cacheCreate += cacheCreate;
    turn.usage.cacheRead += cacheRead;
    turn.usage.output += output;
    turn.apiCalls += 1;
    // What the model saw on this call: everything it read, cached or not.
    const context = input + cacheCreate + cacheRead;
    if (context > 0) {
      model.context = { tokens: context, at };
      turn.contextTokens = context;
    }
    if (m.model && m.model !== '<synthetic>') {
      model.models[m.model] = (model.models[m.model] || 0) + 1;
      model.lastModel = m.model;
    }
  }

  for (const block of Array.isArray(m.content) ? m.content : []) {
    if (!block) continue;
    if (block.type === 'text' && block.text) {
      turn.responseText = turn.responseText ? `${turn.responseText}\n\n${block.text}` : block.text;
    } else if (block.type === 'tool_use') {
      const tool = {
        id: block.id,
        name: block.name,
        summary: toolSummary(block.name || '', block.input),
        at,
        endAt: null,
        done: false,
        error: false,
      };
      turn.tools.push(tool);
      if (block.id) state.toolsById.set(block.id, tool);
      if (block.name === 'Agent' || block.name === 'Task') {
        const sub = {
          toolUseId: block.id,
          agentId: null,
          type: block.input?.subagent_type || 'general-purpose',
          description: clip(block.input?.description || '', SUMMARY_CHARS),
          background: Boolean(block.input?.run_in_background),
          status: 'starting',
          at,
          endAt: null,
          tokens: null,
          toolUses: null,
          durationMs: null,
          turn: turn.n,
        };
        model.subagents.push(sub);
        state.subagentsByToolUse.set(block.id, sub);
      }
      if (block.name === 'Skill' && block.input?.skill) {
        model.skills.invoked.push({ name: block.input.skill, at, turn: turn.n });
      }
    } else if (block.type === 'fallback') {
      model.notices.push({ at, kind: 'fallback', from: block.from?.model || null, to: block.to?.model || null });
    }
  }
}

function applyAttachment(model, a, at) {
  switch (a.type) {
    case 'instructions':
      for (const f of Array.isArray(a.files) ? a.files : []) addInstruction(model, f.path, f.type, 'session_start', at);
      return;
    case 'nested_memory':
      addInstruction(model, a.path || a.content?.path, a.content?.type, 'nested', at);
      return;
    case 'skill_listing':
      if (typeof a.skillCount === 'number') model.skills.listed = a.skillCount;
      else if (Array.isArray(a.names)) model.skills.listed = a.names.length;
      return;
    case 'mcp_instructions_delta':
      for (const n of a.addedNames || []) addUnique(model.mcp.servers, n);
      return;
    case 'deferred_tools_delta':
      if (Array.isArray(a.failedMcpServers)) model.mcp.failed = [...a.failedMcpServers];
      if (Array.isArray(a.pendingMcpServers)) model.mcp.pending = [...a.pendingMcpServers];
      return;
    case 'model':
      if (a.identity?.modelId) model.modelId = a.identity.modelId;
      if (a.identity?.marketingName) model.modelName = a.identity.marketingName;
      return;
    case 'hook_success': {
      model.hooks.runs += 1;
      const event = a.hookEvent || 'unknown';
      model.hooks.byEvent[event] = (model.hooks.byEvent[event] || 0) + 1;
      if (typeof a.exitCode === 'number' && a.exitCode !== 0) model.hooks.failures += 1;
      return;
    }
    case 'hook_additional_context':
      model.hooks.contextInjections += 1;
      return;
    case 'edited_text_file':
      addUnique(model.filesEdited, a.filename || a.path);
      return;
    case 'plan_mode':
      model.planMode = true;
      return;
    case 'plan_mode_exit':
      model.planMode = false;
      return;
    default:
      // Attachment subtypes are many and mostly harness bookkeeping. They are
      // not counted as unrecognised; the top-level type is what signals drift.
      return;
  }
}

function addInstruction(model, filePath, type, reason, at) {
  if (!filePath) return;
  const exists = model.instructions.some((i) => i.path === filePath && i.reason === reason);
  if (!exists) model.instructions.push({ path: filePath, type: type || null, reason, at });
}

function applySystem(model, r, at) {
  const subtype = r.subtype || '(none)';
  if (!SYSTEM_SUBTYPES.has(subtype)) {
    const key = `system:${subtype}`;
    model.unknown[key] = (model.unknown[key] || 0) + 1;
    return;
  }
  if (subtype === 'compact_boundary') {
    const md = r.compactMetadata || {};
    model.compactions.push({
      at,
      trigger: md.trigger || null,
      preTokens: md.preTokens ?? null,
      postTokens: md.postTokens ?? null,
      durationMs: md.durationMs ?? null,
    });
    if (typeof md.postTokens === 'number') model.context = { tokens: md.postTokens, at };
  } else if (subtype === 'turn_duration') {
    const turn = model.turns[model.turns.length - 1];
    if (turn && typeof r.durationMs === 'number') turn.durationMs = r.durationMs;
    if (typeof r.pendingBackgroundAgentCount === 'number') model.backgroundPending = r.pendingBackgroundAgentCount;
  } else if (subtype === 'away_summary') {
    if (r.content) model.awaySummaries.push({ at, text: clip(String(r.content), 4000) });
  } else if (subtype === 'stop_hook_summary') {
    if (Array.isArray(r.hookErrors) && r.hookErrors.length) model.hooks.failures += r.hookErrors.length;
  } else if (subtype === 'model_refusal_fallback') {
    model.notices.push({ at, kind: 'fallback', from: r.originalModel || null, to: r.fallbackModel || null });
  }
}

/**
 * Incremental reader for one transcript: a JsonlTail feeding applyRecord, so a
 * live file is followed by reading only what Claude Code appended.
 */
export class TranscriptReader {
  constructor(sessionId, file) {
    this.sessionId = sessionId;
    this.file = file;
    this.tail = new JsonlTail(file, (record) => applyRecord(this.model, record, this.state), () => this.reset());
    this.reset();
  }

  reset() {
    this.model = emptyModel(this.sessionId);
    this.state = { uuids: new Set(), messageIds: new Set(), toolsById: new Map(), subagentsByToolUse: new Map() };
  }

  /** Reads anything appended since the last call. Returns true if the model changed. */
  async refresh() {
    const changed = await this.tail.refresh();
    this.model.badLines = this.tail.badLines;
    return changed;
  }

  get size() {
    return this.tail.offset;
  }

  get mtimeMs() {
    return this.tail.mtimeMs;
  }
}

/** Parses a whole transcript in one go. Used by the CLI and the fixture checks. */
export async function readTranscript(sessionId, file) {
  const reader = new TranscriptReader(sessionId, file);
  await reader.refresh();
  return reader;
}
