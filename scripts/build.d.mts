// Declarations for the plain-JS build helpers, so the behavioral build test
// can import scripts/build.mjs under strict TypeScript.
export function build(): Promise<void>;
export function copyRuntimeAssets(root: string, out?: string): Promise<void>;
export function ensureNative(root: string): Promise<void>;
export function verifyDist(out?: string): Promise<void>;
