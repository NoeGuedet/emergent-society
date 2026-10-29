/**
 * The package layer's public surface (kernel.md, the local-log sections):
 * the frozen constants, the typed errors, the definition store and the Run
 * supervisor — the composition root (the host) imports through this barrel.
 * The protocol codec and the registry stay internal (their consumers are
 * in-package); tests import module paths directly.
 */

export {
  MAX_ERROR_DETAIL_BYTES,
  MAX_MANIFEST_BYTES,
  MAX_PACKAGE_NAME_CHARS,
  MAX_PACKAGE_PURPOSE_CHARS,
  MAX_PACKAGE_SOURCE_BYTES,
  MAX_PACKAGE_SOURCE_BYTES_PER_NODE,
} from './constants.js';
export { PackageError, type PackageErrorCode } from './errors.js';
export {
  createPackageStore,
  type CorruptDefinition,
  type PackageDefinition,
  type PackageStore,
  type PackageStoreDeps,
} from './store.js';
export {
  createRunSupervisor,
  type RunSupervisor,
  type RunSupervisorDeps,
  type RunSupervisorEvents,
} from './supervisor.js';
