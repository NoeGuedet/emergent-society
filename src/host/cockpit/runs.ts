import { constants } from 'node:fs';
import {
  lstat, mkdir, open, rm,
} from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { LlmModel } from '../../context/contracts.js';
import {
  lstatAt, mkdirAt, openLeafAt, openPinnedDirAt, openPinnedRoot, readdirFd, realpathFd,
} from '../../node/world-fs.js';
import { assertCredentialStore, loadProviderStore } from '../credentials.js';
import { readCharterFile } from '../charter-file.js';
import { initHome } from '../layout.js';

export type RunManifest = {
  readonly v: 0;
  readonly id: string;
  readonly label: string;
  readonly heading: string;
  readonly nodeModel: string;
  readonly gatewayModel: string;
  readonly nodeCount: number;
  readonly spawn: boolean;
  readonly createdAt: number;
};

export type RunPaths = {
  readonly home: string;
  readonly nodesFile: string;
  readonly charterFile: string;
};

export type CreateRunInput = {
  readonly label: string;
  readonly heading: string;
  readonly nodeModel: string;
  readonly gatewayModel: string;
  readonly nodeCount: number;
  readonly nodeLimit: number;
  readonly spawn: boolean;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_LABEL = 200;
const MAX_HEADING = 4096;
const MAX_MODEL = 256;

function assertText(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || value.trim() === '' || Buffer.byteLength(value, 'utf8') > max) {
    throw new Error(`${name} must be a non-empty string under ${max} bytes`);
  }
  return value;
}

function assertLimit(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error('nodeLimit must be a positive safe integer');
  }
  return value as number;
}

function parseManifest(raw: string, id: string): RunManifest {
  const value = JSON.parse(raw) as Partial<RunManifest>;
  if (value.v !== 0 || value.id !== id || !UUID_RE.test(value.id ?? '')
    || typeof value.label !== 'string' || value.label.trim() === ''
    || Buffer.byteLength(value.label, 'utf8') > MAX_LABEL
    || typeof value.heading !== 'string' || value.heading.trim() === ''
    || Buffer.byteLength(value.heading, 'utf8') > MAX_HEADING
    || typeof value.nodeModel !== 'string' || value.nodeModel === ''
    || Buffer.byteLength(value.nodeModel, 'utf8') > MAX_MODEL
    || typeof value.gatewayModel !== 'string' || value.gatewayModel === ''
    || Buffer.byteLength(value.gatewayModel, 'utf8') > MAX_MODEL
    || !Number.isSafeInteger(value.nodeCount) || value.nodeCount! < 1 || value.nodeCount! > 16
    || typeof value.spawn !== 'boolean' || !Number.isFinite(value.createdAt)) {
    throw new Error('run manifest is invalid');
  }
  return value as RunManifest;
}

async function privateFile(handle: FileHandle): Promise<void> {
  const info = await handle.stat();
  if (!info.isFile() || (info.mode & 0o777) !== 0o600
    || (process.getuid?.() !== undefined && info.uid !== process.getuid!())) {
    throw new Error('run file must be a same-uid 0600 regular file');
  }
}

async function privateDir(handle: FileHandle): Promise<void> {
  const info = await handle.stat();
  if (!info.isDirectory() || (info.mode & 0o777) !== 0o700
    || (process.getuid?.() !== undefined && info.uid !== process.getuid!())) {
    throw new Error('run directory must be a same-uid 0700 directory');
  }
}

async function readPrivateAt(parentFd: number, name: string): Promise<string> {
  const handle = await openLeafAt(parentFd, name, constants.O_RDONLY);
  try {
    await privateFile(handle);
    return await handle.readFile('utf8');
  } finally {
    await handle.close().catch(() => {});
  }
}

async function writePrivateAt(
  parentFd: number, name: string, data: string | Uint8Array,
): Promise<void> {
  const handle = await openLeafAt(
    parentFd, name,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_TRUNC,
  );
  try {
    await handle.chmod(0o600);
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close().catch(() => {});
  }
}

async function assertPrivateDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory() || (info.mode & 0o777) !== 0o700
    || (process.getuid?.() !== undefined && info.uid !== process.getuid!())) {
    throw new Error('runs root must be a same-uid 0700 directory');
  }
}

type PinnedRun = {
  readonly root: FileHandle;
  readonly run: FileHandle;
  readonly real: string;
};

export class RunsStore {
  private constructor(readonly root: string) {}

  static async open(root: string): Promise<RunsStore> {
    try {
      await assertPrivateDirectory(root);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        await mkdir(root, { recursive: true, mode: 0o700 });
        await assertPrivateDirectory(root);
      } else {
        throw err;
      }
    }
    return new RunsStore(await realpath(root));
  }

  private async pinnedRoot(): Promise<FileHandle> {
    return await openPinnedRoot(this.root, { resolved: true });
  }

  private async openRun(id: string): Promise<PinnedRun> {
    if (!UUID_RE.test(id)) throw new Error('invalid run id');
    const root = await this.pinnedRoot();
    try {
      const entry = await lstatAt(root.fd, id);
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw new Error('run id is not a pinned directory');
      }
      const run = await openPinnedDirAt(root.fd, id);
      await privateDir(run);
      return { root, run, real: await realpathFd(run) };
    } catch (err) {
      await root.close().catch(() => {});
      throw err;
    }
  }

  private async closeRun(pinned: PinnedRun): Promise<void> {
    await pinned.run.close().catch(() => {});
    await pinned.root.close().catch(() => {});
  }

  async catalog(providerHome: string): Promise<readonly LlmModel[] | undefined> {
    await assertCredentialStore(providerHome);
    const store = await loadProviderStore(providerHome);
    return store.llm?.models;
  }

  async create(input: CreateRunInput, providerHome: string, charterPath: string): Promise<RunManifest> {
    const id = randomUUID();
    const label = assertText(input.label, 'label', MAX_LABEL);
    const heading = assertText(input.heading, 'heading', MAX_HEADING);
    const nodeModel = assertText(input.nodeModel, 'nodeModel', MAX_MODEL);
    const gatewayModel = assertText(input.gatewayModel, 'gatewayModel', MAX_MODEL);
    const nodeCount = assertLimit(input.nodeCount);
    if (nodeCount > 16) throw new Error('nodeCount must be between 1 and 16');
    assertLimit(input.nodeLimit);
    if (typeof input.spawn !== 'boolean') throw new Error('spawn must be boolean');
    const root = await this.pinnedRoot();
    let run: FileHandle | null = null;
    try {
      await mkdirAt(root.fd, id, { mode: 0o700 });
      run = await openPinnedDirAt(root.fd, id);
      await privateDir(run);
      const real = await realpathFd(run);
      const home = join(real, 'home');
      await initHome(home);
      const homeHandle = await openPinnedDirAt(run.fd, 'home');
      let providerBytes: Buffer;
      const source = await open(join(providerHome, 'providers.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await source.stat();
        if (!info.isFile() || ![0o600, 0o400].includes(info.mode & 0o777)
          || (process.getuid?.() !== undefined && info.uid !== process.getuid!())) {
          throw new Error('the provider store must be a same-uid 0600/0400 regular file');
        }
        providerBytes = await source.readFile();
      } finally {
        await source.close().catch(() => {});
      }
      try {
        await writePrivateAt(homeHandle.fd, 'providers.json', providerBytes);
      } finally {
        await homeHandle.close().catch(() => {});
      }
      const charter = await readCharterFile(home, 'node-0', charterPath);
      await writePrivateAt(run.fd, 'gateway.charter.md', charter);
      const nodes = Array.from({ length: nodeCount }, (_, index) => ({
        uid: `node-${index}`,
        model: nodeModel,
        heading,
        spawn: input.spawn && index === 0,
      }));
      await writePrivateAt(run.fd, 'nodes.json', JSON.stringify(nodes));
      const manifest: RunManifest = {
        v: 0, id, label, heading, nodeModel, gatewayModel, nodeCount,
        spawn: input.spawn, createdAt: Date.now(),
      };
      await writePrivateAt(run.fd, 'run.json', JSON.stringify(manifest));
      return manifest;
    } catch (err) {
      await rm(join(this.root, id), { recursive: true, force: true }).catch(() => {});
      throw err;
    } finally {
      await run?.close().catch(() => {});
      await root.close().catch(() => {});
    }
  }

  async list(): Promise<readonly RunManifest[]> {
    const root = await this.pinnedRoot();
    let names: string[];
    try {
      names = (await readdirFd(root)).map((entry) => entry.name);
    } finally {
      await root.close().catch(() => {});
    }
    const out: RunManifest[] = [];
    for (const id of names.sort()) {
      if (!UUID_RE.test(id)) continue;
      try {
        out.push(await this.read(id));
      } catch {
        // A damaged or symlinked run is not selectable.
      }
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }

  async read(id: string): Promise<RunManifest> {
    const pinned = await this.openRun(id);
    try {
      return parseManifest(await readPrivateAt(pinned.run.fd, 'run.json'), id);
    } finally {
      await this.closeRun(pinned);
    }
  }

  async paths(id: string): Promise<RunPaths> {
    const pinned = await this.openRun(id);
    try {
      const homeEntry = await lstatAt(pinned.run.fd, 'home');
      if (homeEntry.isSymbolicLink() || !homeEntry.isDirectory()) {
        throw new Error('run home is not a pinned directory');
      }
      const home = await openPinnedDirAt(pinned.run.fd, 'home');
      try {
        await privateDir(home);
        const realHome = await realpathFd(home);
        return {
          home: realHome,
          nodesFile: join(pinned.real, 'nodes.json'),
          charterFile: join(pinned.real, 'gateway.charter.md'),
        };
      } finally {
        await home.close().catch(() => {});
      }
    } finally {
      await this.closeRun(pinned);
    }
  }

  async home(id: string): Promise<string> {
    return (await this.paths(id)).home;
  }

  async nodesFile(id: string): Promise<string> {
    return (await this.paths(id)).nodesFile;
  }

  async charterFile(id: string): Promise<string> {
    return (await this.paths(id)).charterFile;
  }
}
