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
 * summary per tool call instead). For the Castle (#159) a tool call also keeps
 * the file paths it names and the first words of a shell command's segments
 * (toolTargets), and its verdict; the words are for matching test and build
 * rules and are never sent to the page. Subagent transcripts are read for their
 * tool calls only (SubagentReader).
 *
 * Field meanings were established from a survey of 44 real sessions written by
 * Claude Code 2.1.197 to 2.1.282 on 2026-09-26.
 */

import path from 'node:path';

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

/**
 * Attachment subtypes known to carry nothing the product shows. The handled
 * ones are the cases in applyAttachment. Anything in neither is counted as
 * unrecognised, like a top-level type: Claude Code moved subagent completions
 * and queued prompts INTO an attachment (queued_command), and while attachments
 * went uncounted that change dropped data with the drift counter at zero (#113).
 * Surveyed from 44 real sessions (2.1.197 to 2.1.283), 2026-09-26.
 */
const IGNORED_ATTACHMENTS = new Set([
  'total_tokens_reminder',
  'deferred_tools_record',
  'diagnostics',
  'batching_reminder_sent',
  'bash_output_audience_note',
  'task_reminder',
  'environment',
  'silent_turn_reminder',
  'agent_listing_delta',
  'command_permissions',
  'auto_mode',
  'auto_mode_exit',
  'prompt_snapshot',
  'date',
  'date_change',
  'remote_session_change',
  'session_context',
  'ultrathink_effort',
  'file',
  'credential_org',
  'compact_file_reference',
  'invoked_skills',
  'read_truncation_notice',
  'workflow_size_guideline_change',
  'task_status',
  'plan_file_reference',
  'thinking_stripped',
  'thinking_drop',
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
    // contextByHook: hook name ("PostToolUse:Edit", event plus matcher) -> count.
    hooks: { runs: 0, failures: 0, contextInjections: 0, contextByHook: {}, byEvent: {} },
    filesEdited: [],
    toolFailures: 0,
    permissionDenials: 0,
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

/** Tools whose input names a command line (the Castle's shell verb). */
export const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const MAX_TARGET_PATHS = 4;
const MAX_HEAD_SEGMENTS = 8;
const HEAD_WORDS = 4;

/**
 * What a tool call points at, for the Castle (#159): the files it names and,
 * for a shell call, the first words of each command segment ("heads"), which
 * is all a test or build rule needs to recognise `npm test` or `dotnet build`.
 * Shared by ingest (hooks), the main transcript and subagent transcripts, so
 * the three sources cannot classify one call differently.
 *
 * Paths come from `file_path`, `notebook_path` and `path` (Grep and Glob), as
 * strings only (#33). A relative one resolves against the caller's own cwd,
 * never against LayerCake's: without a cwd it is dropped. Heads are held in
 * memory to match against rules and never sent to the page; the page gets the
 * one-line summary, as it always has.
 */
export function toolTargets(name, input, cwd) {
  const str = (v) => (typeof v === 'string' ? v : '');
  const i = input && typeof input === 'object' ? input : {};
  const base = str(cwd);
  const paths = [];
  for (const raw of [str(i.file_path), str(i.notebook_path), str(i.path)]) {
    if (!raw || paths.length >= MAX_TARGET_PATHS) continue;
    let p = null;
    if (path.isAbsolute(raw)) p = path.normalize(raw);
    else if (base && path.isAbsolute(base)) p = path.resolve(base, raw);
    if (p && !paths.includes(p)) paths.push(p);
  }
  const shell = SHELL_TOOLS.has(str(name));
  const heads = shell ? commandHeads(str(i.command)) : [];
  // The files a shell call names, to place a plain one in their rooms (#176).
  // Like heads, held in memory and never sent to the page.
  const shellPaths = shell ? commandPaths(str(i.command), base) : [];
  return { paths, heads, shellPaths, background: i.run_in_background === true };
}

const MAX_SHELL_PATHS = 16;

/**
 * The path-like words of a command line (#176): a word with a slash or a
 * backslash, or ending in a file extension, that is not a flag, a URL, a
 * variable or a home path. Quotes are stripped and `--opt=value` gives its
 * value. A relative word resolves against the caller's cwd (none without one),
 * and a Git Bash `/c/...` reads as `C:\...` on Windows. Words that are not files
 * (`origin/main`) come through too: castle.js keeps only those a room's
 * patterns claim. Bounded: the first 4000 characters, at most 16 paths, and no
 * pattern here can backtrack.
 */
export function commandPaths(command, cwd) {
  if (typeof command !== 'string' || !command) return [];
  const base = typeof cwd === 'string' && path.isAbsolute(cwd) ? cwd : null;
  const out = [];
  for (let w of command.slice(0, 4000).split(/[\s;|&<>()`]+/)) {
    if (out.length >= MAX_SHELL_PATHS) break;
    w = w.replace(/^["']+/, '').replace(/["',:]+$/, '');
    if (w.startsWith('-')) {
      const eq = w.indexOf('=');
      if (eq === -1) continue;
      w = w.slice(eq + 1).replace(/^["']+/, '');
    }
    if (!w || w.length > 260 || w.includes('://') || w.includes('$') || w.startsWith('~')) continue;
    if (!/[\\/]/.test(w) && !/\.[A-Za-z0-9]{1,8}$/.test(w)) continue;
    const drive = /^\/([A-Za-z])\/(.*)$/.exec(w);
    if (drive && process.platform === 'win32') w = `${drive[1].toUpperCase()}:\\${drive[2]}`;
    let p = null;
    if (path.isAbsolute(w)) p = path.normalize(w);
    else if (base) p = path.resolve(base, w);
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}

/**
 * The first words of each segment of a command line, lowercased, split on
 * `&&`, `||`, `;`, `|` and newlines. Leading environment assignments
 * (`CI=1 npm test`) and a leading `(` are skipped, so the words are the
 * program and its first arguments.
 */
export function commandHeads(command) {
  if (typeof command !== 'string' || !command) return [];
  const out = [];
  for (const segment of command.slice(0, 4000).split(/&&|\|\||[;|\r\n]/)) {
    const words = segment.trim().replace(/^\(+/, '').split(/\s+/).filter(Boolean);
    while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift();
    if (words.length) out.push(words.slice(0, HEAD_WORDS).map((w) => w.replace(/^["']|["']$/g, '').toLowerCase()));
    if (out.length >= MAX_HEAD_SEGMENTS) break;
  }
  return out;
}

const DENIED_RE = /Permission for this action was denied|doesn't want to proceed/;

/**
 * What a finished tool call says, the same way for a hook and a transcript:
 *   { ok: true }                          it ran and succeeded
 *   { ok: false, exitCode: n | null }     it ran and failed ("Exit code N" is
 *                                          how a shell reports it, docs: hooks)
 *   { ok: null, reason }                  no verdict: denied, rejected before
 *                                          it ran (<tool_use_error>, which
 *                                          fires no failure hook), interrupted,
 *                                          or not shown to have run
 * A denial or an interrupt must never read as a failure: saying "No" to Claude
 * is not trouble in the code (#160).
 *
 * `ran` is true for a hook's PostToolUseFailure, which fires only for a tool
 * that started executing (docs: hooks). A transcript error carries no such
 * guarantee: Claude Code also records a call its own checks refused before it
 * ran, in words that change between versions ("Compound command changes
 * working directory ... require manual approval", measured 2026-09-29, #164).
 * So without `ran`, an error is a failure only on evidence the tool ran: an
 * exit code, or a system error code such as EACCES or ENOENT.
 */
export function toolVerdict({ isError, text, interrupted, ran = false }) {
  if (interrupted) return { ok: null, reason: 'interrupted' };
  if (!isError) return { ok: true };
  const t = typeof text === 'string' ? text : '';
  const first = t.split('\n', 1)[0].trim();
  const exit = /^(?:Error: )?Exit code (\d+)/.exec(first);
  if (exit) return { ok: false, exitCode: Number(exit[1]) };
  if (DENIED_RE.test(t)) return { ok: null, reason: 'denied' };
  if (/^\s*<tool_use_error>/.test(t)) return { ok: null, reason: 'rejected' };
  if (/^\[Request interrupted/.test(first)) return { ok: null, reason: 'interrupted' };
  if (ran || /\bE[A-Z]{3,}\b/.test(first)) return { ok: false, exitCode: null };
  return { ok: null, reason: 'not run' };
}

/** A transcript tool_result block's verdict (toolVerdict), with its record's toolUseResult. */
function resultVerdict(block, result) {
  const interrupted = Boolean(result && typeof result === 'object' && !Array.isArray(result) && result.interrupted === true);
  return toolVerdict({ isError: Boolean(block.is_error), text: textOf(block.content), interrupted });
}

/** A Write's own word for what it did, when it says: 'create' or 'update'. */
export function writeTypeOf(result) {
  const t = result && typeof result === 'object' && !Array.isArray(result) ? result.type : null;
  return t === 'create' || t === 'update' ? t : null;
}

/** One line describing a tool call, from its input. Never the input body itself. */
export function toolSummary(name, input) {
  // Strings only: ingest passes hook bodies straight in, and String() on an
  // object whose toString is not a function throws (#33).
  const str = (v) => (typeof v === 'string' ? v : '');
  const i = input && typeof input === 'object' ? input : {};
  const n = str(name);
  let s = '';
  if (n === 'Bash' || n === 'PowerShell') s = str(i.description) || str(i.command);
  else if (n === 'Read' || n === 'Write' || n === 'Edit' || n === 'NotebookEdit') s = str(i.file_path) || str(i.notebook_path);
  else if (n === 'Grep' || n === 'Glob') s = str(i.pattern);
  else if (n === 'Agent' || n === 'Task') s = [str(i.subagent_type), str(i.description)].filter(Boolean).join(': ');
  else if (n === 'Skill') s = str(i.skill);
  else if (n === 'WebFetch') s = str(i.url);
  else if (n === 'WebSearch') s = str(i.query);
  else if (n.startsWith('mcp__')) s = n.split('__')[1] || '';
  else s = str(i.description) || str(i.file_path) || str(i.path) || str(i.query);
  return clip(s.replace(/\s+/g, ' '), SUMMARY_CHARS);
}

function newTurn(model, at, cls) {
  const turn = {
    n: model.turns.length + 1,
    at,
    kind: cls.kind,
    text: cls.text || '',
    images: cls.images || 0,
    source: cls.source || null,
    // Typed while Claude was working, and handed to it mid-turn (#112).
    queued: Boolean(cls.queued),
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
      return applyAttachment(model, r.attachment || {}, at, state);
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
    applyTaskNotification(model, cls.text, at, state);
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
    tool.verdict = resultVerdict(block, r.toolUseResult);
    tool.writeType = writeTypeOf(r.toolUseResult);
    if (block.is_error) {
      tool.error = true;
      model.toolFailures += 1;
      if (/Permission for this action was denied|doesn't want to proceed/.test(textOf(block.content))) {
        model.permissionDenials += 1;
      }
      // An Agent call that failed never starts its subagent, and nothing
      // else will end it: it read "starting" forever (#114).
      const failed = state.subagentsByToolUse.get(block.tool_use_id);
      if (failed && (failed.status === 'starting' || failed.status === 'running')) {
        failed.status = 'failed';
        failed.endAt = at;
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

/**
 * A background task's completion notice: the <task-notification> text Claude
 * Code sends back to the model when a subagent (or a background shell) ends.
 * It arrives as a user record, or, more and more often, as a queued_command
 * attachment (#111); both carry the same tags. The subagent is found by the
 * tool-use id of the call that started it, or failing that by <task-id>,
 * which is its agent id: 46 of 299 notices seen carried no tool-use id.
 */
function applyTaskNotification(model, text, at, state) {
  const tag = (name) => new RegExp(`<${name}>([^<]+)</${name}>`).exec(text)?.[1]?.trim() || null;
  const toolUseId = tag('tool-use-id');
  const taskId = tag('task-id');
  const sub =
    (toolUseId && state.subagentsByToolUse.get(toolUseId)) ||
    (taskId && model.subagents.find((s) => s.agentId === taskId)) ||
    null;
  if (!sub) return;
  sub.status = tag('status') || 'completed';
  sub.endAt = at;
  const tokens = /<subagent_tokens>(\d+)/.exec(text)?.[1];
  const toolUses = /<tool_uses>(\d+)/.exec(text)?.[1];
  const duration = /<duration_ms>(\d+)/.exec(text)?.[1];
  if (tokens) sub.tokens = Number(tokens);
  if (toolUses) sub.toolUses = Number(toolUses);
  if (duration) sub.durationMs = Number(duration);
}

/**
 * A command Claude Code queued and handed to the model mid-turn (#111, #112):
 * a task notification, or a prompt the user typed while Claude was working.
 * A queued prompt is written ONLY here, never also as a user record, so it
 * becomes a turn of its own, marked queued. A peer message (origin "peer",
 * isMeta) classifies as ignored, as it does in a user record. Any other mode
 * is counted as unrecognised, so a new one shows instead of vanishing.
 */
function applyQueuedCommand(model, a, at, state) {
  const text = typeof a.prompt === 'string' ? a.prompt : textOf(a.prompt);
  if (a.commandMode === 'task-notification') {
    applyTaskNotification(model, text, at, state);
    return;
  }
  if (a.commandMode === 'prompt') {
    const cls = classifyUser({ origin: a.origin, isMeta: a.isMeta, message: { content: a.prompt } });
    if (cls.kind === 'prompt' || cls.kind === 'command' || cls.kind === 'bash') newTurn(model, at, { ...cls, queued: true });
    return;
  }
  const key = `attachment:queued_command:${a.commandMode || '(none)'}`;
  model.unknown[key] = (model.unknown[key] || 0) + 1;
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
        // For the Castle (#159): paths and command heads, never the input body.
        targets: toolTargets(block.name, block.input, r.cwd),
        at,
        endAt: null,
        done: false,
        error: false,
        verdict: null,
        writeType: null,
      };
      turn.tools.push(tool);
      if (block.id) state.toolsById.set(block.id, tool);
      if (block.name === 'Agent' || block.name === 'Task') {
        const sub = {
          toolUseId: block.id,
          agentId: null,
          type: block.input?.subagent_type || 'general-purpose',
          description: clip(block.input?.description || '', SUMMARY_CHARS),
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

function applyAttachment(model, a, at, state) {
  switch (a.type) {
    case 'queued_command':
      applyQueuedCommand(model, a, at, state);
      return;
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
    case 'hook_additional_context': {
      // Any hook's: the user's own and plugins' too. LayerCake's answer is
      // always empty, so its hooks never produce one (#25).
      model.hooks.contextInjections += 1;
      const name = String(a.hookName || a.hookEvent || 'unknown');
      model.hooks.contextByHook[name] = (model.hooks.contextByHook[name] || 0) + 1;
      return;
    }
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
      // Mostly harness bookkeeping, listed in IGNORED_ATTACHMENTS. A subtype in
      // neither list is counted, so a format change inside an attachment shows
      // in "Transcript read" instead of silently dropping data (#113).
      if (!IGNORED_ATTACHMENTS.has(a.type)) {
        const key = `attachment:${a.type || '(none)'}`;
        model.unknown[key] = (model.unknown[key] || 0) + 1;
      }
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

  /** True once the transcript holds a result for this tool call (finished, failed, denied or interrupted). */
  toolDone(toolUseId) {
    return Boolean(this.state.toolsById.get(toolUseId)?.done);
  }

  get size() {
    return this.tail.offset;
  }

  get mtimeMs() {
    return this.tail.mtimeMs;
  }
}

/**
 * Tool calls from one subagent's own transcript, for the Castle (#159):
 * <session>/subagents/agent-<id>.jsonl, where every record carries isSidechain,
 * its agentId and its own cwd (surveyed 2026-09-29: 705 files, 115,828
 * records, all three on every one). Keeps tool calls only (name, summary,
 * targets, times, verdict), nothing the subagent said. The caller passes a file
 * sessions.js found by a pattern-checked name; no path comes from a record.
 *
 * Record types it does not recognise are counted in `unknown`, which the
 * Castle reports on its own, so the session view's "Transcript read" figure
 * does not depend on whether a Castle tab is open.
 */
export class SubagentReader {
  constructor(agentId, file) {
    this.agentId = agentId;
    this.file = file;
    this.tail = new JsonlTail(file, (record) => this.apply(record), () => this.reset());
    this.reset();
  }

  reset() {
    this.tools = [];
    this.toolsById = new Map();
    this.uuids = new Set();
    this.firstAt = null;
    this.lastAt = null;
    this.unknown = {};
  }

  apply(r) {
    if (!r || typeof r !== 'object') return;
    if (r.uuid) {
      if (this.uuids.has(r.uuid)) return;
      this.uuids.add(r.uuid);
    }
    const at = typeof r.timestamp === 'string' ? r.timestamp : null;
    if (at) {
      if (!this.firstAt) this.firstAt = at;
      this.lastAt = at;
    }
    if (r.type === 'assistant') {
      for (const block of Array.isArray(r.message?.content) ? r.message.content : []) {
        if (block?.type !== 'tool_use' || !block.id || this.toolsById.has(block.id)) continue;
        const tool = {
          id: block.id,
          name: block.name,
          summary: toolSummary(block.name || '', block.input),
          targets: toolTargets(block.name, block.input, r.cwd),
          at,
          endAt: null,
          done: false,
          error: false,
          verdict: null,
          writeType: null,
        };
        this.tools.push(tool);
        this.toolsById.set(block.id, tool);
      }
    } else if (r.type === 'user') {
      if (!Array.isArray(r.message?.content)) return;
      for (const block of r.message.content) {
        if (block?.type !== 'tool_result') continue;
        const tool = this.toolsById.get(block.tool_use_id);
        if (!tool) continue;
        tool.done = true;
        tool.endAt = at;
        tool.error = Boolean(block.is_error);
        tool.verdict = resultVerdict(block, r.toolUseResult);
        tool.writeType = writeTypeOf(r.toolUseResult);
      }
    } else if (r.type !== 'attachment' && r.type !== 'system' && !IGNORED_TYPES.has(r.type)) {
      const key = r.type || '(none)';
      this.unknown[key] = (this.unknown[key] || 0) + 1;
    }
  }

  /** Reads anything appended since the last call. Returns true if anything was read. */
  refresh() {
    return this.tail.refresh();
  }
}

/** A subagent's `.meta.json`, reduced to what the Castle shows. Strings only. */
export function subagentMeta(parsed) {
  const s = (v) => (typeof v === 'string' && v ? v : null);
  const p = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  return {
    agentType: s(p.agentType),
    toolUseId: s(p.toolUseId),
    description: clip(s(p.description) || '', SUMMARY_CHARS) || null,
  };
}

/** Parses a whole transcript in one go. Used by the CLI and the fixture checks. */
export async function readTranscript(sessionId, file) {
  const reader = new TranscriptReader(sessionId, file);
  await reader.refresh();
  return reader;
}
