import { describe, expect, it } from 'vitest';
import { PassThrough, Writable } from 'node:stream';
import { MAX_FRAME_BYTES } from '../constants.js';
import {
  FrameDecoder,
  InFlightGuard,
  encodeFrame,
  writeFrame,
  type ProtocolFrame,
} from '../protocol.js';

/**
 * The Run facade protocol codec (kernel.md, the sandbox and local-log
 * sections): JSON-lines over stdio, one frame per line, 1 MiB per line with
 * an unterminated line killed at the cap, one request in flight per
 * direction, a callId mismatch or replay torn down. Pure and duplex-testable
 * in memory — no launcher, no processes.
 */

const READY: ProtocolFrame = {
  type: 'run/ready',
  tools: [{
    name: 'grep_world',
    description: 'search the world files',
    parameters: { type: 'object', properties: { pattern: { type: 'string' } } },
  }],
};

const FRAMES: readonly ProtocolFrame[] = [
  READY,
  { type: 'tool/invoke', callId: 'i-1', name: 'grep_world', args: { pattern: 'x' } },
  { type: 'tool/result', callId: 'i-1', ok: true, result: { matches: [] } },
  { type: 'tool/result', callId: 'i-1', ok: false, error: 'grep failed' },
  { type: 'svc/execute', callId: 's-1', cmd: 'grep -rn hi .' },
  { type: 'svc/web_search', callId: 's-2', query: 'landlock', maxResults: 5 },
  { type: 'svc/web_search', callId: 's-2', query: 'landlock' },
  { type: 'svc/web_fetch', callId: 's-3', url: 'https://example.org' },
  { type: 'svc/result', callId: 's-1', ok: true, result: { status: 'completed', exitCode: 0 } },
  { type: 'svc/result', callId: 's-1', ok: false, error: 'denied' },
  { type: 'run/dispose' },
];

describe('protocol codec: framing round-trip', () => {
  it('encodes each frame as one canonical line and decodes it back byte-identically', () => {
    for (const frame of FRAMES) {
      const line = encodeFrame(frame);
      expect(line.endsWith('\n')).toBe(true);
      expect(() => JSON.parse(line)).not.toThrow();
      const decoder = new FrameDecoder();
      const outcomes = decoder.push(line);
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]).toMatchObject({ status: 'frame', frame });
    }
  });

  it('decodes several frames split across arbitrary chunk boundaries', () => {
    const lines = FRAMES.map((frame) => encodeFrame(frame)).join('');
    const decoder = new FrameDecoder();
    const seen: ProtocolFrame[] = [];
    for (const char of lines) {
      for (const outcome of decoder.push(char)) {
        expect(outcome.status).toBe('frame');
        seen.push((outcome as { frame: ProtocolFrame }).frame);
      }
    }
    expect(seen).toEqual(FRAMES);
  });

  it('refuses a frame carrying a lone surrogate as invalid-shape (never a kernel crash)', () => {
    const decoder = new FrameDecoder();
    // A forged frame whose description is a lone surrogate: valid JSON to
    // parse, but no canonical form — the decoder refuses it before any
    // downstream canonicalization can throw inside the kernel. The JSON text
    // must carry the ESCAPE SEQUENCE (backslash-u-d800): JSON.parse decodes
    // it in memory to the lone surrogate, which the raw character cannot
    // reach (it lands as U+FFFD through any UTF-8 round trip).
    const jsonEscape = String.fromCharCode(0x5c) + 'ud800';
    const newline = String.fromCharCode(0x0a);
    const forged = `{"type":"run/ready","tools":[{"name":"x","description":"${jsonEscape}","parameters":{}}]}${newline}`;
    const outcomes = decoder.push(forged);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ status: 'teardown', reason: 'invalid-shape' });
  });

  it('decodes many complete lines arriving in one chunk', () => {
    const [first, second, third] = [
      FRAMES[0]!, FRAMES[1]!, FRAMES[2]!,
    ];
    const decoder = new FrameDecoder();
    const outcomes = decoder.push(
      encodeFrame(first) + encodeFrame(second) + encodeFrame(third).slice(0, 5),
    );
    expect(outcomes).toHaveLength(2);
    expect(outcomes[0]).toMatchObject({ status: 'frame', frame: first });
    expect(outcomes[1]).toMatchObject({ status: 'frame', frame: second });
    // The partial tail survives into the next chunk.
    const rest = decoder.push(encodeFrame(third).slice(5));
    expect(rest).toHaveLength(1);
    expect(rest[0]).toMatchObject({ status: 'frame', frame: third });
  });

  it('accepts a frame at exactly the cap and refuses one byte more at encode', () => {
    // The canonical encoding sorts keys, so the base length is measured, not
    // assumed: padding the result string grows the line one byte per char.
    const base = encodeFrame({ type: 'tool/result', callId: 'c', ok: true, result: '' });
    const fits = 'x'.repeat(MAX_FRAME_BYTES + 1 - base.length);
    const at = { type: 'tool/result', callId: 'c', ok: true, result: fits } as const;
    expect(Buffer.byteLength(encodeFrame(at))).toBe(MAX_FRAME_BYTES + 1); // cap content + terminator
    const over = {
      type: 'tool/result', callId: 'c', ok: true, result: fits + 'y',
    } as const;
    expect(() => encodeFrame(over)).toThrow(/frame/);
    // The cap counts content bytes, the decoder's own accounting: a frame at
    // exactly the cap decodes.
    const decoder = new FrameDecoder();
    expect(decoder.push(encodeFrame(at))[0]).toMatchObject({ status: 'frame' });
  });
});

describe('protocol codec: teardown verdicts', () => {
  it('kills an unterminated line at the cap and poisons the decoder', () => {
    const decoder = new FrameDecoder();
    const justUnder = 'x'.repeat(MAX_FRAME_BYTES - 1);
    expect(decoder.push(justUnder)).toEqual([]);
    const crossing = decoder.push('xy');
    expect(crossing).toHaveLength(1);
    expect(crossing[0]).toMatchObject({ status: 'teardown', reason: 'frame-cap' });
    // Poisoned: every later push is a teardown verdict, never a frame.
    expect(decoder.push('{"type":"run/dispose"}\n')[0])
      .toMatchObject({ status: 'teardown' });
  });

  it('kills a completed over-cap line at the byte that crosses, before the newline', () => {
    const decoder = new FrameDecoder();
    const first = Buffer.alloc(MAX_FRAME_BYTES - 1, 0x61);
    expect(decoder.push(first)).toEqual([]);
    const outcomes = decoder.push(Buffer.concat([Buffer.from('aa\n')]));
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ status: 'teardown', reason: 'frame-cap' });
  });

  it('tears down on malformed JSON and poisons the decoder', () => {
    const decoder = new FrameDecoder();
    const first = decoder.push('not json\n');
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ status: 'teardown', reason: 'malformed' });
    expect(decoder.push('{"type":"run/dispose"}\n')[0])
      .toMatchObject({ status: 'teardown', reason: 'poisoned' });
  });

  it('tears down on an unknown frame type', () => {
    const decoder = new FrameDecoder();
    expect(decoder.push('{"type":"nonsense"}\n')[0])
      .toMatchObject({ status: 'teardown', reason: 'unknown-type' });
  });

  it('tears down on every invalid frame shape', () => {
    const cases: string[] = [
      '{"type":"tool/invoke","name":"n","args":{}}',                       // no callId
      '{"type":"tool/invoke","callId":"c","name":"","args":{}}',           // empty name
      '{"type":"tool/invoke","callId":"c","name":"n"}',                    // no args
      '{"type":"tool/invoke","callId":"c","name":"n","args":{},"x":1}',    // stray key
      '{"type":"tool/result","callId":"c","ok":true}',                     // ok without result
      '{"type":"tool/result","callId":"c","ok":false}',                    // !ok without error
      '{"type":"tool/result","callId":"c","ok":true,"error":"e"}',         // ok carrying error
      '{"type":"run/ready","tools":"nope"}',                               // tools not an array
      '{"type":"run/ready","tools":[{"name":"n"}]}',                       // incomplete tool
      '{"type":"run/ready","tools":[{"name":"n","description":"d","parameters":[]}]}', // parameters not an object
      '{"type":"run/ready","tools":[{"name":"' + 'x'.repeat(65) + '","description":"d","parameters":{}}]}',
      '{"type":"svc/execute","callId":"c","cmd":""}',                      // empty command
      '{"type":"svc/web_search","callId":"c"}',                            // no query
      '{"type":"svc/web_search","callId":"c","query":"q","maxResults":0}', // out of range
      '{"type":"svc/web_fetch","callId":"c","url":""}',                    // empty url
      '{"type":"run/dispose","extra":true}',                               // stray key
    ];
    for (const line of cases) {
      const decoder = new FrameDecoder();
      const outcomes = decoder.push(`${line}\n`);
      expect(outcomes, line).toHaveLength(1);
      expect(outcomes[0], line).toMatchObject({ status: 'teardown', reason: 'invalid-shape' });
    }
  });

  it('treats a noise byte stream without a newline as one growing line, never a desync', () => {
    const decoder = new FrameDecoder();
    // A console.log-style burst of 64 KiB chunks without newlines: no frame is
    // ever produced, and the verdict arrives only when the cap is crossed.
    for (let i = 0; i < Math.floor(MAX_FRAME_BYTES / (64 * 1024)); i += 1) {
      expect(decoder.push('x'.repeat(64 * 1024))).toEqual([]);
    }
    const outcomes = decoder.push('x');
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ status: 'teardown', reason: 'frame-cap' });
  });
});

describe('protocol codec: one request in flight per direction', () => {
  it('accepts the matching callId and tears down a mismatched one', () => {
    const guard = new InFlightGuard();
    expect(guard.begin('a')).toBeNull();
    expect(guard.settle('b')).toEqual({ reason: 'callId-mismatch' });
    // The guard is poisoned after a desync.
    expect(guard.settle('a')).toEqual({ reason: 'poisoned' });
  });

  it('tears down a settle for a call that is not in flight', () => {
    const guard = new InFlightGuard();
    expect(guard.settle('nope')).toEqual({ reason: 'not-in-flight' });
  });

  it('tears down a second begin while one request is in flight', () => {
    const guard = new InFlightGuard();
    expect(guard.begin('a')).toBeNull();
    expect(guard.begin('b')).toEqual({ reason: 'busy' });
    expect(guard.settle('a')).toEqual({ reason: 'poisoned' });
  });

  it('tears down a replayed settle of an already-settled call', () => {
    const guard = new InFlightGuard();
    expect(guard.begin('a')).toBeNull();
    expect(guard.settle('a')).toBeNull();
    expect(guard.settle('a')).toEqual({ reason: 'not-in-flight' });
    expect(guard.begin('a')).toEqual({ reason: 'poisoned' });
  });
});

describe('protocol codec: duplex writes', () => {
  it('round-trips a frame through a real stream pair', async () => {
    const stream = new PassThrough();
    const decoder = new FrameDecoder();
    const delivered = new Promise<ReturnType<FrameDecoder['push']>>((resolve) => {
      stream.on('data', (chunk: Buffer) => { resolve(decoder.push(chunk)); });
    });
    await writeFrame(stream, {
      type: 'tool/invoke', callId: 'i-9', name: 'grep_world', args: {},
    });
    const outcomes = await delivered;
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      status: 'frame',
      frame: { type: 'tool/invoke', callId: 'i-9' },
    });
  });

  it('is drain-aware: the write resolves only after the stream drains', async () => {
    let drained = false;
    const slow = new PassThrough({ highWaterMark: 1 });
    slow.on('drain', () => { drained = true; });
    const before = slow.readableLength;
    expect(before).toBeGreaterThanOrEqual(0);
    let resolved = false;
    const written = writeFrame(slow, {
      type: 'tool/invoke', callId: 'i-10', name: 'grep_world',
      args: { pattern: 'x'.repeat(4096) },
    }).then(() => { resolved = true; });
    await new Promise((resolve) => setImmediate(resolve));
    expect(resolved).toBe(false);
    slow.read(); // pull the bytes through so the stream drains
    await written;
    expect(drained).toBe(true);
  });

  it('never writes an oversized frame to the stream', async () => {
    const stream = new PassThrough();
    const big = 'x'.repeat(MAX_FRAME_BYTES);
    await expect(writeFrame(stream, {
      type: 'tool/result', callId: 'c', ok: true, result: big,
    })).rejects.toThrow(/frame/);
    expect(stream.readableLength).toBe(0);
  });

  it('releases the write promise when the stream errors', async () => {
    const stream = new Writable({
      highWaterMark: 1,
      write(_chunk, _enc, callback) { callback(new Error('EPIPE-like')); },
    });
    await expect(writeFrame(stream, {
      type: 'run/dispose',
    })).rejects.toThrow('EPIPE-like');
  });
});
