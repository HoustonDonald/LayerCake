/**
 * Stands in for `claude -p` in the smoke test (LAYERCAKE_CLAUDE_CMD), so the
 * AI summary path runs without spending anyone's usage.
 *
 *   node smoke-claude-stub.mjs <control dir> ...the real claude arguments...
 *
 * <control dir>/mode decides the behaviour:
 *   exit-early  exit at once without reading stdin, as a claude that rejects
 *               a flag would; a large digest then breaks the pipe
 *   ok          read the digest, record argv and stdin, answer like claude -p
 */

import fs from 'node:fs';
import path from 'node:path';

const [control, ...args] = process.argv.slice(2);
const mode = fs.readFileSync(path.join(control, 'mode'), 'utf8').trim();

if (mode === 'exit-early') process.exit(1);

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  fs.writeFileSync(path.join(control, 'last-run.json'), JSON.stringify({ args, input }));
  process.stdout.write(
    JSON.stringify({
      type: 'result',
      is_error: false,
      result: '- stub summary: the widget was fixed',
      total_cost_usd: 0.0001,
      usage: { input_tokens: 120, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 12 },
      modelUsage: { 'claude-haiku-4-5': {} },
    })
  );
});
