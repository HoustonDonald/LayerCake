/**
 * Follows an append-only JSON Lines file: reads only what was appended since
 * the last call, and hands each complete line to a callback.
 *
 * Shared by the transcript reader and the prompt-history reader, which both
 * tail files Claude Code appends to while it runs. Read-only: stat and
 * fs.open(path, 'r'), each through withTimeout.
 *
 * Lines are split on the newline byte, which never occurs inside a multi-byte
 * UTF-8 sequence, so a chunk boundary cannot cut a character in half. A file
 * that shrinks was rewritten rather than appended to, and is read again from
 * the start (the owner's reset() decides what that means for its state).
 */

import fs from 'node:fs/promises';

import { DIR_TIMEOUT_MS, withTimeout } from './safety.js';

const CHUNK_BYTES = 1024 * 1024;
const NEWLINE = 0x0a;

export class JsonlTail {
  /**
   * @param {string} file
   * @param {(record: object) => void} onRecord  called per parsed line
   * @param {() => void} onReset  called when the file shrank and is re-read
   */
  constructor(file, onRecord, onReset) {
    this.file = file;
    this.onRecord = onRecord;
    this.onReset = onReset;
    this.offset = 0;
    this.partial = Buffer.alloc(0);
    this.mtimeMs = 0;
    this.badLines = 0;
    this.pending = Promise.resolve();
  }

  /**
   * Reads anything appended since the last call. Returns true if anything was
   * read. Calls are serialized: the offset advances after each await, so two
   * overlapping reads would both consume the same bytes and push the offset
   * past them, and those records would be lost for good. Shown in review with
   * two streams polling one live session.
   */
  refresh() {
    const run = this.pending.then(() => this.readAppended());
    this.pending = run.catch(() => {});
    return run;
  }

  async readAppended() {
    const st = await withTimeout(fs.stat(this.file), DIR_TIMEOUT_MS, this.file);
    if (st.size < this.offset) {
      this.offset = 0;
      this.partial = Buffer.alloc(0);
      this.badLines = 0;
      this.onReset();
    }
    this.mtimeMs = st.mtimeMs;
    if (st.size === this.offset) return false;

    const handle = await withTimeout(fs.open(this.file, 'r'), DIR_TIMEOUT_MS, this.file);
    try {
      while (this.offset < st.size) {
        const length = Math.min(CHUNK_BYTES, st.size - this.offset);
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await withTimeout(
          handle.read(buffer, 0, length, this.offset),
          DIR_TIMEOUT_MS,
          this.file
        );
        if (bytesRead === 0) break;
        this.offset += bytesRead;
        this.consume(buffer.subarray(0, bytesRead));
      }
    } finally {
      await handle.close();
    }
    return true;
  }

  consume(chunk) {
    const data = this.partial.length ? Buffer.concat([this.partial, chunk]) : chunk;
    let start = 0;
    for (let i = data.indexOf(NEWLINE, start); i !== -1; i = data.indexOf(NEWLINE, start)) {
      this.line(data.subarray(start, i));
      start = i + 1;
    }
    // Copied, so the retained tail does not pin the whole chunk in memory.
    this.partial = Buffer.from(data.subarray(start));
  }

  line(bytes) {
    const text = bytes.toString('utf8').trim();
    if (!text) return;
    let record;
    try {
      record = JSON.parse(text);
    } catch {
      this.badLines += 1;
      return;
    }
    this.onRecord(record);
  }
}
