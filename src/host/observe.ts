/**
 * The host's operator diagnostics: one bounded JSON object per line.
 *
 * This is a diagnostic channel, never a second truth and never a payload
 * channel: the plan fixes its shape so an operator can read a cell's progress
 * from stderr without the host ever printing model text, tool output, request
 * or response bodies, headers, or a credential. A caller chooses the fields;
 * this module enforces the bounds — 11 fields, 200 code points per string, the
 * JSONL-safe value types only — so no call site can widen them by accident.
 *
 * `emit` owns the line terminator: it serializes once as
 * `JSON.stringify(payload) + '\n'`, so the default sink (stderr) writes a
 * complete line and a caller-supplied sink receives exactly one terminated
 * line. A field named `event` cannot override the event name: the name is
 * merged last. A write failure and a non-serializable payload are swallowed —
 * diagnostics are never the failure they describe — and an invalid event name
 * is replaced by `host/log-error` rather than thrown.
 *
 * Strings are truncated to 200 code points first and then stripped of C0/C1
 * controls and the two line separators, so a host-authored path or message can
 * neither forge a second line nor smuggle a control character into a log
 * consumer.
 */

/** The value types a diagnostic field may carry. */
export type LogValue = string | number | boolean | null;

/** One diagnostic's fields; `event` is added by `emit`, never supplied. */
export type LogFields = Readonly<Record<string, LogValue>>;

export interface HostLog {
  emit(event: string, fields?: LogFields): void;
}

/** The event-name grammar: lowercase, one slash/dash-separated namespace. */
const EVENT_NAME_RE = /^[a-z][a-z0-9/-]{0,63}$/;
/** The field cap, excluding `event`. */
const MAX_FIELDS = 11;
/** The per-string cap, in code points, not UTF-16 units. */
const MAX_STRING_CODE_POINTS = 200;
/** C0 and C1 controls plus the Unicode line/paragraph separators. */
const CONTROL_RE = /[\u0000-\u001f\u007f\u2028\u2029]/g;
/** The replacement event for a name outside `EVENT_NAME_RE`. */
const LOG_ERROR_EVENT = 'host/log-error';

function boundedValue(value: LogValue): LogValue {
  if (typeof value !== 'string') return value;
  return Array.from(value).slice(0, MAX_STRING_CODE_POINTS).join('').replace(CONTROL_RE, '');
}

function isLogValue(value: unknown): value is LogValue {
  return typeof value === 'string' || typeof value === 'number'
    || typeof value === 'boolean' || value === null;
}

/**
 * Builds a log writing complete JSONL lines to `write` (stderr by default).
 *
 * The sink is called once per `emit`, with exactly one line: a throwing sink is
 * swallowed, so emitting a diagnostic can never fail the operation it reports.
 */
export function createHostLog(
  write: (line: string) => void = (line) => { process.stderr.write(line); },
): HostLog {
  return {
    emit(event: string, fields?: LogFields): void {
      const valid = typeof event === 'string' && EVENT_NAME_RE.test(event);
      const name = valid ? event : LOG_ERROR_EVENT;
      const kept: Record<string, LogValue> = {};
      if (fields !== undefined) {
        for (const key of Object.keys(fields).slice(0, MAX_FIELDS)) {
          const value = fields[key];
          if (isLogValue(value)) kept[key] = boundedValue(value);
        }
      }
      if (!valid) kept['error'] = 'invalid-event';
      // `event` is merged last: a caller field of that name is overwritten,
      // never able to rename the line it appears on.
      const line = `${JSON.stringify({ ...kept, event: name })}\n`;
      try {
        write(line);
      } catch {
        // A diagnostic is not the failure it describes.
      }
    },
  };
}
