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
  if (!buildNative()) {
    throw new Error(
      'es-landlock launcher is missing or stale and could not be built. ' +
        'Install a C compiler (Debian/Ubuntu: sudo apt install build-essential) ' +
        'and run `npm run build:native` before running the suite.',
    );
  }
}
