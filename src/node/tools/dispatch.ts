import type {
  AgentConfig, AssistantProjection, FunctionCall, RequestId, SafeFailure,
} from '../../context/contracts.js';
import type { BoundaryGate } from '../gate.js';
import type { WorldRepo } from '../world.js';
import {
  boundShellText, renderShellText, runShell, shellArtifactBytes, shellFailure, shellIsError,
} from './shell.js';
import type { ShellPolicy, ShellResult } from './shell.js';

/**
 * Foreground tool dispatch (T7, kernel.md §4).
 *
 * `dispatchCalls` turns an assistant projection's advertised calls into durable
 * `tool/call` + `tool/result` facts. Tool names are recognized exactly: `execute`
 * runs one foreground shell command, `wait` is loop control, and any other name
 * is an unknown tool that never becomes bash. Arguments stay raw until here,
 * where they are parsed as a plain JSON object; a malformed, unknown or denied
 * call yields a fixed error result with the matching `tool_call_id` and no shell.
 * `called` counts the calls actually accepted (each has its own `tool/call`).
 */

export type DispatchResult = { readonly waited: boolean; readonly called: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type Decision =
  | { readonly kind: 'execute'; readonly cmd: string }
  | { readonly kind: 'wait' }
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
  const hasHandler = name === 'execute' || name === 'wait';
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
  });
}

function appendErrorResult(
  gate: BoundaryGate, id: RequestId, callId: string, failure: SafeFailure,
): void {
  gate.append('tool/result', {
    turn: id.turn, request: id, callId,
    message: { role: 'tool', content: `error: ${failure.code}`, tool_call_id: callId },
    isError: true, raw: null, failure, synthetic: false,
  });
}

function appendWaitResult(gate: BoundaryGate, id: RequestId, callId: string): void {
  gate.append('tool/result', {
    turn: id.turn, request: id, callId,
    message: {
      role: 'tool', content: 'Waiting until a foreign world commit', tool_call_id: callId,
    },
    isError: false, raw: null, failure: null, synthetic: false,
  });
}

/** Captures the raw wrapper and appends the bounded shell result. */
async function appendShellResult(
  gate: BoundaryGate, id: RequestId, callId: string, result: ShellResult, maxToolResultBytes: number,
): Promise<void> {
  const complete = !result.truncated && !result.drainExpired;
  const raw = await gate.capture(shellArtifactBytes(result), 'utf8', complete);
  const content = boundShellText(renderShellText(result), maxToolResultBytes, raw);
  gate.append('tool/result', {
    turn: id.turn, request: id, callId,
    message: { role: 'tool', content, tool_call_id: callId },
    isError: shellIsError(result),
    raw,
    failure: shellFailure(result),
    synthetic: false,
  });
}

export async function dispatchCalls(
  projection: AssistantProjection, id: RequestId, world: WorldRepo, gate: BoundaryGate,
  config: AgentConfig, shellPolicy: ShellPolicy,
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

    // `runShell` re-checks the signal after the flush above, so an abort that
    // landed during that await returns cancelled without spawning.
    const result = await runShell(decision.cmd, world.path, gate.signal, shellPolicy);
    await appendShellResult(gate, id, call.id, result, config.policy.maxToolResultBytes);
    await gate.flush();
  }

  return { waited, called };
}
