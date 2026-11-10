import React, { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { terminalAction, watchTerminal } from '../api.js';
import { terminalIdentity, terminalTitle } from '../sessionFormat.js';

export default function TerminalPane({ terminal, onUpdate, historyLabel, onOpenHistory }) {
  const container = useRef(null);
  const update = useRef(onUpdate);
  update.current = onUpdate;
  const [generation, setGeneration] = useState(0);
  const [connection, setConnection] = useState('Connecting…');
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState('');
  const [closing, setClosing] = useState(false);
  const { id } = terminal;

  useEffect(() => {
    let alive = true;
    let controller = null;
    let accepting = false;
    let size = '';
    let queue = Promise.resolve();
    const term = new Terminal({ cursorBlink: true, scrollback: 2000, fontSize: 14, convertEol: false,
      fontFamily: '"Cascadia Mono", Consolas, monospace', theme: { background: '#171b21', foreground: '#edf0f3' } });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container.current);
    setConnection('Connecting…');
    setError(null);
    const send = (action, body) => {
      const lease = controller;
      if (!lease) return;
      queue = queue.then(async () => {
        if (alive && controller === lease) await terminalAction(id, action, { ...body, controller: lease });
      }).catch((err) => { if (alive && err.code !== 'ETERMINALCLOSED') setError(err.message); });
    };
    const measure = () => {
      if (!container.current?.clientWidth || !container.current?.clientHeight) return;
      fit.fit();
      const cols = Math.max(2, Math.min(term.cols, 500));
      const rows = Math.max(2, Math.min(term.rows, 250));
      if (controller && accepting && size !== `${cols}x${rows}`) {
        size = `${cols}x${rows}`;
        send('resize', { cols, rows });
      }
    };
    const observer = new ResizeObserver(measure);
    observer.observe(container.current);
    const input = term.onData((data) => {
      if (!accepting) return;
      for (let start = 0; start < data.length;) {
        let end = Math.min(start + 16000, data.length);
        if (end < data.length && /[\uD800-\uDBFF]/.test(data[end - 1])) end -= 1;
        send('input', { data: data.slice(start, end) });
        start = end;
      }
    });
    const unwatch = watchTerminal(id, {
      onEvent: (name, payload) => {
        if (!alive) return;
        if (name === 'ready') {
          controller = payload.controller;
          accepting = payload.first;
          term.write(payload.data, () => {
            if (!alive || !controller) return;
            accepting = true;
            setConnection(null);
            measure();
          });
        }
        if (name === 'output') term.write(payload.data);
        if (name === 'state') update.current(payload);
        if (name === 'replaced') {
          controller = null;
          accepting = false;
          setConnection('This terminal is open in another window.');
          unwatch();
        }
      },
      onError: (message) => {
        if (!alive) return;
        accepting = false;
        controller = null;
        setConnection(message);
      },
    });
    measure();
    return () => {
      alive = false;
      observer.disconnect();
      unwatch();
      input.dispose();
      term.dispose();
    };
  }, [id, generation]);

  async function rename(event) {
    event.preventDefault();
    try {
      onUpdate(await terminalAction(id, 'rename', { title }));
      setEditing(false);
    } catch (err) { setError(err.message); }
  }

  async function close() {
    if (!window.confirm(`Close ${terminalTitle(terminal)}?`)) return;
    setClosing(true);
    try { await terminalAction(id, 'close'); }
    catch (err) { setClosing(false); setError(err.message); }
  }

  return (
    <section className="terminal-pane" aria-label="Session terminal">
      <header className="terminal-head">
        <div>
          <h2>{terminalTitle(terminal)}</h2>
          <div>{terminalIdentity(terminal)}
            {' · '}{terminal.running ? 'Terminal open' : `Exited${terminal.exitCode == null ? '' : ` (${terminal.exitCode})`}`}
          </div>
          <code>{terminal.cwd}</code>
        </div>
        <div className="terminal-actions">
          {onOpenHistory && <button className="btn btn-small" onClick={onOpenHistory}>{historyLabel}</button>}
          <button className="btn btn-small" onClick={() => { setTitle(terminal.title || ''); setEditing(true); }}>Rename</button>
          {terminal.running && <button className="btn btn-small" disabled={closing} onClick={close}>Close terminal</button>}
        </div>
      </header>
      {editing && <form className="terminal-actions" onSubmit={rename}>
        <input aria-label="Task name" placeholder="Task name" autoFocus maxLength={80} value={title} onChange={(e) => setTitle(e.target.value)} required />
        <button className="btn btn-small" type="submit">Save name</button>
        <button className="btn btn-small" type="button" onClick={() => setEditing(false)}>Cancel</button>
      </form>}
      {connection && <div className="terminal-actions muted">
        {connection}
        {connection !== 'Connecting…' && <button className="btn btn-small" onClick={() => setGeneration((n) => n + 1)}>Reconnect</button>}
      </div>}
      {error && <div className="err-item" role="alert">{error}</div>}
      {terminal.running && terminal.reportsActivity && terminal.tool === 'codex' && !terminal.activitySeen &&
        <div className="muted">Review LayerCake’s reporting hooks when Codex prompts, or open <code>/hooks</code>.</div>}
      <div className="terminal-screen" ref={container} />
    </section>
  );
}
