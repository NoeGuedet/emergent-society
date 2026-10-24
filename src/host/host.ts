import { C13_EVENT_TYPES } from '../context/events.js';
import type { AgentConfig } from '../context/contracts.js';
import { openFrontierJournal, type FrontierJournal } from '../frontier/index.js';
import type { ProviderRegistry } from '../node/tools/providers.js';
import { DEFAULT_TERMINAL_ENV } from '../node/tools/terminal.js';
import { webToolsFromProviders } from '../node/tools/web.js';
import {
  NodeDriver, NodeStateError, WorldRepo, createAgentRuntime,
  type AgentRuntime, type TurnHandler, type TurnResult,
} from '../node/index.js';
import { ProviderAdapter } from '../provider/adapter.js';
import { systemProviderPolicy } from '../provider/policy.js';
import { OpenAITransport } from '../provider/transport.js';
import type { LlmCredential } from './credentials.js';
import { cellPaths } from './layout.js';
import type { HostLog } from './observe.js';

/**
 * The composition root: one cell, composed in one place and in one order.
 *
 * `composeCell` walks the plan's order exactly — the world, then the cell's
 * frontier journal, then the provider transport and adapter built on that
 * journal's gate, then the runtime, then the driver — and hands back the parts
 * a host lifetime needs to steer and report. Every path in here comes from
 * `cellPaths`, so the world pair, the frontier directory and the node's local
 * log are addressed through the journal's own constructors rather than
 * re-spelled.
 *
 * The frontier journal is the cell's, not the runtime's: the host opens it
 * before anything can send, injects its gate into the adapter and the web
 * tools, and closes it only once the driver has stopped. That is why a failure
 * anywhere after the open closes the frontier before rethrowing — a cell that
 * never came to be must not leave the home locked. There is deliberately no
 * driver cleanup branch: `NodeDriver.open` already closes its own writer when
 * it fails, and nothing after a successful open can throw before the cell is
 * returned (`Cell.close` is the only later transition).
 *
 * `Cell.close` is the lifetime's single exit. Its callers share one in-flight
 * outcome: concurrent calls await the same promise, so a booting cell is
 * stopped, run and settled exactly once even when a host tears down from two
 * paths. It refuses a cell whose driver has not settled —
 * `active`/`waiting`/`stopping` means the caller did not await `run()`, and
 * closing the frontier under a live turn would cut the very journal the turn is
 * writing. That refusal is not sticky: a rejected close clears the in-flight
 * promise, so the caller's own `stop(); await run(); close()` still closes the
 * cell. A `booting` cell is stopped and awaited here — `NodeDriver.open` has
 * already journaled `node/boot`, so `run()` writes an empty `node/shutdown` and
 * releases the local writer — and the frontier is closed before the shared
 * promise resolves, so a resolved close always means the home is unlocked.
 *
 * `wrapHandler` is the driver-to-log seam: it never changes a turn's result, it
 * only records the bounded facts the operator reads (turn, trigger, outcome,
 * whether tools ran, and for a recoverable failure the failure's code and
 * status). A thrown handler is `turn/error` with the error's *name* only, and
 * the throw propagates unchanged for the driver to classify.
 */

/** Everything one cell needs to exist; every field is already validated. */
export type CellOptions = {
  readonly home: string; readonly uid: string;
  readonly config: AgentConfig; readonly credential: LlmCredential;
  readonly providers: ProviderRegistry;
  readonly sandbox: false | { readonly launcherPath?: string };
  readonly pollMs?: number; readonly log: HostLog;
};

/** The composed cell: its durable parts, its live parts, and its one exit. */
export type Cell = {
  readonly world: WorldRepo; readonly frontier: FrontierJournal;
  readonly runtime: AgentRuntime; readonly driver: NodeDriver;
  /** The effective journaled config after the ready phase, not necessarily `CellOptions.config`. */
  readonly config: AgentConfig; readonly webTools: boolean;
  close(): Promise<void>;
};

/** The states in which closing would cut a live turn's journal. */
const UNSETTLED: ReadonlySet<string> = new Set(['active', 'waiting', 'stopping']);

/**
 * Composes one node against its cell home and returns it ready to run.
 *
 * On any failure after the frontier journal is open, the journal is closed
 * before the error is rethrown, so the home is never left locked by a cell that
 * was never returned.
 */
export async function composeCell(options: CellOptions): Promise<Cell> {
  const { home, uid, config, credential, providers, sandbox, pollMs, log } = options;
  const paths = cellPaths(home, uid);
  const world = await WorldRepo.open(paths.world, { gitDir: paths.gitDir });
  const frontier = await openFrontierJournal(home, {
    worldHead: () => world.headHash(), now: Date.now,
  });
  try {
    const webTools = webToolsFromProviders(providers, frontier.gate);
    const transport = new OpenAITransport({
      endpoint: credential.endpoint,
      key: credential.key,
      credentialId: credential.credentialId,
    });
    const adapter = new ProviderAdapter(transport, systemProviderPolicy, frontier.gate);
    const runtime = createAgentRuntime({
      home, uid, world, initialConfig: config, adapter,
      terminal: { env: DEFAULT_TERMINAL_ENV, sandbox },
      ...(webTools !== undefined ? { webTools } : {}),
    });
    const driver = await NodeDriver.open(home, uid, wrapHandler(runtime.handler, log), world, {
      knownTypes: C13_EVENT_TYPES,
      hooks: runtime.hooks,
      ...(pollMs !== undefined ? { worldPollMs: pollMs } : {}),
      onError: (err) => log.emit('driver/error', { error: err.name }),
      onMaintenance: () => log.emit('host/parked'),
    });
    // The ready phase has already folded the journal during `open`, so a resume
    // reports the config the journal holds, not the one this call supplied.
    const effective = runtime.snapshot().config?.value ?? config;
    let closing: Promise<void> | null = null;
    const closeOnce = async (): Promise<void> => {
      if (driver.state === 'booting') {
        driver.stop();
        await driver.run();
      } else if (UNSETTLED.has(driver.state)) {
        throw new NodeStateError(
          `close() before run() settled: state is ${driver.state}`,
        );
      }
      await frontier.close();
    };
    // One in-flight close for every caller. A rejection clears the memo, so a
    // refused close leaves the cell closable by `stop(); await run(); close()`.
    const close = (): Promise<void> => {
      if (closing === null) {
        closing = closeOnce().catch((err: unknown) => {
          closing = null;
          throw err;
        });
      }
      return closing;
    };
    return {
      world, frontier, runtime, driver, config: effective,
      webTools: webTools !== undefined, close,
    };
  } catch (err) {
    await frontier.close().catch(() => {});
    throw err;
  }
}

/**
 * Wraps a turn handler with the diagnostic events of §3.10.
 *
 * The result is returned unchanged and a throw is rethrown unchanged: this
 * wrapper observes, it never decides. A recoverable failure
 * (`outcome: 'error'`) is an ordinary result and adds its code and status; a
 * thrown handler adds only the error's name.
 */
export function wrapHandler(handler: TurnHandler, log: HostLog): TurnHandler {
  return async (ctx): Promise<TurnResult> => {
    log.emit('turn/start', { turn: ctx.turn, trigger: ctx.trigger });
    let result: TurnResult;
    try {
      result = await handler(ctx);
    } catch (err) {
      log.emit('turn/error', {
        turn: ctx.turn, error: err instanceof Error ? err.name : 'Error',
      });
      throw err;
    }
    if (result.outcome === 'error') {
      log.emit('turn/end', {
        turn: ctx.turn, outcome: result.outcome, toolCalls: result.toolCalls,
        errorCode: result.error.code, errorStatus: result.error.status,
      });
    } else {
      log.emit('turn/end', {
        turn: ctx.turn, outcome: result.outcome, toolCalls: result.toolCalls,
      });
    }
    return result;
  };
}
