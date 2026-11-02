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

it('parses start with --charter-file, and keeps it absent otherwise', () => {
  expect(parseHostCommand([
    'start', '--home', '/x', '--model', 'm', '--heading', 'h', '--charter-file', '/tmp/charter.txt',
  ])).toEqual({
    command: 'start', home: '/x', uid: 'node-0', model: 'm', heading: 'h', noSandbox: false,
    charterFile: '/tmp/charter.txt',
  });
  expect('charterFile' in parseHostCommand(
    ['start', '--home', '/x', '--model', 'm', '--heading', 'h'],
  )).toBe(false);
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
    ['start', '--home', '/x', '--uid', 'human', '--model', 'm', '--heading', 'h'],
    ['resume', '--home', '/x', '--model', 'm'],
    ['resume', '--home', '/x', '--charter-file', '/tmp/charter.txt'],
    ['start', '--home', '/x', '--model', 'm', '--heading', 'h', '--charter-file', 'rel.txt'],
    ['start', '--home', '/x', '--model', 'm', '--heading', 'h', '--charter-file'],
    ['start', '--home', '/x', '--model', 'm', '--heading', 'h', '--charter-file='],
    ['init', '--home', '/x', '--uid', 'node-0'],
  ]) {
    expect(() => parseHostCommand(argv)).toThrow(UsageError);
  }
  expect(() => parseHostCommand(['resume', '--home', '/x', '--charter-file', '/tmp/c.txt']))
    .toThrow(/charter-file/);
});

it('parses chat with the default tail and its session flags', () => {
  expect(parseHostCommand(['chat', '--home', '/x'])).toEqual({
    command: 'chat', home: '/x', tail: 20, conversation: false, json: false,
  });
  expect(parseHostCommand([
    'chat', '--home', '/x', '--tail', '5', '--conversation', '--json',
  ])).toEqual({
    command: 'chat', home: '/x', tail: 5, conversation: true, json: true,
  });
  expect(parseHostCommand(['chat', '--home', '/x', '--tail=3'])).toMatchObject({ tail: 3 });
  for (const argv of [
    ['chat', '--home', '/x', '--tail', '0'],
    ['chat', '--home', '/x', '--tail', 'abc'],
    ['chat', '--home', '/x', '--tail', '1.5'],
    ['chat', '--home', '/x', '--tail=-2'],
    ['chat', '--home', '/x', '--tail'],
    ['chat', '--home', '/x', '--uid', 'node-0'],
    ['chat', '--home', '/x', '--model', 'm'],
    ['chat', '--home', 'x'],
    ['chat', '--home'],
    ['chat', '--home', '/x', 'stray'],
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

it('parses --nodes-file and refuses the solo flags it replaces', () => {
  expect(parseHostCommand(['start', '--home', '/x', '--nodes-file', '/tmp/nodes.json'])).toEqual({
    command: 'start', home: '/x', uid: 'node-0', noSandbox: false,
    nodesFile: '/tmp/nodes.json',
  });
  expect(parseHostCommand(['resume', '--home', '/x', '--nodes-file', '/tmp/nodes.json'])).toEqual({
    command: 'resume', home: '/x', uid: 'node-0', noSandbox: false,
    nodesFile: '/tmp/nodes.json',
  });
  for (const argv of [
    ['start', '--home', '/x', '--nodes-file', '/tmp/n.json', '--uid', 'node-1'],
    ['start', '--home', '/x', '--nodes-file', '/tmp/n.json', '--model', 'm'],
    ['start', '--home', '/x', '--nodes-file', '/tmp/n.json', '--heading', 'h'],
    ['start', '--home', '/x', '--nodes-file', '/tmp/n.json', '--charter-file', '/tmp/c'],
    ['start', '--home', '/x', '--nodes-file', 'rel.json'],
    ['resume', '--home', '/x', '--nodes-file', '/tmp/n.json', '--uid', 'node-1'],
  ]) {
    expect(() => parseHostCommand(argv)).toThrow(UsageError);
  }
});

it('USAGE lists the six commands, the exit codes and the eight disclosures', () => {
  for (const s of [
    'init', 'start', 'resume', 'pause', 'status', 'chat', 'Exit codes: 0',
    'interrupts in-flight', 'partial world writes', 'fresh PTY', 'not re-executed',
    'one turn', 'released its cell', 'blocks a new host', '--charter-file',
    'no journaled', 'resume refuses it', 'config wins.', 'secret-bearing file',
  ]) {
    expect(USAGE).toContain(s);
  }
  expect(USAGE).toContain('[--charter-file <abs-path>]');
  expect(USAGE).toContain('status --home');
  expect(USAGE).toContain('--json');
  // The six-command contract: chat is the CLI's first interactive command, and
  // the help text states its prompt loop, its flags and its non-TTY behavior.
  expect(USAGE).toContain('chat   --home <abs-dir> [--tail N] [--conversation] [--json]');
  expect(USAGE).toContain('interactive human↔overlay session');
  expect(USAGE).toContain('non-TTY stdin');
  expect(USAGE).toContain('Ctrl-C aborts the wait');
  expect(USAGE).not.toContain('SECRET');
});
