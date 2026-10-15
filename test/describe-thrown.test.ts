/**
 * describeThrown (describe-thrown.ts): a thrown value as text, for a
 * diagnostic that must not fail in its turn.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { describeThrown } from '../src/describe-thrown.js';

describe('describeThrown', () => {
  it('gives an Error\'s message or any other value\'s String form, and never throws', () => {
    assert.equal(describeThrown(new Error('disk full')), 'disk full');
    assert.equal(describeThrown('EIO'), 'EIO');
    assert.equal(describeThrown(null), 'null');
    assert.equal(describeThrown(undefined), 'undefined');
    // No prototype, so no toString: String() throws, and the tag stands in.
    assert.equal(describeThrown(Object.create(null)), '[object Object]');
    const hidden = new Error('hidden');
    Object.defineProperty(hidden, 'message', { get() { throw new Error('getter'); } });
    assert.equal(describeThrown(hidden), '[object Error]');
    // A revoked proxy fails String() and the tag alike.
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    assert.equal(describeThrown(proxy), 'a value that cannot be printed');
  });
});
