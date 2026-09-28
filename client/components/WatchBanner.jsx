import React, { useEffect, useState } from 'react';

/** Changed files named in the bar before the rest fold into "and N more". */
const SHOWN_FILES = 4;

/**
 * "Something changed on disk" banner.
 *
 * Shows only when there is something to say. The Rescan button is the whole
 * point: re-scanning replaces the lineage and would discard an in-progress
 * edit, so it stays an explicit act rather than something that happens to you
 * while you are typing. When the editor is dirty the button says so and asks
 * again, because losing unsaved work to a background event is exactly the kind
 * of surprise this tool should never produce.
 *
 * Each changed file carries a Mute button (#13). While Claude Code runs,
 * ~/.claude.json changes every few seconds, and a bar that re-lights for it
 * every time buries the change that matters. A muted file is still counted and
 * listed, marked muted; it only loses the right to light the bar. Nothing is
 * hidden, and nothing is filtered on the server: `mute` is this viewer's
 * preference, applied here.
 */
export default function WatchBanner({ changes, ready, error, editorDirty, onRescan, onDismiss, notify, notifyError, notifySupported, onEnableNotifications, onDisableNotifications, mute }) {
  const [confirming, setConfirming] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [showMuted, setShowMuted] = useState(false);

  const loud = changes.filter((c) => !mute.isMuted(c.absPath));
  const quiet = changes.filter((c) => mute.isMuted(c.absPath));
  const lit = loud.length > 0;

  // A pending "discard your edit?" was about changes that asked for a rescan.
  // Once only muted ones are left, nothing is asking, so the question goes.
  useEffect(() => {
    if (!lit) setConfirming(false);
  }, [lit]);

  // A watch that is only partly working is worth saying out loud: "no events"
  // would otherwise read as "nothing changed" when it really means "nobody was
  // looking at that ancestor".
  const gaps = (ready?.skipped?.length || 0) + (ready?.errors?.length || 0);

  // `error` is the stream's alone. A refused notification permission is shown
  // beside its button below, never here: sharing this state once replaced the
  // whole bar and hid real changes until a rescan (#128).
  if (error) {
    return (
      <div className="watch-banner watch-banner-warn">
        <span className="watch-dot watch-dot-off" />
        <span className="watch-text">Not watching for changes. {error}</span>
      </div>
    );
  }

  if (!lit && !ready) return null;

  // Unmuted first, so a muted file never pushes a real change out of view.
  const ordered = [...loud, ...quiet];
  const shown = showAll ? ordered : ordered.slice(0, SHOWN_FILES);
  const folded = ordered.length - shown.length;
  const files = ordered.length > 0 && (
    <span className="watch-files" title={ordered.map((c) => c.absPath).join('\n')}>
      {shown.map((c) => (
        <FileChip
          key={mute.keyOf(c.absPath)}
          path={c.absPath}
          name={c.name || c.absPath}
          muted={mute.isMuted(c.absPath)}
          onToggle={mute.toggle}
        />
      ))}
      {folded > 0 && (
        <button type="button" className="watch-more" onClick={() => setShowAll(true)}>
          and {folded} more
        </button>
      )}
      {showAll && ordered.length > SHOWN_FILES && (
        <button type="button" className="watch-more" onClick={() => setShowAll(false)}>
          fewer
        </button>
      )}
    </span>
  );

  // Muted files with no change pending are named too, behind a count, so a
  // mute set long ago can never leave a file silently out of the bar.
  const changedKeys = new Set(changes.map((c) => mute.keyOf(c.absPath)));
  const mutedIdle = mute.paths.filter((p) => !changedKeys.has(mute.keyOf(p)));
  const mutedList = mutedIdle.length > 0 && (
    <span className="watch-files">
      <button
        type="button"
        className="watch-more"
        title={mutedIdle.join('\n')}
        onClick={() => setShowMuted((v) => !v)}
      >
        {mutedIdle.length} {quiet.length > 0 ? 'other ' : ''}muted
      </button>
      {showMuted &&
        mutedIdle.map((p) => (
          <FileChip key={mute.keyOf(p)} path={p} name={baseName(p)} muted onToggle={mute.toggle} />
        ))}
    </span>
  );

  // Rescan and Dismiss, wherever changes are pending. The idle bar needs them
  // too: with only muted changes it used to keep their chips with no way to
  // clear them short of a rescan from elsewhere (#133).
  const actions = confirming ? (
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
  );

  if (!lit) {
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
          {quiet.length > 0 && (
            <span className="watch-quiet">
              , {quiet.length} muted {quiet.length === 1 ? 'change' : 'changes'}
            </span>
          )}
        </span>
        {files}
        {mutedList}
        {changes.length > 0 && actions}
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
        {notifyError && <span className="watch-notify-note">{notifyError}</span>}
      </div>
    );
  }

  // The count includes muted files: they changed too, and Rescan reads them.
  const summary =
    changes.length === 1
      ? `${changes[0].name || changes[0].absPath} changed on disk`
      : `${changes.length} files changed on disk${quiet.length ? ` (${quiet.length} muted)` : ''}`;

  return (
    <div className="watch-banner watch-banner-active">
      <span className="watch-dot watch-dot-hot" />
      <span className="watch-text">{summary}</span>
      {files}
      {mutedList}
      {actions}
    </div>
  );
}

/** One file in the bar, with the button that mutes or unmutes it. */
function FileChip({ path, name, muted, onToggle }) {
  return (
    <span className={muted ? 'watch-file watch-file-muted' : 'watch-file'} data-path={path} title={path}>
      <span className="watch-file-name">{name}</span>
      {muted && <span className="watch-file-state">muted</span>}
      <button
        type="button"
        className="watch-file-mute"
        onClick={() => onToggle(path)}
        title={
          muted
            ? 'Let changes to this file light the bar again'
            : 'Stop this file lighting the bar. Its changes are still counted and listed here.'
        }
      >
        {muted ? 'Unmute' : 'Mute'}
      </button>
    </span>
  );
}

function baseName(p) {
  return String(p).split(/[\\/]/).pop() || p;
}

/** Tooltip listing what is NOT covered, so the gap count is checkable. */
function gapTitle(ready) {
  const lines = [];
  for (const s of ready.skipped || []) lines.push(`${s.absPath} - ${s.reason}`);
  for (const e of ready.errors || []) lines.push(`${e.path} - ${e.message}`);
  return lines.join('\n');
}
