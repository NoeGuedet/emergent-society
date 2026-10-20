import { describe, expect, it } from 'vitest';
import { readdir } from 'node:fs/promises';
import { InvalidNodeUidError } from '../../journal/index.js';
import { NodeDriver } from '../driver.js';
import { createAgentRuntime, defaultAgentConfig } from '../loop.js';
import { DEFAULT_TERMINAL_ENV } from '../tools/terminal.js';
import { ProviderAdapter } from '../../provider/adapter.js';
import type { SerializedTransport, TransportFacts, TransportResult } from '../../provider/transport.js';
import type { Frontier } from '../../frontier/index.js';
import type { TurnHandler } from '../driver.js';
import { useWorld, type WorldFixture } from './helpers.js';

const fixture = useWorld('node-uid-');

/** A transport that is never reached: the uid is refused before any turn. */
class UnusedTransport implements SerializedTransport {
  readonly facts: TransportFacts = {
    url: 'https://test.invalid/v1/chat/completions',
    headers: { 'content-type': 'application/json' },
    credentialId: 'test',
  };
  async post(_body: Uint8Array, signal: AbortSignal, _maxBytes: number): Promise<TransportResult> {
    void signal;
    throw new Error('transport must not be reached with an invalid uid');
  }
}

/**
 * A stub frontier: this suite never crosses one — the uid is refused first —
 * and a stub keeps the refused construction from creating a `frontier/`
 * directory, which the emptiness assertions read.
 */
const UNUSED_FRONTIER: Frontier = {
  begin: () => Promise.reject(new Error('frontier must not be reached with an invalid uid')),
  complete: () => Promise.reject(new Error('frontier must not be reached with an invalid uid')),
};

const delay = (ms: number, signal: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  if (signal.aborted) { reject(new Error('cancelled')); return; }
  const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
  const onAbort = (): void => { clearTimeout(timer); reject(new Error('cancelled')); };
  signal.addEventListener('abort', onAbort, { once: true });
});

function runtimeWithUid(fx: WorldFixture, uid: string): unknown {
  const config = defaultAgentConfig();
  return createAgentRuntime({
    home: fx.home, uid, world: fx.world, initialConfig: config,
    terminal: { env: DEFAULT_TERMINAL_ENV },
    adapter: new ProviderAdapter(new UnusedTransport(), {
      delay,
      schedule: (ms, callback) => { const timer = setTimeout(callback, ms); return () => { clearTimeout(timer); }; },
    }, UNUSED_FRONTIER),
  });
}

describe('the node uid at the runtime and driver boundaries', () => {
  it('refuses an invalid runtime uid at construction, before anything exists', async () => {
    const fx = fixture();
    expect(() => runtimeWithUid(fx, '../escape')).toThrow(InvalidNodeUidError);
    // Construction threw before any journal or blob directory was created.
    await expect(readdir(fx.home)).resolves.toEqual([]);
  });

  it('refuses an invalid driver uid before the writer touches the filesystem', async () => {
    const fx = fixture();
    const handler: TurnHandler = () => ({ outcome: 'waiting', toolCalls: false });
    await expect(NodeDriver.open(fx.home, '../escape', handler, fx.world))
      .rejects.toBeInstanceOf(InvalidNodeUidError);
    await expect(readdir(fx.home)).resolves.toEqual([]);
  });

  it('accepts a dotted/hyphenated/underscored uid at both boundaries', async () => {
    const fx = fixture();
    expect(() => runtimeWithUid(fx, 'a.b-c_1')).not.toThrow();
  });
});
