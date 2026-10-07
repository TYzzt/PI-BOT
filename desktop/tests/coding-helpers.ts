import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PlanBody } from '../packages/protocol/src/index.js';
export const fixturePlan: PlanBody = { goal: '修复加法函数并通过测试', scope: ['修改 main.mjs 的 add 实现'], nonGoals: ['不修改其他用户文件'], modules: ['main.mjs', 'test.mjs'], steps: [{ stepId: 'fix-add', title: '修复加法', description: '读取现有实现，修正运算符并运行验证' }], commands: ['node test.mjs'], externalActions: [], verification: ['运行 node test.mjs，要求退出码 0'], acceptance: ['add(2,3) 返回 5'], questions: [] };
export function fixtureProject(root: string) {
  execFileSync('/usr/bin/git', ['init', '-q', root]);
  writeFileSync(join(root, 'main.mjs'), 'export function add(a, b) { return a - b; }\n');
  writeFileSync(join(root, 'test.mjs'), 'import { add } from "./main.mjs"; if(add(2,3)!==5) process.exit(1); console.log("PASS add");\n');
  writeFileSync(join(root, 'notes.txt'), 'user original notes\n');
  execFileSync('/usr/bin/git', ['-C', root, 'add', '.']);
  writeFileSync(join(root, 'notes.txt'), 'user uncommitted notes\n');
}
export const fixtureQuestions = [{ id: 'scope', prompt: '这次修复需要覆盖哪些场景？', options: [{ id: 'minimal', label: '只修复当前问题（推荐）' }, { id: 'extended', label: '同时完善边界情况' }] }, { id: 'verification', prompt: '希望如何验证修改？', options: [{ id: 'existing', label: '运行现有测试（推荐）' }, { id: 'new', label: '补充新的测试' }] }];
export async function codingEndpoint(longRun = false) {
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk; const json = JSON.parse(body); requests.push(json);
    const names = (json.tools ?? []).map((t: any) => t.function.name); const planning = names.includes('update_plan');
    const agent = JSON.stringify(json.messages[0]).includes('当前为正常项目对话');
    const lastUser = json.messages.findLastIndex((m: any) => m.role === 'user');
    const userContent = json.messages[lastUser]?.content;
    let current = typeof userContent === 'string' ? userContent : (userContent ?? []).map((part: any) => part.text ?? '').join('');
    try { current = JSON.parse(current).message ?? current; } catch {}
    const early = JSON.stringify(json.messages).includes('early-question') || JSON.stringify(json.messages).includes('execution-question');
    const answered = JSON.stringify(json.messages).includes('问题「这次修复需要覆盖哪些场景？');
    const reading = names.includes('read_file') && !planning && (!names.includes('run_command') || (agent && !/修复|添加注释|slow-command/.test(current) && !(early && answered)));
    const count = (reading || agent || early ? json.messages.slice(lastUser + 1) : json.messages).filter((m: any) => m.role === 'tool').length;
    const slow = (agent ? current : JSON.stringify(json.messages[1])).includes('slow-command');
    const ignored = JSON.stringify(json.messages[1]).includes('read-ignored');
    const questions = JSON.stringify(json.messages[1]).includes('need-question');
    const longPlan = JSON.stringify(json.messages[1]).includes('progress-long-plan');
    const replan = JSON.stringify(json.messages[1]).includes('scope-expansion');
    let call: { name: string; args: unknown } | undefined;
    if (planning) {
      if (count === 0) call = { name: 'read_file', args: { path: ignored ? 'private.txt' : 'main.mjs' } };
      if (count === 1 && early && !answered && !JSON.stringify(json.messages[1]).includes('execution-question')) call = { name: 'request_user_input', args: { questions: fixtureQuestions } };
      else if (count === 1) call = { name: 'update_plan', args: { plan: { ...fixturePlan, ...(longPlan ? { steps: fixturePlan.steps.map(step => ({ ...step, description: '完成加法修复并核对验证结果。'.repeat(120) })) } : {}), questions: questions ? ['请提供期望结果'] : [] } } };
    } else if (reading) {
      if (count === 0) call = { name: 'read_file', args: { path: 'main.mjs' } };
    } else if (names.includes('run_command')) {
      if (count === 0) call = replan ? { name: 'request_replan', args: { reason: '需要扩大范围', plan: fixturePlan } } : { name: 'read_file', args: { path: 'main.mjs' } };
      if (count === 1 && early && !answered) call = { name: 'request_user_input', args: { questions: fixtureQuestions } };
      else if (count === 1 && slow && JSON.stringify(json.messages.findLast((m: any) => m.role === 'tool')).includes('a + b')) call = { name: 'git_status', args: {} };
      else if (count === 1) call = { name: 'edit_file', args: { path: 'main.mjs', oldText: current.includes('添加注释') ? 'export function' : 'a - b', newText: current.includes('添加注释') ? '// Adds two numbers.\nexport function' : 'a + b' } };
      // Deliberately attempt a write after asking; the pause gate must reject it.
      if (count === 2 && early && !answered) call = { name: 'edit_file', args: { path: 'main.mjs', oldText: 'a - b', newText: 'a + b' } };
      else if (count === 2 && slow && names.includes('update_step')) call = { name: 'update_step', args: { stepId: 'fix-add', state: 'running', note: '正在运行验证命令' } };
      else if (count === 2) call = { name: 'run_command', args: { command: slow ? 'node -e "console.log(\'started\'); setInterval(()=>{},1000)"' : 'node test.mjs', verification: true, timeoutSeconds: 20 } };
      if (count === 3 && slow && names.includes('update_step')) call = { name: 'run_command', args: { command: 'node -e \"console.log(\'started\'); setInterval(()=>{},1000)\"', verification: true, timeoutSeconds: 20 } };
      else if (count === 3 && names.includes('update_step')) call = { name: 'update_step', args: { stepId: 'fix-add', state: 'completed', note: '实际验证已执行' } };
    }
    if (longRun && names.includes('run_command') && count >= 4 && count < 204) call = { name: 'git_status', args: {} };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = (delta: unknown, finish_reason: string | null = null) => res.write('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: json.model, choices: [{ index: 0, delta, finish_reason }] }) + '\n\n');
    if (call) { emit({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_' + count, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] }); emit({}, 'tool_calls'); }
    else { emit({ role: 'assistant', content: early && !answered ? '等待你的回答。' : reading ? (json.messages.filter((m: any) => m.role === 'user').length > 1 ? '接着上次的说明：减号使 add 返回差值，而不是两数之和。' : 'main.mjs 中的 add 函数实际使用 a - b，返回两个参数的差值。这是直接阅读代码的结果。') : planning ? '计划已生成，请审阅。' : '执行结束，请查看真实验证和差异。' }); emit({}, 'stop'); }
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, requests, close: async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); } };
}
