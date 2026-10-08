// A stand-in guard used only by lock.test.ts. Run in place of the real helper
// (via the launcher seam) it simulates a critical section that outlives the
// caller's bounded wait: it lingers, then writes an owner record and exits, so
// the test can tell whether the caller actually killed the process (fixed
// `flock -F`) or left an orphan that can still write (forking flock).
import { writeFileSync } from 'node:fs';

// Invoked with the guard's own argv (`acquire <dir> <pid> <startedAt> <token>`).
const dir = process.argv[3];

setTimeout(() => {
  try {
    writeFileSync(`${dir}/journal.v0.owner`, JSON.stringify({
      pid: process.pid, startedAt: null, token: 'f'.repeat(32),
    }));
  } catch { /* the test cleans up */ }
  process.exit(0);
}, 3000);
