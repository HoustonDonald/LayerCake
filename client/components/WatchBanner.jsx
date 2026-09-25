import React, { useState } from 'react';

/**
 * "Something changed on disk" banner.
 *
 * Shows only when there is something to say. The Rescan button is the whole
 * point: re-scanning replaces the lineage and would discard an in-progress
 * edit, so it stays an explicit act rather than something that happens to you
 * while you are typing. When the editor is dirty the button says so and asks
 * again, because losing unsaved work to a background event is exactly the kind
 * of surprise this tool should never produce.
 */
export default function WatchBanner({ changes, ready, error, editorDirty, onRescan, onDismiss, notify, notifySupported, onEnableNotifications, onDisableNotifications }) {
  const [confirming, setConfirming] = useState(false);

  // A watch that is only partly working is worth saying out loud: "no events"
  // would otherwise read as "nothing changed" when it really means "nobody was
  // looking at that ancestor".
  const gaps = (ready?.skipped?.length || 0) + (ready?.errors?.length || 0);

  if (error) {
    return (
      <div className="watch-banner watch-banner-warn">
        <span className="watch-dot watch-dot-off" />
        <span className="watch-text">Not watching for changes. {error}</span>
      </div>
    );
  }

  if (changes.length === 0) {
    if (!ready) return null;
    return (
      <div className="watch-banner watch-banner-idle">
        <span className="watch-dot watch-dot-on" />
        <span className="watch-text">
          Watching {ready.watchedCount} {ready.watchedCount === 1 ? 'folder' : 'folders'}
          {gaps > 0 && (
            <span className="watch-gap" title={gapTitle(ready)}>
              {' '}
              ({gaps} not watched)
            </span>
          )}
        </span>
        {notifySupported && (
          <button
            className="btn btn-small"
            onClick={notify ? onDisableNotifications : onEnableNotifications}
            title={
              notify
                ? 'Stop showing desktop notifications'
                : 'Show a desktop notification when this window is in the background'
            }
          >
            {notify ? 'Notifications on' : 'Notify me'}
          </button>
        )}
      </div>
    );
  }

  const summary =
    changes.length === 1
      ? `${changes[0].name || changes[0].absPath} changed on disk`
      : `${changes.length} files changed on disk`;

  return (
    <div className="watch-banner watch-banner-active">
      <span className="watch-dot watch-dot-hot" />
      <span className="watch-text">
        {summary}
        <span className="watch-paths" title={changes.map((c) => c.absPath).join('\n')}>
          {' '}
          {changes
            .slice(0, 3)
            .map((c) => c.name || c.absPath)
            .join(', ')}
          {changes.length > 3 ? `, and ${changes.length - 3} more` : ''}
        </span>
      </span>

      {confirming ? (
        <>
          <span className="watch-confirm">Re-scanning discards your unsaved edit.</span>
          <button className="btn btn-small btn-primary" onClick={onRescan}>
            Discard and rescan
          </button>
          <button className="btn btn-small" onClick={() => setConfirming(false)}>
            Keep editing
          </button>
        </>
      ) : (
        <>
          <button
            className="btn btn-small btn-primary"
            onClick={() => (editorDirty ? setConfirming(true) : onRescan())}
          >
            Rescan
          </button>
          <button className="btn btn-small" onClick={onDismiss}>
            Dismiss
          </button>
        </>
      )}
    </div>
  );
}

/** Tooltip listing what is NOT covered, so the gap count is checkable. */
function gapTitle(ready) {
  const lines = [];
  for (const s of ready.skipped || []) lines.push(`${s.absPath} - ${s.reason}`);
  for (const e of ready.errors || []) lines.push(`${e.path} - ${e.message}`);
  return lines.join('\n');
}
