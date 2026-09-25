import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Keychain } from '../packages/service/src/keychain.js';
test('macOS Keychain 真实保存、读取、更新、删除（仅测试凭据）', { skip: process.env.T_AGNET_TEST_KEYCHAIN !== '1' }, async () => {
  const keychain = new Keychain(resolve('native/dist/keychain'), 'dev.t-agnet.test'); const id = randomUUID();
  try { assert.equal(await keychain.get(id), null); await keychain.set(id, 'test-only-secret'); assert.equal(await keychain.get(id), 'test-only-secret'); await keychain.set(id, 'updated-test-secret'); assert.equal(await keychain.get(id), 'updated-test-secret'); await keychain.delete(id); assert.equal(await keychain.get(id), null); }
  finally { await keychain.delete(id); }
});
