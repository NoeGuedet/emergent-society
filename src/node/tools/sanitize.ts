/**
 * PTY output sanitization for the model-facing render (C1.4b).
 *
 * A session's output is a tty stream: programs emit ANSI escapes (they see a
 * terminal, unlike the old pipe shell), CRLF endings and carriage-return
 * redraws. The render strips them — OSC, CSI, the DCS/APC/PM string sequences
 * (ESC-introduced, or C1-character-introduced when those bytes survived UTF-8
 * decoding), single-character escapes, and residual C0/C1 controls; the raw
 * artifact keeps the verbatim bytes. Display hygiene only: raw 8-bit C1 bytes
 * never reach this string as controls — node-pty/`decodeToolText` decode
 * non-fatally, so a bare 0x90 is already U+FFFD upstream. The C1 rule below
 * therefore covers only the UTF-8-encoded C1 characters (e.g. C2 90 → U+0090).
 * Order is load-bearing: escapes, then newline normalization, then per-line
 * carriage returns, then residual control bytes. No replacement can split a
 * surrogate pair. This is display hygiene, never a security boundary.
 */
export function sanitizePtyText(text: string): string {
  return text
    // OSC: ESC ] ... terminated by BEL or ST (ESC \ or the 8-bit C1 ST 0x9C).
    .replace(/\x1b\][^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c)/g, '')
    // DCS (ESC P), APC (ESC _) and PM (ESC ^): string sequences whose payload
    // runs to ST (ESC \ or 0x9C), defensively to BEL, or to the capture's end.
    // Their introducers are in the generic short-escape range, so the payload
    // must be consumed here or it would survive after the introducer is removed.
    .replace(/\x1b[P^_][\s\S]*?(?:\x1b\\|\x07|\x9c|$)/g, '')
    // C1 string-sequence introducers as characters. They arrive here only
    // through their UTF-8 encoding (C2 90/98/9D/9E/9F → U+0090/98/9D/9E/9F); a
    // raw 0x90 byte decodes non-fatally to U+FFFD upstream and never matches.
    // They carry the same payloads as the ESC forms: deleting the introducer
    // alone (as the residual-C1 rule below would) leaves that payload visible,
    // so consume it to ST/BEL exactly like the ESC forms.
    .replace(/[\x90\x98\x9d\x9e\x9f][\s\S]*?(?:\x1b\\|\x07|\x9c|$)/g, '')
    // CSI: ESC [ params intermediates final.
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    // Charset/designate: ESC ( X, ESC ) X, ESC # X. (Other short escapes: the generic rule below.)
    .replace(/\x1b[()#][0-9A-Za-z]/g, '')
    // A trailing partial CSI/OSC (a capture cut mid-sequence) drops its tail.
    // This rule must precede the generic short-escape rule below: ']' is in
    // that rule's [\-_] range, so an ESC ] cut mid-sequence would otherwise
    // lose only its introducer and leak the parameter text.
    .replace(/\x1b(?:\[[0-?]*[ -/]*|\][^\x07\x1b]*)$/, '')
    .replace(/\x1b[@-Z\\-_]/g, '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => {
      // A carriage return redraws the line: the last segment survives — except
      // a trailing CR, which redraws nothing and keeps what came before.
      const last = line.lastIndexOf('\r');
      if (last === -1) return line;
      if (last === line.length - 1) {
        const prev = line.lastIndexOf('\r', last - 1);
        return line.slice(prev + 1, last);
      }
      return line.slice(last + 1);
    })
    .join('\n')
    // Residual C0 controls, DEL and raw C1 controls, tab and newline excepted.
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\x80-\x9f]/g, '');
}
