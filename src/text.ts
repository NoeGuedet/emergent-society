import { Buffer } from 'node:buffer';

/**
 * The one UTF-8 boundary module. Three paths bound model-visible text by a byte
 * cap — tool results, assistant content and the git diff renderer — and a drift
 * between their cut rules would let one path split a character or miscount the
 * retained bytes, so the cut and the notice live here once. The single-line
 * operator/model value — a refusal detail, a sidecar reason, a status line —
 * has the same one-home rule: its strip class and cap are here, not copied into
 * the three renderers.
 */

/**
 * The capture a truncation notice names. Structural by design: this neutral
 * boundary module must not depend on the context layer's contracts. The two
 * forms render different nouns and tails — a local artifact has a digest, a
 * frontier call has a call id and no artifact digest.
 */
export type TruncationCapture =
  | { readonly kind: 'artifact'; readonly sha256: string;
      readonly bytes: number; readonly complete: boolean }
  | { readonly kind: 'frontier'; readonly call: string;
      readonly bytes: number; readonly complete: boolean };

/**
 * Non-fatal UTF-8 decoding: each invalid sequence becomes U+FFFD, the same
 * deterministic policy the tool and git renderers share. Never throws.
 */
export function decodeToolText(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes);
}

/**
 * The one unsafe class for a single-line value that may reach a model, an
 * operator or a log: every Unicode control (`Cc`) and format (`Cf`) character —
 * C0/DEL, C1, zero-width joiners, bidi controls and isolates, the BOM, tags,
 * interlinear annotation — plus the line/paragraph separators and the variation
 * selectors, which are not `Cf` but can still hide or spoof the text. Any of
 * them can forge a second line or reorder what is displayed; none is content a
 * refusal detail, a sidecar reason or a status line needs.
 */
const SINGLE_LINE_STRIP = /[\p{Cc}\p{Cf}\u2028\u2029\uFE00-\uFE0F\u{E0100}-\u{E01EF}]+/gu;

/**
 * One bounded single-line value: the unsafe class becomes a space, runs of
 * whitespace collapse, and at most `maxCodePoints` code points survive. The
 * cap is applied while walking the string, so a megabyte-scale hostile input
 * allocates only the retained prefix rather than an array of every code point.
 *
 * Precondition: `text` has no lone surrogate (its sources are decoded bytes,
 * validated payloads or enum labels), so the code-point walk is lossless.
 */
export function singleLine(text: string, maxCodePoints: number): string {
  const cleaned = text.replace(SINGLE_LINE_STRIP, ' ');
  let bounded = '';
  let count = 0;
  for (const ch of cleaned) {
    if (count >= maxCodePoints) break;
    bounded += ch;
    count += 1;
  }
  return bounded.replace(/\s+/g, ' ').trim();
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
 * while the capture has its own captured byte count and completeness. The
 * old "showing X of Y bytes" form conflated them and hid an incomplete capture;
 * every value here is kernel-controlled policy or manifest data, never
 * provider-controlled content, and it stays on one line.
 *
 * The capture's form is part of the rendering: a local artifact names its
 * digest, a frontier call names the call and carries no artifact digest (a
 * fixed noun would otherwise claim one for a frontier capture). Neither form
 * claims a partial capture is complete. A caller may append one `action`
 * clause — a reachable next step for the tool that produced the truncation;
 * it must never promise the raw bytes are retrievable, because no tool
 * reads the kernel's blob store. The action is flattened to one line here,
 * so a caller cannot widen the notice by accident.
 */
export function truncationNotice(
  kind: 'output' | 'content', maxBytes: number, capture: TruncationCapture,
  action?: string,
): string {
  const captured = `${capture.bytes} captured bytes, complete: ${capture.complete ? 'yes' : 'no'}`;
  const tail = capture.kind === 'artifact'
    ? `raw artifact: ${captured}; raw sha256 ${capture.sha256}`
    : `frontier call: ${capture.call}, ${captured}`;
  const flat = action === undefined
    ? undefined : action.replace(/[\u000a\u000d\u2028\u2029]+/g, ' ');
  return `\n[${kind} truncated: model text capped at ${maxBytes} bytes; ${tail}`
    + (flat === undefined ? ']' : `; ${flat}]`);
}
