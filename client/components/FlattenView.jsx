import React, { useEffect, useState } from 'react';
import Markdown from 'react-markdown';

import { getFlatten } from '../api.js';

const TABS = [
  { kind: 'claude-md', label: 'CLAUDE.md chain' },
  { kind: 'settings', label: 'settings.json chain' },
  { kind: 'definitions', label: 'Agents & skills' },
  { kind: 'mcp', label: 'MCP servers' },
];

function SectionHead({ section }) {
  return (
    <div className="flat-section-head">
      <span className="level-index">{String(section.precedence).padStart(2, '0')}</span>
      <span className="flat-section-title">{section.title}</span>
      {section.empty && <span className="badge">nothing found</span>}
    </div>
  );
}

function MemoryView({ data }) {
  return (
    <>
      {data.sections.map((section) => (
        <div className={`flat-section${section.empty ? ' empty' : ''}`} key={section.levelId}>
          <SectionHead section={section} />
          {section.files.map((file) => (
            <div className="flat-file" key={file.path}>
              <div className="flat-file-head">
                {file.path}
                {file.truncated ? '  (truncated)' : ''}
              </div>
              <div className="flat-file-body">
                {file.error ? (
                  <div className="notice err">
                    {file.error.code}: {file.error.message}
                  </div>
                ) : (
                  <>
                    {file.note && <div className="notice info">{file.note}</div>}
                    <div className="markdown">
                      <Markdown>{file.content}</Markdown>
                    </div>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      ))}
    </>
  );
}

function SettingsView({ data }) {
  return (
    <>
      <div className="flat-section">
        <div className="flat-section-head">
          <span className="flat-section-title">Computed effective settings</span>
        </div>
        <div className="flat-file-body">
          <pre className="code">{JSON.stringify(data.merged, null, 2)}</pre>
        </div>
      </div>

      {data.provenance.length > 0 && (
        <div className="flat-section">
          <div className="flat-section-head">
            <span className="flat-section-title">Which level supplied each key</span>
          </div>
          <div className="flat-file-body">
            <table className="prov-table">
              <thead>
                <tr>
                  <th>Key</th>
                  <th>Mode</th>
                  <th>Winning level</th>
                  <th>File</th>
                </tr>
              </thead>
              <tbody>
                {data.provenance.map((row) => (
                  <tr key={row.keyPath}>
                    <td>{row.keyPath}</td>
                    <td>{row.mode}</td>
                    <td>{row.level}</td>
                    <td>{row.file}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {data.sections.map((section) => (
        <div className={`flat-section${section.empty ? ' empty' : ''}`} key={section.levelId}>
          <SectionHead section={section} />
          {section.files.map((file) => (
            <div className="flat-file" key={file.path}>
              <div className="flat-file-head">{file.path}</div>
              <div className="flat-file-body">
                {file.error ? (
                  <div className="notice err">
                    {file.error.code}: {file.error.message}
                  </div>
                ) : file.jsonError ? (
                  <>
                    <div className="notice warn">JSON did not parse: {file.jsonError}</div>
                    <pre className="code">{file.content}</pre>
                  </>
                ) : (
                  <pre className="code">{JSON.stringify(file.parsed, null, 2)}</pre>
                )}
              </div>
            </div>
          ))}
        </div>
      ))}
    </>
  );
}

function DefinitionsView({ data }) {
  const shadowed = data.groups.filter((g) => g.shadowed);
  return (
    <>
      {shadowed.length > 0 && (
        <div className="flat-rule" style={{ borderRadius: 4 }}>
          {shadowed.length} definition name{shadowed.length === 1 ? ' is' : 's are'} declared at more
          than one level.
        </div>
      )}
      {data.groups.map((group) => (
        <div className={`group-card${group.shadowed ? ' shadowed' : ''}`} key={group.key}>
          <div className="group-card-head">
            <span className="badge">{group.category}</span>
            <span className="group-name">{group.name}</span>
            {group.shadowed && <span className="badge partial">shadowed</span>}
          </div>
          {group.winner?.description && <div className="group-desc">{group.winner.description}</div>}
          {group.definitions.map((def, i) => (
            <div className={`def-row${i === 0 ? ' winner' : ''}`} key={def.path}>
              <span className="tag">{i === 0 ? 'effective' : 'shadowed'}</span>
              <span>{def.path}</span>
            </div>
          ))}
        </div>
      ))}
    </>
  );
}

function McpView({ data }) {
  return (
    <>
      {data.servers.length === 0 && (
        <div className="flat-section empty">
          <div className="flat-section-head">
            <span className="flat-section-title">No file-defined MCP servers on this chain</span>
          </div>
        </div>
      )}
      {data.servers.map((server) => (
        <div className={`group-card${server.shadowed ? ' shadowed' : ''}`} key={server.name}>
          <div className="group-card-head">
            <span className="badge">{server.winner?.transport || 'mcp'}</span>
            <span className="group-name">{server.name}</span>
            {server.shadowed && <span className="badge partial">defined {server.definitions.length}×</span>}
          </div>
          {server.definitions.map((def, i) => (
            <div className={`def-row${i === 0 ? ' winner' : ''}`} key={`${def.path}-${i}`}>
              <span className="tag">{i === 0 ? 'effective' : 'shadowed'}</span>
              <span>
                {def.command || def.url || '—'} · {def.path}
                {def.scope && def.scope !== 'global' ? ` · ${def.scope}` : ''}
              </span>
            </div>
          ))}
        </div>
      ))}

      <div className="flat-section">
        <div className="flat-section-head">
          <span className="flat-section-title">Source files</span>
        </div>
        <div className="flat-file-body">
          {data.sources.map((source) => (
            <div className="def-row" key={source.path}>
              <span className="tag">{String(source.precedence).padStart(2, '0')}</span>
              <span>
                {source.path}
                {source.jsonError ? ` — JSON error: ${source.jsonError}` : ''}
                {source.error ? ` — ${source.error.message}` : ''}
                {!source.error && !source.jsonError
                  ? ` — ${source.serverNames.length} server(s)`
                  : ''}
              </span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

export default function FlattenView({ scanId }) {
  const [kind, setKind] = useState('claude-md');
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getFlatten(scanId, kind)
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [scanId, kind]);

  return (
    <>
      <div className="flat-tabs">
        {TABS.map((tab) => (
          <button
            key={tab.kind}
            className={kind === tab.kind ? 'active' : ''}
            onClick={() => setKind(tab.kind)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {error && <div className="error-banner">{error}</div>}
      {loading && <div className="spinner">Flattening…</div>}

      {!loading && data && (
        <>
          <div className="flat-rule">{data.rule}</div>
          {data.kind === 'claude-md' && <MemoryView data={data} />}
          {data.kind === 'settings' && <SettingsView data={data} />}
          {data.kind === 'definitions' && <DefinitionsView data={data} />}
          {data.kind === 'mcp' && <McpView data={data} />}
        </>
      )}
    </>
  );
}
