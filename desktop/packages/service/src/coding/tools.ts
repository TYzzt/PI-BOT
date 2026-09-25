import { Type } from 'typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { readFile, writeFile, mkdir, readdir, lstat } from 'node:fs/promises';
import { dirname, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { planBodySchema, type PlanBody, type StepStatus, type ToolCall } from '../../../protocol/src/index.js';
import { safePath, entries, fileImage, projectStatus, type FileImage } from './workspace.js';
import { command, commandPath } from './command.js';
import type { CodingStore } from './store.js';
const strings = () => Type.Array(Type.String());
const planSchema = Type.Object({ goal: Type.String(), scope: strings(), nonGoals: strings(), modules: strings(), steps: Type.Array(Type.Object({ stepId: Type.String(), title: Type.String(), description: Type.String() })), commands: strings(), externalActions: strings(), verification: strings(), acceptance: strings(), questions: strings() });
export interface ToolContext {
  taskId: string; runId: string; root: string; mode: 'read' | 'plan' | 'execute'; store: CodingStore; key: string;
  cancelled: () => boolean; signal: AbortSignal; notify: (toolId?: string) => void; onTool?: (tool: ToolCall) => void; onStep?: (step: StepStatus) => void;
  plan?: PlanBody; pause?: 'needs_replan' | 'waiting_for_local_action'; pauseReason?: string;
  readImages: Map<string, FileImage>; calls: number;
}
export function codingTools(ctx: ToolContext): ToolDefinition[] {
  const redact = (s: string) => s.replaceAll(ctx.key, '[已隐藏凭据]');
  function tool(name: string, description: string, parameters: any, execute: (p: any, signal: AbortSignal, append: (text: string) => void, record: ToolCall) => Promise<unknown>): ToolDefinition {
    return { name, label: name, description, parameters, executionMode: 'sequential', execute: async (_id, rawParams) => {
      const params = rawParams as any;
      if (ctx.cancelled() || ctx.signal.aborted) throw new Error('运行已停止');
      if (ctx.pause) throw new Error('任务已暂停，不得继续调用工具');
      if (++ctx.calls > 150) { ctx.pause = 'needs_replan'; ctx.pauseReason = '本轮工具调用达到 150 次，请缩小任务后重新规划'; throw new Error(ctx.pauseReason); }
      const record: ToolCall = { id: randomUUID(), taskId: ctx.taskId, runId: ctx.runId, name, input: redact(JSON.stringify(params)).slice(0, 12000), output: '', state: 'running', startedAt: Date.now(), endedAt: null, exitCode: null, verification: name === 'run_command' && !!params.verification, truncated: false, cwd: ctx.root, path: name === 'run_command' ? commandPath() : '' };
      let last = 0;
      const save = () => { ctx.store.putTool(record); ctx.notify(record.id); };
      const append = (text: string) => { const next = redact(record.output + text); record.truncated ||= next.length > 64000; record.output = next.slice(0, 64000); if (Date.now() - last > 150) { last = Date.now(); save(); } };
      save();
      try {
        const result = await execute(params, ctx.signal, append, record);
        if (record.state === 'running') record.state = ctx.signal.aborted ? 'cancelled' : 'completed';
        const output = redact(typeof result === 'string' ? result : JSON.stringify(result));
        if (!record.output) append(output);
        return { content: [{ type: 'text', text: output.slice(0, 16000) }], details: {} };
      } catch (error) {
        record.state = ctx.signal.aborted ? 'cancelled' : 'failed';
        const message = redact(error instanceof Error ? error.message : '工具执行失败'); append('\n' + message);
        // Tool errors are returned to Pi for correction, but paused/cancelled gates remain active.
        throw new Error(message);
      } finally { record.endedAt = Date.now(); save(); ctx.onTool?.({ ...record }); }
    } };
  }
  async function read(path: string) {
    const target = await safePath(ctx.root, path); const stat = await lstat(target);
    if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error('只能读取文本文件');
    if (stat.size > 128 * 1024) throw new Error('单次文件读取上限 128 KiB');
    const text = await readFile(target, 'utf8'); if (text.includes('\0')) throw new Error('不支持读取二进制内容');
    const image = await fileImage(target); if (image) ctx.readImages.set(relative(ctx.root, target), image);
    return text;
  }
  const tools = [
    tool('read_file', '读取项目内文本文件，最多 128 KiB。路径相对于项目根目录。', Type.Object({ path: Type.String() }), async p => read(p.path)),
    tool('list_files', '列举项目目录，省略 .git，最多 500 项。', Type.Object({ path: Type.Optional(Type.String()) }), async p => { const target = await safePath(ctx.root, p.path || '.'); const names = await readdir(target, { withFileTypes: true }); return names.filter(e => e.name !== '.git').slice(0, 500).map(e => ({ name: e.name, directory: e.isDirectory(), symlink: e.isSymbolicLink() })); }),
    tool('search_files', '在受跟踪和非忽略文本文件内搜索普通字符串（非正则），最多 100 个结果。', Type.Object({ query: Type.String({ minLength: 1 }), path: Type.Optional(Type.String()) }), async p => {
      if (!p.query || p.query.length > 500) throw new Error('搜索词长度必须为 1 到 500');
      if (p.path) await safePath(ctx.root, p.path);
      const { names, submodules } = await entries(ctx.root); const matches: { path: string; line: number; text: string }[] = [];
      for (const name of names) { if (ctx.signal.aborted) throw new Error('运行已停止'); if (submodules.includes(name) || (p.path && p.path !== '.' && name !== p.path && !name.startsWith(p.path.replace(/\/$/, '') + '/'))) continue;
        try { const text = await read(name); for (const [i, line] of text.split('\n').entries()) { if (line.includes(p.query)) matches.push({ path: name, line: i + 1, text: line.slice(0, 500) }); if (matches.length >= 100) return { matches, truncated: true }; } } catch { /* Unreadable/binary files are omitted; direct read exposes the error. */ }
      } return { matches, truncated: false };
    }),
    tool('git_status', '只读查询分支和暂存/未暂存/未跟踪状态。', Type.Object({}), async () => projectStatus(ctx.root)),
  ];
  if (ctx.mode === 'plan') tools.push(tool('update_plan', '提交结构化计划。每次修改保留相同语义步骤的 stepId。问题未解决时填写 questions；此工具不修改项目。', Type.Object({ plan: planSchema }), async p => { ctx.plan = planBodySchema.parse(JSON.parse(redact(JSON.stringify(p.plan)))); return { saved: true, questions: ctx.plan.questions }; }));
  else if (ctx.mode === 'execute') tools.push(
    tool('write_file', '创建或替换项目内文本文件。保留用户已有修改；优先使用 edit_file。', Type.Object({ path: Type.String(), content: Type.String() }), async p => { if (p.content.length > 256000) throw new Error('单次写入上限 256000 字符'); const path = await safePath(ctx.root, p.path, true); const existing = await fileImage(path); if (existing && ctx.readImages.get(relative(ctx.root, path))?.hash !== existing.hash) throw new Error('覆盖现有文件前必须读取，且读取后文件不能被外部修改'); await mkdir(dirname(path), { recursive: true }); await safePath(ctx.root, p.path, true); if (ctx.signal.aborted) throw new Error('运行已停止'); await writeFile(path, p.content, 'utf8'); return '文件已写入'; }),
    tool('edit_file', '以唯一精确文本匹配修改文件，匹配不存在或不唯一时拒绝。', Type.Object({ path: Type.String(), oldText: Type.String(), newText: Type.String() }), async p => { const path = await safePath(ctx.root, p.path, true); const text = await read(p.path); if (!p.oldText || text.split(p.oldText).length !== 2) throw new Error('原文本不存在或不唯一，请重新读取文件'); const changed = text.replace(p.oldText, p.newText); if (changed.length > 256000) throw new Error('结果文件过大'); if (ctx.signal.aborted) throw new Error('运行已停止'); await safePath(ctx.root, p.path, true); await writeFile(path, changed, 'utf8'); return '文件已编辑'; }),
    tool('run_command', '在项目目录执行非交互 zsh 命令，stdin 关闭。timeoutSeconds 默认 120，上限 600。验证计划中的测试或检查时 verification=true；直接运行验证命令，不追加 echo 或用 || true 掩盖失败。禁止提交、推送、重置、清理和后台常驻。需要交互时暂停任务。', Type.Object({ command: Type.String(), timeoutSeconds: Type.Optional(Type.Number({ minimum: 1, maximum: 600 })), verification: Type.Boolean() }), async (p, signal, append, record) => {
      if (!p.command || p.command.length > 12000) throw new Error('命令长度无效');
      const result = await command(p.command, ctx.root, (p.timeoutSeconds ?? 120) * 1000, signal, (stream, text, truncated) => { record.truncated ||= !!truncated; append(`[${stream}] ${text}`); });
      record.exitCode = result.code; record.state = result.cancelled ? 'cancelled' : result.code === 0 && !result.timedOut && !result.interaction ? 'completed' : 'failed';
      if (result.interaction) { ctx.pause = 'waiting_for_local_action'; ctx.pauseReason = '命令需要本机交互，请在外部终端处理后重新规划'; }
      append('\n' + JSON.stringify(result)); return { ...result, output: record.output, truncated: record.truncated };
    }),
    tool('update_step', '报告批准计划步骤的进度；不代表测试通过。', Type.Object({ stepId: Type.String(), state: Type.Union([Type.Literal('running'), Type.Literal('completed'), Type.Literal('failed')]), note: Type.String() }), async p => { const steps = ctx.store.steps(ctx.taskId); if (!steps.some(s => s.stepId === p.stepId)) throw new Error('步骤不属于当前批准计划'); const next = steps.map(s => s.stepId === p.stepId ? { ...s, state: p.state, note: redact(p.note).slice(0, 2000) } as StepStatus : s); ctx.store.putSteps(ctx.taskId, next); ctx.onStep?.(next.find(s => s.stepId === p.stepId)!); return '进度已记录'; }),
    tool('request_replan', '范围扩大或需要额外外部动作时调用，立即封闭执行工具并生成待重新审阅的计划版本。', Type.Object({ reason: Type.String(), plan: planSchema }), async p => { ctx.plan = planBodySchema.parse(JSON.parse(redact(JSON.stringify(p.plan)))); ctx.pause = 'needs_replan'; ctx.pauseReason = p.reason.slice(0, 2000); return '已暂停，等待重新规划及用户批准'; }),
    tool('request_local_action', '需要用户在本机进行登录或其他交互时暂停，不能索取密码。', Type.Object({ reason: Type.String() }), async p => { ctx.pause = 'waiting_for_local_action'; ctx.pauseReason = p.reason.slice(0, 2000); return '已暂停，用户处理后需要重新规划'; }),
  );
  return tools;
}
