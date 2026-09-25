import React, { useState } from 'react';

const CATEGORY_ORDER = [
  'memory',
  'settings',
  'mcp',
  'agent',
  'skill',
  'command',
  'hook',
  'rule',
  'plugin-manifest',
  'home-config',
  'other',
];

const CATEGORY_LABEL = {
  memory: 'Instructions / memory',
  settings: 'Settings',
  mcp: 'MCP',
  agent: 'Agents',
  skill: 'Skills',
  command: 'Commands',
  hook: 'Hooks',
  rule: 'Rules',
  'plugin-manifest': 'Plugin manifests',
  'home-config': 'Home config',
  other: 'Other',
};

/**
 * Label for one entry. Plugin trees nest six levels deep, so the raw relative
 * path is unreadable at this width; the plugin name plus the filename carries
 * the same information. Entries that sit outside their level's directory come
 * back as "..\thing", which reads as noise, so those show the full path.
 */
function entryLabel(entry) {
  const parts = entry.relPath.split(/[\\/]/);
  const base = parts[parts.length - 1];
  // Every skill manifest is called SKILL.md, so the folder is the identifying part.
  const leaf =
    entry.isSkillManifest && parts.length > 1 ? `${parts[parts.length - 2]}/${base}` : base;

  if (entry.plugin) {
    const pluginName = entry.plugin.split('/')[1] || entry.plugin;
    return `${pluginName} › ${leaf}`;
  }
  if (entry.relPath.startsWith('..')) return entry.absPath;
  return entry.relPath;
}

function formatBytes(n) {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function AbsentList({ items }) {
  const [open, setOpen] = useState(false);
  if (!items.length) return null;
  return (
    <div className="absent-list">
      <button className="absent-toggle" onClick={() => setOpen((v) => !v)}>
        {open ? '▾' : '▸'} {items.length} probed, not found
      </button>
      {open &&
        items.map((item) => (
          <div className="absent-item" key={item.absPath}>
            <s>{item.absPath}</s>
            {item.note ? ` — ${item.note}` : ''}
          </div>
        ))}
    </div>
  );
}

function OtherList({ items }) {
  const [open, setOpen] = useState(false);
  if (!items.length) return null;
  return (
    <div className="other-list">
      <button className="absent-toggle" onClick={() => setOpen((v) => !v)}>
        {open ? '▾' : '▸'} {items.length} other entries in .claude/ (listed, not parsed)
      </button>
      {open &&
        items.map((item) => (
          <div className="absent-item" key={item.absPath}>
            {item.type === 'dir' ? '📁 ' : '• '}
            {item.name}
            {item.note ? ` — ${item.note}` : ''}
          </div>
        ))}
    </div>
  );
}

function Level({ level, selectedPath, onSelect, defaultOpen }) {
  const [open, setOpen] = useState(defaultOpen);
  const isEmpty = level.status === 'empty';

  const grouped = new Map();
  for (const entry of level.entries) {
    if (!grouped.has(entry.category)) grouped.set(entry.category, []);
    grouped.get(entry.category).push(entry);
  }
  const categories = [...grouped.keys()].sort(
    (a, b) => CATEGORY_ORDER.indexOf(a) - CATEGORY_ORDER.indexOf(b)
  );

  const badgeClass =
    level.status === 'error'
      ? 'error'
      : level.status === 'partial'
        ? 'partial'
        : level.status === 'found'
          ? 'found'
          : '';

  return (
    <div className={`level${isEmpty ? ' is-empty' : ''}`}>
      <button className="level-header" onClick={() => setOpen((v) => !v)}>
        <span className="caret">{open ? '▾' : '▸'}</span>
        <span className="level-index">{String(level.precedence).padStart(2, '0')}</span>
        <span className="level-title">
          <span className="level-name">{level.label}</span>
          {level.dir && <span className="level-path">{level.dir}</span>}
        </span>
        <span className={`badge ${badgeClass}`}>
          {level.status === 'empty' ? 'nothing found' : level.status}
        </span>
      </button>

      {open && (
        <div className="level-body">
          {level.note && <div className="level-note">{level.note}</div>}

          {level.errors.map((err, i) => (
            <div className="err-item" key={`${err.path}-${i}`}>
              ⚠ {err.message} — {err.path}
            </div>
          ))}

          {categories.map((category) => (
            <div key={category}>
              <div className="group-label">{CATEGORY_LABEL[category] || category}</div>
              {grouped.get(category).map((entry) => (
                <button
                  key={entry.id}
                  className={`entry${selectedPath === entry.absPath ? ' selected' : ''}`}
                  onClick={() => onSelect(entry)}
                  title={entry.absPath}
                >
                  <span
                    className={`dot${entry.error ? ' error' : entry.sensitive ? ' sensitive' : ''}`}
                  />
                  <span className="entry-name">{entryLabel(entry)}</span>
                  <span className="entry-size">{formatBytes(entry.size)}</span>
                </button>
              ))}
            </div>
          ))}

          {level.redacted.length > 0 && (
            <div className="redacted-list">
              {level.redacted.map((item) => (
                <div className="absent-item" key={item.absPath}>
                  🔒 {item.absPath} — {item.reason}
                </div>
              ))}
            </div>
          )}

          <OtherList items={level.other || []} />
          <AbsentList items={level.absent} />
        </div>
      )}
    </div>
  );
}

export default function LineageTree({ lineage, selectedPath, onSelect }) {
  return (
    <div>
      <div className="summary-bar">
        <span>{lineage.summary.levelCount} levels</span>
        <span>{lineage.summary.fileCount} files</span>
        {lineage.summary.errorCount > 0 && (
          <span style={{ color: 'var(--err)' }}>{lineage.summary.errorCount} errors</span>
        )}
        {lineage.summary.redactedCount > 0 && (
          <span>{lineage.summary.redactedCount} redacted</span>
        )}
        <span>{new Date(lineage.scannedAt).toLocaleTimeString()}</span>
      </div>
      {lineage.levels.map((level) => (
        <Level
          key={level.id}
          level={level}
          selectedPath={selectedPath}
          onSelect={onSelect}
          defaultOpen={level.status === 'found' || level.status === 'partial'}
        />
      ))}
    </div>
  );
}
