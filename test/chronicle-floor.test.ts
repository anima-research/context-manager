/**
 * The @animalabs/chronicle range context-manager declares (#291).
 *
 * The window index writes a write-down, one presentRows call's rows and
 * one call's tombstones as one record, through chronicle's
 * appendManyToStateJsonWithIdentity, and has no one-record-per-item path
 * (src/window-index.ts, WindowIndex.write). Chronicle's batched calls
 * (appendManyToStateJson, appendManyToStateJsonWithIdentity,
 * getStateItemsJson, getRecords) are in no published release before 0.6.0:
 * 0.5.0 has none of them. So the range takes nothing below 0.6.0, and the
 * chronicle this suite runs on (a linked tree until 0.6.0 is published) has
 * all four.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JsStore } from '@animalabs/chronicle';

type Manifest = { name: string; version: string; dependencies?: Record<string, string> };
// From dist/test, as the suite runs.
const ours = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as Manifest;

/** A caret range's floor (`^M.m.p`), the form context-manager declares. */
function floorOf(range: string): [number, number, number] {
  const parts = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(range);
  assert.ok(parts, `${range} is a caret range on a release`);
  return [Number(parts[1]), Number(parts[2]), Number(parts[3])];
}

/** Whether the caret `range` admits the release `version`, as npm reads it:
 *  at or above the floor, below the next change of its first nonzero part. */
function admits(range: string, version: string): boolean {
  const [major, minor, patch] = floorOf(range);
  const [vMajor, vMinor, vPatch] = version.split('.').map(Number) as [number, number, number];
  const atOrAbove = vMajor > major || (vMajor === major && (vMinor > minor || (vMinor === minor && vPatch >= patch)));
  if (!atOrAbove) return false;
  if (major > 0) return vMajor === major;
  if (minor > 0) return vMajor === 0 && vMinor === minor;
  return vMajor === 0 && vMinor === 0 && vPatch === patch;
}

const BATCHED_CALLS = ['appendManyToStateJson', 'appendManyToStateJsonWithIdentity', 'getStateItemsJson', 'getRecords'] as const;

describe("context-manager's chronicle range", () => {
  it('the caret reading', () => {
    assert.equal(admits('^0.6.0', '0.6.0'), true);
    assert.equal(admits('^0.6.0', '0.6.4'), true);
    assert.equal(admits('^0.6.0', '0.5.9'), false);
    assert.equal(admits('^0.6.0', '0.7.0'), false);
    assert.equal(admits('^1.2.0', '1.9.0'), true);
    assert.equal(admits('^0.0.3', '0.0.4'), false);
  });

  it('takes chronicle only at a release with the batched calls: not 0.5.0 or earlier, which have none', () => {
    const range = ours.dependencies?.['@animalabs/chronicle'];
    assert.ok(range, 'context-manager depends on chronicle');
    for (const published of ['0.4.0', '0.5.0']) {
      assert.equal(admits(range, published), false,
        `${range} admits chronicle ${published}, published without ${BATCHED_CALLS.join(', ')}`);
    }
    assert.equal(admits(range, '0.6.0'), true, `${range} admits chronicle 0.6.0, the release with the batched calls`);
  });

  it('runs on a chronicle with each batched call', () => {
    const proto = JsStore.prototype as unknown as Record<string, unknown>;
    for (const call of BATCHED_CALLS) {
      assert.equal(typeof proto[call], 'function', `the chronicle this suite runs on has JsStore.${call}`);
    }
  });
});
