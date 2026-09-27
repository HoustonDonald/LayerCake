import React, { useState } from 'react';

const KIND_LABEL = {
  agent: 'Agent',
  command: 'Command',
  skill: 'Skill',
  rule: 'Rule',
  hook: 'Hook script',
  memory: 'Instructions',
  settings: 'Settings',
  mcp: 'MCP servers',
};

/**
 * "New file" for one level (#15). The choices are the options the scan itself
 * offered for this level, so the UI cannot ask for a place the server would
 * refuse; the name pattern is the one /api/manifest serves from the guard.
 * The server builds the path and still checks everything.
 */
export default function CreateFile({ options, namePattern, onCreate }) {
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState('');
  const [name, setName] = useState('');
  const [ext, setExt] = useState('');
  const [acknowledge, setAcknowledge] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  if (!options.length) return null;
  const option = options.find((o) => o.id === choice) || options[0];
  const needsName = option.kind === 'tree';
  const exts = option.exts || [];
  const chosenExt = exts.length > 1 ? ext || exts[0] : exts[0] || '';
  let nameOk = true;
  try {
    nameOk = !needsName || !namePattern || new RegExp(namePattern).test(name);
  } catch {
    // A pattern this browser cannot compile leaves the check to the server.
  }
  const target = needsName
    ? `${option.label}${name || '…'}${option.folderFile ? `/${option.folderFile}` : chosenExt}`
    : option.label;

  function reset() {
    setOpen(false);
    setName('');
    setExt('');
    setAcknowledge(false);
    setError(null);
  }

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const done = await onCreate({ option, name, ext: chosenExt, acknowledge });
      if (done !== false) reset();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <div className="create-file">
        <button className="absent-toggle" onClick={() => setOpen(true)}>
          + New file here
        </button>
      </div>
    );
  }

  return (
    <form className="create-file open" onSubmit={submit}>
      <div className="create-row">
        <select
          value={option.id}
          onChange={(e) => {
            setChoice(e.target.value);
            setExt('');
            setAcknowledge(false);
            setError(null);
          }}
        >
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {KIND_LABEL[o.category] || o.category} · {o.label}
            </option>
          ))}
        </select>
        {needsName && (
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="name"
            spellCheck={false}
            autoComplete="off"
            aria-invalid={Boolean(name) && !nameOk}
          />
        )}
        {needsName && exts.length > 1 && (
          <select value={chosenExt} onChange={(e) => setExt(e.target.value)}>
            {exts.map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </select>
        )}
      </div>
      <div className="create-target">{target}</div>
      {needsName && name && !nameOk && (
        <div className="notice warn">Lowercase letters, digits, - and _ only, starting with a letter or digit.</div>
      )}
      {option.executable && (
        <div className="notice warn">
          <strong>Claude Code executes this file, not just reads it.</strong> It runs only once a hooks
          entry in settings.json names it.
          <label className="ack">
            <input type="checkbox" checked={acknowledge} onChange={(e) => setAcknowledge(e.target.checked)} />
            I understand, create this hook
          </label>
        </div>
      )}
      <div className="create-row">
        <button
          className="btn btn-primary btn-small"
          type="submit"
          disabled={busy || (needsName && (!name || !nameOk)) || (option.executable && !acknowledge)}
        >
          {busy ? 'Creating…' : 'Create from template'}
        </button>
        <button className="btn btn-small" type="button" onClick={reset} disabled={busy}>
          Cancel
        </button>
        <span className="editor-hint">Never replaces an existing file.</span>
      </div>
      {error && <div className="notice err">{error}</div>}
    </form>
  );
}
