/**
 * Windows PowerShell 5.1, the one every Windows 10 and 11 has, and the quoting
 * that goes with starting it. No imports and nothing at load, so the exe's entry
 * (desktop/main.js) can use it without loading the server.
 *
 * Always the absolute System32 path, never a PATH lookup: a powershell.exe
 * earlier on PATH would run instead. PowerShell 7 is not assumed (#11).
 */

import path from 'node:path';

export const WINDOWS_POWERSHELL = path.join(
  process.env.SystemRoot || 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe'
);

/**
 * A PowerShell single-quoted literal. PowerShell treats the typographic quotes
 * U+2018 to U+201B as single quotes too, so a path such as C:\Users\Sean
 * O'Brien needs every one of them escaped, and the escape is the same
 * character doubled: replacing a curly one with an ASCII pair would change the
 * path. Checked with PowerShell's own parser for ', U+2018 and U+2019.
 */
export function psQuote(text) {
  return `'${String(text).replace(/['\u2018\u2019\u201A\u201B]/g, (q) => q + q)}'`;
}

/**
 * A path for a PowerShell parameter that expands wildcards, such as
 * Start-Process -WorkingDirectory in 5.1: a folder named "[proj] x" otherwise
 * matches nothing and the start fails (measured). The escape is a backtick
 * before [ ] and ` (* and ? cannot occur in a Windows path). It goes inside
 * psQuote, where the backticks stay literal for the wildcard engine to read.
 */
export function psWildcardEscape(text) {
  return String(text).replace(/[[\]`]/g, '`$&');
}

/**
 * One argument as the Windows command-line rules read it (CommandLineToArgvW,
 * and every C runtime): wrapped in double quotes when it holds a space or tab
 * or is empty, with trailing backslashes doubled so they do not escape the
 * closing quote. A double quote inside is refused rather than escaped: none
 * can occur in a Windows path, and the values quoted here are paths and ids.
 */
export function winArgQuote(arg) {
  const text = String(arg);
  if (text.includes('"')) throw new Error(`Refusing to quote an argument holding a double quote: ${text}`);
  if (text && !/[ \t]/.test(text)) return text;
  return `"${text.replace(/(\\+)$/, '$1$1')}"`;
}

/** A script as -EncodedCommand takes it: base64 of UTF-16LE, so no command line parses it. */
export function encodeCommand(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}
