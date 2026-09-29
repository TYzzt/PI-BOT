import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OutputBuffer, charTail } from './text-limit.js';

const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function toolOutputDir(dataDir: string, taskId: string) { return join(dataDir, 'coding-tool-output', taskId); }

export interface SavedOutput { callId: string; omittedChars: number; headChars: number; tailChars: number }

export function displayOutput(head: string, tail: string, omittedChars: number, limit = 64000): string {
  if (omittedChars <= 0) return head.length > limit ? charTail(head, limit) : head;
  const marker = `\n[已省略 ${omittedChars} 个字符]\n`;
  const tailPart = charTail(tail, Math.min(tail.length, 32000));
  const room = limit - marker.length - tailPart.length;
  return (room > 0 ? head.slice(0, room) : '') + marker + tailPart;
}

export function createToolOutput(dataDir: string) {
  const fileOf = (taskId: string, callId: string) => {
    if (!idPattern.test(taskId) || !idPattern.test(callId)) throw new Error('没有保留的输出');
    return join(toolOutputDir(dataDir, taskId), callId);
  };
  return {
    save(taskId: string, callId: string, text: string): SavedOutput | null {
      try {
        if (!idPattern.test(taskId) || !idPattern.test(callId)) return null;
        const file = fileOf(taskId, callId);
        if (existsSync(file)) return null;
        const buffer = new OutputBuffer();
        buffer.push(text);
        const snap = buffer.snapshot();
        mkdirSync(toolOutputDir(dataDir, taskId), { recursive: true, mode: 0o700 });
        writeFileSync(file, snap.body, { encoding: 'utf8', mode: 0o600 });
        return { callId, omittedChars: snap.omittedChars, headChars: snap.head.length, tailChars: snap.tail.length };
      } catch { return null; }
    },
    read(taskId: string, callId: string, offset = 0, maxChars = 4000) {
      const file = fileOf(taskId, callId);
      if (!existsSync(file)) throw new Error('没有保留的输出');
      const text = readFileSync(file, 'utf8');
      const start = Math.max(0, Math.floor(offset) || 0);
      const size = Math.min(12000, Math.max(1, Math.floor(maxChars) || 1));
      const slice = text.slice(start, start + size);
      const next = start + slice.length;
      return { callId, offset: start, text: slice, nextOffset: next < text.length ? next : null, totalChars: text.length, truncated: next < text.length };
    },
    removeTask(taskId: string) { if (idPattern.test(taskId)) rmSync(toolOutputDir(dataDir, taskId), { recursive: true, force: true }); },
  };
}
export type ToolOutputStore = ReturnType<typeof createToolOutput>;
