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
 */
export default function DiffView({ before, after }) {
  const hunks = useMemo(
    () => structuredPatch('', '', before, after, '', '', { context: 3 }).hunks,
    [before, after]
  );

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
