import { Buffer } from 'node:buffer';
import type { ArtifactRef } from '../../context/contracts.js';

/**
 * Bounded, deterministically-decoded tool text shared by the shell and web
 * tools. The bound cuts at a code-point boundary; the truncation notice names
 * the retained raw artifact's own digest and byte count.
 */

export function decodeToolText(bytes: Uint8Array): string {
  // Non-fatal decoding replaces each invalid sequence with U+FFFD, the same
  // deterministic policy the Git renderer applies.
  return new TextDecoder('utf-8').decode(bytes);
}

/**
 * Cuts only at a code-point boundary, so a retained multibyte character is never
 * split and no U+FFFD is introduced by the model-text bound itself.
 */
function truncateUtf8(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString('utf8');
}

/**
 * Bounds the model-visible tool text to `maxBytes` UTF-8 bytes, measured after
 * deterministic decoding. The notice names the captured raw artifact's digest
 * and captured byte count — the retained prefix's own facts when capture was
 * incomplete, never the complete original's.
 */
export function boundToolText(text: string, maxBytes: number, raw: ArtifactRef): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  const retained = truncateUtf8(text, maxBytes);
  const retainedBytes = Buffer.byteLength(retained, 'utf8');
  return retained + `\n[output truncated: showing ${retainedBytes} of ${raw.bytes} bytes; `
    + `raw sha256 ${raw.sha256}]`;
}
