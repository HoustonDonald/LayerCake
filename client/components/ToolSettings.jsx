import React, { useEffect, useId, useState } from 'react';
import { getClaudeUserConfig, getCodexConfig } from '../api.js';
import { pathKey } from '../sessionFormat.js';

export function ToolSelector({ tool, onChange }) {
  return <div className="s-scope tool-selector" aria-label="Configuration tool">
    <button className={tool === 'claude' ? 'active' : ''} aria-pressed={tool === 'claude'} onClick={() => onChange('claude')}>Claude Code</button>
    <button className={tool === 'codex' ? 'active' : ''} aria-pressed={tool === 'codex'} onClick={() => onChange('codex')}>Codex</button>
  </div>;
}

function Origin({ origin, label, layers, onOpenSource }) {
  const matches = (layers || []).flatMap((layer, index) =>
    !layer.disabled && layer.type === origin.type && (!origin.path || pathKey(layer.path) === pathKey(origin.path)) ? [index] : []);
  const text = [label, origin.type, origin.path].filter(Boolean).join(' · ');
  return <div className="muted">
    {onOpenSource && matches.length === 1 ? <button type="button" className="source-link" onClick={() => onOpenSource(matches[0])}>{text}</button> : text}
  </div>;
}

function ConfigValues({ settings, origins = {}, layers, onOpenSource }) {
  return settings.length ? <dl className="config-values">
    {settings.map(([key, value]) => <React.Fragment key={key}>
      <dt><code>{key}</code></dt>
      <dd><code>{JSON.stringify(value)}</code>
        {origins[key] ? <Origin origin={origins[key]} layers={layers} onOpenSource={onOpenSource} />
          : Object.entries(origins).filter(([name]) => name.startsWith(`${key}.`)).map(([name, origin]) => (
            <Origin key={name} label={name} origin={origin} layers={layers} onOpenSource={onOpenSource} />
          ))}
      </dd>
    </React.Fragment>)}
  </dl> : <p className="muted">No explicit settings in the displayed categories.</p>;
}

function InstructionContent({ file }) {
  return file.error ? <div className="err-item">{file.error}</div> : <pre>{file.content}</pre>;
}

function CodexSettings({ data }) {
  const prefix = useId();
  const sourceId = (index) => `${prefix}-source-${index}`;
  const openSource = (index) => {
    const source = document.getElementById(sourceId(index));
    source?.focus({ preventScroll: true });
    source?.scrollIntoView({ block: 'nearest' });
  };
  return <>
    <h3>Effective settings</h3>
    <ConfigValues settings={Object.entries(data.config)} origins={data.origins} layers={data.layers} onOpenSource={openSource} />
    <h3>Sources</h3>
    <div className="muted">Strongest first. Layer Cake displays selected settings and omits connection details.</div>
    <ul className="config-list">
      {data.layers.map((layer, i) => <li key={`${layer.type}:${i}`} id={sourceId(i)} tabIndex={-1}>
        {layer.type}{layer.path && <> · <code>{layer.path}</code></>}
        {layer.disabled && <span className="warn"> · Skipped by Codex</span>}
        {Object.keys(layer.config).length > 0 && <pre>{JSON.stringify(layer.config, null, 2)}</pre>}
      </li>)}
    </ul>
    {data.requirements && <>
      <h3>Managed requirements</h3>
      <pre>{JSON.stringify(data.requirements, null, 2)}</pre>
    </>}
    <h3>Instruction files</h3>
    <p className="muted">Shown in discovery order for this directory.</p>
    {data.instructions.length ? data.instructions.map((file) => <details key={file.path}>
      <summary>{file.scope} · <code>{file.path}</code>{file.truncated ? ' · Truncated' : ''}</summary>
      <InstructionContent file={file} />
    </details>) : <p className="muted">No instruction files found.</p>}
    <h3>Skills</h3>
    {data.skills.length ? <ul className="config-list">{data.skills.map((s, i) => <li key={s.path || i}>
      {s.name}{s.scope && <> · {s.scope}</>}{!s.enabled && ' · Disabled'}
      {s.path && <div><code>{s.path}</code></div>}
      {s.description && <div className="muted">{s.description}</div>}
    </li>)}</ul> : <p className="muted">No skills reported.</p>}
    <h3>Hooks</h3>
    {data.hooks.length ? <ul className="config-list">{data.hooks.map((h, i) => <li key={i}>
      {h.event || 'Hook'}{h.status && <> · {h.status}</>}{h.path && <div><code>{h.path}</code></div>}
    </li>)}</ul> : <p className="muted">No hooks reported.</p>}
  </>;
}

function codexGroups(data, onOpenSource) {
  const { mcp_servers = {}, plugins = {}, ...config } = data.config;
  const settings = Object.entries(config);
  const namedEntries = (values, section) => Object.entries(values).map(([label, { enabled }]) => {
    const origin = data.origins[`${section}.${label}.enabled`] ?? data.origins[`${section}.${label}`];
    return { label, identity: label, path: origin?.path, scope: origin?.type, origin, status: enabled ? 'Enabled' : 'Disabled' };
  });
  const effectiveValues = (values) => <ConfigValues settings={values} origins={data.origins} layers={data.layers} onOpenSource={onOpenSource} />;
  return [
    { id: 'settings', title: 'Effective settings', entries: settings.map(([key, value]) => ({
      label: key, content: effectiveValues([[key, value]]),
    })), overview: effectiveValues(settings) },
    { id: 'sources', title: 'Sources', description: 'Strongest first. Layer Cake displays selected settings and omits connection details.',
      empty: 'No configuration layers reported.', entries: data.layers.map((layer) => ({
        label: layer.type, path: layer.path, status: layer.disabled ? 'Skipped by Codex' : null,
        content: <ConfigValues settings={Object.entries(layer.config)} />,
      })) },
    { id: 'instructions', title: 'Instruction files', description: 'Shown in discovery order for this directory.',
      empty: 'No instruction files found.', entries: data.instructions.map((file) => ({
        label: file.path.split(/[\\/]/).at(-1), path: file.path, scope: file.scope,
        status: file.error ? 'Unreadable' : file.truncated ? 'Truncated' : null,
        content: <InstructionContent file={file} />,
      })) },
    { id: 'skills', title: 'Skills', empty: 'No skills reported.', entries: data.skills.map((skill) => ({
      label: skill.name || 'Skill', path: skill.path, scope: skill.scope, status: skill.enabled ? 'Enabled' : 'Disabled',
      content: skill.description && <p>{skill.description}</p>,
    })) },
    { id: 'hooks', title: 'Hooks', empty: 'No hooks reported.', entries: data.hooks.map((hook) => ({
      label: hook.event || 'Hook', path: hook.path, status: hook.status,
    })) },
    { id: 'mcp', title: 'MCP servers', empty: 'No MCP servers reported.', entries: namedEntries(mcp_servers, 'mcp_servers') },
    { id: 'plugins', title: 'Plugins', empty: 'No plugins reported in effective settings.', entries: namedEntries(plugins, 'plugins') },
    { id: 'requirements', title: 'Managed requirements', empty: 'No managed approval or sandbox restrictions reported.',
      entries: [['Approval policies', data.requirements?.approvalPolicies], ['Sandbox modes', data.requirements?.sandboxModes]]
        .filter(([, value]) => value != null).map(([label, value]) => ({ label, content: <pre>{JSON.stringify(value, null, 2)}</pre> })) },
  ].map((group) => {
    const occurrences = new Map();
    const entries = group.entries.map((entry) => {
      const identity = entry.identity ?? JSON.stringify([entry.label, entry.path, entry.scope]);
      const count = occurrences.get(identity) ?? 0;
      occurrences.set(identity, count + 1);
      return { ...entry, id: `${identity}:${count}` };
    });
    return { ...group, entries };
  });
}

const DEFAULT_NAVIGATION = { expanded: {}, selection: { group: 'settings', entry: null } };

function CodexExplorer({ data, navigation = DEFAULT_NAVIGATION, onNavigate }) {
  const prefix = useId();
  const [focusSource, setFocusSource] = useState(null);
  const { expanded, selection } = navigation;
  const openSource = (index) => {
    const source = groups.find(({ id }) => id === 'sources').entries[index];
    onNavigate((previous = DEFAULT_NAVIGATION) => ({
      expanded: { ...previous.expanded, sources: true }, selection: { group: 'sources', entry: source.id },
    }));
    setFocusSource(source.id);
  };
  const groups = codexGroups(data, openSource);
  const group = groups.find(({ id }) => id === selection.group);
  const entry = group.entries.find(({ id }) => id === selection.entry);
  useEffect(() => {
    if (focusSource && entry?.id === focusSource) {
      document.getElementById(`${prefix}-detail-title`)?.focus();
      setFocusSource(null);
    }
  }, [entry?.id, focusSource, prefix]);
  return <div className="panes">
    <nav className="pane-left codex-tree" aria-label="Codex configuration categories">
      {groups.map(({ id, title, entries }) => {
        const open = Boolean(expanded[id] && entries.length);
        const branchId = `${prefix}-${id}`;
        return <div className="level" key={id}>
          <button className={`level-header${group.id === id && !entry ? ' selected' : ''}`}
            aria-current={group.id === id && !entry ? 'true' : undefined}
            aria-expanded={entries.length ? open : undefined} aria-controls={entries.length ? branchId : undefined}
            onClick={() => onNavigate((previous = DEFAULT_NAVIGATION) => ({
              selection: { group: id, entry: null },
              expanded: entries.length ? { ...previous.expanded, [id]: !open } : previous.expanded,
            }))}>
            <span className="caret" aria-hidden="true">{entries.length ? (open ? '▼' : '▶') : ''}</span>
            <span className="level-title level-name">{title}</span>
            <span className="badge">{entries.length}</span>
          </button>
          {entries.length > 0 && <div className="level-body" id={branchId} hidden={!open}>
            {open && entries.map((row) => {
              const selected = group.id === id && entry?.id === row.id;
              return <button className={`entry${selected ? ' selected' : ''}`} key={row.id}
                aria-current={selected ? 'true' : undefined} title={row.path || row.label}
                onClick={() => onNavigate((previous = DEFAULT_NAVIGATION) => ({ ...previous, selection: { group: id, entry: row.id } }))}>
                <span className="entry-name">
                  {row.label}
                  {row.path && <span className="codex-entry-path">{row.path}</span>}
                </span>
                <span className="entry-size">{row.scope || row.status}</span>
              </button>;
            })}
          </div>}
        </div>;
      })}
    </nav>
    <div className="pane-right codex-detail" key={JSON.stringify([group.id, entry?.id])}>
      {entry ? <>
        <div className="muted">{group.title}</div>
        <h3 id={`${prefix}-detail-title`} tabIndex={-1}>{entry.label}</h3>
        {entry.origin ? <Origin origin={entry.origin} layers={data.layers} onOpenSource={openSource} /> : entry.path && <code>{entry.path}</code>}
        {(entry.scope || entry.status) && <p className="muted">{[entry.origin ? null : entry.scope, entry.status].filter(Boolean).join(' · ')}</p>}
        {entry.content}
      </> : <>
        <h3>{group.title}</h3>
        {group.description && <p className="muted">{group.description}</p>}
        {group.overview || <p className="muted">{group.entries.length ? 'Select an item on the left to inspect it.' : group.empty}</p>}
      </>}
    </div>
  </div>;
}

function ClaudeSettings({ levels, selectedFile, onSelect }) {
  const selected = levels.some((level) => level.entries.some((entry) => entry.type === 'file' && entry.absPath === selectedFile)) ? selectedFile : null;
  const [result, setResult] = useState(null);
  useEffect(() => {
    setResult(null);
    if (!selected) return undefined;
    let current = true;
    getClaudeUserConfig(selected).then((file) => { if (current) setResult(file); })
      .catch((err) => { if (current) setResult({ error: { message: err.message } }); });
    return () => { current = false; };
  }, [selected]);
  return <>
    {levels.map((level) => <section key={level.kind}>
      <h3>{level.label}</h3>
      <code>{level.dir}</code>
      <ul className="config-list">
        {level.entries.filter((entry) => entry.type === 'file' && entry.category !== 'home-config').map((entry) =>
          <li key={entry.absPath}><button className="btn btn-small" aria-pressed={selected === entry.absPath} onClick={() => onSelect(entry.absPath)}>
            {entry.name || entry.absPath}
          </button> <span className="muted">{entry.category}</span></li>)}
        {level.errors?.map((item, i) => <li className="err-item" key={i}>{item.path} · {item.message}</li>)}
      </ul>
    </section>)}
    {selected && <section>
      <h3>Selected file</h3><code>{selected}</code>
      {result?.error ? <div className="err-item">{result.error.message}</div>
        : <pre>{result?.content ?? 'Reading file…'}</pre>}
    </section>}
  </>;
}

export default function ToolSettings({ tool, scanId, projectDir, explorer = false, navigation, onNavigate, claudeFile, onClaudeFile }) {
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let current = true;
    if (tool === 'claude') setResult(null);
    setError(null);
    setLoading(true);
    const request = tool === 'codex' ? getCodexConfig(scanId) : getClaudeUserConfig();
    request.then((data) => { if (current) setResult(data); })
      .catch((err) => { if (current) setError(err.message); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [tool, scanId, revision]);
  return <section className={`tool-settings${explorer ? ' is-explorer' : ''}`}>
    <div className="terminal-head">
      <div><h2>{scanId ? 'Codex project settings' : `${tool === 'codex' ? 'Codex' : 'Claude Code'} user settings`}</h2>
        <code>{projectDir || result?.home}</code>
        <div className="muted">Read only{scanId ? ' · Settings for this working directory' : ' · User and managed scope'}</div>
      </div>
      <button className="btn btn-small" disabled={loading} onClick={() => setRevision((n) => n + 1)}>{loading && result ? 'Refreshing…' : 'Refresh'}</button>
    </div>
    {error && <div className="err-item settings-error" role="alert">{result ? `Refresh failed. Showing the previous result. ${error}` : error}</div>}
    {loading && !result && <div className="empty-state">Reading settings…</div>}
    {result && (explorer ? <CodexExplorer data={result} navigation={navigation} onNavigate={onNavigate} />
      : tool === 'codex' ? <CodexSettings data={result} /> : <ClaudeSettings levels={result} selectedFile={claudeFile} onSelect={onClaudeFile} />)}
  </section>;
}
