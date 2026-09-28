import React, { useMemo } from 'react';
import { structuredPatch } from 'diff';

const LINE_CLASS = {
  '+': 'diff-add',
  '-': 'diff-del',
  ' ': 'diff-ctx',
  // jsdiff's "\ No newline at end of file" marker, which belongs to the line above.
  '\\': 'diff-note',
};

/**
 * A line diff of two texts, drawn as unified hunks with three lines of context.
 *
 * The diff comes from jsdiff rather than a hand-written one. A line diff is
 * Myers' algorithm plus hunking, a solved problem, and jsdiff is the standard
 * implementation of both with no dependencies of its own. It runs in the
 * browser on two strings the page already holds, so it adds no file reader and
 * nothing that could reach the network.
 *
 * Each line keeps its +/- marker, so the change reads the same in monochrome.
 *
 * It gives up after DIFF_TIMEOUT_MS, jsdiff's own `timeout` option, rather
 * than freeze the page (#54): replacing every line of a 5,000-line file took
 * 4.3 s, while a one-line edit of a 1.6 MB file takes about 20 ms and half of
 * a 2,000-line file changed about 300 ms (measured, jsdiff 9, Node 24).
 */
const DIFF_TIMEOUT_MS = 500;

const lineCount = (text) => (text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0);

export default function DiffView({ before, after }) {
  const hunks = useMemo(
    () => structuredPatch('', '', before, after, '', '', { context: 3, timeout: DIFF_TIMEOUT_MS })?.hunks ?? null,
    [before, after]
  );

  if (hunks === null) {
    return (
      <div className="notice info">
        Too different to show line by line: the comparison stopped after {DIFF_TIMEOUT_MS / 1000} s. The file has{' '}
        {lineCount(before)} lines now and {lineCount(after)} in your edit. Save replaces all of it, after a snapshot of
        what is there now.
      </div>
    );
  }
  if (hunks.length === 0) return <div className="notice info">No differences.</div>;

  let added = 0;
  let removed = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line[0] === '+') added += 1;
      else if (line[0] === '-') removed += 1;
    }
  }

  return (
    <div className="diff">
      <div className="diff-summary">
        {added} line{added === 1 ? '' : 's'} added, {removed} removed
      </div>
      <div className="diff-lines">
        {hunks.map((hunk) => (
          <div className="diff-hunk" key={`${hunk.oldStart}:${hunk.newStart}`}>
            <div className="diff-head">
              @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
            </div>
            {hunk.lines.map((line, i) => (
              <div key={i} className={`diff-line ${LINE_CLASS[line[0]] || 'diff-ctx'}`}>
                {line}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
