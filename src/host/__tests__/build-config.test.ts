import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { copyRuntimeAssets, verifyDist } from '../../../scripts/build.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));

it('copies the guard and verifies the dist invariants behaviorally', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'es-build-'));
  const out = join(fixture, 'dist');
  try {
    await mkdir(join(fixture, 'src', 'journal'), { recursive: true });
    await writeFile(join(fixture, 'src', 'journal', 'lock-guard.mjs'), '// guard\n');
    await copyRuntimeAssets(fixture, out);
    expect(await readFile(join(out, 'journal', 'lock-guard.mjs'), 'utf8')).toBe('// guard\n');

    await mkdir(join(out, 'journal'), { recursive: true });
    await mkdir(join(out, 'node', 'tools'), { recursive: true });
    await mkdir(join(out, 'host'), { recursive: true });
    await writeFile(join(out, 'journal', 'lock.js'), '// lock\n');
    await writeFile(join(out, 'node', 'tools', 'sandbox.js'), '// sandbox\n');
    await writeFile(join(out, 'host', 'main.js'), '// main\n');
    const launcher = join(fixture, 'native', 'es-landlock', 'es-landlock');
    await mkdir(dirname(launcher), { recursive: true });
    await writeFile(launcher, '#!/bin/sh\n');
    await chmod(launcher, 0o755);
    await expect(verifyDist(out)).resolves.toBeUndefined();

    await rm(join(out, 'journal', 'lock-guard.mjs'));
    await expect(verifyDist(out)).rejects.toThrow(/lock-guard\.mjs/);
    await copyRuntimeAssets(fixture, out);
    await mkdir(join(out, 'native'), { recursive: true });
    await expect(verifyDist(out)).rejects.toThrow(/dist\/native/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

it('pins the build config, package scripts and ignore entry', async () => {
  const build = JSON.parse(await readFile(join(root, 'tsconfig.build.json'), 'utf8'));
  expect(build.compilerOptions).toMatchObject({ rootDir: 'src', outDir: 'dist', noEmit: false });
  expect(build.include).toEqual(['src']);
  expect(build.exclude).toContain('src/**/__tests__/**');
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  expect(pkg.scripts.build).toBe('node scripts/build.mjs');
  expect(await readFile(join(root, '.gitignore'), 'utf8')).toContain('/dist/');
});
