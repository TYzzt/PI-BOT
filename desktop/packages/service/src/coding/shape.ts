import { charTail } from './text-limit.js';

export const MODEL_BUDGET = 12000;
export const READ_MORE = '使用 read_tool_output，传入 callId，可用 offset 继续读取保留内容。';

function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }

function fit(value: unknown, budget: number) { const text = JSON.stringify(value); return text.length <= budget ? text : null; }

function fileLines(text: string) {
  if (!text) return [];
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function shrinkFile(value: Record<string, unknown>, callId: string, budget: number) {
  const startLine = Number(value.startLine) || 1;
  const totalLines = Number(value.totalLines) || 0;
  const lines = fileLines(typeof value.text === 'string' ? value.text : '');
  const pack = (kept: string[], lineTooLong = false) => {
    const next = startLine + kept.length;
    const more = next <= totalLines && (lineTooLong || kept.length < lines.length || value.truncated === true);
    return {
      path: value.path, startLine, totalLines, truncated: more || lineTooLong, lineTooLong: lineTooLong || undefined,
      text: lineTooLong ? undefined : kept.join('\n'), nextLine: more ? next : undefined,
      outputCallId: callId, readMore: READ_MORE,
      note: lineTooLong ? '单行超过返回上限，未放入残行。请用 read_tool_output 按窗口读取。' : more ? `文件共 ${totalLines} 行，本次从第 ${startLine} 行返回 ${kept.length} 行。下一行是 ${next}。` : value.note,
    };
  };
  let kept = lines.slice();
  while (kept.length > 1 && !fit(pack(kept), budget)) kept = kept.slice(0, -1);
  if (!fit(pack(kept), budget)) return pack([], true);
  return pack(kept);
}

function shrinkCommand(value: Record<string, unknown>, callId: string, budget: number) {
  const output = typeof value.output === 'string' ? value.output : '';
  const pack = (chars: number) => ({ ...value, output: charTail(output, chars), truncated: true, outputCallId: callId, readMore: READ_MORE });
  let lo = 0, hi = output.length, best = pack(0);
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const candidate = pack(mid);
    if (fit(candidate, budget)) { best = candidate; lo = mid + 1; } else hi = mid - 1;
  }
  return best;
}

function shrinkSearch(value: Record<string, unknown>, callId: string, budget: number) {
  const matches = Array.isArray(value.matches) ? value.matches.map(item => ({ ...(item as Record<string, unknown>) })) : [];
  const pack = (items: Record<string, unknown>[]) => ({ ...value, matches: items, truncated: true, outputCallId: callId, readMore: READ_MORE });
  let kept = matches.slice();
  while (kept.length && !fit(pack(kept), budget)) kept = kept.slice(0, -1);
  if (kept.length === 1 && typeof kept[0].text === 'string' && !fit(pack(kept), budget)) {
    let text = kept[0].text;
    while (text.length > 80 && !fit(pack([{ ...kept[0], text }]), budget)) text = text.slice(0, Math.ceil(text.length * 0.7));
    kept = [{ ...kept[0], text }];
  }
  return fit(pack(kept), budget) ? pack(kept) : { truncated: true, outputCallId: callId, readMore: READ_MORE, matches: [] };
}

function shrinkGeneric(value: unknown, callId: string, budget: number): unknown {
  if (Array.isArray(value)) {
    let items = value.slice();
    while (items.length && !fit(items, budget)) items = items.slice(0, -1);
    if (fit(items, budget) && items.length === value.length) return items;
    const wrapped = { items, truncated: true, omitted: value.length - items.length, outputCallId: callId, readMore: READ_MORE };
    return fit(wrapped, budget) ? wrapped : { truncated: true, outputCallId: callId, readMore: READ_MORE, note: '结果超过长度上限，请用 read_tool_output 按窗口读取保留内容。' };
  }
  if (!isRecord(value)) return { truncated: true, outputCallId: callId, readMore: READ_MORE, note: '结果超过长度上限，请用 read_tool_output 按窗口读取保留内容。' };
  const copy: Record<string, unknown> = { ...value, truncated: true, outputCallId: callId, readMore: READ_MORE };
  const strings = Object.keys(copy).filter(key => typeof copy[key] === 'string' && key !== 'readMore' && key !== 'path');
  for (const key of strings) {
    let text = String(copy[key]);
    if (!text.includes('\n')) continue;
    let lines = text.split('\n');
    while (lines.length > 1 && !fit({ ...copy, [key]: lines.join('\n') }, budget)) lines = lines.slice(0, -1);
    copy[key] = lines.join('\n');
  }
  if (fit(copy, budget)) return copy;
  for (const key of strings) {
    let text = String(copy[key]);
    while (text.length > 40 && !fit({ ...copy, [key]: text }, budget)) text = charTail(text, Math.ceil(text.length * 0.7));
    copy[key] = text;
  }
  if (fit(copy, budget)) return copy;
  return { truncated: true, outputCallId: callId, readMore: READ_MORE, note: '结果超过长度上限，请用 read_tool_output 按窗口读取保留内容。' };
}

export function fitModelValue(value: unknown, callId: string, budget = MODEL_BUDGET): { text: string; truncated: boolean } {
  // Plain text already has its own format (browser snapshots, short status lines). Keep it when it fits so callers can still read it.
  if (typeof value === 'string') {
    if (value.length <= budget) return { text: value, truncated: false };
    const marker = { truncated: true, outputCallId: callId, readMore: READ_MORE, text: '' };
    const room = Math.max(0, budget - JSON.stringify(marker).length);
    marker.text = value.slice(0, room);
    const text = JSON.stringify(marker);
    return { text: text.length <= budget ? text : JSON.stringify({ truncated: true, outputCallId: callId, readMore: READ_MORE, note: '结果超过长度上限，请用 read_tool_output 按窗口读取保留内容。' }), truncated: true };
  }
  const direct = JSON.stringify(value);
  if (direct.length <= budget) return { text: direct, truncated: false };
  let shrunk: unknown = value;
  if (isRecord(value) && typeof value.text === 'string' && typeof value.startLine === 'number' && typeof value.path === 'string' && !('matches' in value) && !('cancelled' in value)) shrunk = shrinkFile(value, callId, budget);
  else if (isRecord(value) && typeof value.output === 'string' && 'cancelled' in value) shrunk = shrinkCommand(value, callId, budget);
  else if (isRecord(value) && Array.isArray(value.matches)) shrunk = shrinkSearch(value, callId, budget);
  else shrunk = shrinkGeneric(value, callId, budget);
  let text = JSON.stringify(shrunk);
  if (text.length > budget) text = JSON.stringify({ truncated: true, outputCallId: callId, readMore: READ_MORE, note: '结果超过长度上限，请用 read_tool_output 按窗口读取保留内容。' });
  return { text, truncated: true };
}
