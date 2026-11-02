import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { AssistantProjection, ChatMessage, FunctionCall, SafeFailure } from '../../context/contracts.js';
import { GATEWAY_ADDRESSEE, HUMAN_AUTHOR } from '../../journal/index.js';
import { ChatLog, readChat } from '../../host/chat.js';
import { ChatWatcher } from '../../host/chat-watcher.js';
import { initHome } from '../../host/layout.js';
import { createHostLog } from '../../host/observe.js';
import { ConversationLog } from '../../node/conversation.js';
import { ConversationWatcher } from '../../node/conversation-watcher.js';
import { WorldRepo } from '../../node/world.js';
import { commitAs } from '../../node/__tests__/helpers.js';
import { ProviderAdapter, type SendPlan, type SendResult } from '../../provider/adapter.js';
import { systemProviderPolicy } from '../../provider/policy.js';
import type { BoundaryGate } from '../../node/gate.js';
import { NO_REPLY_NOTICE, OVERLAY_FRAMING } from '../cycle.js';
import { createOverlayGate } from '../gate.js';
import { serializeWire } from '../../provider/wire.js';
import { CHAT_WINDOW_HEADER, THREAD_WINDOW_HEADER } from '../context.js';
import { OVERLAY_CHAT_WINDOW, OVERLAY_CYCLE_STEPS, OVERLAY_POLICY } from '../policy.js';
import { OverlayService } from '../service.js';
import { WORLD_READ_FRAMING } from '../world-read.js';

/**
 * The gateway overlay's cycle and service (A3 — the overlay's side).
 *
 * The service is exercised against the real chat log, the real conversation
 * stream (its cross-process flock) and a real world, with only the model
 * exchange scripted (`OverlaySend`) — the one seam the host's adapter fills.
 */

const dirs: string[] = [];
const chats: ChatLog[] = [];
afterEach(async () => {
  for (const chat of chats.splice(0)) await chat.close().catch(() => {});
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

type ScriptStep =
  | { readonly text: string | null; readonly calls?: readonly { name: string; args: unknown }[] }
  | { readonly failure: SafeFailure };

/** A scripted model exchange: records every plan it was handed. */
function scripted(steps: readonly ScriptStep[]): {
  send: (plan: SendPlan, gate: BoundaryGate) => Promise<SendResult>;
  plans: SendPlan[];
} {
  const plans: SendPlan[] = [];
  let index = 0;
  const send = async (plan: SendPlan, _gate: BoundaryGate): Promise<SendResult> => {
    plans.push(plan);
    const step = steps[Math.min(index, steps.length - 1)]!;
    index += 1;
    if ('failure' in step) return { kind: 'failure', failure: step.failure };
    const calls: FunctionCall[] = (step.calls ?? []).map((call, callIndex) => ({
      id: `c${index}-${callIndex}`,
      type: 'function',
      function: { name: call.name, arguments: JSON.stringify(call.args) },
    }));
    const message: AssistantProjection['message'] = {
      role: 'assistant', content: step.text, tool_calls: calls,
    };
    return { kind: 'response', projection: { message, contentTruncated: false, frontierCall: 'call-1' } };
  };
  return { send, plans };
}

type Fixture = {
  readonly home: string;
  readonly world: WorldRepo;
  readonly chat: ChatLog;
};

async function fixture(seed?: { readonly path: string; readonly text: string }): Promise<Fixture> {
  const home = await mkdtemp(join(tmpdir(), 'es-overlay-cycle-'));
  dirs.push(home);
  await initHome(home);
  const world = await WorldRepo.open(join(home, 'world'), { gitDir: join(home, 'world.git') });
  if (seed !== undefined) {
    await commitAs(world, 'node-0', { [seed.path]: seed.text }, 'seed the world');
  }
  const chat = await ChatLog.open(home);
  chats.push(chat);
  return { home, world, chat };
}

function serviceOf(
  fx: Fixture,
  send: (plan: SendPlan, gate: BoundaryGate) => Promise<SendResult>,
  lines: string[] = [],
): OverlayService {
  return new OverlayService({
    home: fx.home,
    config: { model: 'test-model', charter: 'You are the gateway overlay.' },
    chat: fx.chat,
    conversation: ConversationLog.for(fx.home),
    world: fx.world,
    send,
    log: createHostLog((line) => { lines.push(line); }),
    pollMs: 0,
  });
}

it('runs the boot cycle on the pre-existing backlog of BOTH windows, then one cycle per human/ gateway-addressed arrival', async () => {
  const fx = await fixture();
  // The backlog written while the host was down: a human chat record and a
  // node's gateway-addressed question. Neither file will grow when the host
  // starts, so only the boot cycle can digest them.
  await fx.chat.append(HUMAN_AUTHOR, 'digest this, please', 1_000);
  await ConversationLog.for(fx.home).append('node-1', undefined, 'the world is on fire');
  const { send, plans } = scripted([{ text: 'noted.' }]);
  const service = serviceOf(fx, send);
  service.start();
  await service.idle();
  expect(plans).toHaveLength(1);
  const history = JSON.stringify(plans[0]!.history);
  expect(history).toContain('digest this, please');
  expect(history).toContain('the world is on fire');
  const delivered = await readChat(fx.home);
  // The chat holds BOTH sides: the human's record and the cycle's response.
  expect(delivered.map((message) => [message.uid, message.text])).toEqual([
    ['human', 'digest this, please'],
    ['gateway', 'noted.'],
  ]);

  // A human's chat record is the second surface's arrival.
  await fx.chat.append(HUMAN_AUTHOR, 'and now this', 2_000);
  ChatWatcher.for(fx.home).poke();
  await vi.waitFor(() => { expect(plans).toHaveLength(2); });
  await service.idle();

  // The overlay's OWN delivery (uid: gateway, appended by the cycle) never
  // re-triggers — the watcher's actor filter absorbs it.
  await ChatWatcher.for(fx.home).check();
  await service.idle();
  expect(plans).toHaveLength(2);
  expect((await readChat(fx.home)).map((message) => message.uid))
    .toEqual(['human', 'gateway', 'human', 'gateway']);

  await service.stop();
});

it('cycles only on gateway-addressed conversation records, never on the overlay\'s own sends', async () => {
  const fx = await fixture();
  const { send, plans } = scripted([{ text: 'understood.' }]);
  const service = serviceOf(fx, send);
  service.start();
  await service.idle();
  expect(plans).toHaveLength(1);

  // A node's question: the conversation side's arrival.
  await ConversationLog.for(fx.home).append('node-2', undefined, 'what is the direction?');
  ConversationWatcher.for(fx.home).poke();
  await vi.waitFor(() => { expect(plans).toHaveLength(2); });

  // The overlay's own send names a NODE addressee: it grows the stream and
  // arms the node's notice, and it NEVER re-triggers the overlay.
  await ConversationLog.for(fx.home).append(GATEWAY_ADDRESSEE, 'node-2', 'the human will answer');
  ConversationWatcher.for(fx.home).poke();
  await vi.waitFor(() => {
    expect(ConversationWatcher.for(fx.home).gatewayArrivalCount()).toBe(1);
  });
  await service.idle();
  expect(plans).toHaveLength(2);

  await service.stop();
});

it('serializes cycles and coalesces everything that arrives mid-cycle into ONE more', async () => {
  const fx = await fixture();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const send = async (plan: SendPlan, _gate: BoundaryGate): Promise<SendResult> => {
    calls += 1;
    if (calls === 1) await blocked;
    return {
      kind: 'response',
      projection: {
        message: { role: 'assistant', content: `reply ${plan.id.ordinal}`, tool_calls: [] },
        contentTruncated: false, frontierCall: 'call-1',
      },
    };
  };
  const service = serviceOf(fx, send);
  service.start();
  // The boot cycle is now running (blocked). Three notifications across both
  // surfaces while it runs: they collapse into ONE more cycle.
  await vi.waitFor(() => { expect(calls).toBe(1); });
  await fx.chat.append(HUMAN_AUTHOR, 'one', 1);
  await ChatWatcher.for(fx.home).check();
  service.markDirty();
  service.markDirty();
  release();
  await service.idle();
  expect(calls).toBe(2);
  expect((await readChat(fx.home)).map((message) => message.text))
    .toEqual(['one', 'reply 0', 'reply 0']);
  await service.stop();
});

it('bounds a cycle at OVERLAY_CYCLE_STEPS model rounds and delivers the final prose once', async () => {
  const fx = await fixture();
  // Every round asks for a tool and carries prose; the step bound, not the
  // model, ends the cycle.
  const { send, plans } = scripted([
    { text: 'round prose', calls: [{ name: 'world_log', args: { n: 1 } }] },
  ]);
  const service = serviceOf(fx, send);
  service.start();
  await service.idle();
  expect(plans).toHaveLength(OVERLAY_CYCLE_STEPS);
  const delivered = await readChat(fx.home);
  expect(delivered).toHaveLength(1);
  expect(delivered[0]).toMatchObject({ uid: 'gateway', text: 'round prose' });
  await service.stop();
});

it('delivers the LAST non-empty prose, never an earlier one when a later exists; a text-less cycle delivers the notice', async () => {
  const fx = await fixture();
  const first = serviceOf(fx, scripted([
    { text: 'intermediate prose', calls: [{ name: 'world_log', args: {} }] },
    { text: 'the final answer' },
  ]).send);
  first.start();
  await first.idle();
  expect((await readChat(fx.home)).map((message) => message.text)).toEqual(['the final answer']);
  await first.stop();

  // The MIXED case: round 1 has prose AND a tool call, round 2 has no prose
  // and no tools — round 1's prose is the last non-empty text and is delivered.
  const mixed = await fixture();
  const mixedService = serviceOf(mixed, scripted([
    { text: 'the only prose', calls: [{ name: 'world_log', args: {} }] },
    { text: null },
  ]).send);
  mixedService.start();
  await mixedService.idle();
  expect((await readChat(mixed.home)).map((message) => message.text)).toEqual(['the only prose']);
  await mixedService.stop();

  const second = await fixture();
  const textless = serviceOf(second, scripted([
    { text: null, calls: [{ name: 'world_log', args: {} }] },
    { text: null },
  ]).send);
  textless.start();
  await textless.idle();
  expect((await readChat(second.home)).map((message) => message.text)).toEqual([NO_REPLY_NOTICE]);
  await textless.stop();
});

it('truncates a long final text to the conversation cap and says so', async () => {
  const fx = await fixture();
  const service = serviceOf(fx, scripted([{ text: 'x'.repeat(9_000) }]).send);
  service.start();
  await service.idle();
  const [record] = await readChat(fx.home);
  expect(record).toBeDefined();
  const bytes = Buffer.byteLength(record!.text, 'utf8');
  expect(bytes).toBeLessThanOrEqual(8_192);
  expect(record!.text.endsWith(' (truncated)')).toBe(true);
  await service.stop();
});

it('reports a provider failure as one bounded host diagnostic and delivers no chat record', async () => {
  const fx = await fixture();
  const lines: string[] = [];
  const service = serviceOf(
    fx, scripted([{ failure: { code: 'network', status: null } }]).send, lines,
  );
  service.start();
  await service.idle();
  const failure = lines.map((line) => JSON.parse(line) as Record<string, unknown>)
    .find((line) => line['event'] === 'overlay/provider-failed');
  expect(failure).toMatchObject({ code: 'network', status: null });
  expect(await readChat(fx.home)).toEqual([]);
  // The failure did not re-arm the flag: no retry storm, no cycle loop.
  await service.idle();
  expect(lines.filter((line) => line.includes('overlay/provider-failed'))).toHaveLength(1);
  await service.stop();
});

it('assembles the charter, the framing line, both bounded windows and the three tools', async () => {
  const fx = await fixture({ path: 'DIRECTION.md', text: 'the ratified direction\n' });
  for (let i = 0; i < OVERLAY_CHAT_WINDOW + 3; i += 1) {
    await fx.chat.append(i % 2 === 0 ? HUMAN_AUTHOR : GATEWAY_ADDRESSEE, `chat-${i}`, 1_000 + i);
  }
  for (let i = 0; i < 4; i += 1) {
    await ConversationLog.for(fx.home).append(`node-${i}`, undefined, `question-${i}`, 2_000 + i);
  }
  const { send, plans } = scripted([{ text: 'ok' }]);
  const service = serviceOf(fx, send);
  service.start();
  await service.idle();
  const plan = plans[0]!;
  expect(plan.charter).toContain('gateway overlay');
  expect(plan.heading).toBe(OVERLAY_FRAMING);
  expect(plan.policy).toBe(OVERLAY_POLICY);
  expect(plan.tools.map((tool) => tool.name)).toEqual(['send_message', 'read_world', 'world_log']);
  expect(plan.queue).toEqual([]);
  const history = plan.history as readonly ChatMessage[];
  expect(history).toHaveLength(2);
  expect(history[0]!.content).toContain(CHAT_WINDOW_HEADER);
  expect(history[1]!.content).toContain(THREAD_WINDOW_HEADER);
  // The chat window is bounded: the oldest three records are out, the newest
  // OVERLAY_CHAT_WINDOW are in (all of them, both actors).
  expect(history[0]!.content).not.toContain('chat-0');
  expect(history[0]!.content).not.toContain('chat-2');
  expect(history[0]!.content).toContain(`chat-${OVERLAY_CHAT_WINDOW + 2}`);
  expect(history[1]!.content).toContain('question-3');
  await service.stop();
});

it('runs one cycle whose tool result enters the next request, with the framing line', async () => {
  const fx = await fixture({ path: 'notes.txt', text: 'committed notes\n' });
  const { send, plans } = scripted([
    { text: null, calls: [{ name: 'read_world', args: { path: 'notes.txt' } }] },
    { text: 'I read the notes.' },
  ]);
  const service = serviceOf(fx, send);
  service.start();
  await service.idle();
  expect(plans).toHaveLength(2);
  // The second request carries the first round's tool exchange in its queue.
  const queue = plans[1]!.queue as readonly ChatMessage[];
  const result = queue.find((message) => message.role === 'tool');
  expect(result).toBeDefined();
  expect((result as { content: string }).content).toContain(WORLD_READ_FRAMING);
  expect((result as { content: string }).content).toContain('committed notes');
  expect((await readChat(fx.home)).map((message) => message.text)).toEqual(['I read the notes.']);
  await service.stop();
});

it('serializes the overlay plan to the wire subset only — no fabricated journal receipt', async () => {
  const fx = await fixture();
  const { send, plans } = scripted([{ text: 'ok' }]);
  const service = serviceOf(fx, send);
  service.start();
  await service.idle();
  const wire = JSON.parse(Buffer.from(serializeWire(plans[0]!)).toString('utf8')) as Record<string, unknown>;
  // The wire's own keys: the plan carries no config/stateHash/toolsHash/sections
  // and nothing is invented for the serializer to read.
  expect(Object.keys(wire).sort()).toEqual(['messages', 'model', 'n', 'stream', 'tools']);
  expect(wire['model']).toBe('test-model');
  const messages = wire['messages'] as readonly { role: string; content: string }[];
  expect(messages[0]).toEqual({ role: 'system', content: 'You are the gateway overlay.' });
  expect(messages[1]).toEqual({ role: 'system', content: OVERLAY_FRAMING });
  await service.stop();
});

it('refuses an overlay request above the overlay policy\'s maxRequestBytes at send', async () => {
  const never = (label: string) => async (): Promise<never> => {
    throw new Error(label);
  };
  const adapter = new ProviderAdapter({
    facts: { url: 'https://test.invalid/v1/chat/completions', headers: {}, credentialId: 'llm' },
    post: async () => { throw new Error('the transport must never be reached'); },
  }, systemProviderPolicy, {
    begin: never('the frontier must never begin'),
    complete: never('the frontier must never complete'),
  });
  const plan: SendPlan = {
    id: { turn: 0, ordinal: 0 },
    model: 'test-model',
    parameters: {},
    policy: OVERLAY_POLICY,
    tools: [],
    charter: 'x'.repeat(OVERLAY_POLICY.maxRequestBytes + 1),
    heading: OVERLAY_FRAMING,
    history: [],
    queue: [],
  };
  const result = await adapter.send(
    plan, createOverlayGate(new AbortController().signal),
  );
  expect(result).toEqual({ kind: 'failure', failure: { code: 'request-limit', status: null } });
});

it('rides the synthetic no-op gate: the assistant append is dropped, the signal is live', async () => {
  const controller = new AbortController();
  const gate = createOverlayGate(controller.signal);
  expect(gate.signal).toBe(controller.signal);
  const projection: AssistantProjection = {
    message: { role: 'assistant', content: 'x', tool_calls: [] },
    contentTruncated: false, frontierCall: 'call-1',
  };
  // The append and the store are accepted and dropped: the frontier is the
  // assistant message's only record.
  expect(gate.append('assistant/message', {
    id: { turn: 0, ordinal: 0 }, value: { kind: 'inline', value: projection },
  })).toEqual({ seq: 0, hash: '' });
  await expect(gate.flush()).resolves.toBeUndefined();
  await expect(gate.store({ a: 1 })).resolves.toEqual({ kind: 'inline', value: { a: 1 } });
  await expect(gate.capture(new Uint8Array(), 'utf8'))
    .rejects.toThrow('frontier-only');
});

it('stops cleanly: the subscriptions end and no cycle runs after stop', async () => {
  const fx = await fixture();
  const { send, plans } = scripted([{ text: 'ok' }]);
  const service = serviceOf(fx, send);
  service.start();
  await service.idle();
  await service.stop();
  expect(ChatWatcher.for(fx.home).subscriberCount).toBe(0);
  expect(ConversationWatcher.for(fx.home).subscriberCount).toBe(0);
  service.markDirty();
  await service.idle();
  expect(plans).toHaveLength(1);
});
