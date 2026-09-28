import React, { useEffect, useState } from 'react';
import Markdown from 'react-markdown';

import { getFlatten } from '../api.js';

const TABS = [
  { kind: 'claude-md', label: 'CLAUDE.md chain' },
  { kind: 'settings', label: 'settings.json chain' },
  { kind: 'definitions', label: 'Agents & skills' },
  { kind: 'mcp', label: 'MCP servers' },
];

/** A chain level whose only files are ones an earlier level already showed. */
function repeatsOnly(section) {
  return section.empty && section.repeatedPaths?.length > 0;
}

function SectionHead({ section }) {
  return (
    <div className="flat-section-head">
      <span className="level-index">{String(section.precedence).padStart(2, '0')}</span>
      <span className="flat-section-title">{section.title}</span>
      {section.empty && !repeatsOnly(section) && <span className="badge">nothing found</span>}
      {repeatsOnly(section) && <span className="badge">shown above</span>}
    </div>
  );
}

/** Names the other levels that reached the same file (flatten's alsoReachedFrom, #117). */
function AlsoReached({ from }) {
  if (!from?.length) return null;
  return (
    <span className="muted" title="The same file, found again by the directory walk. Claude Code loads it once.">
      {' '}· also reached through {from.join('; ')}
    </span>
  );
}

function MemoryView({ data }) {
  return (
    <>
      {data.sections.map((section) => (
        <div className={`flat-section${section.empty && !repeatsOnly(section) ? ' empty' : ''}`} key={section.levelId}>
          <SectionHead section={section} />
          {section.repeatedNote && (
            <div className="flat-file-body">
              <div className="notice info">
                {section.repeatedNote}
                <ul>
                  {section.repeatedPaths.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              </div>
            </div>
          )}
          {section.files.map((file) => (
            <div className={`flat-file${file.conditional ? ' not-read' : ''}`} key={file.path}>
              <div className="flat-file-head">
                {file.path}
                {file.truncated ? '  (truncated)' : ''}
                {file.conditional && <> <span className="badge partial">conditional rule</span></>}
              </div>
              {file.conditional && <div className="notice info">{file.conditional}</div>}
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

const MODE_LABEL = {
  override: 'override',
  concat: 'combined',
  replace: 'taken whole',
  'replace+concat': 'taken whole, then combined',
};

/**
 * Which managed source Claude Code uses, and why each other one is not
 * (#147). Server-managed settings come first because they outrank the rest,
 * and LayerCake can only say whether Claude Code has cached any.
 */
function ManagedSources({ managed }) {
  if (!managed) return null;
  const cache = managed.remoteCache;
  return (
    <div className="flat-section">
      <div className="flat-section-head">
        <span className="flat-section-title">Managed policy: which source applies</span>
        <span className="badge">{managed.behavior}</span>
      </div>
      <div className="flat-file-body">
        {managed.fatal?.map((f) => (
          <div className="notice err" key={f.path}>
            {f.path} ({f.source}) does not parse as a JSON object. Claude Code 2.1.283 treats an admin policy document
            like that as fatal at startup, so it will most likely not start until the document is fixed or removed.
          </div>
        ))}
        {managed.behaviorFrom && (
          <div className="notice info">
            managedSourcesBehavior is &quot;{managed.behavior}&quot;, read from the {managed.behaviorFrom}, the highest source present.
          </div>
        )}
        <table className="prov-table">
          <thead>
            <tr>
              <th>Source, highest first</th>
              <th>Used</th>
              <th>Why</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                Server-managed settings
                <div className="muted">{cache.path}</div>
              </td>
              <td>{cache.present ? 'probably' : 'most likely not'}</td>
              <td>
                {cache.present
                  ? 'Claude Code has cached server-managed settings here. While they are in force they are used in place of every source below, so the effective settings on this page may not be what applies. Not merged: Claude Code fetches them again at startup and can hold them back until they are approved.'
                  : 'No cache here, so this configuration home has most likely not received server-managed settings. They come from the claude.ai admin console or a Claude apps gateway and are fetched, never read from a file.'}
              </td>
            </tr>
            {managed.sources.map((s) => (
              <tr key={s.id}>
                <td>
                  {s.label}
                  {s.paths.map((p) => (
                    <div className="muted" key={p}>
                      {p}
                    </div>
                  ))}
                </td>
                <td>{s.applied ? 'yes' : 'no'}</td>
                <td>{s.applied ? 'Applied.' : s.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** A dotted key with a line-break opportunity after each dot (#129). */
function KeyPath({ path }) {
  return path.split('.').map((part, i) => (
    <React.Fragment key={i}>
      {i > 0 && (
        <>
          .<wbr />
        </>
      )}
      {part}
    </React.Fragment>
  ));
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
            <span className="flat-section-title">Which file supplied each key</span>
          </div>
          <div className="flat-file-body">
            <table className="prov-table">
              <thead>
                <tr>
                  <th>Key</th>
                  <th>Mode</th>
                  <th>From</th>
                </tr>
              </thead>
              <tbody>
                {data.provenance.map((row) => (
                  <tr key={row.keyPath}>
                    <td>
                      <KeyPath path={row.keyPath} />
                    </td>
                    <td>{MODE_LABEL[row.mode] || row.mode}</td>
                    <td>
                      {row.sources.map((s) => (
                        <div className="prov-source" key={s.file}>
                          {s.label}
                          {Array.isArray(s.added) && row.mode !== 'replace' ? ` (+${s.added.length})` : ''}{' '}
                          <span className="muted">{s.file}</span>
                        </div>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <ManagedSources managed={data.managed} />

      {data.ignored?.length > 0 && (
        <div className="flat-section">
          <div className="flat-section-head">
            <span className="flat-section-title">Set but ignored by Claude Code</span>
          </div>
          <div className="flat-file-body">
            {data.ignored.map((row) => (
              <div className="notice warn" key={`${row.keyPath} ${row.file}`}>
                {row.keyPath} in {row.file}: {row.reason}
              </div>
            ))}
          </div>
        </div>
      )}

      {data.sections.map((section) => (
        <div className={`flat-section${section.empty && !repeatsOnly(section) ? ' empty' : ''}`} key={section.levelId}>
          <SectionHead section={section} />
          {section.repeatedNote && (
            <div className="flat-file-body">
              <div className="notice info">
                {section.repeatedNote}
                <ul>
                  {section.repeatedPaths.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              </div>
            </div>
          )}
          {section.files.map((file) => (
            <div className={`flat-file${file.notRead ? ' not-read' : ''}`} key={file.path}>
              <div className="flat-file-head">
                {file.path}{' '}
                {file.registry && <span className="badge">registry value</span>}{' '}
                {file.sources.length > 0 ? (
                  <span className="badge">{file.sources.join(' + ')} settings</span>
                ) : (
                  <span className="badge partial">not read by Claude Code</span>
                )}{' '}
                {file.managed &&
                  (file.managed.applied ? (
                    <span className="badge found">applied</span>
                  ) : (
                    <span className="badge partial" title={file.managed.reason || ''}>
                      skipped, see the managed policy table
                    </span>
                  ))}
              </div>
              <div className="flat-file-body">
                {file.notRead && <div className="notice info">{file.notRead}</div>}
                {file.note && file.note !== file.notRead && <div className="notice info">{file.note}</div>}
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
              <span>
                {def.path}
                <AlsoReached from={def.alsoReachedFrom} />
              </span>
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
                <AlsoReached from={def.alsoReachedFrom} />
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
            <div className={`def-row${source.notRead ? ' not-read' : ''}`} key={source.path}>
              <span className="tag">{String(source.precedence).padStart(2, '0')}</span>
              <span>
                {source.path}
                {source.exclusive && <> <span className="badge">managed, exclusive control</span></>}
                {source.notRead && <> <span className="badge partial">{source.blocked ? 'not loaded' : 'not read by Claude Code'}</span></>}
                {source.jsonError ? ` — JSON error: ${source.jsonError}` : ''}
                {source.error ? ` — ${source.error.message}` : ''}
                {!source.error && !source.jsonError && !source.notRead
                  ? ` — ${source.serverNames.length} server(s)`
                  : ''}
                {source.notRead && !source.error && !source.jsonError
                  ? ` — defines ${source.serverNames.length ? source.serverNames.join(', ') : 'no servers'}, not loaded`
                  : ''}
                <AlsoReached from={source.alsoReachedFrom} />
                {source.notRead && <div className="notice info">{source.notRead}</div>}
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
