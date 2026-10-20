import { randomUUID } from 'node:crypto';
import {
  BlobStore, CorruptionError, JournalError, JournalReader, JournalWriter,
  frontierLayout, readVerifiedBlob, repairIn, sha256HexOf,
  type JsonValue, type JournalLayout,
} from '../journal/index.js';
import {
  FRONTIER_EVENT_TYPES, FRONTIER_MAX_BODY_BYTES, WORLD_HEAD_RE, FrontierValidationError,
  validateBeginInput, validateFrontierEvent, validateOutcome,
  type BodyRef, type CallId, type FrontierCall, type FrontierOutcome,
  type FrontierRequestInput, type HttpRequest, type HttpResponse,
} from './events.js';

/**
 * The frontier gate: the only writer of the frontier journal's exchange facts.
 *
 * `begin` is the durable-before-send half. In order: it validates the input,
 * refuses a body over the ceiling, assembles and validates the `http/request`
 * payload, writes the body blob (durable and content-addressed), appends and
 * flushes the event, then reads the blob back through the journal's verified
 * path, proving digest and exact length. Only when that barrier succeeds does
 * the gate touch its retry and timing maps — every failure path leaves no map
 * entry, so a failed begin never burns a group or fabricates a start time.
 *
 * `complete` is the durable-before-proceeding half: it validates the outcome,
 * finds the call's start in this process (an unknown call is a typed refusal,
 * never a fabricated duration), assembles and validates `http/response`, writes
 * the captured bytes, appends, flushes and verifies.
 *
 * `openFrontierJournal` repairs a torn tail, opens the writer on the frontier
 * layout and runs one reconciliation pass: every request without a terminal
 * gets exactly one `http/incomplete` marker, durably, and damage to the scanned
 * payloads is `FrontierCorruptionError` — a member of the journal's corruption
 * family, so `isCorruption()` classifies it.
 *
 * The maps are per process and bounded: the retry map (`group → lastAttempt`,
 * LRU with `maxGroups` entries) is an integrity aid that degrades fail-open
 * when an entry is evicted, and the timing map (`call → startedAt`) is emptied
 * one call at a time. Concurrency is the writer's: callers may begin/complete
 * concurrently and appends serialise on the single writer.
 */

/** The retry map's default bound: a per-process integrity aid, emptied at boot. */
const DEFAULT_MAX_GROUPS = 4096;

/**
 * A terminal for a call this process never began. There is no start time to
 * subtract, so the gate refuses rather than inventing a duration.
 */
export class FrontierUnknownCallError extends JournalError {
  constructor(public readonly call: CallId) {
    super(`frontier call ${JSON.stringify(call)} was not begun in this process`);
  }
}

/**
 * Damage to the frontier journal's contents. It extends the journal's exported
 * `CorruptionError`, so the one predicate (`isCorruption`) covers it without the
 * frontier deep-importing the journal's error module.
 */
export class FrontierCorruptionError extends CorruptionError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

export interface Frontier {
  /** Validates, writes the body blob, appends `http/request`, verifies + flushes. */
  begin(input: FrontierRequestInput): Promise<FrontierCall>;
  /** Writes the body blob, appends the terminal `http/response`, verifies + flushes. */
  complete(call: FrontierCall, outcome: FrontierOutcome): Promise<void>;
}

export interface FrontierJournal {
  readonly gate: Frontier;
  close(): Promise<void>;
}

class Gate implements Frontier {
  /** `group → lastAttempt`, in LRU order (Map keeps insertion order). */
  private readonly groups = new Map<CallId, number>();
  /** `call → startedAt`, per process, deleted when its terminal is durable. */
  private readonly started = new Map<CallId, number>();

  constructor(
    private readonly writer: JournalWriter,
    private readonly blobs: BlobStore,
    private readonly worldHead: () => Promise<string | null>,
    private readonly now: () => number,
    private readonly maxGroups: number,
  ) {}

  async begin(raw: FrontierRequestInput): Promise<FrontierCall> {
    // 1. The producer's input, including the attempt/group pairing.
    const input = validateBeginInput(raw);
    if (input.body.byteLength > FRONTIER_MAX_BODY_BYTES) {
      throw new FrontierValidationError(
        `invalid begin input: body exceeds the ${FRONTIER_MAX_BODY_BYTES}-byte frontier ceiling`,
      );
    }

    const call = randomUUID();
    const group = input.group ?? randomUUID();
    const attempt = input.attempt;
    this.assertAttempt(group, attempt);
    const startedAt = this.now();

    // 2. Assemble and validate the payload; the world HEAD is a best-effort
    // stamp, never a failure (A1).
    const worldHead = await this.readWorldHead();
    const bytes = Buffer.from(input.body);
    const body: BodyRef = {
      encoding: input.encoding,
      sha256: sha256HexOf(bytes),
      bytes: bytes.byteLength,
      complete: true,
    };
    const assembled: HttpRequest = {
      call,
      group,
      attempt,
      method: input.method,
      url: input.url,
      headers: input.headers,
      credentials: input.credentials ?? [],
      body,
      world_head: worldHead,
    };
    const validated = validateFrontierEvent('http/request', assembled);

    // 3. The blob is durable before the event that references it...
    await this.blobs.put(bytes);
    // 4. ...and the event is durable before the caller may send.
    this.writer.append('http/request', validated);
    await this.writer.flush();
    // 5. The barrier means "durable and provably readable".
    await this.verifyBlob(body);

    // Only now may the in-process maps learn about the call.
    this.recordAttempt(group, attempt);
    this.started.set(call, startedAt);
    return { call, group };
  }

  async complete(call: FrontierCall, raw: FrontierOutcome): Promise<void> {
    const outcome = validateOutcome(raw);
    const startedAt = this.started.get(call.call);
    if (startedAt === undefined) throw new FrontierUnknownCallError(call.call);

    const elapsed = this.now() - startedAt;
    const durationMs = Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0;
    const bytes = Buffer.from(outcome.body);
    const body: BodyRef = {
      encoding: outcome.encoding,
      sha256: sha256HexOf(bytes),
      bytes: bytes.byteLength,
      complete: outcome.complete,
    };
    const assembled: HttpResponse = {
      call: call.call,
      status: outcome.status,
      headers: outcome.headers ?? {},
      body,
      timing: { durationMs },
      error: outcome.error === undefined ? null : { code: outcome.error },
    };
    const validated = validateFrontierEvent('http/response', assembled);

    await this.blobs.put(bytes);
    this.writer.append('http/response', validated);
    await this.writer.flush();
    // The terminal is durable: retire the call now, so a later retry is
    // refused as unknown instead of appending a duplicate terminal that boot
    // reconciliation would read as corruption.
    this.started.delete(call.call);
    await this.verifyBlob(body);
  }

  /** The shared read-back: digest and exact byte length through the trusted read. */
  private async verifyBlob(body: BodyRef): Promise<void> {
    await readVerifiedBlob(
      { blob: body.sha256, size: body.bytes },
      (hash) => this.blobs.get(hash),
    );
  }

  /**
   * The retry rule against a *present* entry is one step forward: the attempt
   * must be exactly `last + 1`. A repeat, an out-of-order attempt and attempt 0
   * on a known group all fall under `attempt <= last`; a jump past `last + 1`
   * is a skip. A supplied group with no entry is accepted at any attempt —
   * eviction degrades the check fail-open, never into a refusal. An omitted
   * group is minted fresh, so the map can never be consulted for it.
   */
  private assertAttempt(group: CallId, attempt: number): void {
    const last = this.groups.get(group);
    if (last === undefined) return;
    if (attempt <= last) {
      throw new FrontierValidationError(
        `invalid begin input: attempt ${attempt} does not follow the last attempt ${last} `
        + `of group ${JSON.stringify(group)}`,
      );
    }
    if (attempt > last + 1) {
      throw new FrontierValidationError(
        `invalid begin input: attempt ${attempt} skips past the next attempt ${last + 1} `
        + `of group ${JSON.stringify(group)}`,
      );
    }
  }

  /** Records an attempt and evicts the least recently used group past the bound. */
  private recordAttempt(group: CallId, attempt: number): void {
    this.groups.delete(group);
    this.groups.set(group, attempt);
    while (this.groups.size > this.maxGroups) {
      const oldest = this.groups.keys().next();
      if (oldest.done === true) break;
      this.groups.delete(oldest.value);
    }
  }

  /**
   * Reads the kernel's world HEAD. A throwing callback or a result the shared
   * `WORLD_HEAD_RE` rejects stamps `null`: a best-effort observation can never
   * fail the exchange.
   */
  private async readWorldHead(): Promise<string | null> {
    let value: unknown;
    try {
      value = await this.worldHead();
    } catch {
      return null;
    }
    return typeof value === 'string' && WORLD_HEAD_RE.test(value) ? value : null;
  }
}

/**
 * Opens the cell's frontier journal: repairs a torn tail, takes the writer lock,
 * reconciles orphans, and returns the gate.
 *
 * A reconciliation failure closes the writer before propagating. Nothing is
 * pending at that point (the writer resumed a durable log), so the close is the
 * normal path; its rejection is irrelevant beside the corruption being
 * reported, and swallowing it keeps the lock from leaking either way.
 *
 * @throws SessionAlreadyOwnedError when a live writer already owns the journal.
 * @throws TornTailError / repair errors as the journal's own types.
 * @throws FrontierCorruptionError when the scanned payloads are damaged.
 */
export async function openFrontierJournal(
  home: string,
  opts: {
    worldHead: () => Promise<string | null>;
    now: () => number;
    batchWindowMs?: number;
    maxGroups?: number;
  },
): Promise<FrontierJournal> {
  const maxGroups = opts.maxGroups ?? DEFAULT_MAX_GROUPS;
  if (!Number.isSafeInteger(maxGroups) || maxGroups < 1) {
    throw new Error('maxGroups must be a positive safe integer');
  }
  const layout = frontierLayout(home);
  await repairIn(layout);
  const writer = await JournalWriter.openIn(layout, {
    now: opts.now,
    ...(opts.batchWindowMs === undefined ? {} : { batchWindowMs: opts.batchWindowMs }),
  });
  try {
    await reconcile(writer, layout);
  } catch (err) {
    await writer.close().catch(() => {});
    throw err;
  }
  return {
    gate: new Gate(writer, new BlobStore(home), opts.worldHead, opts.now, maxGroups),
    close: () => writer.close(),
  };
}

/**
 * One pass over the journal's envelopes. A request with no terminal record is
 * an orphan — a fact, recorded as one `http/incomplete` marker — while a
 * malformed payload, a terminal for an unknown call, or a second terminal for
 * one call is corruption, never a guess or a silent skip. Frontier events are
 * small by construction, so no blob is resolved to find a call id.
 */
async function reconcile(writer: JournalWriter, layout: JournalLayout): Promise<void> {
  const reader = await JournalReader.openIn(layout, { knownTypes: FRONTIER_EVENT_TYPES });
  const requests = new Set<CallId>();
  const terminals = new Set<CallId>();
  for await (const event of reader.events()) {
    let payload: JsonValue;
    try {
      payload = validateFrontierEvent(event.type, event.data);
    } catch (err) {
      throw new FrontierCorruptionError(
        `${layout.dir}: malformed ${event.type} payload at seq ${event.seq}`,
        { cause: err },
      );
    }
    const call = callOf(payload);
    if (event.type === 'http/request') {
      requests.add(call);
      continue;
    }
    if (!requests.has(call)) {
      throw new FrontierCorruptionError(
        `${layout.dir}: ${event.type} at seq ${event.seq} names the unknown call `
        + JSON.stringify(call),
      );
    }
    if (terminals.has(call)) {
      throw new FrontierCorruptionError(
        `${layout.dir}: duplicate terminal for call ${JSON.stringify(call)} at seq ${event.seq}`,
      );
    }
    terminals.add(call);
  }

  const orphans = [...requests].filter((call) => !terminals.has(call));
  if (orphans.length === 0) return;
  for (const call of orphans) writer.append('http/incomplete', { call });
  await writer.flush();
}

/** Every validated frontier payload carries its call id. */
function callOf(payload: JsonValue): CallId {
  return (payload as unknown as { readonly call: CallId }).call;
}
