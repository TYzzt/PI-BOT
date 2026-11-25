/** Real-model UI trigger evaluation. Only explicit evaluation credentials are used. */
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createBotAgent, a2uiTools, UI_INSTRUCTIONS } from '../../packages/agent/src/index.js';
import { uiHistorySummary } from '../../server/src/ui-context.js';
import { tableDocument } from '../../packages/a2ui/tests/table-fixtures.js';

const cases = [
  {name: 'comparison', ui: true, prompt: '帮我比较并选型：方案 A 每月 50 元、支持离线、维护成本高；方案 B 每月 100 元、不支持离线、维护成本低；方案 C 免费、支持离线、没有技术支持。我们重视离线和预算，请整理关键差异与建议。'},
  {name: 'research', ui: true, prompt: '根据这些已核实资料整理 assistant-ui 调研结果：能力分为聊天原语、运行时适配、工具展示、生成式界面；优势分别是组合灵活、可接自有后端、工具状态清晰、结构化信息可读。当前项目需要聊天与工具展示，后续计划生成式界面。请按能力分类、适用场景、接入优先级给出完整结论。'},
  {name: 'statistics', ui: true, prompt: '分析本周运营数据：周一到周日订单分别为 120、150、90、200、180、260、300，收入分别为 1200、1500、900、2000、1800、2600、3000 元。请整理总量、趋势和高低点，方便我快速理解。'},
  {name: 'process', ui: true, prompt: '整理上线流程与当前进度：需求确认已完成，接口开发已完成，联调进行中，回归测试待开始，灰度发布待开始。联调负责人小王、截止周三；测试负责人小李、截止周四；发布负责人小张、截止周五。请清楚说明阶段、依赖、负责人和后续安排。'},
  {name: 'fact', ui: false, prompt: '一加一是多少？'},
  {name: 'short-explanation', ui: false, prompt: '用一句话解释缓存。'},
  {name: 'text-only', ui: false, prompt: '只用纯文字比较 A（免费、离线）和 B（收费、联网），不要展示 UI。'},
  {name: 'follow-up', ui: false, prompt: '刚才表格中的开放权重是什么意思？简短解释。', history: [{role: 'assistant' as const, content: '已整理模型对比。' + uiHistorySummary(tableDocument('card'))}]},
];
if (process.argv.includes('--list')) {
  console.log(JSON.stringify(cases.map(({name, ui, prompt}) => ({name, expects_ui: ui, prompt})), null, 2));
} else {
  const baseUrl = process.env.PI_BOT_EVAL_BASE_URL, apiKey = process.env.PI_BOT_EVAL_API_KEY, modelId = process.env.PI_BOT_EVAL_MODEL;
  if (!baseUrl || !apiKey || !modelId) throw new Error('Set PI_BOT_EVAL_BASE_URL, PI_BOT_EVAL_API_KEY and PI_BOT_EVAL_MODEL. Production credentials are not discovered.');
  const output = resolve(process.env.PI_BOT_EVAL_OUTPUT ?? 'artifacts/evals');
  await mkdir(output, {recursive: true});
  const results: object[] = [];
  for (let repeat = 0; repeat < 3; repeat++) for (const item of cases) {
    const dir = await mkdtemp(join(tmpdir(), 'pibot-ui-eval-'));
    const calls: {name: string; error?: string}[] = [], batches: object[] = [];
    const tools = a2uiTools(messages => { batches.push(messages); }).map(tool => ({...tool, execute: async (...args: Parameters<typeof tool.execute>) => {
      const call: {name: string; error?: string} = {name: tool.name}; calls.push(call);
      try { return await tool.execute(...args); } catch (error) { call.error = error instanceof Error ? error.message : String(error); throw error; }
    }}));
    let agent: Awaited<ReturnType<typeof createBotAgent>> | undefined;
    try {
      agent = await createBotAgent({model: {id: randomUUID(), name: modelId, baseUrl, modelId, contextWindow: 32000, maxTokens: 6000}, apiKey, cwd: dir, agentDir: join(dir, 'agent'), tools, history: item.history ?? [], systemPrompt: '你是 PiBot，像可靠的同事一样按用户需求呈现结果。资料已经给出，无需检索。\n' + UI_INSTRUCTIONS});
      const answer = await agent.prompt(item.prompt, () => {});
      results.push({repeat, name: item.name, prompt: item.prompt, expects_ui: item.ui, calls, batches, answer, protocol_pass: (batches.length > 0) === item.ui && calls.every(call => !call.error)});
    } catch (error) { results.push({repeat, name: item.name, calls, error: error instanceof Error ? error.message : String(error), protocol_pass: false}); }
    finally { agent?.dispose(); await rm(dir, {recursive: true, force: true}); }
    await writeFile(join(output, 'ui-behavior.json'), JSON.stringify({model: modelId, cases: cases.length, repeats: 3, results}, null, 2));
  }
  console.log(`Saved ${results.length} trials to ${output}; review component suitability and duplicate content alongside protocol_pass.`);
  if (results.some(result => !(result as {protocol_pass: boolean}).protocol_pass)) process.exitCode = 1;
}
