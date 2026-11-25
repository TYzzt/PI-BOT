import test from 'node:test';
import assert from 'node:assert/strict';
import { uiHistorySummary } from '../src/ui-context.js';
import { tableDocument } from '../../packages/a2ui/tests/table-fixtures.js';

test('UI-only history has a bounded descriptive summary without replaying table contents', () => {
  const summary = uiHistorySummary(tableDocument('card-tabs', true));
  assert.match(summary, /此前已展示/);
  assert.match(summary, /AuiTable/);
  assert.match(summary, /模型对比/);
  assert.match(summary, /模型名称/);
  assert.ok(summary.length < 1100);
  assert.ok(!summary.includes('超长中文'));
  assert.equal(uiHistorySummary(null), '');
  assert.equal(uiHistorySummary({surfaces: []}), '');
});
