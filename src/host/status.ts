import { join } from 'node:path';
import { lstat, stat } from 'node:fs/promises';
import {
  FRONTIER_EVENT_TYPES, validateFrontierEvent, type HttpRequest, type HttpResponse,
} from '../frontier/index.js';
import { JournalReader, frontierLayout } from '../journal/index.js';
import { WorldRepo } from '../node/world.js';
import { readOwner } from './owner.js';
import { HostConfigError } from './errors.js';

/**
 * The read-only `status` report: one cell home, observed, never perturbed.
 *
 * `readStatus` gathers three sections — the host owner record, the frontier
 * journal and the world repository — and `formatStatus` renders the human
 * lines. Nothing here writes, takes a lock, reconciles, resolves a blob,
 * opens the local node log or touches the network: the frontier is served by
 * the journal's own reader, which loads the whole log once per report
 * (O(journal) — a streaming reader is handoff debt, not this command), and
 * the world is read through the repository's own HEAD plumbing. No clock and
 * no environment are consulted, so two reports over an unchanged home are
 * byte-identical.
 *
 * Degradation is reported, never thrown. The one throw is `HostConfigError`,
 * for a home that is absent or not a directory (a symlinked home reads as a
 * link and is refused as observed); every failure while reading the frontier
 * or the world folds into `frontier.error` / `world.error` as the failing
 * error's name, and the report resolves with everything accumulated up to
 * the failure. A raw filesystem fault on the home probe or the world-pair
 * probes themselves propagates unchanged — the house `stat` idiom — to the
 * CLI's catch. The human
 * lines never print an error name — the CLI's exit code is the signal;
 * `--json` carries them.
 */

/** The report `readStatus` resolves with and `formatStatus` renders. */
export type StatusReport = {
  readonly home: string;
  readonly host: {
    readonly state: 'running' | 'idle' | 'stale' | 'unverified';
    readonly pid?: number; readonly uid?: string; readonly command?: 'start' | 'resume';
    /** Present only when the running record carries it (any host that records
     * its mode); never fabricated for an idle or stale home. */
    readonly sandbox?: 'landlock' | 'off';
  };
  readonly frontier: {
    readonly present: boolean; readonly count: number; readonly lastHash: string | null;
    readonly counts: Readonly<Record<string, number>>; readonly openCalls: number;
    readonly lastRequest: { call: string; url: string; worldHead: string | null; attempt: number } | null;
    readonly lastResponse: { call: string; status: number | null; error: string | null; durationMs: number } | null;
    readonly error: string | null;
  };
  readonly world: { readonly present: boolean; readonly head: string | null; readonly error: string | null };
};

/** The delay before the world read's single retry. */
const WORLD_RETRY_MS = 50;

/** The error name a folded failure carries; a non-Error throw is still a name. */
function nameOf(error: unknown): string {
  return error instanceof Error ? error.name : 'Error';
}

/** One bounded pause between the world read's two attempts. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/** `lstat`, with ENOENT/ENOTDIR folded to `null`; any other failure propagates. */
async function lstatOrNull(path: string) {
  try {
    return await lstat(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw err;
  }
}

/** `stat`, with ENOENT/ENOTDIR folded to `null`; any other failure propagates. */
async function statOrNull(path: string) {
  try {
    return await stat(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw err;
  }
}

/**
 * The request payload's local guard. Validation already ran —
 * `validateFrontierEvent` throws before anything is counted — so this only
 * narrows the four projected fields for the compiler; it is never a second
 * validation.
 */
function isRequestPayload(data: unknown): data is HttpRequest {
  if (typeof data !== 'object' || data === null) return false;
  const fields = data as Record<string, unknown>;
  return typeof fields['call'] === 'string'
    && typeof fields['url'] === 'string'
    && (fields['world_head'] === null || typeof fields['world_head'] === 'string')
    && typeof fields['attempt'] === 'number';
}

/** The response payload's local guard, over its four projected fields. */
function isResponsePayload(data: unknown): data is HttpResponse {
  if (typeof data !== 'object' || data === null) return false;
  const fields = data as Record<string, unknown>;
  const timing = fields['timing'];
  if (typeof timing !== 'object' || timing === null) return false;
  const error = fields['error'];
  return typeof fields['call'] === 'string'
    && (fields['status'] === null || typeof fields['status'] === 'number')
    && typeof (timing as Record<string, unknown>)['durationMs'] === 'number'
    && (error === null
      || (typeof error === 'object' && error !== null
        && typeof (error as Record<string, unknown>)['code'] === 'string'));
}

/** The incomplete marker's local guard; its projection needs only `call`. */
function isIncompletePayload(data: unknown): data is { readonly call: string } {
  if (typeof data !== 'object' || data === null) return false;
  return typeof (data as Record<string, unknown>)['call'] === 'string';
}

/**
 * The owner record's classification, mapped onto the report's host shape.
 * `readOwner` is total — every absent, malformed or unverifiable record
 * classifies — so a degraded home is reported on here, never refused.
 */
async function hostOf(home: string): Promise<StatusReport['host']> {
  const owner = await readOwner(home);
  switch (owner.kind) {
    case 'live':
      return {
        state: 'running',
        pid: owner.record.pid,
        uid: owner.record.uid,
        command: owner.record.command,
        ...(owner.record.sandbox === undefined ? {} : { sandbox: owner.record.sandbox }),
      };
    case 'unverified':
      return {
        state: 'unverified',
        pid: owner.record.pid,
        ...(owner.record.sandbox === undefined ? {} : { sandbox: owner.record.sandbox }),
      };
    case 'stale':
      // No pid: the recorded process is gone, and repeating its pid would
      // read as a live fact.
      return { state: 'stale' };
    case 'absent':
      return { state: 'idle' };
  }
}

/**
 * The frontier journal's verified contents, folded into the report's shape.
 * Presence is one `lstat` of the layout's log file: ENOENT/ENOTDIR (no
 * frontier directory yet) is the plain absent fact, while any other stat
 * failure is the frontier's error, folded rather than thrown. A present
 * journal is read through the journal's own reader — no lock, no
 * reconciliation, no blob resolution — and any read or validation failure
 * leaves the counters at whatever the generator served before it.
 */
async function frontierOf(home: string): Promise<StatusReport['frontier']> {
  const layout = frontierLayout(home);
  let present = false;
  let error: string | null = null;
  try {
    await lstat(join(layout.dir, layout.logFile));
    present = true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') error = nameOf(err);
  }

  let count = 0;
  const counts: Record<string, number> = {};
  let lastHash: string | null = null;
  const requestIds = new Set<string>();
  const closedIds = new Set<string>();
  let lastRequest: StatusReport['frontier']['lastRequest'] = null;
  let lastResponse: StatusReport['frontier']['lastResponse'] = null;

  if (present) {
    try {
      const reader = await JournalReader.openIn(layout, {
        knownTypes: FRONTIER_EVENT_TYPES,
      });
      for await (const event of reader.events()) {
        // Validate first, count second: a payload that does not validate
        // throws here and is never counted.
        const data = validateFrontierEvent(event.type, event.data);
        count += 1;
        counts[event.type] = (counts[event.type] ?? 0) + 1;
        lastHash = event.hash;
        if (event.type === 'http/request' && isRequestPayload(data)) {
          requestIds.add(data.call);
          lastRequest = {
            call: data.call,
            url: data.url,
            worldHead: data.world_head,
            attempt: data.attempt,
          };
        } else if (event.type === 'http/response' && isResponsePayload(data)) {
          closedIds.add(data.call);
          lastResponse = {
            call: data.call,
            status: data.status,
            error: data.error?.code ?? null,
            durationMs: data.timing.durationMs,
          };
        } else if (event.type === 'http/incomplete' && isIncompletePayload(data)) {
          closedIds.add(data.call);
        }
      }
    } catch (err) {
      // The generator's position is the whole rule: a frame that cannot be
      // scanned yields nothing (count 0), while a chain break or a payload
      // refusal fires after the verified prefix was served (counts kept).
      error = nameOf(err);
    }
  }

  const openCalls = [...requestIds].filter((call) => !closedIds.has(call)).length;
  return { present, count, lastHash, counts, openCalls, lastRequest, lastResponse, error };
}

/**
 * The world pair and its HEAD: absent, unreadable, or committed. The pair is
 * probed with `stat` — the repository open resolves both paths, so a
 * symlinked pair the running system accepts is a pair here too — and a
 * partial pair reads absent: status invents no third state, `init` is the
 * component that refuses a partial layout.
 */
async function worldOf(home: string): Promise<StatusReport['world']> {
  const worldDir = join(home, 'world');
  const gitDir = join(home, 'world.git');
  const [worldEntry, gitEntry] = await Promise.all([statOrNull(worldDir), statOrNull(gitDir)]);
  if (worldEntry?.isDirectory() !== true || gitEntry?.isDirectory() !== true) {
    return { present: false, head: null, error: null };
  }
  try {
    return { present: true, head: await readWorldHead(worldDir, gitDir), error: null };
  } catch {
    // One retry after a fixed delay: a concurrent commit can transiently
    // surface an ENOENT inside the trust scan.
    await sleep(WORLD_RETRY_MS);
    try {
      return { present: true, head: await readWorldHead(worldDir, gitDir), error: null };
    } catch (err) {
      return { present: true, head: null, error: nameOf(err) };
    }
  }
}

/** One world read: open (its trust layers run) then HEAD, unborn as null. */
async function readWorldHead(worldDir: string, gitDir: string): Promise<string | null> {
  const repo = await WorldRepo.open(worldDir, { gitDir });
  return await repo.headHash();
}

/**
 * Reads one cell home's status. Strictly read-only: the report is a
 * point-in-time snapshot and nothing in it is written back.
 *
 * @throws HostConfigError when the home is absent or not a directory (a
 * symlink home reads as a link and is refused as observed). A raw filesystem
 * fault on the home probe or the world-pair probes propagates unchanged;
 * every failure while reading the frontier or the world folds into the
 * report instead.
 */
export async function readStatus(home: string): Promise<StatusReport> {
  // The home gate is the one refusal: status reports on degraded homes (a
  // wrong owner, a permissive mode), it does not refuse them.
  const homeEntry = await lstatOrNull(home);
  if (homeEntry === null) throw new HostConfigError('home does not exist; run init');
  if (!homeEntry.isDirectory()) {
    throw new HostConfigError(`home must be a directory: ${home}`);
  }
  const host = await hostOf(home);
  const frontier = await frontierOf(home);
  const world = await worldOf(home);
  return { home, host, frontier, world };
}

/**
 * The human report: exact lines, fixed order, no trailing newline (the CLI
 * adds the final one). The two `last-*` lines are omitted entirely when
 * their record is null, the frontier line always prints its three exchange
 * counts, and no line ever prints an error name — `frontier.error` and
 * `world.error` are `--json` fields; the exit code is the human signal.
 */
export function formatStatus(report: StatusReport): string {
  const lines = [`home: ${report.home}`];
  lines.push(hostLine(report.host));
  lines.push(
    `frontier: ${report.frontier.count} events last=${report.frontier.lastHash} `
    + `http/request=${report.frontier.counts['http/request'] ?? 0} `
    + `http/response=${report.frontier.counts['http/response'] ?? 0} `
    + `http/incomplete=${report.frontier.counts['http/incomplete'] ?? 0} `
    + `open=${report.frontier.openCalls}`,
  );
  const request = report.frontier.lastRequest;
  if (request !== null) {
    lines.push(
      `last-request: call=${request.call} url=${request.url} `
      + `world_head=${request.worldHead} attempt=${request.attempt}`,
    );
  }
  const response = report.frontier.lastResponse;
  if (response !== null) {
    lines.push(
      `last-response: call=${response.call} status=${response.status} `
      + `error=${response.error} duration_ms=${response.durationMs}`,
    );
  }
  lines.push(report.world.present ? `world: head=${report.world.head}` : 'world: absent');
  return lines.join('\n');
}

/** The host line, one shape per owner state; `stale` carries no pid. */
function hostLine(host: StatusReport['host']): string {
  switch (host.state) {
    case 'running':
      return host.sandbox === undefined
        ? `host: running pid=${host.pid} uid=${host.uid} command=${host.command}`
        : `host: running pid=${host.pid} uid=${host.uid} command=${host.command} sandbox=${host.sandbox}`;
    case 'unverified':
      return host.sandbox === undefined
        ? `host: unverified pid=${host.pid}`
        : `host: unverified pid=${host.pid} sandbox=${host.sandbox}`;
    case 'stale':
      return 'host: stale';
    case 'idle':
      return 'host: idle';
  }
}
