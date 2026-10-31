import { describe, expect, it } from 'vitest';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { withFailingWrite } from '../../journal/__tests__/helpers.js';
import { openTestDriver } from './helpers.js';
import { readFrontier } from '../../frontier/__tests__/helpers.js';
import { useWorld, type WorldFixture } from './helpers.js';
import { NodeDriver } from '../driver.js';
import { createAgentRuntime, defaultAgentConfig } from '../loop.js';
import { DEFAULT_TERMINAL_ENV } from '../tools/terminal.js';
import { C13_EVENT_TYPES } from '../../context/events.js';
import { loadVerifiedEvents } from '../../context/loader.js';
import { ProviderAdapter } from '../../provider/adapter.js';
import type {
  SerializedTransport, TransportFacts, TransportResult,
} from '../../provider/transport.js';
import type { AgentConfig } from '../../context/contracts.js';

const fixture = useWorld('c13-barrier-');

/** Records every send; returns a valid no-op response if it is ever reached. */
class CountingTransport implements SerializedTransport {
  readonly facts: TransportFacts = {
    url: 'https://test.invalid/v1/chat/completions',
    headers: { 'content-type': 'application/json' },
    credentialId: 'test',
  };
  readonly sends: Uint8Array[] = [];
  async post(body: Uint8Array, signal: AbortSignal, _maxBytes: number): Promise<TransportResult> {
    if (signal.aborted) {
      return {
        status: null, headers: {}, body: new Uint8Array(), complete: false,
        failure: { code: 'cancelled', status: null },
      };
    }
    this.sends.push(body);
    return { status: 200, headers: {}, complete: true, failure: null,
      body: Buffer.from(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'noop' } }] })) };
  }
}

const delay = (ms: number, signal: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  if (signal.aborted) { reject(new Error('cancelled')); return; }
  const onAbort = (): void => { clearTimeout(timer); reject(new Error('cancelled')); };
  const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
  signal.addEventListener('abort', onAbort, { once: true });
});

async function runtimeFor(fx: WorldFixture, transport: CountingTransport, config: AgentConfig) {
  const journal = await fx.frontier();
  return createAgentRuntime({
    home: fx.home, uid: 'n1', world: fx.world, initialConfig: config,
    terminal: { env: DEFAULT_TERMINAL_ENV },
    adapter: new ProviderAdapter(transport, {
      delay,
      schedule: (ms, callback) => { const timer = setTimeout(callback, ms); return () => { clearTimeout(timer); }; },
    }, journal.gate),
  });
}

describe('C1.3 request barrier fault', () => {
  it('D2: a flush failure on the turn/start barrier yields zero sends and zero effects', async () => {
    const fx = fixture();
    const config = defaultAgentConfig();
    const transport = new CountingTransport();
    const runtime = await runtimeFor(fx, transport, config);
    let driver: NodeDriver | null = null;
    let running: Promise<void> | null = null;
    try {
      // open() runs its own resume flush normally; the injected fault lands on the first
      // write inside run(), which is the durable turn/start barrier, before any send.
      driver = await openTestDriver(fx.home, 'n1', runtime.handler, fx.world, {
        knownTypes: C13_EVENT_TYPES, hooks: runtime.hooks, worldPollMs: 0, batchWindowMs: 10000,
      });
      await withFailingWrite(fx.home, async () => {
        running = driver!.run();
        await expect(running).rejects.toThrow('injected EIO');
        running = null;
      });
      // The barrier held: turn/start is durable, no request ever reached the transport.
      expect(transport.sends).toHaveLength(0);
      await expect(access(join(fx.world.path, 'note.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
      const events = await loadVerifiedEvents(fx.home, 'n1', C13_EVENT_TYPES);
      expect(events.some((event) => event.type === 'turn/start')).toBe(true);
      expect(events.some((event) => [
        'request/plan', 'request/wire', 'response/raw', 'request/usage', 'assistant/attempt',
      ].includes(event.type))).toBe(false);
      // Nothing crossed the frontier either: no request record, so no begin.
      const frontier = await readFrontier(fx.home);
      expect(frontier.filter((event) => event.type === 'http/request')).toHaveLength(0);
    } finally {
      if (driver) {
        driver.stop();
        // Local alias with an explicit `as`: control-flow analysis otherwise
        // narrows `running` to `null` at this point (the only assignment it sees
        // in this scope is the trailing `running = null`), which is not the
        // intent — the promise survives when the `expect` above threw.
        const pending = running as Promise<void> | null;
        if (pending) await pending.catch(() => {});
        else if (driver.state === 'booting' || driver.state === 'active') await driver.run().catch(() => {});
      }
    }
  });
});
