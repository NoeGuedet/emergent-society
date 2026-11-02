// The conversation stream's cross-process writer: one short-lived helper under
// `<home>/.es/conversation.lock`, the lock-guard precedent (journal/lock.ts).
//
// Node has no flock binding, so the kernel's appends run here, under the lock
// held by util-linux flock (`flock -F` execs this helper in place, so the lock
// fd stays held for the whole critical section). The parent validates the
// record, ensures `<home>/.es` exists and spawns:
//
//   flock -F --exclusive --wait=<s> <lock> <node> conversation-append.mjs <cmd> <file>
//
// with the complete JSON line on stdin for `append`.
//
// Under the lock, `append` does exactly the audited sequence: stat (the file's
// start state and the create fact), the torn-tail TERMINATION FIRST (a
// non-empty stream not ending in a newline gets one appended, so a crash
// fragment becomes its own droppable degraded line and the new record is never
// glued to it), then the stat of the record's start offset, one O_APPEND write
// followed by one fsync, and the home directory's entry made durable when this
// helper created the file. `repair` is the host-only boot counterpart: a TAIL
// read that truncates one incomplete trailing fragment, under the same lock.
import { open, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

const MAX_LINE_BYTES = 64 * 1024;
const TAIL_READ_BYTES = 64 * 1024;
const NEWLINE = 0x0a;

const [, , command, file] = process.argv;

function fail(message) {
  process.stderr.write(`conversation-append: ${message}\n`);
  process.exit(1);
}

/** Reads stdin to EOF, bounded: the parent's line is a small JSON record. */
async function readStdin() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > MAX_LINE_BYTES) fail('the record line exceeds the helper bound');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Makes a file's directory entry durable (the home directory, 0700). */
async function syncDirectory(dir) {
  const handle = await open(dir, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Appends one line. The stat precedes the open: under the lock no other
 * locking writer can race it, and a stat that says ENOENT is this helper's
 * create fact.
 */
async function append() {
  const line = await readStdin();
  if (line.length === 0) fail('the record line is empty');
  if (line[line.length - 1] !== NEWLINE) fail('the record line is not newline-terminated');
  let exists = true;
  try {
    await stat(file);
  } catch (err) {
    if (err && err.code === 'ENOENT') exists = false;
    else throw err;
  }
  const handle = await open(file, 'a+', 0o600);
  let offset;
  try {
    // The torn-tail TERMINATION FIRST: the fragment keeps its bytes, but it
    // can never be glued to this record (one droppable degraded line).
    const start = (await handle.stat()).size;
    if (start > 0) {
      const last = Buffer.alloc(1);
      const { bytesRead } = await handle.read(last, 0, 1, start - 1);
      if (bytesRead === 1 && last[0] !== NEWLINE) {
        await handle.write('\n', null, 'utf8');
      }
    }
    // THEN the stat: the record's start offset, after any termination.
    offset = (await handle.stat()).size;
    await handle.write(line, null, 'utf8');
    await handle.sync();
    if (!exists) await syncDirectory(dirname(file));
  } finally {
    await handle.close();
  }
  process.stdout.write(`${JSON.stringify({ offset, bytes: line.length, created: !exists })}\n`);
}

/**
 * Truncates one incomplete trailing fragment. A clean stream (empty, or
 * newline-terminated) is untouched; a tail window with no newline at all is a
 * corrupted stream the helper refuses rather than truncating blindly.
 */
async function repair() {
  let size;
  try {
    size = (await stat(file)).size;
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      process.stdout.write(`${JSON.stringify({ repaired: 0, size: 0 })}\n`);
      return;
    }
    throw err;
  }
  if (size === 0) {
    process.stdout.write(`${JSON.stringify({ repaired: 0, size: 0 })}\n`);
    return;
  }
  const readBytes = Math.min(size, TAIL_READ_BYTES);
  const tail = Buffer.alloc(readBytes);
  const handle = await open(file, 'r+');
  try {
    let read = 0;
    while (read < readBytes) {
      const { bytesRead } = await handle.read(tail, read, readBytes - read, size - readBytes + read);
      if (bytesRead === 0) fail("the stream's tail could not be read");
      read += bytesRead;
    }
    if (tail[readBytes - 1] === NEWLINE) {
      process.stdout.write(`${JSON.stringify({ repaired: 0, size })}\n`);
      return;
    }
    const cut = tail.lastIndexOf(NEWLINE);
    if (cut === -1) fail('the trailing fragment is longer than the repair window');
    const kept = size - readBytes + cut + 1;
    await handle.truncate(kept);
    await handle.sync();
    process.stdout.write(`${JSON.stringify({ repaired: size - kept, size: kept })}\n`);
  } finally {
    await handle.close();
  }
}

if (file === undefined) fail('usage: conversation-append <append|repair> <file>');

try {
  if (command === 'append') await append();
  else if (command === 'repair') await repair();
  else fail(`unknown command ${JSON.stringify(command)}`);
} catch (err) {
  fail(err instanceof Error ? err.message : 'the conversation stream could not be written');
}
