import { Buffer } from 'node:buffer';

/**
 * The one UTF-8 boundary module. Three paths bound model-visible text by a byte
 * cap — tool results, assistant content and the git diff renderer — and a drift
 * between their cut rules would let one path split a character or miscount the
 * retained bytes, so the cut and the notice live here once.
 */

/**
 * The artifact-reference fields the notice reads. Structural by design: this
 * neutral boundary module must not depend on the context layer's contracts.
 */
type TruncationArtifact = {
  readonly sha256: string; readonly bytes: number; readonly complete: boolean;
};

/**
 * Non-fatal UTF-8 decoding: each invalid sequence becomes U+FFFD, the same
 * deterministic policy the tool and git renderers share. Never throws.
 */
export function decodeToolText(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes);
}

/**
 * The longest prefix of `text` whose UTF-8 encoding is at most `maxBytes`,
 * cut only at a code-point boundary. Continuation bytes (`10xxxxxx`) back the
 * cut up over the character they belong to, so a multibyte character — or the
 * U+FFFD replacement of an unpaired surrogate — is never split, and the cut
 * never introduces a replacement of its own. The returned `bytes` is the
 * prefix's encoded length, which is what callers account for.
 *
 * Precondition: `text` has no lone surrogate, so the encode/decode round trip is
 * lossless — callers feed TextDecoder output or `toJson`-validated content;
 * otherwise the decode would surface the surrogate as U+FFFD.
 */
export function utf8Prefix(text: string, maxBytes: number): { text: string; bytes: number } {
  const encoded = Buffer.from(text, 'utf8');
  if (encoded.length <= maxBytes) return { text, bytes: encoded.length };
  let end = maxBytes;
  while (end > 0 && (encoded[end]! & 0xc0) === 0x80) end -= 1;
  return { text: encoded.subarray(0, end).toString('utf8'), bytes: end };
}

/**
 * The model-facing truncation notice. It states the two bounds separately: the
 * model text was capped at `maxBytes` (the post-render, model-visible bound),
 * while the raw artifact has its own captured byte count and completeness. The
 * old "showing X of Y bytes" form conflated them and hid an incomplete capture;
 * every value here is kernel-controlled policy or manifest data, never
 * provider-controlled content, and it stays on one line.
 */
export function truncationNotice(
  kind: 'output' | 'content', maxBytes: number, raw: TruncationArtifact,
): string {
  return `\n[${kind} truncated: model text capped at ${maxBytes} bytes; `
    + `raw artifact: ${raw.bytes} captured bytes, complete: ${raw.complete ? 'yes' : 'no'}; `
    + `raw sha256 ${raw.sha256}]`;
}
