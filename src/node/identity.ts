import { NODE_UID_RE } from '../journal/index.js';

/**
 * The kernel's identity-sentence vocabulary (plan §0.8).
 *
 * Every charter ends with the kernel's own final sentence, and the sentence
 * grammar is the node-uid grammar (`NODE_UID_RE`) — never a hardcoded
 * `node-\d+`, so an operator-chosen uid and a minted one behave identically.
 * Two named patterns are built on that grammar:
 *
 * - **the authored-strip pattern** (`AUTHORED_IDENTITY_RE`) — any trailing
 *   ` You are <uid>[, composed by <uid>]?.`, for ANY uid. The kernel owns the
 *   final sentence of every charter, so an authored one (an operator file, a
 *   world charter written by another node, a spawn's inline charter, a
 *   `update_self` charter read from the world) is stripped before the kernel
 *   stamps its own: a world charter cannot smuggle a second identity past it.
 * - **the own-sentence pattern** (`ownIdentitySentenceRe(uid)`) — this node's
 *   uid plus its optional composer suffix. `update_self` extracts the composer
 *   from the current sentence with it and re-stamps the same suffix, so
 *   kinship survives a rewrite and a restart.
 *
 * The no-match branch simply appends. Both patterns are anchored at the end
 * of the string and tolerate trailing whitespace: a world file normally ends
 * with a newline, and an end-anchored pattern would otherwise leave an
 * authored sentence in place and let the kernel's stack on top of it. The
 * sentence is the last thing a charter carries (its trailing blanks included).
 *
 * This module is a leaf of the node layer: it imports the journal's uid
 * grammar and nothing else, so the host, the runtime and the executor can
 * share one definition of the sentence.
 */

/**
 * The uid grammar as an inner-pattern fragment: `NODE_UID_RE.source` without
 * its anchors, so the sentence patterns below can never drift from the one
 * grammar the journal enforces.
 */
const UID_FRAGMENT = NODE_UID_RE.source.replace(/^\^/, '').replace(/\$$/, '');

/** Escapes the one uid this node inserts into its own-sentence pattern. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The authored-strip pattern: a trailing kernel identity sentence over the uid
 * grammar, for any uid. Never a hardcoded minted-uid form — a world charter
 * authored by a custom-uid node (`alice`) is stripped exactly like a minted
 * one's.
 */
export const AUTHORED_IDENTITY_RE =
  new RegExp(` You are ${UID_FRAGMENT}(?:, composed by ${UID_FRAGMENT})?\\.\\s*$`);

/**
 * The own-sentence pattern for one node: ` You are <uid>.` or
 * ` You are <uid>, composed by <composer>.`, anchored at the end of a charter
 * (trailing whitespace tolerated, like the authored-strip pattern). Group 1 is
 * the composer uid (`undefined` when the sentence has no composer suffix). The
 * uid is regex-escaped, so the grammar's metacharacters cannot widen the
 * pattern.
 */
export function ownIdentitySentenceRe(uid: string): RegExp {
  return new RegExp(
    ` You are ${escapeRegExp(uid)}(?:, composed by (${UID_FRAGMENT}))?\\.\\s*$`,
  );
}

/**
 * The kernel's final sentence: boot stamps ` You are <uid>.`; a composed node
 * stamps ` You are <uid>, composed by <requester>.` — on a derived charter AND
 * on a requested one.
 */
export function identitySentence(uid: string, composerUid?: string): string {
  return composerUid === undefined
    ? ` You are ${uid}.`
    : ` You are ${uid}, composed by ${composerUid}.`;
}

/** Strips any authored trailing identity sentence (any uid); no match is a no-op. */
export function stripAuthoredIdentity(charter: string): string {
  return charter.replace(AUTHORED_IDENTITY_RE, '');
}

/**
 * The composer uid named by this node's own trailing sentence, or null when the
 * sentence is absent or carries no composer suffix (a booted node's own
 * sentence). A rewrite preserves exactly this value.
 */
export function composerOf(charter: string, uid: string): string | null {
  const match = ownIdentitySentenceRe(uid).exec(charter);
  if (match === null) return null;
  return match[1] ?? null;
}
