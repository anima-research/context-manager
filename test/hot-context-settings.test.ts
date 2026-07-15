import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

import {
  AutobiographicalStrategy,
  ContextManager,
  PassthroughStrategy,
} from '../src/index.js';

const path = './test-hot-context-settings-store';

function cleanup(): void {
  rmSync(path, { recursive: true, force: true });
}

test('hot context settings are typed, live, and cancelable', async () => {
  cleanup();
  const manager = await ContextManager.open({
    path,
    strategy: new AutobiographicalStrategy({
      adaptiveResolution: true,
      foldingStrategy: 'kv-stable',
      recentWindowTokens: 30_000,
      kvStableReachTokens: 8_000,
    }),
  });
  try {
    assert.deepEqual(manager.getHotContextSettings(), {
      tailTokens: 30_000,
      transitionPaceTokens: 8_000,
      prepared: true,
    });
    assert.deepEqual(
      manager.updateHotContextSettings({
        tailTokens: 20_000,
        transitionPaceTokens: 4_000,
        preparedWindowTokens: 60_000,
      }),
      {
        tailTokens: 20_000,
        transitionPaceTokens: 4_000,
        preparedWindowTokens: 60_000,
        prepared: false,
      },
    );
    assert.equal(
      manager.updateHotContextSettings({ preparedWindowTokens: null }).prepared,
      true,
    );
  } finally {
    manager.close();
    cleanup();
  }
});

test('non-capable strategies reject live context settings', async () => {
  cleanup();
  const manager = await ContextManager.open({ path, strategy: new PassthroughStrategy() });
  try {
    assert.equal(manager.getHotContextSettings(), null);
    assert.throws(
      () => manager.updateHotContextSettings({ tailTokens: 10_000 }),
      /does not support live context settings/,
    );
  } finally {
    manager.close();
    cleanup();
  }
});

test('prepared-window transition requires the KV-stable controller', () => {
  const strategy = new AutobiographicalStrategy({
    adaptiveResolution: true,
    foldingStrategy: 'flat-profile',
  });
  assert.throws(
    () => strategy.updateHotContextSettings({ preparedWindowTokens: 40_000 }),
    /foldingStrategy "kv-stable"/,
  );
  assert.equal(strategy.getHotContextSettings().preparedWindowTokens, undefined);
});
