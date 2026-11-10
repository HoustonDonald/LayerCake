// Stand-in for either CLI. No account, model, or files outside the fixture.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';

const tool = path.basename(process.argv[1]).startsWith('codex') ? 'codex' : 'claude';
const args = process.argv.slice(2);
const fixtureId = '9abc0000-0000-4000-8000-000000000001';
const dir = process.env.LAYERCAKE_FIXTURE_PROJECT;

if (args.includes('app-server')) {
  const saved = { id: fixtureId, cwd: dir, name: 'Saved Codex fixture', updatedAt: 1700000000, status: { type: 'notLoaded' } };
  for await (const line of createInterface({ input: process.stdin })) {
    const { id, method, params } = JSON.parse(line);
    if (!id) continue;
    const model = params?.cwd ? 'fixture-project' : 'fixture-user';
    const results = {
      initialize: {},
      'config/read': {
        config: { model, mcp_servers: { fixture: { env: { TOKEN: 'fixture-private-value' } } } },
        origins: { model: { name: { type: params?.cwd ? 'project' : 'user' } } },
        layers: [{ name: { type: 'user' }, config: { model: 'fixture-user' } }],
      },
      'configRequirements/read': { requirements: null },
      'skills/list': { data: [] },
      'hooks/list': { data: [] },
      'thread/list': { data: [saved], nextCursor: null },
      'thread/read': { thread: saved },
    };
    console.log(JSON.stringify({ id, result: results[method] }));
  }
} else {
  const option = (name) => args.includes(name) ? args[args.indexOf(name) + 1] : null;
  const id = option('--resume') || option('--session-id') || option('resume') || fixtureId;
  const settings = option('--settings') && JSON.parse(await fs.readFile(option('--settings'), 'utf8'));
  const report = tool === 'codex' ? process.env.LAYERCAKE_CODEX_REPORT : settings?.hooks.PreToolUse[0].hooks[0].url;
  const hook = async (event, body = {}) => {
    if (!report) return;
    await fetch(report, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: id, cwd: process.cwd(), hook_event_name: event, ...body }),
    });
  };
  await hook(tool === 'codex' ? 'SessionStart' : 'UserPromptSubmit');
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  rl.on('SIGINT', () => console.log('FIXTURE INTERRUPTED'));
  console.log(`FIXTURE READY ${tool}`);
  for await (const line of rl) {
    if (line === 'fixture-exit') break;
    if (line === 'fixture-edit') {
      const data = tool === 'codex'
        ? { tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Update File: lib/main.js\n*** End Patch' },
          tool_response: 'Success. Updated the following files:' }
        : { tool_name: 'Edit', tool_input: { file_path: path.join(process.cwd(), 'lib', 'main.js') } };
      data.tool_use_id = 'fixture-edit';
      await hook('PreToolUse', data);
      await hook('PostToolUse', data);
    }
    if (line === 'fixture-test') {
      const data = { tool_name: 'Bash', tool_use_id: 'fixture-test', tool_input: { command: 'npm test' }, tool_response: { exit_code: 0 } };
      await hook('PreToolUse', data);
      await hook('PostToolUse', data);
    }
    // For a tab's state (#207): a call that starts and does not finish, a
    // permission prompt (Claude Code reports one; Codex does not), a turn's end.
    if (line === 'fixture-pending') await hook('PreToolUse', { tool_name: 'Bash', tool_use_id: 'fixture-pending', tool_input: { command: 'npm run build' } });
    if (line === 'fixture-permission') await hook('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'npm run build' } });
    if (line === 'fixture-stop') await hook('Stop');
    // Delimiters distinguish our response from the terminal's local echo.
    console.log(`FIXTURE RECEIVED [${line}]`);
  }
  await hook('SessionEnd');
  rl.close();
}
