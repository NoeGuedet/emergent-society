// Builds the vendored Landlock launcher with the host's C compiler.
// No npm dependency: the binary is compiled locally and git-ignored.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const scriptPath = fileURLToPath(import.meta.url);
const sourcePath = path.join(root, 'native', 'es-landlock', 'es-landlock.c');
const binaryPath = path.join(root, 'native', 'es-landlock', 'es-landlock');

const CC_HINT =
  'es-landlock needs a C compiler to build the native launcher.\n' +
  'Install one (Debian/Ubuntu: sudo apt install build-essential) and re-run\n' +
  '`npm run build:native` (or `npm ci && npm run build:native`).';

export function needsBuild() {
  if (!existsSync(binaryPath)) return true;
  const binaryTime = statSync(binaryPath).mtimeMs;
  return [sourcePath, scriptPath].some((file) => statSync(file).mtimeMs > binaryTime);
}

export function buildNative() {
  const cc = process.env.CC ?? 'cc';
  const version = spawnSync(cc, ['--version'], { stdio: 'ignore' });
  if (version.error || version.status !== 0) {
    console.error(`es-landlock: C compiler ${JSON.stringify(cc)} is not usable.`);
    console.error(CC_HINT);
    return 'compiler';
  }

  const result = spawnSync(
    cc,
    [
      '-O2',
      '-Wall',
      '-Wextra',
      '-Werror',
      '-std=c11',
      '-o',
      binaryPath,
      sourcePath,
    ],
    { cwd: root, stdio: 'inherit' },
  );
  if (result.error || result.status !== 0) {
    console.error(
      `es-landlock: compilation failed (${result.error?.message ?? `exit ${result.status}`}); the compiler output above is authoritative.`,
    );
    return 'compile';
  }

  // Normalize the launcher to 0755 regardless of the caller's umask: the
  // kernel-side launcher and the tests exec this path directly.
  chmodSync(binaryPath, 0o755);
  return 'ok';
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(scriptPath);

if (invokedDirectly) {
  if (buildNative() !== 'ok') process.exit(1);
  console.log(`es-landlock: built ${path.relative(root, binaryPath)}`);
}
