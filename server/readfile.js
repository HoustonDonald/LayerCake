/**
 * Single file reader. The only place a file body is produced.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import yaml from 'js-yaml';

import { FILE_TIMEOUT_MS, MAX_FILE_BYTES, isSecret, isSensitive, describeError } from './safety.js';
import { timedFsCall } from './sharegate.js';

const MARKDOWN_EXTS = new Set(['.md', '.markdown', '.mdx']);
const JSON_EXTS = new Set(['.json', '.jsonc']);

/**
 * Splits YAML frontmatter from a markdown body.
 * Tolerant by design: a malformed block is returned as raw text with the parse
 * error attached rather than failing the whole read.
 */
export function splitFrontmatter(text) {
  const match = /^\ufeff?---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { frontmatter: null, frontmatterRaw: null, frontmatterError: null, body: text };

  const raw = match[1];
  const body = text.slice(match[0].length);
  try {
    const parsed = yaml.load(raw, { schema: yaml.JSON_SCHEMA });
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { frontmatter: parsed, frontmatterRaw: raw, frontmatterError: null, body };
    }
    return {
      frontmatter: null,
      frontmatterRaw: raw,
      frontmatterError: 'Frontmatter is not a key/value mapping',
      body,
    };
  } catch (err) {
    return {
      frontmatter: null,
      frontmatterRaw: raw,
      frontmatterError: err.message,
      body,
    };
  }
}

export function classify(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (MARKDOWN_EXTS.has(ext)) return 'markdown';
  if (JSON_EXTS.has(ext)) return 'json';
  return 'text';
}

/**
 * Reads a file for display. Never throws on filesystem problems: an error is a
 * value the UI renders as a badge.
 */
export async function readForDisplay(absPath) {
  const base = {
    path: absPath,
    name: path.basename(absPath),
    ext: path.extname(absPath).toLowerCase(),
    kind: classify(absPath),
    sensitive: isSensitive(absPath),
  };

  if (isSecret(absPath)) {
    return { ...base, error: { code: 'EREDACTED', message: 'Credential file. Never read by this tool.' } };
  }

  let st;
  try {
    // Through the share gate, like the scan (#66): a click on a file whose
    // share has died costs a refusal, not a stranded thread per click.
    st = await timedFsCall(absPath, () => fs.stat(absPath));
  } catch (err) {
    return { ...base, error: describeError(err) };
  }
  if (st.isDirectory()) {
    return { ...base, error: { code: 'EISDIR', message: 'This is a directory, not a file.' } };
  }

  const truncated = st.size > MAX_FILE_BYTES;
  let content;
  try {
    if (truncated) {
      content = await timedFsCall(
        absPath,
        async () => {
          const handle = await fs.open(absPath, 'r');
          try {
            const buf = Buffer.alloc(MAX_FILE_BYTES);
            const { bytesRead } = await handle.read(buf, 0, MAX_FILE_BYTES, 0);
            return buf.subarray(0, bytesRead).toString('utf8');
          } finally {
            await handle.close();
          }
        },
        absPath,
        FILE_TIMEOUT_MS
      );
    } else {
      content = await timedFsCall(absPath, () => fs.readFile(absPath, 'utf8'), absPath, FILE_TIMEOUT_MS);
    }
  } catch (err) {
    return { ...base, size: st.size, error: describeError(err) };
  }

  const result = {
    ...base,
    size: st.size,
    mtime: st.mtime.toISOString(),
    truncated,
    truncatedAt: truncated ? MAX_FILE_BYTES : null,
    content,
    error: null,
  };

  if (base.kind === 'markdown') {
    const fm = splitFrontmatter(content);
    result.frontmatter = fm.frontmatter;
    result.frontmatterRaw = fm.frontmatterRaw;
    result.frontmatterError = fm.frontmatterError;
    result.body = fm.body;
  }

  if (base.kind === 'json' && !truncated) {
    try {
      result.parsed = JSON.parse(content);
      result.jsonError = null;
    } catch (err) {
      result.parsed = null;
      result.jsonError = err.message;
    }
  }

  return result;
}
