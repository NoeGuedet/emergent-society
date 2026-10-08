import { afterEach, describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { OpenAITransport } from '../transport.js';

// A file-level restore for the one global `fetch` patch below, so an aborted
// test cannot leave a wrapper installed in the shared worker.
const REAL_FETCH = globalThis.fetch;
afterEach(() => { globalThis.fetch = REAL_FETCH; });

/**
 * Transport tests over a real local HTTP server on 127.0.0.1: the exact bytes
 * are sent unmodified, only the content-type/authorization headers are set, the
 * body is captured bounded, and network/abort failures become safe results.
 * No real external network is used and nothing logs headers or the key.
 */

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}/v1/chat/completions`;
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => { if (error) reject(error); else resolve(); });
  });
}

/**
 * Installs a narrow wrapper around the global `fetch` that acknowledges when the
 * client has actually read the first body chunk. The real loopback network and
 * the real `OpenAITransport` are used — only the one global fetch call is
 * intercepted, so a test can wait on a client-observable event instead of
 * guessing with a sleep. `highWaterMark: 0` keeps the stream from prefetching,
 * so the acknowledgement fires only for a pending client read. Returns the
 * restore function; always call it in a `finally`.
 */
function observeFirstBodyChunk(onFirstChunk: () => void): () => void {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (
    input: string | URL | Request, init?: RequestInit,
  ): Promise<Response> => {
    const response = await realFetch(input, init);
    if (response.body === null) return response;
    const reader = response.body.getReader();
    let first = true;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller): Promise<void> {
        const { done, value } = await reader.read();
        if (done) { controller.close(); return; }
        controller.enqueue(value);
        if (first) { first = false; onFirstChunk(); }
      },
      cancel(reason): Promise<void> { return reader.cancel(reason); },
    }, { highWaterMark: 0 });
    return new Response(stream, {
      status: response.status, statusText: response.statusText, headers: response.headers,
    });
  }) as typeof fetch;
  return () => { globalThis.fetch = realFetch; };
}

describe('OpenAITransport: exact bytes and headers', () => {
  it('sends the input bytes verbatim and returns a complete 200 body', async () => {
    const bodies: Buffer[] = [];
    const headers: Record<string, string | string[] | undefined>[] = [];
    const server = createServer((req, res) => {
      headers.push(req.headers);
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        bodies.push(Buffer.concat(chunks));
        res.setHeader('content-type', 'application/json');
        res.end('{"ok":true}');
      });
    });
    const endpoint = await listen(server);
    try {
      const transport = new OpenAITransport({ endpoint, key: 'test-key-never-log' });
      const body = Buffer.from(JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hé' }] }));
      const result = await transport.post(body, new AbortController().signal, 1 << 20);
      expect(result.status).toBe(200);
      expect(result.complete).toBe(true);
      expect(result.failure).toBeNull();
      expect(Buffer.from(result.body).toString('utf8')).toBe('{"ok":true}');
      expect(Buffer.from(bodies[0]!).equals(body)).toBe(true);
      expect(headers[0]!['content-type']).toBe('application/json');
      expect(headers[0]!['authorization']).toBe('Bearer test-key-never-log');
    } finally {
      await close(server);
    }
  });

  it('preserves invalid UTF-8 bytes verbatim (no decoding in the transport)', async () => {
    const server = createServer((_req, res) => {
      res.statusCode = 200;
      res.end(Buffer.from([0xff, 0xfe, 0x00, 0x41]));
    });
    const endpoint = await listen(server);
    try {
      const transport = new OpenAITransport({ endpoint, key: 'k' });
      const result = await transport.post(new Uint8Array(), new AbortController().signal, 1024);
      expect(result.complete).toBe(true);
      expect(result.failure).toBeNull();
      expect([...result.body]).toEqual([0xff, 0xfe, 0x00, 0x41]);
    } finally {
      await close(server);
    }
  });

  it('returns a complete non-200 body with no transport failure', async () => {
    const server = createServer((_req, res) => { res.statusCode = 429; res.end('slow down'); });
    const endpoint = await listen(server);
    try {
      const transport = new OpenAITransport({ endpoint, key: 'k' });
      const result = await transport.post(new Uint8Array(), new AbortController().signal, 1024);
      expect(result.status).toBe(429);
      expect(result.complete).toBe(true);
      expect(result.failure).toBeNull();
      expect(Buffer.from(result.body).toString('utf8')).toBe('slow down');
    } finally {
      await close(server);
    }
  });
});

describe('OpenAITransport: bounded body and failures', () => {
  it('truncates an over-cap body to a prefix with a body-limit failure', async () => {
    const server = createServer((_req, res) => { res.end('abcdefgh'); });
    const endpoint = await listen(server);
    try {
      const transport = new OpenAITransport({ endpoint, key: 'k' });
      const result = await transport.post(new Uint8Array(), new AbortController().signal, 4);
      expect(result.status).toBe(200);
      expect(result.complete).toBe(false);
      expect(result.failure).toEqual({ code: 'body-limit', status: 200 });
      expect(Buffer.from(result.body).toString('utf8')).toBe('abcd');
    } finally {
      await close(server);
    }
  });

  it('returns a safe network result when the socket closes before headers', async () => {
    const server = createServer();
    server.on('connection', (socket) => { socket.destroy(); });
    const endpoint = await listen(server);
    try {
      const transport = new OpenAITransport({ endpoint, key: 'k' });
      const result = await transport.post(new Uint8Array(), new AbortController().signal, 1024);
      expect(result.status).toBeNull();
      expect(result.body).toHaveLength(0);
      expect(result.complete).toBe(false);
      expect(result.failure).toEqual({ code: 'network', status: null });
    } finally {
      await close(server);
    }
  });

  it('returns a safe cancelled result for an already-aborted signal', async () => {
    const server = createServer((_req, res) => { res.end('{}'); });
    const endpoint = await listen(server);
    try {
      const transport = new OpenAITransport({ endpoint, key: 'k' });
      const controller = new AbortController();
      controller.abort();
      const result = await transport.post(new Uint8Array(), controller.signal, 1024);
      expect(result.status).toBeNull();
      expect(result.complete).toBe(false);
      expect(result.failure).toEqual({ code: 'cancelled', status: null });
    } finally {
      await close(server);
    }
  });

  it('preserves the known status and partial bytes when aborted after headers', async () => {
    const prefix = '{"partial":';
    let ack!: () => void;
    const prefixRead = new Promise<void>((resolve) => { ack = resolve; });
    const server = createServer((req, res) => {
      req.on('error', () => { /* the abort resets the socket */ });
      res.on('error', () => { /* the abort resets the socket */ });
      req.on('data', () => { /* drain */ });
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write(prefix); // headers + a prefix, then the response stalls
      });
    });
    const endpoint = await listen(server);
    const restoreFetch = observeFirstBodyChunk(() => ack());
    try {
      const transport = new OpenAITransport({ endpoint, key: 'k' });
      const controller = new AbortController();
      const sending = transport.post(new Uint8Array(), controller.signal, 1024);
      // The client has read the first prefix chunk, so `status` is already
      // assigned and the transport is stalled on the next read: aborting now is
      // exact, with no timing guess.
      await prefixRead;
      controller.abort();
      const result = await sending;
      expect(result.status).toBe(200);
      expect(result.complete).toBe(false);
      expect(result.failure).toEqual({ code: 'cancelled', status: 200 });
      expect(Buffer.from(result.body).toString('utf8')).toBe(prefix);
    } finally {
      restoreFetch();
      await close(server);
    }
  });
});
