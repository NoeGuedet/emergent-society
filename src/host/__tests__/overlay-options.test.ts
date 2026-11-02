import { expect, it } from 'vitest';
import { UsageError } from '../errors.js';
import { parseHostCommand, USAGE } from '../options.js';

/**
 * The gateway overlay's CLI surface: `--gateway-charter` (the operator's
 * absolute charter path) and `--gateway-model` (start-only, and meaningless
 * without a charter). Resume refuses both — the persisted configuration wins.
 */

it('parses the gateway flags on start and keeps them absent otherwise', () => {
  expect(parseHostCommand([
    'start', '--home', '/x', '--model', 'm', '--heading', 'h',
    '--gateway-charter', '/tmp/gw.md', '--gateway-model', 'gw-model',
  ])).toEqual({
    command: 'start', home: '/x', uid: 'node-0', model: 'm', heading: 'h',
    noSandbox: false, gatewayCharter: '/tmp/gw.md', gatewayModel: 'gw-model',
  });
  expect(parseHostCommand([
    'start', '--home', '/x', '--model', 'm', '--heading', 'h',
    '--gateway-charter', '/tmp/gw.md',
  ])).toEqual({
    command: 'start', home: '/x', uid: 'node-0', model: 'm', heading: 'h',
    noSandbox: false, gatewayCharter: '/tmp/gw.md',
  });
  expect('gatewayCharter' in parseHostCommand([
    'start', '--home', '/x', '--model', 'm', '--heading', 'h',
  ])).toBe(false);
  // A nodes-file boot may configure the overlay too: the flags are not part of
  // the solo flags it replaces.
  expect(parseHostCommand([
    'start', '--home', '/x', '--nodes-file', '/tmp/n.json', '--gateway-charter', '/tmp/gw.md',
  ])).toMatchObject({ gatewayCharter: '/tmp/gw.md', nodesFile: '/tmp/n.json' });
});

it('refuses a model without a charter, a relative or empty charter, and both flags on resume', () => {
  for (const argv of [
    ['start', '--home', '/x', '--model', 'm', '--heading', 'h', '--gateway-model', 'gw'],
    ['start', '--home', '/x', '--model', 'm', '--heading', 'h', '--gateway-charter', 'rel.md'],
    ['start', '--home', '/x', '--model', 'm', '--heading', 'h', '--gateway-charter='],
    ['resume', '--home', '/x', '--gateway-charter', '/tmp/gw.md'],
    ['resume', '--home', '/x', '--gateway-model', 'gw'],
  ]) {
    expect(() => parseHostCommand(argv)).toThrow(UsageError);
  }
  expect(() => parseHostCommand([
    'resume', '--home', '/x', '--gateway-charter', '/tmp/gw.md',
  ])).toThrow(/gateway-charter/);
});

it('USAGE documents the overlay config home', () => {
  for (const fragment of [
    '--gateway-charter', '--gateway-model', 'gateway.charter.md', 'nodes-only host',
    'resume takes', 'the persisted configuration wins',
  ]) {
    expect(USAGE).toContain(fragment);
  }
});
