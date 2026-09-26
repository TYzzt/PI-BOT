import { test } from 'node:test';
import assert from 'node:assert/strict';
import { answersReady, formatQuestionAnswers, planBodySchema } from '../packages/protocol/src/index.js';
import { cloudPlanBody } from '../packages/service/src/cloud/plan.js';

const choice = { id: 'channel', prompt: '频道缺失时', options: [{ id: 'error', label: '直接报错' }, { id: 'fallback', label: '回退当前频道' }] };

test('plan questions accept legacy strings and choice objects', () => {
  const legacy = planBodySchema.parse({ goal: '目标', scope: ['范围'], nonGoals: [], modules: [], steps: [{ stepId: 's1', title: '步骤', description: '' }], commands: [], externalActions: [], verification: ['验证'], acceptance: ['验收'], questions: ['请提供期望结果'] });
  const chosen = planBodySchema.parse({ ...legacy, questions: [choice, { ...choice, id: 'scope', prompt: '存量任务', allowMultiple: true, options: [{ id: 'keep', label: '只限新建' }, { id: 'clean', label: '清理旧数据' }] }] });
  assert.equal(typeof legacy.questions[0], 'string');
  assert.equal(chosen.questions.length, 2);
  const cloud = cloudPlanBody(chosen);
  assert.deepEqual(cloud.questions[0], { ...choice, allow_multiple: false });
});

test('choice answers format the selected label', () => {
  assert.equal(answersReady([choice], {}), false);
  const picks = { channel: { options: ['error'], other: '' } };
  assert.equal(answersReady([choice], picks), true);
  assert.equal(formatQuestionAnswers([choice], picks), '问题「频道缺失时」选择：直接报错');
  assert.equal(formatQuestionAnswers(['请提供期望结果'], { 'legacy:0': { options: [], other: '返回 5' } }), '问题「请提供期望结果」选择：返回 5');
  assert.equal(answersReady(['请提供期望结果'], {}), false);
});
