// vitest globalSetup: builds the vendored Landlock launcher once per run when
// the binary is absent or older than its source or the build script.
//
// ES_SKIP_NATIVE_BUILD=1 is the partial-run escape hatch (vitest has no
// --no-globalSetup flag): suites that genuinely need the binary skip when it is
// absent; the default-factory loop-driven suites legitimately fail closed.
import { buildNative, needsBuild } from './build-native.mjs';

export default async function setup() {
  if (process.env.ES_SKIP_NATIVE_BUILD === '1') return;
  if (!needsBuild()) return;

  const outcome = buildNative();
  if (outcome === 'ok') return;
  if (outcome === 'compiler') {
    throw new Error(
      'es-landlock launcher is missing or stale and no usable C compiler is available. ' +
        'Install one (Debian/Ubuntu: sudo apt install build-essential) ' +
        'and run `npm run build:native` before running the suite.',
    );
  }
  throw new Error(
    'es-landlock launcher is missing or stale and failed to compile. ' +
      'The compiler output above is authoritative; fix the build and run ' +
      '`npm run build:native` before running the suite.',
  );
}
