import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { decodeToolText, singleLine, truncationNotice, utf8Prefix } from '../text.js';
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

describe('singleLine', () => {
  it('strips control, bidi and zero-width characters and collapses whitespace', () => {
    const hostile = 'a\u0000b\u0085c\u202ed\u200be\ufefff\u001b[31m\n\tg';
    expect(singleLine(hostile, 100)).toBe('a b c d e f [31m g');
  });

  it('strips the whole Cc/Cf class, separators and variation selectors', () => {
    // U+061C (Arabic letter mark), U+206A (deprecated bidi), U+E0001 (tag),
    // U+FE0F (variation selector), U+2028 (line separator): all invisible or
    // reordering, all stripped; the visible letters survive as one line.
    const exotic = 'a\u061cb\u206ac\u{e0001}d\uFE0Fe\u2028f';
    const stripped = singleLine(exotic, 100);
    expect(stripped).toBe('a b c d e f');
    expect(stripped).not.toMatch(
      /[\p{Cc}\p{Cf}\u2028\u2029\uFE00-\uFE0F\u{E0100}-\u{E01EF}]/u,
    );
  });

  it('caps by code points without splitting a surrogate pair', () => {
    const value = `${'a'.repeat(299)}😀b`;
    const bounded = singleLine(value, 300);
    expect(Array.from(bounded)).toHaveLength(300);
    expect(bounded.endsWith('😀')).toBe(true);
  });

  it('returns an empty string for whitespace-only input', () => {
    expect(singleLine(' \n\t ', 10)).toBe('');
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

  it('appends the caller-supplied action after the artifact facts, one line', () => {
    const action = 'the raw bytes are unreachable — rerun the command writing the full output'
      + ' to a world file';
    const withAction = truncationNotice('output', 256, {
      kind: 'artifact', sha256: SHA, bytes: 4096, complete: false,
    }, action);
    expect(withAction).toBe(`\n[output truncated: model text capped at 256 bytes; `
      + `raw artifact: 4096 captured bytes, complete: no; raw sha256 ${SHA}; ${action}]`);
    // One line: no newline inside the notice beyond its own leading one.
    expect(withAction.indexOf('\n', 1)).toBe(-1);
    // No action: the notice keeps its exact prior shape.
    expect(truncationNotice('output', 256, {
      kind: 'artifact', sha256: SHA, bytes: 4096, complete: false,
    })).toBe(`\n[output truncated: model text capped at 256 bytes; `
      + `raw artifact: 4096 captured bytes, complete: no; raw sha256 ${SHA}]`);
    const viaBound = boundToolText('a'.repeat(300), 256, {
      kind: 'artifact', sha256: SHA, bytes: 4096, complete: false,
    }, action);
    expect(viaBound).toContain(action);
    // A caller cannot widen the notice: newlines in the action are flattened.
    const flat = truncationNotice('output', 256, {
      kind: 'artifact', sha256: SHA, bytes: 512, complete: true,
    }, 'line one\nline two');
    expect(flat).toContain('line one line two');
    expect(flat.indexOf('\n', 1)).toBe(-1);
  });
});
