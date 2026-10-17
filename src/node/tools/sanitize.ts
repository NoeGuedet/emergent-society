/**
 * PTY output sanitization for the model-facing render (C1.4b).
 *
 * A session's output is a tty stream: programs emit ANSI escapes (they see a
 * terminal, unlike the old pipe shell), CRLF endings and carriage-return
 * redraws. The render strips them; the raw artifact keeps the verbatim bytes.
 * Order is load-bearing: escapes, then newline normalization, then per-line
 * carriage returns, then residual control bytes. No replacement can split a
 * surrogate pair. This is display hygiene, never a security boundary.
 */
export function sanitizePtyText(text: string): string {
  return text
    // OSC: ESC ] ... terminated by BEL or ST (ESC \).
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
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
    // Residual C0 controls and DEL, tab and newline excepted.
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}
