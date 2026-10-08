// A test-owned journal owner: a real child process that acquires the journal
// through the same flock-guarded helper the writer uses, then stays alive so
// its recorded pid can be observed as a live owner (and reclaimed once killed).
//
// argv: <dir> <mode>   mode = hold | contend
//   hold    — acquire immediately, report `{owned, code}`, stay alive.
//   contend — wait for the 'go' message, then acquire and report; stay alive
//             only while owned, so a loser exits.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [dir, mode = 'hold'] = process.argv.slice(2);
const helper = fileURLToPath(new URL('../../lock-guard.mjs', import.meta.url));
const sidecar = join(dir, 'journal.v0.lock');
const token = randomBytes(16).toString('hex');

function selfStart() {
  const stat = readFileSync('/proc/self/stat', 'utf8');
  return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]);
}

function acquire() {
  return spawnSync('/usr/bin/flock', [
    '--wait=5', '--exclusive', sidecar,
    process.execPath, helper, 'acquire', dir, String(process.pid), String(selfStart()), token,
  ]).status;
}

function run() {
  const code = acquire();
  if (process.send) process.send({ owned: code === 0, code });
  if (code !== 0) process.exit(0);
}

if (mode === 'hold') {
  run();
} else {
  process.on('message', (message) => {
    if (message === 'go') run();
    if (message === 'exit') process.exit(0);
  });
  if (process.send) process.send({ ready: true });
}

// Keep the process (and therefore its live-owner record) alive.
setInterval(() => {}, 1000);
