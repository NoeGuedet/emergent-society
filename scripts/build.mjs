// Compiles the kernel into dist/, copies the runtime assets tsc does not emit,
// and verifies the layout plus the native launcher. No npm dependency: tsc is
// the one in node_modules and the launcher is compiled locally.
//
// Importing this module performs no work; only direct invocation builds.
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildNative, needsBuild } from './build-native.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = join(root, 'dist');
const scriptPath = fileURLToPath(import.meta.url);
const launcherRel = join('native', 'es-landlock', 'es-landlock');
const required = ['journal/lock.js', 'journal/lock-guard.mjs', 'node/tools/sandbox.js'];

const toPosix = (path) => path.split(sep).join('/');

async function statFile(file) {
  try {
    const info = await stat(file);
    return info.isFile() ? info : null;
  } catch {
    return null;
  }
}

async function isExecutableFile(file) {
  const info = await statFile(file);
  return info !== null && (info.mode & 0o111) !== 0;
}

async function walk(dir, prefix = '') {
  const entries = await readdir(dir, { withFileTypes: true });
  const found = [];
  for (const entry of entries) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    found.push({ rel, entry });
    if (entry.isDirectory()) found.push(...(await walk(join(dir, entry.name), rel)));
  }
  return found;
}

export async function copyRuntimeAssets(root, out = join(root, 'dist')) {
  const destination = join(out, 'journal', 'lock-guard.mjs');
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(join(root, 'src', 'journal', 'lock-guard.mjs'), destination);
}

export async function ensureNative(root) {
  if (process.env.ES_SKIP_NATIVE_BUILD !== '1' && needsBuild()) {
    if (buildNative() !== 'ok') {
      throw new Error(
        'es-landlock could not be built; install a C compiler and re-run `npm run build:native`',
      );
    }
  }
  if (!(await isExecutableFile(join(root, launcherRel)))) {
    throw new Error(`missing ${toPosix(launcherRel)} (run \`npm run build:native\`)`);
  }
}

export async function verifyDist(out = dist) {
  const label = (rel) => `${basename(out)}/${toPosix(rel)}`;

  for (const rel of required) {
    if ((await statFile(join(out, ...rel.split('/')))) === null) {
      throw new Error(`missing ${label(rel)}`);
    }
  }

  for (const { rel, entry } of await walk(out)) {
    if (rel === 'src' || rel === 'native') throw new Error(`${label(rel)} must not exist`);
    if (rel.split('/').includes('__tests__')) throw new Error(`${label(rel)} must not exist`);
    if (entry.isFile() && entry.name.endsWith('.test.js')) {
      throw new Error(`${label(rel)} must not be emitted`);
    }
  }

  const launcher = join(
    dirname(join(out, 'node', 'tools', 'sandbox.js')),
    '..',
    '..',
    '..',
    launcherRel,
  );
  if (!(await isExecutableFile(launcher))) throw new Error(`missing ${toPosix(launcherRel)}`);
}

export async function build() {
  await rm(dist, { recursive: true, force: true });
  await ensureNative(root);

  const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
  const result = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.build.json'], {
    cwd: root,
    stdio: 'inherit',
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(
      `typescript failed: ${result.error?.message ?? `exit ${result.status}`}; the output above is authoritative`,
    );
  }

  await copyRuntimeAssets(root);
  await verifyDist(dist);
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(scriptPath);

if (invokedDirectly) {
  build()
    .then(() => {
      console.log('built dist/');
    })
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
