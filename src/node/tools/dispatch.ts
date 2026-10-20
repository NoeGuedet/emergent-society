import type {
  AgentConfig, ArtifactRef, AssistantProjection, FunctionCall, RequestId, SafeFailure,
} from '../../context/contracts.js';
import { isRecord } from '../../util.js';
import type { BoundaryGate } from '../gate.js';
import { sanitizePtyText } from './sanitize.js';
import type { CommandOutcome, TerminalPort } from './terminal.js';
import { boundToolText, decodeToolText } from './text.js';
import { renderExtract, renderSearch } from './web.js';
import type { WebOutcome, WebTools } from './web.js';

/**
 * Tool dispatch (T7, kernel.md §4).
 *
 * `dispatchCalls` turns an assistant projection's advertised calls into durable
 * `tool/call` + `tool/result` facts. Tool names are recognized exactly: `execute`
 * runs one command in the node's persistent shell session (marker-encapsulated,
 * typed statuses, reset-on-timeout), `wait` is loop control, `web_search` and
 * `web_fetch` run through the injected `WebTools` port (its client is the only
 * place the credential is written, and only into an `Authorization` header), and
 * any other name is an unknown tool that never becomes bash. Arguments stay raw
 * until here, where they are parsed as a plain JSON object; a malformed, unknown
 * or denied call yields a fixed error result with the matching `tool_call_id` and
 * no shell. An extract-level `failed: true` render is an error result with a null
 * `SafeFailure`, the ordinary-nonzero-exit precedent. `called` counts the calls
 * actually accepted (each has its own `tool/call`).
 */

export type DispatchResult = { readonly waited: boolean; readonly called: number };

type Decision =
  | { readonly kind: 'execute'; readonly cmd: string }
  | { readonly kind: 'wait' }
  | { readonly kind: 'web_search'; readonly query: string;
      readonly maxResults: number | undefined }
  | { readonly kind: 'web_fetch'; readonly url: string }
  | { readonly kind: 'error'; readonly failure: SafeFailure };

const INVALID: Decision = { kind: 'error', failure: { code: 'invalid-tool', status: null } };

/**
 * Recognizes one advertised call. A name is known only when it is both offered
 * by the config and has a handler here; an offered-but-denied name is `denied`,
 * and any other name is `unknown-tool` — never a shell command.
 */
function decide(call: FunctionCall, config: AgentConfig): Decision {
  const name = call.function.name;
  const offered = config.tools.some((tool) => tool.name === name);
  const hasHandler = name === 'execute' || name === 'wait'
    || name === 'web_search' || name === 'web_fetch';
  if (!offered || !hasHandler) {
    return { kind: 'error', failure: { code: 'unknown-tool', status: null } };
  }
  if (!config.allowedTools.includes(name)) {
    return { kind: 'error', failure: { code: 'denied', status: null } };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(call.function.arguments);
  } catch {
    parsed = undefined;
  }
  if (!isRecord(parsed)) return INVALID;

  if (name === 'wait') {
    // `wait` accepts only an empty object.
    return Object.keys(parsed).length === 0 ? { kind: 'wait' } : INVALID;
  }

  if (name === 'web_search') {
    const keys = Object.keys(parsed);
    if (!keys.every((key) => key === 'query' || key === 'max_results')) return INVALID;
    const query = parsed['query'];
    if (typeof query !== 'string' || query.trim().length === 0) return INVALID;
    const maxResults = parsed['max_results'];
    if (maxResults !== undefined
      && (typeof maxResults !== 'number'
        || !Number.isSafeInteger(maxResults) || maxResults < 1 || maxResults > 20)) {
      return INVALID;
    }
    return { kind: 'web_search', query, maxResults: maxResults as number | undefined };
  }
  if (name === 'web_fetch') {
    const keys = Object.keys(parsed);
    if (keys.length !== 1 || keys[0] !== 'url') return INVALID;
    const url = parsed['url'];
    if (typeof url !== 'string') return INVALID;
    let parsedUrl: URL;
    try { parsedUrl = new URL(url); } catch { return INVALID; }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') return INVALID;
    return { kind: 'web_fetch', url };
  }

  // `execute` requires its own non-whitespace string `cmd` and no unknown keys.
  const keys = Object.keys(parsed);
  if (keys.length !== 1 || keys[0] !== 'cmd') return INVALID;
  const cmd = parsed['cmd'];
  if (typeof cmd !== 'string' || cmd.trim().length === 0) return INVALID;
  return { kind: 'execute', cmd };
}

function appendSyntheticCancelled(
  gate: BoundaryGate, id: RequestId, call: FunctionCall,
): void {
  gate.append('tool/result', {
    turn: id.turn, request: id, callId: call.id,
    message: { role: 'tool', content: 'cancelled', tool_call_id: call.id },
    isError: true, raw: null, failure: { code: 'cancelled', status: null }, synthetic: true,
    frontierCall: null,
  });
}

function appendErrorResult(
  gate: BoundaryGate, id: RequestId, callId: string, failure: SafeFailure,
): void {
  gate.append('tool/result', {
    turn: id.turn, request: id, callId,
    message: { role: 'tool', content: `error: ${failure.code}`, tool_call_id: callId },
    isError: true, raw: null, failure, synthetic: false,
    frontierCall: null,
  });
}

function appendWaitResult(gate: BoundaryGate, id: RequestId, callId: string): void {
  gate.append('tool/result', {
    turn: id.turn, request: id, callId,
    message: {
      role: 'tool', content: 'Waiting until a foreign world commit', tool_call_id: callId,
    },
    isError: false, raw: null, failure: null, synthetic: false,
    frontierCall: null,
  });
}

/**
 * Failure precedence for a session outcome: spawn > cancelled > timeout >
 * output-limit > signal — the retired shell's order. An ordinary nonzero exit
 * and a clean session exit carry no SafeFailure (the extract `failed: true`
 * precedent: content, not transport).
 */
function executeFailure(outcome: CommandOutcome): SafeFailure | null {
  if (outcome.status === 'spawn-failed') return { code: 'spawn', status: null };
  if (outcome.status === 'cancelled') return { code: 'cancelled', status: null };
  if (outcome.status === 'timeout') return { code: 'timeout', status: null };
  if (outcome.truncated) return { code: 'output-limit', status: null };
  if (outcome.status === 'session_exit' && outcome.signal !== null) {
    return { code: 'signal', status: null };
  }
  return null;
}

function executeIsError(outcome: CommandOutcome): boolean {
  return executeFailure(outcome) !== null
    || (outcome.status === 'completed' && outcome.exitCode !== 0)
    || (outcome.status === 'session_exit'
      && (outcome.signal !== null || outcome.exitCode !== 0));
}

/** The deterministic model-facing render of a session outcome. */
function renderExecuteText(outcome: CommandOutcome): string {
  const lines: string[] = [];
  if (outcome.fresh === 'stdin-wedge') {
    lines.push('[session: reset after a command left waiting on stdin — previous shell state is gone]');
  }
  if (outcome.status === 'completed') {
    lines.push(`exit: ${outcome.exitCode}`);
  } else {
    lines.push(`status: ${outcome.status}`);
    if (outcome.status === 'session_exit') {
      lines.push(outcome.signal !== null
        ? `detail: the shell was killed by signal ${outcome.signal}`
        : `detail: the shell exited with code ${outcome.exitCode ?? 'unknown'}`);
    }
    if (outcome.status === 'stdin_read') {
      lines.push('[the command is waiting on standard input; the next execute call resets the session first]');
    }
  }
  if (outcome.reset) lines.push('[session: reset — the next command starts fresh]');
  if (outcome.truncated) lines.push('[output truncated at the capture limit; the command kept running]');
  const text = sanitizePtyText(decodeToolText(outcome.output));
  if (text.length > 0) lines.push('output:', text);
  return lines.join('\n');
}

/** Captures the raw output span and appends the bounded execute result. */
async function appendExecuteResult(
  gate: BoundaryGate, id: RequestId, callId: string,
  outcome: CommandOutcome, maxToolResultBytes: number,
): Promise<void> {
  const complete = outcome.status === 'completed' && !outcome.truncated;
  // A silent command captures nothing: the header alone is the result.
  const raw = outcome.output.length > 0
    ? await gate.capture(outcome.output, 'utf8', complete) : null;
  const rendered = renderExecuteText(outcome);
  gate.append('tool/result', {
    turn: id.turn, request: id, callId,
    message: {
      role: 'tool',
      content: raw === null ? rendered
        : boundToolText(rendered, maxToolResultBytes, {
          kind: 'artifact', sha256: raw.sha256, bytes: raw.bytes, complete: raw.complete,
        }),
      tool_call_id: callId,
    },
    isError: executeIsError(outcome),
    raw,
    failure: executeFailure(outcome),
    synthetic: false,
    frontierCall: null,
  });
}

/** Captures the raw provider body and appends the bounded web result. */
async function appendWebResult(
  gate: BoundaryGate, id: RequestId, callId: string,
  kind: 'web_search' | 'web_fetch', outcome: WebOutcome, maxToolResultBytes: number,
): Promise<void> {
  const append = (
    content: string, isError: boolean, raw: ArtifactRef | null, failure: SafeFailure | null,
  ): void => {
    gate.append('tool/result', {
      turn: id.turn, request: id, callId,
      message: { role: 'tool', content, tool_call_id: callId },
      isError, raw, failure, synthetic: false,
      // The web tools cross the frontier in T6; until then their results carry
      // no frontier reference (and still capture their raw body locally).
      frontierCall: null,
    });
  };
  const captureOf = (raw: ArtifactRef): {
    kind: 'artifact'; sha256: string; bytes: number; complete: boolean;
  } => ({ kind: 'artifact', sha256: raw.sha256, bytes: raw.bytes, complete: raw.complete });
  if (!outcome.ok) {
    // No capture for an empty failure body; a kept prefix has its real complete flag.
    const raw = outcome.body.length > 0
      ? await gate.capture(outcome.body, 'utf8', outcome.complete) : null;
    const head = outcome.status === null
      ? `error: ${outcome.failure.code}`
      : `error: ${outcome.failure.code}\nstatus: ${outcome.status}`;
    append(raw === null ? head
      : boundToolText(`${head}\nbody:\n${decodeToolText(outcome.body)}`,
        maxToolResultBytes, captureOf(raw)),
      true, raw, outcome.failure);
    return;
  }
  const raw = await gate.capture(outcome.body, 'utf8', true);
  const rendered = kind === 'web_search' ? renderSearch(outcome.body) : renderExtract(outcome.body);
  if (rendered === null) {
    append(boundToolText(
      `error: malformed\nstatus: ${outcome.status}\nbody:\n${decodeToolText(outcome.body)}`,
      maxToolResultBytes, captureOf(raw)), true, raw, { code: 'malformed', status: outcome.status });
    return;
  }
  const text = typeof rendered === 'string' ? rendered : rendered.text;
  const failed = typeof rendered === 'string' ? false : rendered.failed;
  append(boundToolText(text, maxToolResultBytes, captureOf(raw)), failed, raw, null);
}

export async function dispatchCalls(
  projection: AssistantProjection, id: RequestId, gate: BoundaryGate,
  config: AgentConfig, terminal: TerminalPort, web?: WebTools,
): Promise<DispatchResult> {
  const calls = projection.message.tool_calls;
  let called = 0;
  let waited = false;

  for (let i = 0; i < calls.length; i++) {
    const call = calls[i]!;
    // Stopped before this call was ever advertised: complete it (and every
    // companion) with a synthetic cancelled result, never a forged tool/call.
    if (gate.signal.aborted) {
      for (let j = i; j < calls.length; j++) appendSyntheticCancelled(gate, id, calls[j]!);
      await gate.flush();
      break;
    }

    gate.append('tool/call', { turn: id.turn, request: id, call });
    await gate.flush();
    called += 1;

    const decision = decide(call, config);
    if (decision.kind === 'error') {
      appendErrorResult(gate, id, call.id, decision.failure);
      await gate.flush();
      continue;
    }
    if (decision.kind === 'wait') {
      waited = true;
      appendWaitResult(gate, id, call.id);
      await gate.flush();
      continue;
    }
    if (decision.kind === 'web_search' || decision.kind === 'web_fetch') {
      if (web === undefined) {
        appendErrorResult(gate, id, call.id, { code: 'denied', status: null });
        await gate.flush();
        continue;
      }
      const outcome = decision.kind === 'web_search'
        ? await web.search(decision.query, decision.maxResults, gate.signal)
        : await web.extract(decision.url, gate.signal);
      await appendWebResult(gate, id, call.id, decision.kind, outcome, config.policy.maxToolResultBytes);
      await gate.flush();
      continue;
    }

    // The terminal re-checks the signal after the flush above, so an abort that
    // landed during that await returns cancelled without writing to the session.
    const outcome = await terminal.run(decision.cmd, {
      timeoutMs: config.policy.shellTimeoutMs,
      killGraceMs: config.policy.killGraceMs,
      maxCaptureBytes: config.policy.maxShellCaptureBytes,
    }, gate.signal);
    await appendExecuteResult(gate, id, call.id, outcome, config.policy.maxToolResultBytes);
    await gate.flush();
  }

  return { waited, called };
}
