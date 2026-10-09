import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseFileLink, resolveProjectFile } from '../apps/desktop/src/project-file.js';
import { temp } from './helpers.js';

test('project file links validate line targets and reject traversal and symlink escapes', async () => {
  const dir = temp(), root = join(dir.path, 'repo'); mkdirSync(root);
  writeFileSync(join(root, 'source.ts'), 'one\ntwo\n'); writeFileSync(join(dir.path, 'outside.ts'), 'outside');
  symlinkSync(join(dir.path, 'outside.ts'), join(root, 'escape.ts'));
  mkdirSync(join(root, '.git')); writeFileSync(join(root, '.git', 'config'), 'private');
  try {
    for (const link of ['source.ts:2', 'source.ts#L2', './source.ts#L2-L3', pathToFileURL(join(root, 'source.ts')).href + '#L2']) assert.deepEqual(await resolveProjectFile(root, link), { path: join(root, 'source.ts'), line: 2 });
    assert.deepEqual(parseFileLink('a%20b.ts:1:4'), { path: 'a b.ts', line: 1 });
    for (const link of ['../outside.ts', '%2e%2e/outside.ts', join(dir.path, 'outside.ts'), 'escape.ts', '.git/config', 'missing.ts', 'source.ts:99', 'source.ts:0', 'https://example.com', 'source.ts?query=1', '%00.ts']) await assert.rejects(resolveProjectFile(root, link));
  } finally { dir.cleanup(); }
});
