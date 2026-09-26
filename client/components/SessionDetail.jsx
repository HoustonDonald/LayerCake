import React, { useEffect, useMemo, useState } from 'react';
import Markdown from 'react-markdown';

import { getTurn } from '../api.js';
import { clock, daysUntil, duration, tokens, usd, when } from '../sessionFormat.js';

const KIND_MARK = { prompt: '›', command: '/', bash: '!', start: '·' };

function Stat({ label, value, tone, title }) {
  return (
    <div className={`stat${tone ? ` ${tone}` : ''}`} title={title}>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

function Section({ title, count, children, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="s-section">
      <button className="s-section-head" onClick={() => setOpen((v) => !v)}>
        <span>{open ? '▾' : '▸'}</span> {title}
        {count != null && <span className="s-count">{count}</span>}
      </button>
      {open && <div className="s-section-body">{children}</div>}
    </div>
  );
}

function ContextGauge({ health }) {
  const c = health?.context;
  if (!c || c.tokens == null) return <div className="gauge-empty">No API call yet, so no context figure.</div>;
  const pct = Math.min(1, c.pct || 0);
  const tone = pct >= 0.8 ? 'warn' : '';
  return (
    <div className="gauge" title={`${c.rule}\nEstimated from the last API call in the transcript; it lags while a reply is still streaming.`}>
      <div className="gauge-head">
        <span>Context</span>
        <span>
          {tokens(c.tokens)} of {tokens(c.window)} ({Math.round(pct * 100)}%)
        </span>
      </div>
      <div className="gauge-track">
        <div className={`gauge-fill ${tone}`} style={{ width: `${pct * 100}%` }} />
      </div>
    </div>
  );
}

function AiSummary({ detail, onSummarize, summarizing, summaryError }) {
  const ai = detail.aiSummary;
  const est = detail.estimate;
  if (ai) {
    return (
      <div className="ai-summary">
        <div className="ai-summary-head">
          AI summary <span className="muted">· {clock(ai.at)} · {ai.model} · {tokens((ai.usage?.inputTokens || 0) + (ai.usage?.cacheCreationTokens || 0) + (ai.usage?.cacheReadTokens || 0))} in / {tokens(ai.usage?.outputTokens)} out · {usd(ai.usage?.costUSD)}</span>
          {ai.turns !== detail.turns.length && <span className="muted"> · made at {ai.turns} turns, now {detail.turns.length}</span>}
        </div>
        <div className="ai-summary-text">{ai.text}</div>
        <button className="btn btn-small" onClick={onSummarize} disabled={summarizing}>
          {summarizing ? 'Summarizing…' : 'Summarize again'}
        </button>
      </div>
    );
  }
  return (
    <div className="ai-summary empty">
      <button className="btn btn-small" onClick={onSummarize} disabled={summarizing || !detail.turns.some((t) => t.kind === 'prompt')}>
        {summarizing ? 'Summarizing…' : 'Summarize with AI'}
      </button>
      <span className="muted" title={est?.method}>
        {' '}
        About {tokens(est?.inputTokens)} tokens in, {usd(est?.costUSD)} on {est?.price?.model} at list price. Counted in
        LayerCake&apos;s own usage, never the session&apos;s.
        {est?.truncated ? ' Long session: the middle is left out and the summary says so.' : ''}
      </span>
      {summaryError && <div className="err-item">{summaryError}</div>}
    </div>
  );
}

function PromptRail({ turns, selected, onSelect }) {
  const [filter, setFilter] = useState('');
  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return turns.filter((t) => t.kind !== 'start' && (!f || t.preview.toLowerCase().includes(f) || t.responsePreview.toLowerCase().includes(f)));
  }, [turns, filter]);
  return (
    <div className="rail">
      <input className="rail-filter" placeholder="Filter prompts and replies" value={filter} onChange={(e) => setFilter(e.target.value)} spellCheck={false} />
      <div className="rail-list">
        {shown.map((t) => (
          <button key={t.n} className={`rail-item kind-${t.kind}${selected === t.n ? ' selected' : ''}`} onClick={() => onSelect(t.n)}>
            <div className="rail-line">
              <span className="rail-mark">{KIND_MARK[t.kind] || '·'}</span>
              <span className="rail-text">{t.preview || '(image only)'}</span>
            </div>
            <div className="rail-meta">
              <span>{clock(t.at)}</span>
              {t.tools > 0 && <span>{t.tools} tools</span>}
              {t.toolErrors > 0 && <span className="err">{t.toolErrors} failed</span>}
              {t.interrupted && <span className="warn">interrupted</span>}
              {t.running && <span className="live">running</span>}
              {t.durationMs != null && <span>{duration(t.durationMs)}</span>}
            </div>
          </button>
        ))}
        {shown.length === 0 && <div className="muted rail-empty">No prompts match.</div>}
      </div>
    </div>
  );
}

function TurnView({ sessionId, n, lastAt }) {
  const [turn, setTurn] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    let alive = true;
    if (n == null) return undefined;
    getTurn(sessionId, n)
      .then((t) => alive && (setTurn(t), setError(null)))
      .catch((e) => alive && setError(e.message));
    return () => {
      alive = false;
    };
    // lastAt: a live turn keeps growing, so it is re-read when the session moves.
  }, [sessionId, n, lastAt]);

  if (n == null) return <div className="empty-state">Pick a prompt on the left to read it and its reply.</div>;
  if (error) return <div className="err-item">{error}</div>;
  if (!turn) return <div className="empty-state">Loading…</div>;
  return (
    <div className="turn">
      <div className="turn-prompt">
        <div className="turn-label">
          {turn.kind === 'prompt' ? 'Prompt' : turn.kind === 'command' ? 'Command' : turn.kind === 'bash' ? 'Shell' : 'Session start'} · {clock(turn.at)}
          {turn.images > 0 && ` · ${turn.images} image${turn.images > 1 ? 's' : ''}`}
          {turn.interrupted && ' · interrupted'}
        </div>
        <pre className="turn-text">{turn.text}</pre>
        {turn.textTruncated && <div className="muted">Prompt truncated for display.</div>}
      </div>
      <div className="turn-reply">
        <div className="turn-label">
          Reply · {turn.apiCalls} API call{turn.apiCalls === 1 ? '' : 's'} · {tokens(turn.usage.output)} out
          {turn.contextTokens != null && ` · context ${tokens(turn.contextTokens)}`}
          {turn.durationMs != null && ` · ${duration(turn.durationMs)}`}
        </div>
        {turn.responseText ? (
          <div className="markdown">
            <Markdown>{turn.responseText}</Markdown>
          </div>
        ) : (
          <div className="muted">No text reply (tools only, or still running).</div>
        )}
        {turn.responseTruncated && <div className="muted">Reply truncated for display.</div>}
      </div>
      {turn.toolCalls.length > 0 && (
        <div className="turn-tools">
          <div className="turn-label">{turn.toolCalls.length} tool calls</div>
          {turn.toolCalls.map((tc) => (
            <div key={tc.id || `${tc.name}-${tc.at}`} className={`tool-row${tc.error ? ' error' : ''}`}>
              <span className="tool-name">{tc.name}</span>
              <span className="tool-summary">{tc.summary}</span>
              <span className="tool-state">{tc.error ? 'failed' : tc.done ? '' : 'running'}</span>
            </div>
          ))}
        </div>
      )}
      {turn.subagents.length > 0 && (
        <div className="turn-tools">
          <div className="turn-label">Subagents</div>
          {turn.subagents.map((s) => (
            <div key={s.toolUseId} className="tool-row">
              <span className="tool-name">{s.type}</span>
              <span className="tool-summary">{s.description}</span>
              <span className="tool-state">{s.status}{s.tokens ? ` · ${tokens(s.tokens)}` : ''}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function SessionDetail({ detail, onSummarize, summarizing, summaryError }) {
  const [turnN, setTurnN] = useState(null);
  const health = detail.health;
  const state = health?.states?.find((s) => s.state === health.state);
  const card = detail.card;
  const expiresIn = daysUntil(card?.expiresAt);
  const lastPrompt = [...detail.turns].reverse().find((t) => t.kind === 'prompt');

  // A new session starts on its latest prompt, which is what someone switching
  // to it most likely wants to see.
  useEffect(() => {
    setTurnN(lastPrompt ? lastPrompt.n : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.sessionId]);

  return (
    <div className={`session-pane glow-${health?.state || 'offline'}`}>
      <div className="s-head">
        <div className="s-title">
          {card.title}
          <span className="s-title-src">{card.titleSource === 'ai' ? 'title by Claude Code' : card.titleSource === 'custom' ? 'your title' : 'first prompt'}</span>
        </div>
        <div className="s-health" title={[state?.rule, ...(health?.reasons || [])].filter(Boolean).join('\n')}>
          <span className={`health-dot h-${health?.state}`} /> {state?.label || health?.state}
        </div>
      </div>
      <div className="s-meta">
        <span>{detail.cwd}</span>
        {detail.gitBranch && <span>branch {detail.gitBranch}</span>}
        <span>{detail.modelName || detail.modelId || Object.keys(detail.models)[0] || 'model unknown'}</span>
        {detail.effort && <span>effort {detail.effort}</span>}
        {detail.permissionMode && <span>{detail.permissionMode} mode</span>}
        {detail.planMode && <span className="warn">plan mode</span>}
        <span>Claude Code {detail.version}</span>
      </div>
      <div className="s-meta">
        <span>started {clock(detail.firstAt)}</span>
        <span>last active {when(detail.lastAt)}</span>
        <span>{duration(card.durationMs)}</span>
        {expiresIn != null && !detail.live && (
          <span className={expiresIn <= 5 ? 'warn' : ''} title="Claude Code deletes transcripts after cleanupPeriodDays without activity. LayerCake keeps this card afterwards.">
            transcript deleted in {expiresIn} day{expiresIn === 1 ? '' : 's'}
          </span>
        )}
      </div>

      {detail.awaySummaries.length > 0 && (
        <div className="recaps">
          {detail.awaySummaries.slice(-2).map((a) => (
            <div key={a.at} className="recap">
              <span className="muted">Claude Code recap, {clock(a.at)}: </span>
              {a.text}
            </div>
          ))}
        </div>
      )}
      <AiSummary detail={detail} onSummarize={onSummarize} summarizing={summarizing} summaryError={summaryError} />

      <div className="stats">
        <Stat label="prompts" value={card.prompts} />
        <Stat label="tool calls" value={card.tools} title={card.topTools.map((t) => `${t.name} ${t.count}`).join(', ')} />
        <Stat label="tool failures" value={detail.toolFailures} tone={detail.toolFailures ? 'warn' : ''} title={`${detail.permissionDenials} permission denials`} />
        <Stat label="files edited" value={detail.filesEditedCount} />
        <Stat label="subagents" value={detail.subagents.length} title={(detail.live ? detail.runningSubagents : 0) ? `${detail.runningSubagents} still running` : ''} />
        <Stat label="compactions" value={detail.compactions.length} />
        <Stat label="API errors" value={detail.errors.length} tone={detail.errors.length ? 'err' : ''} />
        <Stat label="tokens in" value={tokens(detail.totals.input + detail.totals.cacheCreate + detail.totals.cacheRead)} title={`uncached ${detail.totals.input}, cache write ${detail.totals.cacheCreate}, cache read ${detail.totals.cacheRead}, over ${detail.totals.apiCalls} API calls`} />
        <Stat label="tokens out" value={tokens(detail.totals.output)} />
        {detail.costState?.totalCostUSD != null && <Stat label="cost at exit" value={usd(detail.costState.totalCostUSD)} title="Written by Claude Code when the session ended, at list price." />}
      </div>

      <ContextGauge health={health} />
      {(detail.mcp.failed.length > 0 || (detail.live ? detail.runningSubagents : 0) > 0 || detail.hooks.failures > 0) && (
        <div className="alerts">
          {detail.mcp.failed.length > 0 && <span className="warn">MCP servers that failed to connect: {detail.mcp.failed.join(', ')}</span>}
          {(detail.live ? detail.runningSubagents : 0) > 0 && <span>{detail.runningSubagents} subagent{detail.runningSubagents > 1 ? 's' : ''} still running</span>}
          {detail.hooks.failures > 0 && <span className="warn">{detail.hooks.failures} hook failures</span>}
        </div>
      )}

      <div className="s-split">
        <PromptRail turns={detail.turns} selected={turnN} onSelect={setTurnN} />
        <div className="s-turn">
          <TurnView sessionId={detail.sessionId} n={turnN} lastAt={detail.lastAt} />
        </div>
      </div>

      <div className="s-sections">
        <Section title="Memory this session loaded" count={detail.instructions.length} defaultOpen>
          {detail.instructions.map((i) => (
            <div key={`${i.path}-${i.reason}`} className="kv">
              <span className="kv-key">{i.reason === 'session_start' ? 'at start' : i.reason === 'nested' ? 'on entering a folder' : i.reason}</span>
              <span>{i.path}</span>
              <span className="muted">{i.type}</span>
            </div>
          ))}
          {detail.instructions.length === 0 && <div className="muted">None recorded.</div>}
        </Section>
        <Section title="Subagents" count={detail.subagents.length}>
          {detail.subagents.map((s) => (
            <div key={s.toolUseId} className="kv">
              <span className="kv-key">{s.type}</span>
              <span>{s.description}</span>
              <span className="muted">
                {s.status}
                {s.tokens ? ` · ${tokens(s.tokens)} tokens` : ''}
                {s.durationMs ? ` · ${duration(s.durationMs)}` : ''}
                {detail.activity?.[s.agentId] ? ` · last write ${when(detail.activity[s.agentId].lastWriteAt)}` : ''}
              </span>
            </div>
          ))}
        </Section>
        <Section title="Skills" count={detail.skills.invoked.length}>
          <div className="muted">{detail.skills.listed} available to this session.</div>
          {detail.skills.invoked.map((s) => (
            <div key={`${s.name}-${s.at}`} className="kv">
              <span className="kv-key">{s.name}</span>
              <span className="muted">{clock(s.at)}</span>
            </div>
          ))}
        </Section>
        <Section title="Events" count={detail.compactions.length + detail.errors.length + detail.notices.length}>
          {[...detail.compactions.map((c) => ({ at: c.at, text: `Compaction (${c.trigger}): ${tokens(c.preTokens)} → ${tokens(c.postTokens)}` })),
            ...detail.errors.map((e) => ({ at: e.at, text: `API error${e.code ? ` ${e.code}` : ''}${e.status ? ` (${e.status})` : ''}: ${e.message}`, err: true })),
            ...detail.notices.map((n) => ({ at: n.at, text: `Model fallback: ${n.from} → ${n.to}` }))]
            .sort((a, b) => String(a.at).localeCompare(String(b.at)))
            .map((e, i) => (
              <div key={`${e.at}-${i}`} className={`kv${e.err ? ' err' : ''}`}>
                <span className="kv-key">{clock(e.at)}</span>
                <span>{e.text}</span>
              </div>
            ))}
        </Section>
        <Section title="Files edited" count={detail.filesEditedCount}>
          {detail.filesEdited.map((f) => (
            <div key={f} className="kv">
              <span>{f}</span>
            </div>
          ))}
        </Section>
        <Section title="Transcript read" count={Object.keys(detail.parse.unknown).length || null}>
          <div className="muted">
            {detail.parse.lines} lines, {detail.parse.badLines} unreadable. The transcript format is internal to Claude Code and
            can change in any release; record types this version of LayerCake does not recognise are listed here rather than
            silently dropped.
          </div>
          {Object.entries(detail.parse.unknown).map(([type, count]) => (
            <div key={type} className="kv warn">
              <span className="kv-key">{type}</span>
              <span>{count}</span>
            </div>
          ))}
        </Section>
      </div>
    </div>
  );
}
