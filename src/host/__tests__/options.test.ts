import { expect, it } from 'vitest';
import { UsageError } from '../errors.js';
import { parseHostCommand, USAGE } from '../options.js';

/**
 * argv parsing for the four first-light commands.
 *
 * The subcommand token is sliced off before `parseArgs` runs, so every case
 * here is a statement about one command's own option table: what it fills in,
 * what it refuses, and that a refusal is always a `UsageError` (exit 2) rather
 * than a `TypeError` leaking out of `node:util`.
 */

it('parses start with defaults', () => {
  expect(parseHostCommand(['start', '--home', '/x', '--model', 'm', '--heading', 'h'])).toEqual({
    command: 'start', home: '/x', uid: 'node-0', model: 'm', heading: 'h', noSandbox: false,
  });
});

it('parses init/resume/pause', () => {
  expect(parseHostCommand(['init', '--home', '/x'])).toEqual({ command: 'init', home: '/x' });
  expect(parseHostCommand(['resume', '--home', '/x'])).toEqual({
    command: 'resume', home: '/x', uid: 'node-0', noSandbox: false,
  });
  expect(parseHostCommand(['pause', '--home', '/x'])).toEqual({ command: 'pause', home: '/x' });
});

it('slices the subcommand before parseArgs and resolves help first', () => {
  expect(parseHostCommand([])).toEqual({ command: 'help' });
  expect(parseHostCommand(['--help'])).toEqual({ command: 'help' });
  expect(parseHostCommand(['-h'])).toEqual({ command: 'help' });
});

it('rejects a relative home, a missing flag, an unknown flag and an invalid uid as UsageError', () => {
  for (const argv of [
    ['start', '--home', 'x', '--model', 'm', '--heading', 'h'],
    ['start', '--home', '/x', '--heading', 'h'],
    ['start', '--home', '/x', '--model', 'm'],
    ['pause', '--home', '/x', '--uid', 'node-0'],
    ['start', '--home', '/x', '--model', 'm', '--heading', 'h', '--bogus'],
    ['start', '--home', '/x', '--uid', '../x', '--model', 'm', '--heading', 'h'],
    ['resume', '--home', '/x', '--model', 'm'],
    ['init', '--home', '/x', '--uid', 'node-0'],
  ]) {
    expect(() => parseHostCommand(argv)).toThrow(UsageError);
  }
});

it('parses status with --json and refuses the flags it does not own', () => {
  expect(parseHostCommand(['status', '--home', '/x', '--json'])).toEqual({
    command: 'status', home: '/x', json: true,
  });
  for (const argv of [
    ['status', '--home', '/x', '--uid', 'node-0'],
    ['status', '--home', '/x', '--model', 'm'],
  ]) {
    expect(() => parseHostCommand(argv)).toThrow(UsageError);
  }
});

it('USAGE lists the five commands, the exit codes and the seven disclosures', () => {
  for (const s of [
    'init', 'start', 'resume', 'pause', 'Exit codes: 0', 'interrupts in-flight',
    'partial world writes', 'fresh PTY', 'not re-executed', 'one turn',
    'released its cell', 'blocks a new host',
  ]) {
    expect(USAGE).toContain(s);
  }
  expect(USAGE).toContain('status --home');
  expect(USAGE).toContain('--json');
  expect(USAGE).not.toContain('SECRET');
});
