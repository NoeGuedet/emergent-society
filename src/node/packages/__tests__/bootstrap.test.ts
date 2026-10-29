import { describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Writable } from 'node:stream';
import { canonicalizeJson, type JsonValue } from '../../../journal/index.js';
import { MAX_FRAME_BYTES , MAX_OUTPUT_LOG_BYTES } from '../constants.js';
import { encodeFrame, validateFrame, type ProtocolFrame } from '../protocol.js';

/**
 * The Run bootstrap (kernel.md, the sandbox and local-log sections): the child
 * side of the facade. Verify-then-use before a single guest byte evaluates,
 * a bounded print capture on `output.log` with fd 1 reserved for frames, a
 * 1 MiB per-line accounting on stdin, one handler and one service request in
 * flight, and a canonical frame encoder in lockstep with `protocol.ts`.
 *
 * The bootstrap is a script with no exports, so the unit assertions load the
 * source the way Node loads it (types stripped) and take the inlined functions
 * from the evaluated body; the end-to-end assertions copy the source into a
 * fresh leaf and spawn it under Node 24's native type stripping — the spawn is
 * also the proof that the file is erasable-syntax only. Every leaf is
 * `mkdtemp`'d and every spawned child is killed in `finally`.
 */

const BOOTSTRAP_SOURCE = readFileSync(new URL('../run-bootstrap.ts', import.meta.url), 'utf8');
const ECHO_SOURCE = readFileSync(new URL('./fixtures/echo.js', import.meta.url), 'utf8');
/** A source whose TOP-LEVEL code writes a marker: if any guest byte ran
 * before the digest check, this file exists — verify-then-use's own proof. */
const SIDE_EFFECT_SOURCE = 'const fs = await import("node:fs");'
  + ' fs.writeFileSync("guest-ran.txt", "ran");'
  + ' return { tools: [] };\n';
const WORLDWRITE_SOURCE = readFileSync(new URL('./fixtures/worldwrite.js', import.meta.url), 'utf8');
const CRASHY_SOURCE = readFileSync(new URL('./fixtures/crashy.js', import.meta.url), 'utf8');
const BADSHAPE_SOURCE = readFileSync(new URL('./fixtures/badshape.js', import.meta.url), 'utf8');

/** A guest whose handler prints: the print must never reach stdout. */
const NOISY_SOURCE = `
return {
  tools: [
    {
      name: 'noisy',
      description: 'prints and returns',
      parameters: { type: 'object', properties: {}, required: [] },
      handler: async () => {
        console.log('hello from the guest');
        return { ok: true };
      },
    },
  ],
};
`;

/** A guest whose print exceeds the capture cap: the excess is dropped. */
const PRINT_BOMB_SOURCE = `
return {
  tools: [
    {
      name: 'bomb',
      description: 'prints more than the capture cap',
      parameters: { type: 'object', properties: {}, required: [] },
      handler: async () => {
        console.log('x'.repeat(70_000));
        return null;
      },
    },
  ],
};
`;

/** A guest whose handler returns a function: no canonical JSON form. */
const UNSERIALIZABLE_SOURCE = `
return {
  tools: [
    {
      name: 'weird',
      description: 'returns a function',
      parameters: { type: 'object', properties: {}, required: [] },
      handler: async () => () => 1,
    },
  ],
};
`;

type BootstrapCodec = {
  readonly sha256HexOfBytes: (bytes: Uint8Array) => string;
  readonly canonicalStringify: (value: unknown) => string;
};

/**
 * Loads the inlined codec exactly as Node loads the script (type stripping,
 * one evaluated body) and exposes the two functions the lockstep tests compare.
 */
function loadBootstrapCodec(): BootstrapCodec {
  const stripped = stripTypeScriptTypes(BOOTSTRAP_SOURCE, { mode: 'strip' });
  const factory = new Function(
    `${stripped}\nreturn { sha256HexOfBytes: sha256HexOfBytes, canonicalStringify: canonicalStringify };`,
  ) as () => BootstrapCodec;
  return factory();
}

const CODEC = loadBootstrapCodec();

function sha256Of(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

describe('the inline sha256', () => {
  it('matches node:crypto on empty, short, long and multi-block inputs', () => {
    const inputs: Uint8Array[] = [
      new Uint8Array(0),
      Buffer.from('abc', 'utf8'),
      Buffer.from('the quick brown fox jumps over the lazy dog', 'utf8'),
      Buffer.from('héllo wörld — ✓', 'utf8'),
      Buffer.from(Array.from({ length: 1_000 }, (_, index) => index % 256)),
      Buffer.alloc(MAX_FRAME_BYTES, 0x61),
      Buffer.from('abc'.repeat(100_000), 'utf8'),
    ];
    for (const input of inputs) {
      expect(CODEC.sha256HexOfBytes(input)).toBe(createHash('sha256').update(input).digest('hex'));
    }
  });

  it('matches node:crypto around every padding-boundary length', () => {
    for (const length of [0, 1, 54, 55, 56, 63, 64, 65, 119, 120, 127, 128, 129]) {
      const input = Buffer.alloc(length, 0x7a);
      expect(CODEC.sha256HexOfBytes(input)).toBe(createHash('sha256').update(input).digest('hex'));
    }
  });
});

describe('the inline canonical encoder (lockstep with canonicalizeJson)', () => {
  it('is byte-identical for run/ready with a nested schema', () => {
    const frame: JsonValue = {
      type: 'run/ready',
      tools: [{
        name: 'grep_world',
        description: 'search the world files',
        parameters: {
          type: 'object',
          properties: {
            pattern: { type: 'string', minLength: 1 },
            glob: { type: 'string' },
            limit: { type: 'number', maximum: 50 },
          },
          required: ['pattern'],
          additionalProperties: false,
        },
      }],
    };
    expect(CODEC.canonicalStringify(frame)).toBe(canonicalizeJson(frame));
  });

  it('is byte-identical for result, error and service frames', () => {
    const frames: readonly JsonValue[] = [
      {
        type: 'tool/result',
        callId: 'i-1',
        ok: true,
        result: { echoed: 'héllo ✓', nested: { z: 1, a: [true, null, 3.5] } },
      },
      { type: 'tool/result', callId: 'i-2', ok: false, error: 'boom' },
      { type: 'svc/execute', callId: 'svc-1', cmd: 'touch marker.txt' },
      { type: 'svc/web_search', callId: 'svc-2', query: 'landlock', maxResults: 5 },
      { type: 'svc/web_fetch', callId: 'svc-3', url: 'https://example.org' },
    ];
    for (const frame of frames) {
      expect(CODEC.canonicalStringify(frame)).toBe(canonicalizeJson(frame));
    }
  });

  it('sorts by UTF-16 code unit, escapes like JSON and refuses lone surrogates', () => {
    const frame: JsonValue = { b: 1, a: 2, 'ä': 3, Z: 4, '0': 5, 'é': 6 };
    expect(CODEC.canonicalStringify(frame)).toBe(canonicalizeJson(frame));
    expect(CODEC.canonicalStringify(frame)).toBe('{"0":5,"Z":4,"a":2,"b":1,"ä":3,"é":6}');
    expect(() => CODEC.canonicalStringify('\ud800')).toThrow();
    expect(() => canonicalizeJson('\ud800')).toThrow();
  });
});

describe('the bootstrap source', () => {
  it('has no static imports or exports and only node: built-in runtime loads', () => {
    expect(BOOTSTRAP_SOURCE).not.toMatch(/^\s*import\b/m);
    expect(BOOTSTRAP_SOURCE).not.toMatch(/^\s*export\b/m);
    expect(BOOTSTRAP_SOURCE).not.toMatch(/\brequire\s*\(/);
    const specifiers: string[] = [];
    for (const match of BOOTSTRAP_SOURCE.matchAll(/\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g)) {
      specifiers.push(match[2] ?? '');
    }
    expect(specifiers.length).toBeGreaterThan(0);
    expect(specifiers.every((specifier) => specifier.startsWith('node:'))).toBe(true);
    expect(new Set(specifiers)).toEqual(new Set(['node:fs']));
  });
});

type ExitStatus = { readonly code: number | null; readonly signal: NodeJS.Signals | null };

type FrameWaiter = {
  readonly resolve: (frame: ProtocolFrame) => void;
  readonly reject: (error: Error) => void;
};

function withTimeout<T>(promise: Promise<T>, milliseconds: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timed out after ${milliseconds} ms waiting for ${what}`));
    }, milliseconds);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** One spawned bootstrap child: kernel-side framing over its pipes. */
class Harness {
  private readonly child: ChildProcess;
  private readonly stdin: Writable;
  private readonly closedPromise: Promise<ExitStatus>;
  private readonly frames: ProtocolFrame[] = [];
  private receivedFrames = 0;
  private frameWaiter: FrameWaiter | null = null;
  private frameFailure: Error | null = null;
  private stdoutBuffer = '';
  stdoutText = '';
  stderrText = '';

  constructor(scriptPath: string, scriptArgs: readonly string[], cwd: string) {
    const child: ChildProcess = spawn(process.execPath, [scriptPath, ...scriptArgs], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      // The production allowlist, mirrored: nothing inherited from the test env.
      env: { HOME: cwd, TMPDIR: cwd },
    });
    if (child.stdin === null || child.stdout === null || child.stderr === null) {
      child.kill('SIGKILL');
      throw new Error('the bootstrap child must be spawned with pipes');
    }
    this.child = child;
    this.stdin = child.stdin;
    this.closedPromise = new Promise<ExitStatus>((resolve) => {
      child.on('close', (code, signal) => {
        resolve({ code, signal });
      });
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      this.onStdout(chunk);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.stderrText += chunk;
    });
    child.stdin.on('error', () => {
      // EPIPE after a kill is expected, never a test failure.
    });
    child.on('exit', (code, signal) => {
      this.onExit(code, signal);
    });
  }

  /** Sends one kernel-side frame through the real encoder. */
  send(frame: ProtocolFrame): void {
    this.stdin.write(encodeFrame(frame));
  }

  /** Writes raw bytes to the child's stdin (the over-cap case). */
  writeRaw(text: string): void {
    this.stdin.write(text);
  }

  /** The next fully validated frame from the child. */
  nextFrame(): Promise<ProtocolFrame> {
    if (this.frameFailure !== null) return Promise.reject(this.frameFailure);
    const queued = this.frames.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    const waited = new Promise<ProtocolFrame>((resolve, reject) => {
      this.frameWaiter = { resolve, reject };
    });
    return withTimeout(waited, 5_000, 'a protocol frame');
  }

  waitForExit(): Promise<ExitStatus> {
    return withTimeout(this.closedPromise, 10_000, 'the child exit');
  }

  receivedCount(): number {
    return this.receivedFrames;
  }

  kill(): void {
    try {
      this.child.kill('SIGKILL');
    } catch {
      // Already gone.
    }
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    const waiter = this.frameWaiter;
    if (waiter !== null) {
      this.frameWaiter = null;
      waiter.reject(new Error(`child exited (code ${String(code)}, signal ${String(signal)}) before the next frame`));
    }
  }

  private onStdout(chunk: string): void {
    this.stdoutText += chunk;
    this.stdoutBuffer += chunk;
    let newline = this.stdoutBuffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.stdoutBuffer.slice(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line.length > 0) this.acceptLine(line);
      newline = this.stdoutBuffer.indexOf('\n');
    }
  }

  private acceptLine(line: string): void {
    try {
      const parsed: unknown = JSON.parse(line);
      const frame = validateFrame(parsed);
      this.receivedFrames += 1;
      const waiter = this.frameWaiter;
      if (waiter !== null) {
        this.frameWaiter = null;
        waiter.resolve(frame);
        return;
      }
      this.frames.push(frame);
    } catch (err) {
      const failure = err instanceof Error ? err : new Error(String(err));
      this.frameFailure = failure;
      const waiter = this.frameWaiter;
      if (waiter !== null) {
        this.frameWaiter = null;
        waiter.reject(failure);
      }
    }
  }
}

type Leaf = {
  readonly dir: string;
  readonly bootstrapPath: string;
  readonly packagePath: string;
  readonly outputPath: string;
  readonly sourceSha: string;
};

function makeLeaf(source: string): Leaf {
  const dir = mkdtempSync(join(tmpdir(), 'es-run-bootstrap-'));
  const bootstrapPath = join(dir, 'run-bootstrap.ts');
  writeFileSync(bootstrapPath, BOOTSTRAP_SOURCE);
  const packagePath = join(dir, 'package.js');
  writeFileSync(packagePath, source);
  return {
    dir,
    bootstrapPath,
    packagePath,
    outputPath: join(dir, 'output.log'),
    sourceSha: sha256Of(source),
  };
}

function startLeaf(leaf: Leaf, expectedSha: string = leaf.sourceSha): Harness {
  return new Harness(
    leaf.bootstrapPath,
    ['es-package-id', expectedSha, leaf.packagePath, leaf.outputPath],
    leaf.dir,
  );
}

async function cleanup(harness: Harness, leaf: Leaf): Promise<void> {
  harness.kill();
  await harness.waitForExit();
  rmSync(leaf.dir, { recursive: true, force: true });
}

async function expectReady(harness: Harness): Promise<ProtocolFrame> {
  const frame = await harness.nextFrame();
  expect(frame.type).toBe('run/ready');
  return frame;
}

describe('the spawned bootstrap child', () => {
  it('serves run/ready and one tool/invoke for the echo fixture', async () => {
    const leaf = makeLeaf(ECHO_SOURCE);
    const harness = startLeaf(leaf);
    try {
      const ready = await expectReady(harness);
      if (ready.type !== 'run/ready') throw new Error('expected run/ready');
      expect(ready.tools).toEqual([{
        name: 'echo_text',
        description: 'echoes the text',
        parameters: {
          type: 'object',
          properties: { text: { type: 'string', minLength: 1 } },
          required: ['text'],
          additionalProperties: false,
        },
      }]);
      harness.send({ type: 'tool/invoke', callId: 'i-1', name: 'echo_text', args: { text: 'hello' } });
      expect(await harness.nextFrame()).toEqual({
        type: 'tool/result', callId: 'i-1', ok: true, result: { echoed: 'hello' },
      });
      expect(harness.stderrText).toBe('');
    } finally {
      await cleanup(harness, leaf);
    }
  }, 20_000);

  it('refuses a substituted package.js: exit 1, no run/ready, no stdout', async () => {
    const leaf = makeLeaf(SIDE_EFFECT_SOURCE);
    const harness = startLeaf(leaf, sha256Of('a different source'));
    try {
      const status = await harness.waitForExit();
      expect(status.code).toBe(1);
      expect(harness.stdoutText).toBe('');
      expect(harness.receivedCount()).toBe(0);
      expect(harness.stderrText).toBe('');
      // Verify-then-use: not a single guest byte evaluated — the marker the
      // guest's TOP-LEVEL code writes, and the capture file its evaluation
      // would have opened, both never exist.
      expect(existsSync(leaf.outputPath)).toBe(false);
      expect(existsSync(join(leaf.dir, 'guest-ran.txt'))).toBe(false);
    } finally {
      await cleanup(harness, leaf);
    }
  }, 20_000);

  it('turns a thrown handler value into a bounded error and keeps serving', async () => {
    const leaf = makeLeaf(CRASHY_SOURCE);
    const harness = startLeaf(leaf);
    try {
      await expectReady(harness);
      harness.send({ type: 'tool/invoke', callId: 'i-1', name: 'explode', args: {} });
      expect(await harness.nextFrame()).toEqual({
        type: 'tool/result', callId: 'i-1', ok: false, error: 'boom',
      });
      harness.send({ type: 'tool/invoke', callId: 'i-2', name: 'explode', args: {} });
      expect(await harness.nextFrame()).toEqual({
        type: 'tool/result', callId: 'i-2', ok: false, error: 'boom',
      });
    } finally {
      await cleanup(harness, leaf);
    }
  }, 20_000);

  it('answers an unknown tool with tool-not-found and stays alive', async () => {
    const leaf = makeLeaf(ECHO_SOURCE);
    const harness = startLeaf(leaf);
    try {
      await expectReady(harness);
      harness.send({ type: 'tool/invoke', callId: 'i-1', name: 'no_such_tool', args: {} });
      expect(await harness.nextFrame()).toEqual({
        type: 'tool/result', callId: 'i-1', ok: false, error: 'tool-not-found',
      });
      harness.send({ type: 'tool/invoke', callId: 'i-2', name: 'echo_text', args: { text: 'still here' } });
      expect(await harness.nextFrame()).toEqual({
        type: 'tool/result', callId: 'i-2', ok: true, result: { echoed: 'still here' },
      });
    } finally {
      await cleanup(harness, leaf);
    }
  }, 20_000);

  it('captures console.log into output.log, never stdout', async () => {
    const leaf = makeLeaf(NOISY_SOURCE);
    const harness = startLeaf(leaf);
    try {
      await expectReady(harness);
      harness.send({ type: 'tool/invoke', callId: 'i-1', name: 'noisy', args: {} });
      expect(await harness.nextFrame()).toEqual({
        type: 'tool/result', callId: 'i-1', ok: true, result: { ok: true },
      });
      expect(readFileSync(leaf.outputPath, 'utf8')).toBe('hello from the guest\n');
      // Exactly run/ready plus tool/result: the print added no frame at all.
      expect(harness.receivedCount()).toBe(2);
      expect(harness.stdoutText.split('\n').filter((line) => line.length > 0)).toHaveLength(2);
    } finally {
      await cleanup(harness, leaf);
    }
  }, 20_000);

  it('drops capture bytes past the 64 KiB cap', async () => {
    const leaf = makeLeaf(PRINT_BOMB_SOURCE);
    const harness = startLeaf(leaf);
    try {
      await expectReady(harness);
      harness.send({ type: 'tool/invoke', callId: 'i-1', name: 'bomb', args: {} });
      expect(await harness.nextFrame()).toEqual({
        type: 'tool/result', callId: 'i-1', ok: true, result: null,
      });
      expect(statSync(leaf.outputPath).size).toBe(MAX_OUTPUT_LOG_BYTES);
    } finally {
      await cleanup(harness, leaf);
    }
  }, 20_000);

  it('reports a non-serializable return as unserializable-result and stays alive', async () => {
    const leaf = makeLeaf(UNSERIALIZABLE_SOURCE);
    const harness = startLeaf(leaf);
    try {
      await expectReady(harness);
      harness.send({ type: 'tool/invoke', callId: 'i-1', name: 'weird', args: {} });
      expect(await harness.nextFrame()).toEqual({
        type: 'tool/result', callId: 'i-1', ok: false, error: 'unserializable-result',
      });
      harness.send({ type: 'tool/invoke', callId: 'i-2', name: 'weird', args: {} });
      expect(await harness.nextFrame()).toEqual({
        type: 'tool/result', callId: 'i-2', ok: false, error: 'unserializable-result',
      });
    } finally {
      await cleanup(harness, leaf);
    }
  }, 20_000);

  it('refuses a malformed registration: no run/ready, exit 3, stderr diagnostic', async () => {
    const leaf = makeLeaf(BADSHAPE_SOURCE);
    const harness = startLeaf(leaf);
    try {
      const status = await harness.waitForExit();
      // 3 is the child half of the supervisor's contract (invalid-registration).
      expect(status.code).toBe(3);
      expect(harness.stdoutText).toBe('');
      expect(harness.receivedCount()).toBe(0);
      expect(harness.stderrText).toMatch(/invalid registration/);
      expect(harness.stderrText).toMatch(/tools\[0\]/);
    } finally {
      await cleanup(harness, leaf);
    }
  }, 20_000);

  it('kills an incoming line that crosses the 1 MiB cap', async () => {
    const leaf = makeLeaf(ECHO_SOURCE);
    const harness = startLeaf(leaf);
    try {
      await expectReady(harness);
      harness.writeRaw('a'.repeat(MAX_FRAME_BYTES + 1));
      const status = await harness.waitForExit();
      expect(status.code).toBe(1);
    } finally {
      await cleanup(harness, leaf);
    }
  }, 20_000);

  it('round-trips a service call: svc/execute answered by svc/result', async () => {
    const leaf = makeLeaf(WORLDWRITE_SOURCE);
    const harness = startLeaf(leaf);
    try {
      await expectReady(harness);
      harness.send({ type: 'tool/invoke', callId: 'i-1', name: 'touch_file', args: {} });
      const request = await harness.nextFrame();
      if (request.type !== 'svc/execute') throw new Error(`expected svc/execute, got ${request.type}`);
      expect(request.cmd).toBe('touch marker.txt');
      expect(request.callId).toBe('svc-1');
      harness.send({
        type: 'svc/result',
        callId: request.callId,
        ok: true,
        result: { status: 'completed', exitCode: 0 },
      });
      expect(await harness.nextFrame()).toEqual({
        type: 'tool/result', callId: 'i-1', ok: true, result: { status: 'completed' },
      });
    } finally {
      await cleanup(harness, leaf);
    }
  }, 20_000);

  it('treats a mismatched svc/result callId as a fatal desync', async () => {
    const leaf = makeLeaf(WORLDWRITE_SOURCE);
    const harness = startLeaf(leaf);
    try {
      await expectReady(harness);
      harness.send({ type: 'tool/invoke', callId: 'i-1', name: 'touch_file', args: {} });
      const request = await harness.nextFrame();
      if (request.type !== 'svc/execute') throw new Error(`expected svc/execute, got ${request.type}`);
      harness.send({
        type: 'svc/result',
        callId: 'svc-999',
        ok: true,
        result: { status: 'completed', exitCode: 0 },
      });
      const status = await harness.waitForExit();
      expect(status.code).toBe(1);
      expect(harness.stderrText).toMatch(/callId/);
    } finally {
      await cleanup(harness, leaf);
    }
  }, 20_000);

  it('acks run/dispose by exiting 0 promptly', async () => {
    const leaf = makeLeaf(ECHO_SOURCE);
    const harness = startLeaf(leaf);
    try {
      await expectReady(harness);
      harness.send({ type: 'run/dispose' });
      const status = await harness.waitForExit();
      expect(status.code).toBe(0);
    } finally {
      await cleanup(harness, leaf);
    }
  }, 20_000);
});


describe('location-independent leaf delivery', () => {
  it('boots the leaf under an ancestor package.json (the .mts delivery)', async () => {
    // A package.json above the leaf once killed the confined child: Node
    // walked ancestors for the module type and hit EACCES. The explicit
    // .mts name makes the leaf self-describing.
    const ancestor = mkdtempSync(join(tmpdir(), 'es-leaf-'));
    writeFileSync(join(ancestor, 'package.json'), '{"type":"commonjs"}');
    const leafDir = join(ancestor, 'nested', 'deeper', 'leaf');
    mkdirSync(leafDir, { recursive: true });
    const bootstrapPath = join(leafDir, 'run-bootstrap.mts');
    writeFileSync(bootstrapPath, BOOTSTRAP_SOURCE);
    const packagePath = join(leafDir, 'package.js');
    writeFileSync(packagePath, ECHO_SOURCE);
    const leaf: Leaf = {
      dir: leafDir,
      bootstrapPath,
      packagePath,
      outputPath: join(leafDir, 'output.log'),
      sourceSha: sha256Of(ECHO_SOURCE),
    };
    const harness = startLeaf(leaf);
    try {
      await expectReady(harness);
      harness.send({ type: 'tool/invoke', callId: 'i-1', name: 'echo_text', args: { text: 'hi' } });
      expect(await harness.nextFrame()).toMatchObject({
        type: 'tool/result', callId: 'i-1', ok: true,
      });
    } finally {
      await cleanup(harness, leaf);
      rmSync(ancestor, { recursive: true, force: true });
    }
  }, 20_000);
});
