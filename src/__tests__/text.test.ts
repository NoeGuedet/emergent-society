import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { decodeToolText, truncationNotice, utf8Prefix } from '../text.js';
import { boundToolText } from '../node/tools/text.js';

/**
 * Direct coverage for the shared UTF-8 boundary (test finding F3): the cut
 * never splits a code point, the invalid-byte policy is the deterministic
 * non-fatal one, and the notice never conflates the model cap with the capture.
 * Both notice forms are pinned: the local artifact form carries a digest, the
 * frontier form names the call and carries none, and neither claims a partial
 * capture is complete.
 */

const SHA = 'a'.repeat(64);

describe('utf8Prefix', () => {
  it('backs off a two-byte character that straddles the bound', () => {
    const prefix = utf8Prefix('a'.repeat(255) + 'é', 256);
    expect(prefix.text).toBe('a'.repeat(255));
    expect(prefix.bytes).toBe(255);
    expect(prefix.text).not.toContain('\uFFFD');
  });

  it('keeps a four-byte emoji only when it fits whole', () => {
    const straddle = utf8Prefix('a'.repeat(255) + '😀' + 'b', 256);
    expect(straddle.text).toBe('a'.repeat(255));
    expect(straddle.bytes).toBe(255);

    const fits = utf8Prefix('a'.repeat(252) + '😀', 256);
    expect(fits.text).toBe('a'.repeat(252) + '😀');
    expect(fits.bytes).toBe(256);
  });

  it('passes a string exactly at the bound through unchanged', () => {
    const text = 'a'.repeat(256);
    expect(utf8Prefix(text, 256)).toEqual({ text, bytes: 256 });
  });

  it('never splits the replacement of an unpaired surrogate', () => {
    // Buffer encodes a lone surrogate as the three-byte U+FFFD, so 255 ASCII
    // plus it exceeds a 256-byte cap; the cut must drop it whole.
    const prefix = utf8Prefix('a'.repeat(255) + '\ud800', 256);
    expect(prefix.text).toBe('a'.repeat(255));
    expect(prefix.bytes).toBe(255);
    expect(prefix.text).not.toContain('\ud800');
  });
});

describe('decodeToolText', () => {
  it('replaces invalid UTF-8 bytes non-fatally, deterministically', () => {
    expect(decodeToolText(Buffer.from([0x61, 0xff, 0x62]))).toBe('a\uFFFDb');
  });
});

describe('truncationNotice', () => {
  it('states the model cap separately from the artifact capture', () => {
    const bounded = boundToolText('a'.repeat(300), 256, {
      kind: 'artifact', sha256: SHA, bytes: 4096, complete: false,
    });
    expect(bounded.startsWith('a'.repeat(256) + '\n[output truncated:')).toBe(true);
    expect(bounded).toContain('model text capped at 256 bytes');
    expect(bounded).toContain('raw artifact: 4096 captured bytes, complete: no');
    expect(bounded).toContain(`raw sha256 ${SHA}`);
    // One line, and the model-byte count is not presented as the raw size.
    expect(bounded.split('\n')).toHaveLength(2);
  });

  it('renders the frontier form with the call id and no artifact digest', () => {
    const notice = truncationNotice('content', 512, {
      kind: 'frontier', call: 'call-7', bytes: 300, complete: false,
    });
    expect(notice).toBe(`\n[content truncated: model text capped at 512 bytes; `
      + `frontier call: call-7, 300 captured bytes, complete: no]`);
    expect(notice).not.toContain('raw artifact');
    expect(notice).not.toContain('sha256');
  });

  it('reports a complete capture as complete in both forms', () => {
    expect(truncationNotice('content', 512, {
      kind: 'artifact', sha256: SHA, bytes: 512, complete: true,
    })).toBe(`\n[content truncated: model text capped at 512 bytes; `
      + `raw artifact: 512 captured bytes, complete: yes; raw sha256 ${SHA}]`);
    expect(truncationNotice('content', 512, {
      kind: 'frontier', call: 'c1', bytes: 512, complete: true,
    })).toBe(`\n[content truncated: model text capped at 512 bytes; `
      + `frontier call: c1, 512 captured bytes, complete: yes]`);
  });
});
