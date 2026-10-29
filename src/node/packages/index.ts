/**
 * The package layer's public surface (kernel.md, the local-log sections):
 * the frozen constants, the typed errors, and the definition store. The
 * facade protocol, registry and Run supervisor join this barrel in later
 * lots; internals stay unexported and tests import module paths directly.
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
