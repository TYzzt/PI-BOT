import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lstatSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { FileCredentials } from '../packages/service/src/keychain.js';
import { temp } from './helpers.js';

test('本机凭据文件保存、更新、删除，并且拒绝符号链接', async () => {
  const dir = temp();
  try {
    const file = join(dir.path, 'secrets.json');
    const secrets = new FileCredentials(file);
    const id = randomUUID();
    assert.equal(await secrets.get(id), null);
    await secrets.set(id, 'local-only');
    assert.equal(await secrets.get(id), 'local-only');
    assert.equal(lstatSync(file).mode & 0o777, 0o600);
    await secrets.set(id, 'updated');
    await secrets.set(randomUUID(), 'other');
    assert.equal(await secrets.get(id), 'updated');
    await secrets.delete(id);
    assert.equal(await secrets.get(id), null);
    symlinkSync(file, join(dir.path, 'linked.json'));
    await assert.rejects(() => new FileCredentials(join(dir.path, 'linked.json')).get(id), /凭据文件不安全/);
  } finally { dir.cleanup(); }
});
