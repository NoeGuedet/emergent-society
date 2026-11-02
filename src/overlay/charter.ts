import { Buffer } from 'node:buffer';
import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';
import {
  atomicWriteFile, isErrno, syncPath,
} from '../journal/index.js';
import { MAX_CAPTURE_BYTES } from '../node/gate.js';
import { HostConfigError } from '../host/errors.js';

/**
 * The gateway overlay's config home.
 *
 * `<home>/gateway.charter.md` is the overlay's charter (its role, the RAG
 * duties, the data-is-not-instructions clause) and `<home>/gateway.json` is its
 * model; both are kernel-written 0600 sidecars written atomically
 * (`atomicWriteFile`: a 0600 temp, fsync, rename, then the home entry synced —
 * the owner-record precedent), and the pair is what a resume reads back. The
 * charter is a separate Markdown file so the operator can read exactly what
 * governs the overlay, and the model is JSON beside it because a charter is
 * prose, not a config record.
 *
 * A start supplies the pair once (`--gateway-charter <abs-path>`, with
 * `--gateway-model <id>` defaulting to the manifest's first catalog entry) and
 * persists it; a resume takes the persisted pair — a flag on a resume is
 * refused by the parser, the journaled-configs-win analog. A corrupt or
 * partial pair is a bounded host refusal on a gateway-bearing resume and an
 * `unknown`-model fact in `status`, never a silently reset config.
 */

/** The overlay charter's sidecar file name inside the cell home. */
export const GATEWAY_CHARTER_FILE = 'gateway.charter.md';

/** The overlay model's sidecar file name inside the cell home. */
export const GATEWAY_CONFIG_FILE = 'gateway.json';

/** The config sidecar's format version. */
const GATEWAY_CONFIG_VERSION = 0;

/** The config sidecar's read bound: a model id, not a payload. */
const MAX_GATEWAY_CONFIG_BYTES = 4 * 1024;

/** The overlay's persisted configuration: the charter text and the model id. */
export type OverlayConfig = {
  readonly model: string;
  readonly charter: string;
};

/**
 * What the home's overlay sidecars hold. `absent` means neither exists (a home
 * that was never configured for the overlay); `present` is the readable pair;
 * `damaged` is any partial or unreadable state — a refusal for the host and an
 * `unknown` model for `status`.
 */
export type OverlaySidecars =
  | { readonly kind: 'absent' }
  | { readonly kind: 'present'; readonly config: OverlayConfig }
  | { readonly kind: 'damaged'; readonly reason: string };

/** The overlay charter's path in a cell home. */
export function gatewayCharterPath(home: string): string {
  return join(home, GATEWAY_CHARTER_FILE);
}

/** The overlay config's path in a cell home. */
export function gatewayConfigPath(home: string): string {
  return join(home, GATEWAY_CONFIG_FILE);
}

/**
 * Persists the operator's overlay configuration: the charter text and the model
 * id, each atomically, then the home entry made durable so a resume after a
 * crash finds the pair. A failed write is a bounded configuration refusal — the
 * operator asked for an overlay this home cannot remember.
 *
 * The pair is two separate atomic writes, so a crash BETWEEN them leaves a
 * mismatched-but-present pair (a new charter with the previous model, or the
 * reverse): each file is individually whole, the pair is not a transaction.
 * The read classifies such a pair as present and a resume uses it as it
 * stands; the residual is bounded to that one crash window, and the write
 * order is deliberate (the charter first: the role is what the operator
 * rewrites, the model a default).
 */
export async function persistOverlayConfig(home: string, config: OverlayConfig): Promise<void> {
  if (config.model.trim() === '') {
    throw new HostConfigError('the gateway model cannot be blank');
  }
  if (config.charter.trim() === '') {
    throw new HostConfigError('the gateway charter cannot be empty');
  }
  try {
    await atomicWriteFile(gatewayCharterPath(home), config.charter);
    await atomicWriteFile(gatewayConfigPath(home), JSON.stringify({
      v: GATEWAY_CONFIG_VERSION, model: config.model,
    }));
    await syncPath(home);
  } catch (err) {
    throw new HostConfigError(
      'the gateway configuration could not be persisted',
      { cause: err },
    );
  }
}

/**
 * Reads the home's overlay sidecars, tolerantly and totally. Nothing here
 * throws except a raw filesystem fault on the probes: a missing file, an
 * invalid encoding, an oversized value, a malformed record and a partial pair
 * all classify, so `status` can report a damaged home without failing.
 */
export async function readOverlaySidecars(home: string): Promise<OverlaySidecars> {
  const charterPath = gatewayCharterPath(home);
  const configPath = gatewayConfigPath(home);
  const charterExists = await pathIsRegularOrAbsent(charterPath);
  const configExists = await pathIsRegularOrAbsent(configPath);
  if (charterExists === false && configExists === false) return { kind: 'absent' };
  if (charterExists !== true) {
    return { kind: 'damaged', reason: charterExists === null
      ? 'the gateway charter sidecar is not a regular file'
      : 'the gateway charter sidecar is missing' };
  }
  if (configExists !== true) {
    return { kind: 'damaged', reason: configExists === null
      ? 'the gateway config sidecar is not a regular file'
      : 'the gateway config sidecar is missing' };
  }
  let charter: string;
  try {
    charter = await readBoundedUtf8(charterPath, MAX_CAPTURE_BYTES);
  } catch {
    return { kind: 'damaged', reason: 'the gateway charter sidecar is unreadable' };
  }
  if (charter.trim() === '') {
    return { kind: 'damaged', reason: 'the gateway charter sidecar is empty' };
  }
  let raw: string;
  try {
    raw = await readBoundedUtf8(configPath, MAX_GATEWAY_CONFIG_BYTES);
  } catch {
    return { kind: 'damaged', reason: 'the gateway config sidecar is unreadable' };
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { kind: 'damaged', reason: 'the gateway config sidecar is not JSON' };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { kind: 'damaged', reason: 'the gateway config sidecar is not an object' };
  }
  const record = value as Record<string, unknown>;
  if (record['v'] !== GATEWAY_CONFIG_VERSION) {
    return { kind: 'damaged', reason: 'the gateway config sidecar has an unknown version' };
  }
  const model = record['model'];
  if (typeof model !== 'string' || model.trim() === '') {
    return { kind: 'damaged', reason: 'the gateway config sidecar names no model' };
  }
  return { kind: 'present', config: { model, charter } };
}

/**
 * The strict read a gateway-bearing resume gates on: `absent` is a nodes-only
 * host (the overlay was never configured — not a refusal), `damaged` is the
 * bounded host refusal. The model is NOT re-validated against the manifest: the
 * persisted config won, and a model the store no longer serves may legally
 * predate the declaration (the journaled-configs-win rule the node resume
 * follows; its first exchange then fails as an ordinary frontier fact).
 */
export async function resolvePersistedOverlay(home: string): Promise<OverlayConfig | null> {
  const sidecars = await readOverlaySidecars(home);
  switch (sidecars.kind) {
    case 'absent':
      return null;
    case 'present':
      return sidecars.config;
    case 'damaged':
      throw new HostConfigError(
        `the gateway configuration is unreadable: ${sidecars.reason}; a configured`
        + ' overlay needs both <home>/gateway.charter.md and <home>/gateway.json',
      );
  }
}

/**
 * True/false for a regular file's presence; null for any other entry kind. The
 * probe is `lstat`: a symlink to the credential store is refused as observed,
 * never followed — its bytes would otherwise ride an assembled request into
 * the frontier.
 */
async function pathIsRegularOrAbsent(path: string): Promise<boolean | null> {
  try {
    const info = await lstat(path);
    return info.isFile() ? true : null;
  } catch (err) {
    if (isErrno(err, 'ENOENT') || isErrno(err, 'ENOTDIR')) return false;
    throw err;
  }
}

/**
 * Reads at most `maxBytes` of a regular UTF-8 file; an oversize, non-regular or
 * non-UTF-8 file throws. The read stops at `maxBytes` and refuses rather than
 * buffering a larger value.
 */
async function readBoundedUtf8(path: string, maxBytes: number): Promise<string> {
  const info = await lstat(path);
  if (!info.isFile()) throw new Error('not a regular file');
  if (info.size > maxBytes) throw new Error('oversize');
  const buffer = Buffer.alloc(maxBytes + 1);
  const handle = await open(path, 'r');
  try {
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const { bytesRead: chunk } = await handle.read(
        buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (chunk === 0) break;
      bytesRead += chunk;
    }
    if (bytesRead > maxBytes) throw new Error('oversize');
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}
