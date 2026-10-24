import { KernelError } from '../errors.js';

/**
 * The host's typed refusals, rooted at the one kernel error.
 *
 * The host is a foreground composition root rather than a kernel layer: it owns
 * no event vocabulary and no format, so these classes exist only so the CLI can
 * map a refusal onto an exit code and one `host/error` line without matching
 * message text. `HostConfigError` names an unusable cell home, credential store
 * or journal; `HostAlreadyRunningError` a live (or unverifiable) owner record
 * that blocks a second host against the same home; `HostPauseError` a `kill`
 * that failed for a reason other than the target already being gone; and
 * `UsageError` a malformed command line. `UsageError` is thrown by option
 * parsing only, never by the host itself, so it never reaches `host/error`.
 * `name` is assigned once, by `KernelError`, from `new.target`.
 */
export class HostConfigError extends KernelError {}
export class HostAlreadyRunningError extends KernelError {}
export class HostPauseError extends KernelError {}
export class UsageError extends KernelError {}
