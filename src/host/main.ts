import { KernelError } from '../errors.js';
import { runCli } from './cli.js';

/**
 * The compiled entry point: `node dist/host/main.js <command> …`.
 *
 * This module is deliberately almost empty, because everything worth testing
 * lives behind `runCli`. It owns exactly two process facts: the exit code is
 * `runCli`'s resolution, and a failure that escaped the dispatcher still ends
 * the process as a `1` with a bounded label rather than an unhandled-rejection
 * stack. It never calls `process.exit`, so a live host's own shutdown (handlers,
 * logs, flushing) finishes before the process ends.
 *
 * The label is a kernel refusal's message or, for anything else, the error's
 * name: a message from an unexpected throw can carry a path or a payload, and
 * this is the one place with no journal and no bound to put it in.
 */
try {
  process.exitCode = await runCli(process.argv.slice(2));
} catch (err) {
  const label = err instanceof KernelError
    ? err.message
    : (err instanceof Error ? err.name : 'Error');
  process.stderr.write(`host: ${label}\n`);
  process.exitCode = 1;
}
