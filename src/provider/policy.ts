import type { ProviderPolicy } from './adapter.js';

/**
 * The production timing port for `ProviderAdapter` (kernel.md §4): real timers,
 * with a retry delay that can be cancelled instead of slept through.
 *
 * This is the promotion of the test double that lived in
 * `src/node/__tests__/helpers.ts`; behaviour is unchanged, and the adapter tests
 * keep their own copy so no existing test file is touched.
 *
 * `delay` refuses a signal that is already aborted, and otherwise arms one timer
 * and one `abort` listener. The timer firing removes the listener before
 * resolving; an abort clears the timer before rejecting `Error('cancelled')`.
 * Both the resolve and the abort path therefore leave neither a pending timer
 * nor a listener on the caller's signal — a §4 contract note rather than a test,
 * because Node's `AbortSignal` exposes no listener count and spying on the
 * prototype would be a global mutation. `schedule` arms a one-shot timer and
 * returns a non-throwing clear, so the adapter's `finally` can always call it.
 */
export const systemProviderPolicy: ProviderPolicy = {
  delay: (ms, signal) => new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(new Error('cancelled')); return; }
    let timer: NodeJS.Timeout | undefined;
    const onAbort = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      reject(new Error('cancelled'));
    };
    timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  }),
  schedule: (ms, callback) => {
    const timer = setTimeout(callback, ms);
    return () => { clearTimeout(timer); };
  },
};
