import { constants } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';

/** Reads or creates the one host-private bearer; the path is the only public fact. */
export async function loadOrCreateBearer(path: string): Promise<string> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    let created;
    try {
      created = await open(path, 'wx', 0o600);
    } catch (createErr) {
      if ((createErr as NodeJS.ErrnoException).code === 'EEXIST') {
        return await loadOrCreateBearer(path);
      }
      throw createErr;
    }
    const token = randomBytes(32).toString('hex');
    try {
      await created.writeFile(`${token}\n`, 'utf8');
      await created.sync();
    } finally {
      await created.close();
    }
    return token;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || (info.mode & 0o777) !== 0o600
      || (process.getuid?.() !== undefined && info.uid !== process.getuid!())) {
      throw new Error('the cockpit bearer file must be a same-uid 0600 regular file');
    }
    const raw = (await handle.readFile('utf8')).trim();
    if (!/^[0-9a-f]{64}$/.test(raw)) {
      throw new Error('the cockpit bearer file is malformed');
    }
    return raw;
  } finally {
    await handle.close().catch(() => {});
  }
}

/** Constant-time bearer comparison; length itself reveals no token bytes. */
export function bearerMatches(expected: string, supplied: string): boolean {
  const left = Buffer.from(expected, 'utf8');
  const right = Buffer.from(supplied, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}
