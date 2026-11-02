import type { Source } from '../context/contracts.js';
import type {
  BoundaryDataMap, BoundaryGate, BoundaryType,
} from '../node/gate.js';

/**
 * The overlay's SYNTHETIC NO-OP GATE — the honest shim the node-shaped provider
 * adapter rides.
 *
 * `ProviderAdapter.send(plan, gate)` is node-shaped in exactly one respect that
 * matters here: after a successful exchange it appends the assistant projection
 * through the LOCAL gate and flushes (`assistant/message`, stored inline or as
 * an artifact) so the node's local log carries the semantic success fact. The
 * overlay has NO LOCAL LOG — it is not a cell and owns no journal. Its
 * assistant messages are FRONTIER-ONLY: the request body (which carries the
 * whole context and tool exchanges) and the response body captured by the
 * frontier gate are their only record. That is the honest statement of the
 * deviation: it is the local-log half that is absent, not the frontier half.
 *
 * This gate therefore accepts the append and the store and drops both, and its
 * `flush` is a no-op. Its `signal` is the live abort signal the adapter reads
 * (a host stop cancels an in-flight exchange), and it captures no artifacts —
 * `capture` is unreachable from the adapter's path and refuses rather than
 * fabricating a claim-check reference. The returned `Source` is a zero
 * placeholder no caller reads (the adapter ignores `append`'s return value).
 */
export function createOverlayGate(signal: AbortSignal): BoundaryGate {
  return {
    signal,
    append<K extends BoundaryType>(_type: K, _data: BoundaryDataMap[K]): Source {
      // Dropped on purpose: the frontier, not a local log, records the
      // overlay's assistant message.
      return { seq: 0, hash: '' };
    },
    async flush(): Promise<void> {
      // Nothing is pending: there is no local journal to make durable.
    },
    async capture(): Promise<never> {
      throw new Error('the overlay gate captures no artifacts: its exchanges are frontier-only');
    },
    async store<T>(value: T): Promise<{ readonly kind: 'inline'; readonly value: T }> {
      // The payload is handed back so the adapter's typed append still holds
      // together; the append that consumes it drops it.
      return { kind: 'inline', value };
    },
  };
}
