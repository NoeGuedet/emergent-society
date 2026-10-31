import { describe, expect, it } from 'vitest';
import { assertNodeUid, InvalidNodeUidError } from '../../journal/index.js';
import { DIRECTION_MAX_BYTES, readRatifiedDirection } from '../direction.js';
import { commitAs, useWorld } from './helpers.js';

/**
 * The ratified-direction reader: the direction is a world file, the human's
 * commit is the ratification, and a node's draft is not authoritative. The
 * content is bounded and the archive is the world's history (no duplicate).
 */

const fixture = useWorld('node-direction-');

describe('readRatifiedDirection', () => {
  it('returns null when no ratified direction exists', async () => {
    const { world } = fixture();
    expect(await readRatifiedDirection(world)).toBeNull();
  });

  it('pins the latest human-authored DIRECTION.md, not a node draft', async () => {
    const { world } = fixture();
    const human = await commitAs(world, 'human', { 'DIRECTION.md': 'v1: hold the line\n' });
    expect(await readRatifiedDirection(world)).toEqual({ commit: human, text: 'v1: hold the line\n' });

    // A node drafts v2: the file moves, the direction does not.
    await commitAs(world, 'node-0', { 'DIRECTION.md': 'v2: a draft\n' }, 'draft');
    expect(await readRatifiedDirection(world)).toEqual({ commit: human, text: 'v1: hold the line\n' });

    // The human ratifies: now the draft's successor is the pin.
    const ratified = await commitAs(world, 'human', { 'DIRECTION.md': 'v3: ratified\n' }, 'ratify');
    expect(await readRatifiedDirection(world)).toEqual({ commit: ratified, text: 'v3: ratified\n' });
  });

  it('returns null for a node-only direction and for an empty ratified file', async () => {
    const { world } = fixture();
    await commitAs(world, 'node-0', { 'DIRECTION.md': 'draft only\n' });
    expect(await readRatifiedDirection(world)).toBeNull();
    await commitAs(world, 'human', { 'DIRECTION.md': '\n\n' }, 'empty');
    expect(await readRatifiedDirection(world)).toBeNull();
  });

  it('bounds the pinned text at the direction ceiling', async () => {
    const { world } = fixture();
    await commitAs(world, 'human', { 'DIRECTION.md': 'x'.repeat(DIRECTION_MAX_BYTES * 2) });
    const pin = await readRatifiedDirection(world);
    expect(pin).not.toBeNull();
    expect(pin!.text).toContain(`truncated`);
    expect(Buffer.byteLength(pin!.text, 'utf8')).toBeLessThan(DIRECTION_MAX_BYTES + 200);
  });

  it('reserves the human author name: no node can claim it', () => {
    expect(() => assertNodeUid('human')).toThrow(InvalidNodeUidError);
    expect(() => assertNodeUid('humanoid')).not.toThrow();
  });
});
