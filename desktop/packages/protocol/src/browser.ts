import { z } from 'zod';
export interface JevStatus { configured: boolean; baseUrl: string; model: string; hasKey: boolean; }
export interface BrowserStatus { executable: string | null; running: boolean; holder: { taskId: string; runId: string; since: number } | null; jev: JevStatus; }
export interface BrowserApi {
  jevGet: { input: Record<string, never>; output: JevStatus };
  jevSave: { input: { baseUrl: string; model: string; apiKey?: string }; output: JevStatus };
  jevDelete: { input: Record<string, never>; output: JevStatus };
  jevTest: { input: Record<string, never>; output: { ok: true; model: string } };
  browserStatus: { input: Record<string, never>; output: BrowserStatus };
}
export const browserSchemas = {
  jevGet: z.object({}).strict(),
  jevSave: z.object({ baseUrl: z.string().trim().url().refine(v => /^https?:\/\//.test(v), 'Base URL 必须是 http 或 https'), model: z.string().trim().min(1).max(100), apiKey: z.string().trim().min(1).max(8192).optional() }).strict(),
  jevDelete: z.object({}).strict(),
  jevTest: z.object({}).strict(),
  browserStatus: z.object({}).strict(),
} satisfies Record<keyof BrowserApi, z.ZodType>;
