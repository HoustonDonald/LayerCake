import React, { useCallback, useEffect, useState } from 'react';

import { compareSnapshot, createSnapshot, listSnapshots, restore } from '../api.js';

const STATUS_LABEL = {
  same: 'unchanged',
  changed: 'differs from disk',
  missing: 'gone from disk',
  error: 'unreadable',
};

function when(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString();
}

/**
 * Snapshot browser and selective restore.
 *
 * Restore is deliberately a two step flow: pick a snapshot, see a per-file
 * comparison against what is on disk right now, then choose which files to put
 * back. A one-click "restore everything" would be faster and much easier to
 * regret, since most files in a snapshot are usually identical to disk and
 * restoring them is pure noise.
 */
export default function SnapshotPanel({ scanId, onRestored }) {
  const [snapshots, setSnapshots] = useState([]);
  const [root, setRoot] = useState('');
  const [selected, setSelected] = useState(null);
  const [comparison, setComparison] = useState(null);
  const [checked, setChecked] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [outcome, setOutcome] = useState(null);
  const [label, setLabel] = useState('');

  const refresh = useCallback(async () => {
    try {
      const res = await listSnapshots();
      setSnapshots(res.snapshots);
      setRoot(res.root);
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function take() {
    setBusy(true);
    setError(null);
    setOutcome(null);
    try {
      const m = await createSnapshot(scanId, label);
      setLabel('');
      setOutcome(
        `Captured ${m.counts.files} files as ${m.id}` +
          (m.counts.skipped ? `, skipped ${m.counts.skipped} oversized` : '') +
          (m.counts.errors ? `, ${m.counts.errors} unreadable` : '')
      );
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function open(id) {
    setSelected(id);
    setComparison(null);
    setChecked(new Set());
    setOutcome(null);
    setError(null);
    setBusy(true);
    try {
      const cmp = await compareSnapshot(id);
      setComparison(cmp);
      // Preselect only what actually differs. Restoring an identical file is a
      // write with no effect, and it would pad the confirmation with noise.
      setChecked(new Set(cmp.rows.filter((r) => r.status === 'changed').map((r) => r.absPath)));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function toggle(absPath) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(absPath)) next.delete(absPath);
      else next.add(absPath);
      return next;
    });
  }

  async function put() {
    setBusy(true);
    setError(null);
    setOutcome(null);
    try {
      const res = await restore(scanId, selected, [...checked]);
      setOutcome(
        `Restored ${res.restored.length} files. Undo snapshot: ${res.undoSnapshotId}` +
          (res.failed.length ? `. ${res.failed.length} failed.` : '')
      );
      if (res.failed.length) {
        setError(res.failed.map((f) => `${f.absPath}: ${f.message}`).join('\n'));
      }
      await open(selected);
      onRestored?.(res);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const rows = comparison?.rows || [];
  const differing = rows.filter((r) => r.status !== 'same').length;
  const sensitive = comparison?.manifest?.counts?.sensitive || 0;

  return (
    <div className="snapshots">
      <div className="snap-head">
        <div className="snap-actions">
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Label this snapshot (optional)"
            spellCheck={false}
          />
          <button className="btn btn-primary" onClick={take} disabled={busy || !scanId}>
            Take snapshot
          </button>
        </div>
        {root && <div className="snap-root">Stored in {root}</div>}
      </div>

      {error && <div className="notice err">{error}</div>}
      {outcome && <div className="notice ok">{outcome}</div>}

      <div className="snap-body">
        <ul className="snap-list">
          {snapshots.length === 0 && <li className="snap-empty">No snapshots yet.</li>}
          {snapshots.map((s) => (
            <li key={s.id}>
              <button
                className={`snap-item${selected === s.id ? ' selected' : ''}`}
                onClick={() => open(s.id)}
                disabled={s.broken}
              >
                <span className="snap-when">{when(s.createdAt) || s.id}</span>
                {s.label && <span className="snap-label">{s.label}</span>}
                <span className="snap-count">
                  {s.broken ? 'unreadable manifest' : `${s.counts?.files ?? 0} files`}
                </span>
              </button>
            </li>
          ))}
        </ul>

        <div className="snap-detail">
          {!selected && <div className="empty-state">Pick a snapshot to compare it against disk.</div>}

          {selected && comparison && (
            <>
              <div className="snap-summary">
                {rows.length} files captured, {differing} differ from disk now.
              </div>

              {sensitive > 0 && (
                <div className="notice warn">
                  {sensitive} file{sensitive === 1 ? '' : 's'} in this snapshot can hold OAuth tokens
                  or machine-specific values. In place it inherits the same permissions as the
                  original, but do not copy this snapshot to a share, a USB stick or another machine
                  without thinking about that.
                </div>
              )}

              <table className="snap-table">
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.absPath} className={r.status === 'same' ? 'is-same' : ''}>
                      <td className="snap-check">
                        <input
                          type="checkbox"
                          checked={checked.has(r.absPath)}
                          onChange={() => toggle(r.absPath)}
                          disabled={r.status === 'error'}
                        />
                      </td>
                      <td className="snap-path" title={r.absPath}>
                        {r.absPath}
                        {r.sensitive && <span className="dot sensitive" title="May hold secrets" />}
                      </td>
                      <td className={`snap-status status-${r.status}`}>{STATUS_LABEL[r.status]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <div className="snap-footer">
                <button
                  className="btn btn-primary"
                  onClick={put}
                  disabled={busy || checked.size === 0}
                >
                  Restore {checked.size} selected
                </button>
                <span className="editor-hint">
                  A snapshot of the current state is taken first, so a restore is itself undoable.
                </span>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
