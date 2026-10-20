// A stand-in guard used only by lock.test.ts. Run in place of the real helper
// (via the launcher seam) it simulates a critical section that outlives the
// caller's bounded wait: it lingers, then writes an owner record and exits, so
// the test can tell whether the caller actually killed the process (fixed
// `flock -F`) or left an orphan that can still write (forking flock).
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Invoked with the guard's own argv:
//   acquire <dir> <pid> <startedAt> <token> --lock <name> --owner <name>
const [, dir, , , , , , ownerFlag, ownerFile] = process.argv.slice(2);
const ownerPath = join(dir, ownerFlag === '--owner' ? ownerFile : '');

setTimeout(() => {
  try {
    writeFileSync(ownerPath, JSON.stringify({
      pid: process.pid, startedAt: null, token: 'f'.repeat(32),
    }));
  } catch { /* the test cleans up */ }
  process.exit(0);
}, 3000);
