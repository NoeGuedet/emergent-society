import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { assertNodeUid } from '../journal/index.js';
import { HostConfigError } from './errors.js';

/**
 * `--nodes-file`: the operator's declaration of a multi-node boot.
 *
 * The file is a strict JSON array of node entries; each entry names a uid and,
 * on a start, its model and heading (and optionally an absolute charter file).
 * An entry may also declare `spawn: true` — the kernel's spawn capability is
 * declared, never implicit, and a solo flag boot grants nobody. A resume takes
 * the uids and the spawn grant only — the journaled config wins for everything
 * else, exactly as the single-node resume refuses `--model`/`--heading`.
 *
 * The file is read at the host gate, not by the CLI parser: a missing, foreign
 * or malformed file is a configuration refusal (exit `2`) that releases the
 * owner record like every other gate failure, and its content is never echoed.
 * Unknown keys are refused rather than ignored, so a typo cannot silently boot
 * a node with the wrong model; duplicate uids would give one home two nodes
 * fighting for the same local log, so they are refused too.
 */

/** The cap on one nodes file: a society, not a fork bomb. */
export const MAX_NODES = 16;

/** The file's own byte ceiling: a declaration, not a payload. */
const MAX_NODES_FILE_BYTES = 64 * 1024;

/** One node's boot input, already validated as JSON. */
export type NodeSpec = {
  readonly uid: string;
  readonly model?: string;
  readonly heading?: string;
  readonly charterFile?: string;
  /** The declared spawn capability: present and true, absent for nobody. */
  readonly spawn?: boolean;
};

const ENTRY_KEYS = new Set(['uid', 'model', 'heading', 'charterFile', 'spawn']);

/** Reads and validates one nodes file for `start` or `resume`. */
export async function readNodesFile(
  path: string, command: 'start' | 'resume',
): Promise<readonly NodeSpec[]> {
  const entry = await lstat(path).catch((err: unknown) => {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new HostConfigError(`nodes file does not exist: ${path}`);
    }
    throw err;
  });
  if (!entry.isFile()) {
    throw new HostConfigError(`nodes file must be a regular file: ${path}`);
  }
  if (entry.size > MAX_NODES_FILE_BYTES) {
    throw new HostConfigError(`nodes file is larger than ${MAX_NODES_FILE_BYTES} bytes`);
  }
  const raw = await readFile(path, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new HostConfigError(`nodes file is not JSON: ${path}`, { cause: err });
  }
  if (!Array.isArray(parsed)) {
    throw new HostConfigError('nodes file must be a JSON array of node entries');
  }
  if (parsed.length === 0) {
    throw new HostConfigError('nodes file must declare at least one node');
  }
  if (parsed.length > MAX_NODES) {
    throw new HostConfigError(`nodes file declares more than ${MAX_NODES} nodes`);
  }
  const seen = new Set<string>();
  const specs: NodeSpec[] = [];
  for (const [index, value] of parsed.entries()) {
    specs.push(parseEntry(value, index, command, seen));
  }
  return specs;
}

function parseEntry(
  value: unknown, index: number, command: 'start' | 'resume', seen: Set<string>,
): NodeSpec {
  const at = `nodes file entry ${index + 1}`;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HostConfigError(`${at} must be an object`);
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!ENTRY_KEYS.has(key)) throw new HostConfigError(`${at} has an unknown key: ${key}`);
  }
  const rawUid = record['uid'];
  if (typeof rawUid !== 'string' || rawUid === '') {
    throw new HostConfigError(`${at} requires a uid`);
  }
  let uid: string;
  try {
    uid = assertNodeUid(rawUid);
  } catch {
    throw new HostConfigError(`${at} has an unsafe uid: ${rawUid}`);
  }
  if (seen.has(uid)) throw new HostConfigError(`nodes file repeats the uid ${uid}`);
  seen.add(uid);

  const model = record['model'];
  const heading = record['heading'];
  const charterFile = record['charterFile'];
  const spawn = record['spawn'];
  if (spawn !== undefined && typeof spawn !== 'boolean') {
    throw new HostConfigError(`${at} has a spawn that is not a boolean`);
  }
  if (command === 'resume') {
    if (model !== undefined || heading !== undefined || charterFile !== undefined) {
      throw new HostConfigError(
        `${at} may declare only a uid and a spawn grant on resume; the journaled config wins`,
      );
    }
    return { uid, ...(spawn !== undefined ? { spawn } : {}) };
  }
  if (typeof model !== 'string' || model === '') {
    throw new HostConfigError(`${at} requires a model`);
  }
  if (typeof heading !== 'string' || heading === '') {
    throw new HostConfigError(`${at} requires a heading`);
  }
  if (charterFile !== undefined) {
    if (typeof charterFile !== 'string' || charterFile === '' || !isAbsolute(charterFile)) {
      throw new HostConfigError(`${at} has a charterFile that is not an absolute path`);
    }
  }
  return {
    uid, model, heading,
    ...(charterFile !== undefined ? { charterFile } : {}),
    ...(spawn !== undefined ? { spawn } : {}),
  };
}
