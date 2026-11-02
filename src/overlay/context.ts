import type { ChatMessage as ChatRecord } from '../host/chat.js';
import {
  GATEWAY_ADDRESSEE, HUMAN_AUTHOR,
} from '../journal/index.js';
import type { ConversationLog, ConversationThread } from '../node/conversation.js';
import { readChatWindow } from '../host/chat.js';
import { OVERLAY_CHAT_WINDOW, OVERLAY_THREAD_WINDOW } from './policy.js';

/**
 * The cycle's context: the two bounded windows that ARE the overlay's memory.
 *
 * There is NO history fold and NO compaction concern here. Each cycle reads the
 * tails of both surfaces — the human↔overlay chat (its conversation with the
 * human) and the gateway's conversation thread (the nodes' questions and its
 * own sends) — bounded independently by `OVERLAY_CHAT_WINDOW` and
 * `OVERLAY_THREAD_WINDOW`, and the model sees exactly those plus this cycle's
 * tool results. The first cycle after a start is the same bounded windows, never
 * the whole of either file.
 */

/** The chat window's header: what the block is, in the kernel's words. */
export const CHAT_WINDOW_HEADER = 'the human↔overlay chat log, oldest first — your conversation'
  + ' with the human';

/** The conversation window's header. */
export const THREAD_WINDOW_HEADER = 'your conversation thread with the nodes, oldest first —'
  + ' the records addressed to you and your own sends';

/** The two bounded windows one cycle assembles. */
export type OverlayWindows = {
  readonly chat: readonly ChatRecord[];
  readonly thread: ConversationThread;
};

/** Reads both windows: bounded tails, never the whole of either log. */
export async function loadOverlayWindows(
  home: string, conversation: ConversationLog,
): Promise<OverlayWindows> {
  const chat = (await readChatWindow(home, OVERLAY_CHAT_WINDOW))
    .filter((record) => record.uid === HUMAN_AUTHOR || record.uid === GATEWAY_ADDRESSEE)
    .slice(-OVERLAY_CHAT_WINDOW);
  const thread = await conversation.thread(GATEWAY_ADDRESSEE, OVERLAY_THREAD_WINDOW);
  return { chat, thread };
}

/** The chat window as one system block. */
export function renderChatWindow(records: readonly ChatRecord[]): string {
  if (records.length === 0) return `${CHAT_WINDOW_HEADER}\n(no chat records yet)`;
  const lines = records.map((record) => `[${stamp(record.at)}] ${record.uid}: ${record.text}`);
  return `${CHAT_WINDOW_HEADER}\n${lines.join('\n')}`;
}

/** The gateway thread as one system block. */
export function renderConversationWindow(thread: ConversationThread): string {
  if (thread.records.length === 0) {
    return `${THREAD_WINDOW_HEADER}\n(no conversation records yet)`;
  }
  const blocks = thread.records.map((record) =>
    `[${stamp(record.at)}] from ${record.from} to ${record.to}\n${record.text}`);
  const older = thread.older
    ? '\n(older records exist — this window shows the newest of the thread)' : '';
  return `${THREAD_WINDOW_HEADER}\n${blocks.join('\n\n')}${older}`;
}

/** One ISO-8601 UTC stamp for the model; the readers never assert times. */
function stamp(at: number): string {
  return new Date(at).toISOString();
}
