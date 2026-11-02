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

it('USAGE lists the seven commands, the exit codes and the eight disclosures', () => {
  for (const s of [
    'init', 'start', 'resume', 'pause', 'status', 'chat', 'direct', 'Exit codes: 0',
    'interrupts in-flight', 'partial world writes', 'fresh PTY', 'not re-executed',
    'one turn', 'released its cell', 'blocks a new host', '--charter-file',
    'no journaled', 'resume refuses it', 'config wins.', 'secret-bearing file',
  ]) {
    expect(USAGE).toContain(s);
  }
  expect(USAGE).toContain('[--charter-file <abs-path>]');
  expect(USAGE).toContain('status --home');
  expect(USAGE).toContain('--json');
  // The chat contract: the CLI's first interactive command, with its prompt
  // loop, its flags and its non-TTY behavior stated in the help text.
  expect(USAGE).toContain('chat   --home <abs-dir> [--tail N] [--conversation] [--json]');
  expect(USAGE).toContain('interactive human↔overlay session');
  expect(USAGE).toContain('non-TTY stdin');
  expect(USAGE).toContain('Ctrl-C aborts the wait');
  // The seventh command: the human's two write acts, both invocations, the
  // stricter flag combinations and the audit sentence are in the help text.
  expect(USAGE).toContain(
    'direct --home <abs-dir> (--text "<msg>" | --file <abs-path>)');
  expect(USAGE).toContain(
    'direct --home <abs-dir> --path <world-relative> --file <abs-path>');
  expect(USAGE).toContain('the human\'s write act, two acts in one command');
  expect(USAGE).toContain('--path requires --file');
  expect(USAGE).toContain('providers.json is refused by path and inode');
  expect(USAGE).toContain('unchanged: no commit — the pin did not move');
  expect(USAGE).not.toContain('SECRET');
});

it('parses direct: the reply default, then the strict flag combinations', () => {
  expect(parseHostCommand(['direct', '--home', '/x', '--text', 'hello'])).toEqual({
    command: 'direct', home: '/x', text: 'hello',
  });
  expect(parseHostCommand(['direct', '--home', '/x', '--file', '/tmp/msg.txt'])).toEqual({
    command: 'direct', home: '/x', file: '/tmp/msg.txt',
  });
  expect(parseHostCommand([
    'direct', '--home', '/x', '--path', 'DIRECTION.md', '--file', '/tmp/d.md',
  ])).toEqual({
    command: 'direct', home: '/x', path: 'DIRECTION.md', file: '/tmp/d.md',
  });
  // A nested tree path survives; --text carries its own record, never a path.
  expect(parseHostCommand([
    'direct', '--home', '/x', '--path', 'notes/2026/plan.md', '--file', '/tmp/p.md',
  ])).toMatchObject({ path: 'notes/2026/plan.md' });
  for (const argv of [
    // --text XOR --file: both, then neither.
    ['direct', '--home', '/x', '--text', 'a', '--file', '/tmp/a.txt'],
    ['direct', '--home', '/x'],
    // --path requires --file and refuses --text.
    ['direct', '--home', '/x', '--path', 'DIRECTION.md', '--text', 'a'],
    ['direct', '--home', '/x', '--path', 'DIRECTION.md'],
    // The path escapes (the tree-path form): absolute, .., ., empty segments,
    // a backslash and a control character are all usage refusals.
    ['direct', '--home', '/x', '--path', '/etc/passwd', '--file', '/tmp/a.txt'],
    ['direct', '--home', '/x', '--path', '../world/x', '--file', '/tmp/a.txt'],
    ['direct', '--home', '/x', '--path', 'a/../b', '--file', '/tmp/a.txt'],
    ['direct', '--home', '/x', '--path', './x', '--file', '/tmp/a.txt'],
    ['direct', '--home', '/x', '--path', 'a//b', '--file', '/tmp/a.txt'],
    ['direct', '--home', '/x', '--path', 'a\\b', '--file', '/tmp/a.txt'],
    ['direct', '--home', '/x', '--path', 'x\u0001', '--file', '/tmp/a.txt'],
    ['direct', '--home', '/x', '--path', '', '--file', '/tmp/a.txt'],
    // Relative/missing files, relative home, unknown flags, stray positionals.
    ['direct', '--home', '/x', '--file', 'rel.txt'],
    ['direct', '--home', '/x', '--file'],
    ['direct', '--home', '/x', '--text'],
    ['direct', '--home', '/x', '--text='],
    ['direct', '--home', 'x', '--text', 'a'],
    ['direct', '--home', '/x', '--text', 'a', '--uid', 'node-0'],
    ['direct', '--home', '/x', '--text', 'a', 'stray'],
  ]) {
    expect(() => parseHostCommand(argv)).toThrow(UsageError);
  }
});
