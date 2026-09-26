import type { BrowserSession } from './index.js';
import type { JevClient, JevQuestion } from './jev.js';
import { BrowserPause } from './pause.js';
import { describe, renderSnapshot, type PageSnapshot } from './snapshot.js';

export interface BrowserTaskInput { goal: string; inputs?: string[]; maxSteps?: number; timeoutMs?: number; threshold?: number; }
export interface BrowserTaskStep { step: number; action: string; detail: string; probability: number | null; done: number; stuck: number; result: string; }
export interface BrowserTaskResult { outcome: 'done' | 'blocked' | 'max_steps' | 'timeout'; model: string; steps: BrowserTaskStep[]; snapshot: string; }

const MAX_OPTIONS = 250;
const CLICKABLE = new Set(['button', 'link', 'checkbox', 'radio', 'tab', 'menuitem', 'option', 'switch', 'clickable', 'summary']);

// Every option Jev may pick is enumerated here; anything else is refused before touching the page.
export function actionCriteria(snapshot: PageSnapshot, inputs: string[]) {
  const criteria: Record<string, string> = {
    done: '目标已经达成，停止操作', blocked: '无法继续（需要登录、验证码、人工确认，或目标无法在此页面完成）',
    scroll_down: '向下滚动页面查看更多内容', scroll_up: '向上滚动页面', wait: '等待页面加载或变化',
  };
  const add = (key: string, text: string) => { if (Object.keys(criteria).length < MAX_OPTIONS) criteria[key] = text; };
  for (const el of snapshot.elements) {
    if (el.disabled) continue;
    const label = describe(el, snapshot.id);
    if (el.role === 'textbox' && el.inputType !== 'password') inputs.forEach((text, i) => add(`type_${el.n}_${i}`, `在 ${label} 中输入：${JSON.stringify(text.slice(0, 200))}`));
    else if (el.role === 'combobox' && el.options.length) el.options.forEach((option, k) => add(`select_${el.n}_${k}`, `在 ${label} 中选择「${option}」`));
    else if (CLICKABLE.has(el.role)) add(`click_${el.n}`, `点击 ${label}`);
  }
  return criteria;
}

export async function runBrowserTask(session: BrowserSession, jev: JevClient, input: BrowserTaskInput): Promise<BrowserTaskResult> {
  const inputs = input.inputs ?? [], maxSteps = Math.min(input.maxSteps ?? 15, 40), threshold = input.threshold ?? 0.85;
  const deadline = Date.now() + (input.timeoutMs ?? 90000);
  const steps: BrowserTaskStep[] = [];
  let model = '', snapshot: PageSnapshot | null = null;
  const finish = (outcome: BrowserTaskResult['outcome']): BrowserTaskResult => ({ outcome, model, steps, snapshot: snapshot ? renderSnapshot(snapshot) : '' });
  for (let step = 1; step <= maxSteps; step++) {
    if (Date.now() > deadline) return finish('timeout');
    if (session.signal.aborted) throw new Error('运行已停止');
    snapshot = await session.snapshotData();
    const criteria = actionCriteria(snapshot, inputs);
    const questions: Record<string, JevQuestion> = {
      action: { type: 'choice', instructions: `为了完成目标「${input.goal}」，下一步应该执行哪个操作？`, criteria },
      done: { type: 'noul', instructions: `目标「${input.goal}」是否已经在当前页面达成？` },
      stuck: { type: 'noul', instructions: `完成目标「${input.goal}」的过程是否已卡住或无法继续（需要登录、验证码、人工确认，或多次操作都没有进展）？` },
    };
    const state = {
      goal: input.goal, page: { title: snapshot.title, url: snapshot.url, text: snapshot.text.slice(0, 3000) },
      elements: snapshot.elements.map(e => describe(e, snapshot!.id)), history: steps.slice(-6).map(s => `${s.step}. ${s.detail} → ${s.result}`),
    };
    const response = await jev.ask(state, questions, session.signal);
    model = response.model;
    const action = response.answers.action, doneAnswer = response.answers.done, stuckAnswer = response.answers.stuck;
    const done = doneAnswer?.type === 'noul' ? doneAnswer.noul : 0, stuck = stuckAnswer?.type === 'noul' ? stuckAnswer.noul : 0;
    const choice = action?.type === 'choice' ? action.choice : '';
    const probability = action?.type === 'choice' ? action.probabilities?.[choice] ?? action.confidence ?? null : null;
    const record = (result: string) => steps.push({ step, action: choice, detail: criteria[choice] ?? choice, probability, done, stuck, result });
    if (done >= threshold) { record('判断目标已达成'); return finish('done'); }
    if (stuck >= threshold) { record('判断已卡住'); return finish('blocked'); }
    if (!Object.hasOwn(criteria, choice)) throw new Error(`Jev 返回了未列出的操作：${choice.slice(0, 60)}`);
    if (choice === 'done') { record('Jev 选择结束'); return finish('done'); }
    if (choice === 'blocked') { record('Jev 选择停止'); return finish('blocked'); }
    const ref = (n: string) => `${snapshot!.id}.${n}`;
    let result: string;
    try {
      let m: RegExpExecArray | null;
      if (choice === 'scroll_down' || choice === 'scroll_up') result = await session.scroll(choice === 'scroll_down' ? 'down' : 'up');
      else if (choice === 'wait') result = await session.wait(1000);
      else if ((m = /^click_(\d+)$/.exec(choice))) result = await session.click(ref(m[1]));
      else if ((m = /^type_(\d+)_(\d+)$/.exec(choice))) result = await session.type(ref(m[1]), inputs[Number(m[2])]);
      else if ((m = /^select_(\d+)_(\d+)$/.exec(choice))) { const el = snapshot.elements.find(e => e.n === Number(m![1]))!; result = await session.select(ref(m[1]), el.options[Number(m[2])]); }
      else throw new Error(`无法识别的操作：${choice}`);
    } catch (error) {
      record(error instanceof Error ? error.message : '操作失败');
      if (error instanceof BrowserPause) throw error;
      continue;
    }
    record(result);
  }
  return finish('max_steps');
}
