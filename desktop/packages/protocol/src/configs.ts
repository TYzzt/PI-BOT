import { z } from 'zod';
export type ConfigRuntime = 'mac' | 'cloud' | 'both';
export type ConfigState = 'pending' | 'available' | 'unavailable' | 'not_applicable' | 'failed';
export type ReasonCode = 'command_missing' | 'platform_unsupported' | 'script_missing' | 'mcp_missing' | 'mcp_unavailable' | 'secret_missing' | 'invalid_config' | 'write_failed';
export interface ConfigReason { code: ReasonCode; detail: string; }
export interface SkillConfig { name: string; description: string; content: string; files: { path: string; content: string }[]; runtime: ConfigRuntime; enabled: boolean; requires: { commands: string[]; platforms: ('darwin' | 'linux' | 'win32')[]; scripts: string[]; mcp: string[] }; installHint: string | null; }
export interface McpEnv { name: string; value: string | null; secretRef: string | null; }
export interface McpConfig { name: string; transport: 'stdio' | 'http'; command: string | null; args: string[]; url: string | null; timeoutMs: number; env: McpEnv[]; runtime: ConfigRuntime; enabled: boolean; disabledTools: string[]; }
export interface DeviceConfigState { deviceId: string; label: string; state: ConfigState; checkedVersion: number; appliedVersion: number; reasons: ConfigReason[]; }
// This Mac's own check. activeVersion is the last version that passed; a failing newer version never replaces it.
export interface LocalConfigState { state: ConfigState; reasons: ConfigReason[]; checkedVersion: number; activeVersion: number; activeHash: string | null; }
export interface ConfigItem<T> { id: string; version: number; hash: string; config: T; local: LocalConfigState; devices: DeviceConfigState[]; cloud?: { state: ConfigState; checkedVersion: number; reasons: ConfigReason[] }; }
export interface ConfigListing { paired: boolean; connected: boolean; syncedAt: number | null; error?: string; skills: ConfigItem<SkillConfig>[]; mcpServers: ConfigItem<McpConfig>[]; secrets: { name: string; present: boolean }[]; }
export interface ConfigApi {
  configList: { input: Record<string, never>; output: ConfigListing };
  configSkillPut: { input: { id: string; expectedVersion: number; requestId: string; config: SkillConfig }; output: ConfigListing };
  configMcpPut: { input: { id: string; expectedVersion: number; requestId: string; config: McpConfig }; output: ConfigListing };
  configDelete: { input: { kind: 'skill' | 'mcp'; id: string; expectedVersion: number; requestId: string }; output: ConfigListing };
  configRecheck: { input: Record<string, never>; output: ConfigListing };
  configSecretSet: { input: { name: string; value: string }; output: ConfigListing };
  configSecretDelete: { input: { name: string }; output: ConfigListing };
}
const id = z.string().uuid();
const name = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, '名称只能包含字母、数字、点、下划线和连字符');
const path = z.string().min(1).max(200).refine(v => !v.startsWith('/') && !v.includes('\\') && v !== 'SKILL.md' && v.split('/').every(p => p && p !== '.' && p !== '..'), '文件路径必须是包内相对路径，且不能是 SKILL.md');
const runtime = z.enum(['mac', 'cloud', 'both']);
const SECRET_LIKE = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL/i;
export const skillConfig = z.object({
  name, description: z.string().max(500), content: z.string().min(1, 'SKILL.md 不能为空').max(200_000),
  files: z.array(z.object({ path, content: z.string().max(200_000) }).strict()).max(20), runtime, enabled: z.boolean(),
  requires: z.object({ commands: z.array(z.string().regex(/^[A-Za-z0-9._+-]{1,64}$/, '命令名只能是单个可执行文件名')).max(20), platforms: z.array(z.enum(['darwin', 'linux', 'win32'])).max(3), scripts: z.array(path).max(20), mcp: z.array(name).max(20) }).strict(),
  installHint: z.string().max(4000).nullable(),
}).strict().refine(v => v.requires.scripts.every(s => v.files.some(f => f.path === s)), '声明的脚本必须包含在技能包文件中')
  .refine(v => new Set(v.files.map(f => f.path)).size === v.files.length, '文件路径重复');
export const mcpConfig = z.object({
  name, transport: z.enum(['stdio', 'http']), command: z.string().min(1).max(500).nullable(), args: z.array(z.string().max(2000)).max(50), url: z.string().url().nullable(),
  timeoutMs: z.number().int().min(1000).max(600000),
  env: z.array(z.object({ name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/, '环境变量名无效'), value: z.string().max(4000).nullable(), secretRef: name.nullable() }).strict()
    .refine(e => (e.value === null) !== (e.secretRef === null), '环境变量需在明文值与 secret 引用中二选一')
    .refine(e => e.value === null || !SECRET_LIKE.test(e.name), '疑似密钥的环境变量请改用 secret 引用')).max(50),
  runtime, enabled: z.boolean(), disabledTools: z.array(z.string().max(200)).max(200),
}).strict().refine(v => v.transport === 'stdio' ? !!v.command && !v.url : !!v.url && !v.command && v.args.length === 0, 'stdio 需要命令且不填 URL；HTTP 需要 URL 且不填命令');
export const configSchemas = {
  configList: z.object({}).strict(),
  configSkillPut: z.object({ id, expectedVersion: z.number().int().min(0), requestId: id, config: skillConfig }).strict(),
  configMcpPut: z.object({ id, expectedVersion: z.number().int().min(0), requestId: id, config: mcpConfig }).strict(),
  configDelete: z.object({ kind: z.enum(['skill', 'mcp']), id, expectedVersion: z.number().int().min(1), requestId: id }).strict(),
  configRecheck: z.object({}).strict(),
  configSecretSet: z.object({ name, value: z.string().min(1).max(8192) }).strict(),
  configSecretDelete: z.object({ name }).strict(),
} satisfies Record<keyof ConfigApi, z.ZodType>;
