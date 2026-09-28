/**
 * Managed policy delivered through the Windows registry (#147; owner decision
 * 17, 2026-09-28): JSON in a `Settings` value under
 * HKLM\SOFTWARE\Policies\ClaudeCode, an MDM or group policy source ranked
 * above the managed settings files, and under HKCU\SOFTWARE\Policies\ClaudeCode,
 * which the user can write and which Claude Code reads only when no admin
 * source delivers policy. Docs and the 2.1.283 bundle agree on both keys, the
 * value name and its types (REG_SZ or REG_EXPAND_SZ).
 *
 * Read the way Claude Code reads it: reg.exe from its absolute System32 path
 * with a fixed argv (`query <key> /v Settings`), both keys at once, 5 s
 * timeout, output capped at 2 MiB, parsed as data and never executed. A
 * process LayerCake starts, so it has its line in CLAUDE.md. Windows only.
 *
 * reg.exe writes to a pipe in the console code page, not UTF-8 (measured on
 * this machine: "é" came back re-encoded and "✓" as "?"). Claude Code parses
 * the same output, so a character outside that code page is most likely lost
 * for it too (reasoned). A value with such bytes says so rather than looking
 * clean.
 *
 * The scan serves where each value is and whether it is there, as it does for
 * a file; the parsed content goes only to the settings view, as a file's does,
 * through policyValue().
 */

import { execFile } from 'node:child_process';
import path from 'node:path';

export const POLICY_VALUE_NAME = 'Settings';
const REG_TIMEOUT_MS = 5000;
const REG_MAX_BYTES = 2 * 1024 * 1024;

const SOURCES = [
  { id: 'hklm', label: 'HKLM registry policy', key: 'HKLM\\SOFTWARE\\Policies\\ClaudeCode' },
  { id: 'hkcu', label: 'HKCU registry policy', key: 'HKCU\\SOFTWARE\\Policies\\ClaudeCode' },
];

/**
 * LAYERCAKE_POLICY_KEYS, for smoke only: JSON {"hklm": key, "hkcu": key} read
 * in place of the real two, so smoke reads keys it wrote and never the
 * machine's policy. Only a key under HKCU\Software\LayerCakeSmoke is taken,
 * so the variable cannot aim the query anywhere else; anything else is an
 * error on both records, never a silent fall back to the real keys.
 */
const SMOKE_KEY = /^HKCU\\Software\\LayerCakeSmoke[\w.-]*(\\[\w.-]+)*$/i;

function policyKeys() {
  const raw = String(process.env.LAYERCAKE_POLICY_KEYS || '').trim();
  if (!raw) return { keys: SOURCES, error: null };
  let wanted = null;
  try {
    wanted = JSON.parse(raw);
  } catch {
    wanted = null;
  }
  const keys = SOURCES.map((s) => ({ ...s, key: typeof wanted?.[s.id] === 'string' ? wanted[s.id] : '' }));
  const bad = keys.find((k) => !SMOKE_KEY.test(k.key));
  if (bad) {
    return {
      keys: SOURCES,
      error: { code: 'EBADKEY', message: 'LAYERCAKE_POLICY_KEYS must name an hklm and an hkcu key under HKCU\\Software\\LayerCakeSmoke; not read.' },
    };
  }
  return { keys, error: null };
}

/** The keys and value this platform reads, for /api/manifest; empty off Windows. */
export function registryPolicyKeys() {
  if (process.platform !== 'win32') return [];
  return policyKeys().keys.map(({ id, key }) => ({ id, key, valueName: POLICY_VALUE_NAME }));
}

/** Each record's value, { text, parsed }, kept off the lineage the scan serves. */
const VALUES = new WeakMap();

/** The parsed JSON object a record holds, or null. */
export function policyValue(record) {
  return VALUES.get(record)?.parsed ?? null;
}

/** The value's text as reg.exe returned it, or null: shown when it does not parse, as a file's is. */
export function policyText(record) {
  return VALUES.get(record)?.text ?? null;
}

/** JSON.parse's own message for a value that did not parse, or null. */
export function policyParseError(record) {
  return VALUES.get(record)?.parseError ?? null;
}

function query(key) {
  const reg = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');
  return new Promise((resolve) => {
    execFile(
      reg,
      ['query', key, '/v', POLICY_VALUE_NAME],
      { timeout: REG_TIMEOUT_MS, maxBuffer: REG_MAX_BYTES, windowsHide: true, encoding: 'buffer' },
      (err, stdout, stderr) => resolve({ err, stdout, stderr })
    );
  });
}

/** One key's record from reg.exe's answer. */
function recordOf(source, { err, stdout, stderr }) {
  const record = {
    id: source.id,
    label: source.label,
    key: source.key,
    valueName: POLICY_VALUE_NAME,
    location: `${source.key}\\${POLICY_VALUE_NAME}`,
    state: 'absent',
    type: null,
    chars: null,
    topLevelKeys: null,
    jsonError: null,
    error: null,
    note: null,
  };
  if (err && err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    record.state = 'error';
    record.error = { code: 'E2BIG', message: 'The value is over 2 MiB, which Claude Code does not read either.' };
    return record;
  }
  if (err && (err.killed || err.signal)) {
    record.state = 'error';
    record.error = { code: 'ETIMEDOUT', message: `reg.exe took over ${REG_TIMEOUT_MS / 1000} s and was stopped.` };
    return record;
  }
  if (err && typeof err.code === 'string') {
    // Spawn failed: no reg.exe where Windows keeps it.
    record.state = 'error';
    record.error = { code: err.code, message: `reg.exe did not run: ${err.message}` };
    return record;
  }
  if (err) {
    // reg.exe answers a missing key or value with exit 1 and an ERROR line,
    // in the machine's language, so the line is kept as said, not matched.
    const said = String(stderr || '').trim().split(/\r?\n/)[0];
    record.note = said ? `reg.exe: ${said}` : null;
    return record;
  }

  const bytes = Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout || ''));
  const text = bytes.toString('utf8');
  const line = /^[ \t]+Settings[ \t]+(REG_[A-Z0-9_]+)[ \t]*([\s\S]*)$/im.exec(text);
  if (!line) {
    record.note = 'reg.exe answered without a Settings value.';
    return record;
  }
  record.state = 'set';
  record.type = line[1].toUpperCase();
  if (record.type !== 'REG_SZ' && record.type !== 'REG_EXPAND_SZ') {
    record.note = `A ${record.type} value: Claude Code reads only REG_SZ or REG_EXPAND_SZ, so it takes no policy from it.`;
    return record;
  }
  // REG_EXPAND_SZ comes back unexpanded (measured), as Claude Code gets it.
  const value = line[2].trim();
  record.chars = value.length;
  if (bytes.some((b) => b > 0x7f)) {
    record.note =
      'The value holds characters outside plain ASCII. reg.exe returns them in the console code page, which ' +
      'loses any it cannot represent, and Claude Code reads the same output: such characters are most likely ' +
      'lost for it too.';
  }
  VALUES.set(record, { text: value, parsed: null });
  if (!value) {
    record.jsonError = 'The value is empty.';
    return record;
  }
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (e) {
    // V8's message quotes the text it could not parse, and this record is
    // served with the scan: its words go to the settings view only.
    record.jsonError = 'The value is not valid JSON.';
    VALUES.set(record, { text: value, parsed: null, parseError: e.message });
    return record;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    record.jsonError = 'The value is JSON but not an object, so it holds no settings.';
    return record;
  }
  record.topLevelKeys = Object.keys(parsed).length;
  VALUES.set(record, { text: value, parsed });
  return record;
}

/**
 * Both registry sources as records, HKLM first. Empty off Windows. Errors
 * are values: a failed query is a record in state "error", never a throw.
 */
export async function readRegistryPolicy() {
  if (process.platform !== 'win32') return [];
  const { keys, error } = policyKeys();
  if (error) {
    return keys.map((source) => ({
      ...recordOf(source, { err: null, stdout: '', stderr: '' }),
      state: 'error',
      error,
      note: null,
    }));
  }
  const answers = await Promise.all(keys.map((source) => query(source.key)));
  return keys.map((source, i) => recordOf(source, answers[i]));
}
