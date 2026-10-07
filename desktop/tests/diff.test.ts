import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUnifiedDiff } from '../apps/desktop/ui/diff.js';
import { baselineChanges, digest, type WorkspaceImage, type FileImage } from '../packages/service/src/coding/workspace.js';

function image(text: string): FileImage { return { text, hash: digest(text), mode: 0o100644, size: text.length, kind: 'file' }; }
function workspace(files: Record<string, FileImage>): WorkspaceImage { return { head: 'head', index: '', files, fingerprint: '', status: '', extras: [] }; }
test('numbered unified review handles multiple hunks, header-like source and missing final newlines', () => {
  const rows = parseUnifiedDiff('--- before/example\n+++ after/example\n@@ -2,2 +2,3 @@ title\n same\n--- old source\n+++ new source\n+extra\n@@ -20 +21 @@\n-old\n+new\n\\ No newline at end of file\n');
  assert.deepEqual(rows.filter(r => r.kind === 'deletion'), [{ kind: 'deletion', text: '-- old source', oldLine: 3 }, { kind: 'deletion', text: 'old', oldLine: 20 }]);
  assert.deepEqual(rows.filter(r => r.kind === 'addition').map(r => r.newLine), [3, 4, 21]);
  assert.equal(rows.at(-1)?.kind, 'note');
  assert.equal(parseUnifiedDiff('binary file differs').length, 0);
});
test('change stats count actual additions and deletions without pretending binary or mode changes are text edits', async () => {
  const before = workspace({ 'mod.ts': image('keep\nold\n'), 'deleted.ts': image('gone\n'), 'mode.ts': image('same\n'), 'bin': { ...image(''), text: undefined } });
  const after = workspace({ 'mod.ts': image('keep\nnew\nextra\n'), 'added.ts': image('new\n'), 'mode.ts': { ...image('same\n'), mode: 0o100755 }, 'bin': { ...image('binary'), text: undefined } });
  const changes = await baselineChanges(before, after, 'mod.ts');
  const file = (path: string) => changes.files.find(f => f.path === path)!;
  assert.deepEqual([file('mod.ts').additions, file('mod.ts').deletions], [2, 1]);
  assert.deepEqual([file('added.ts').kind, file('added.ts').additions, file('added.ts').deletions], ['added', 1, 0]);
  assert.deepEqual([file('deleted.ts').kind, file('deleted.ts').additions, file('deleted.ts').deletions], ['deleted', 0, 1]);
  assert.deepEqual([file('mode.ts').additions, file('mode.ts').deletions], [0, 0]);
  assert.equal(file('bin').additions, undefined); assert.equal(file('bin').preview, false);
  assert.equal(parseUnifiedDiff(changes.diff).filter(r => r.kind === 'addition').length, 2);
});
