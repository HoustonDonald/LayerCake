import React, { useEffect, useState } from 'react';

import { duration, terminalIdentity, terminalTitle, toolLabel } from '../sessionFormat.js';

/**
 * One tab per open embedded terminal, under the header in every view (#207).
 * Each tab says which session it is (its colour, its name, its tool and
 * folder) and what that session is doing: the state comes from the server
 * with the rule that produced it, and an inferred state says so.
 *
 * The colours are the server's small index per terminal turned into a hue
 * here. They tell tabs apart; the dot's own colour is the state.
 */
const TAB_COLORS = ['#b4540a', '#1f6feb', '#8250df', '#0a7f7a', '#bf3989', '#57741a', '#c93c37', '#4d5bd6'];
const STATE_LABEL = { waiting: 'Waiting for you', working: 'Working', idle: 'Idle', unknown: 'Not reporting' };

export function tabColor(terminal) {
  return TAB_COLORS[(terminal.color ?? 0) % TAB_COLORS.length];
}

function folderName(cwd) {
  return String(cwd || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || cwd;
}

export default function SessionTabs({ terminals, selectedId, historySelected, onSelect, onHistory, onKeep, rules }) {
  // The "for 2 min" beside a state counts on its own, between the list's polls.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, []);
  const rule = (state) => rules?.find((r) => r.state === state)?.rule || '';

  return (
    <div className="session-tabs" role="tablist" aria-label="Open sessions">
      <button role="tab" aria-selected={historySelected} className={`session-tab history${historySelected ? ' selected' : ''}`} onClick={onHistory}
        title="Saved sessions, and where a new one is started">
        History
      </button>
      {terminals.map((t) => {
        const state = t.activity?.state || 'unknown';
        const since = t.activity?.since ? Date.parse(t.activity.since) : null;
        const label = `${t.activity?.inferred ? 'Likely waiting' : STATE_LABEL[state]}${since && now - since >= 5000 ? ` ${duration(now - since)}` : ''}`;
        const selected = t.id === selectedId;
        return (
          <div key={t.id} className={`session-tab st-${state}${selected ? ' selected' : ''}`} style={{ '--tab': tabColor(t) }}>
            <button role="tab" aria-selected={selected} className="session-tab-main" onClick={() => onSelect(t.id)}
              title={[terminalIdentity(t), t.cwd, t.activity?.detail, rule(state)].filter(Boolean).join('\n')}>
              <span className="session-tab-name">
                <span className={`tab-dot st-${state}`} aria-hidden="true" />
                <strong>{terminalTitle(t)}</strong>
              </span>
              <span className="session-tab-sub"><span className="session-tab-state">{label}</span> · {toolLabel(t.tool)} · {folderName(t.cwd)}</span>
            </button>
            {onKeep &&<button className={`tab-keep${t.keep ? ' on' : ''}`} aria-pressed={Boolean(t.keep)} onClick={() => onKeep(t.id, !t.keep)}
              title={t.keep
                ? 'Kept on close: when LayerCake closes, this session reopens in Windows Terminal and carries on from its saved chat. Click to end it with LayerCake instead.'
                : 'Keep on close: when LayerCake closes, reopen this session in Windows Terminal instead of ending it.'}>
              {t.keep ? 'Kept' : 'Keep'}
            </button>}
          </div>
        );
      })}
    </div>
  );
}
