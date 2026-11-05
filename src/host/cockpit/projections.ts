import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { C13_EVENT_TYPES } from '../../context/events.js';
import { JournalReader } from '../../journal/index.js';
import { readChatHistory, type ChatMessage } from '../chat.js';
import { readNodeTokenSnapshot, type NodeTokenSnapshot } from '../token-counter.js';
import { readStatus } from '../status.js';
import {
  readConversationStream, type ConversationRecord,
} from '../../node/conversation.js';
import type { RunManifest } from './runs.js';
import { readWorldTree, type WorldTree } from './world-tree.js';

export type NodeView = {
  readonly uid: string;
  readonly lastObservedAt: number | null;
  readonly lastActivity: string;
  readonly error?: string;
};

export type RunView = {
  readonly run: RunManifest;
  readonly active: boolean;
  readonly host: 'running' | 'idle' | 'absent' | 'stale' | 'unverified';
  readonly budget: NodeTokenSnapshot | null;
  readonly nodes: readonly NodeView[];
  readonly diagnostics?: readonly string[];
};

const NODE_UID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_EVENTS = 10_000;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function activity(event: { type: string; data: unknown; time: number }): {
  at: number; label: string;
} | null {
  const data = record(event.data);
  switch (event.type) {
    case 'node/boot': return { at: event.time, label: 'node boot' };
    case 'node/shutdown': {
      const reason = data?.['reason'];
      return { at: event.time, label: typeof reason === 'string' ? `shutdown: ${reason}` : 'shutdown' };
    }
    case 'turn/start': return { at: event.time, label: 'turn started' };
    case 'turn/end': {
      const outcome = data?.['outcome'];
      return { at: event.time, label: typeof outcome === 'string' ? `turn: ${outcome}` : 'turn ended' };
    }
    case 'tool/call': {
      const call = record(data?.['call']);
      const fn = record(call?.['function']);
      const name = fn?.['name'];
      return { at: event.time, label: typeof name === 'string' ? `tool: ${name}` : 'tool call' };
    }
    case 'tool/result': return { at: event.time, label: 'tool result' };
    case 'assistant/message': {
      const accounting = record(data?.['accounting']);
      const usage = record(accounting?.['usage']);
      const total = usage?.['totalTokens'];
      return {
        at: event.time,
        label: typeof total === 'number' ? `model response (${total} tokens)` : 'model response',
      };
    }
    case 'world/commit-refused': {
      const refusal = record(data?.['refusal']);
      const code = refusal?.['code'];
      return { at: event.time, label: typeof code === 'string' ? `world: ${code}` : 'world commit refused' };
    }
    case 'world/commit': return { at: event.time, label: 'world commit' };
    case 'turn/error': return { at: event.time, label: 'turn error' };
    case 'compaction/end': return { at: event.time, label: 'compaction end' };
    default: return null;
  }
}

export async function readNodes(home: string): Promise<readonly NodeView[]> {
  let names: string[];
  try {
    names = await readdir(join(home, 'nodes'));
  } catch {
    return [];
  }
  const out: NodeView[] = [];
  for (const uid of names.sort()) {
    if (!NODE_UID.test(uid)) continue;
    try {
      const info = await lstat(join(home, 'nodes', uid));
      if (!info.isDirectory()) continue;
      const reader = await JournalReader.open(home, uid, { knownTypes: C13_EVENT_TYPES });
      let last: { at: number; label: string } | null = null;
      let count = 0;
      for await (const event of reader.events()) {
        count += 1;
        const next = activity(event);
        if (next !== null) last = next;
        if (count >= MAX_EVENTS) break;
      }
      out.push({
        uid,
        lastObservedAt: last?.at ?? null,
        lastActivity: last?.label ?? 'no activity observed',
      });
    } catch {
      out.push({ uid, lastObservedAt: null, lastActivity: 'unreadable observation', error: 'unreadable' });
    }
  }
  return out;
}

export async function readRunView(
  manifest: RunManifest, runHome: string, activeId: string | null,
): Promise<RunView> {
  let host: RunView['host'] = 'absent';
  try {
    const status = await readStatus(runHome);
    host = status.host.state;
  } catch {
    host = 'unverified';
  }
  let budget: NodeTokenSnapshot | null = null;
  try {
    budget = await readNodeTokenSnapshot(runHome);
  } catch {
    budget = null;
  }
  return {
    run: manifest,
    active: activeId === manifest.id,
    host,
    budget,
    nodes: await readNodes(runHome),
  };
}

export async function readChatTail(home: string): Promise<{
  readonly records: readonly ChatMessage[]; readonly older: boolean; readonly degraded: number;
}> {
  return await readChatHistory(home, 50);
}

export async function readMailbox(home: string): Promise<readonly ConversationRecord[]> {
  const thread = await readConversationStream(home, 50);
  return thread.records.filter(
    (record) => record.from === 'gateway' || record.to === 'gateway',
  );
}

export async function readTree(home: string): Promise<WorldTree> {
  return await readWorldTree(home);
}
