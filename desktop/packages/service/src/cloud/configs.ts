import { access, stat, mkdir, writeFile, rename, rm, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve, sep, isAbsolute, dirname } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Credentials } from '../keychain.js';
import type { Api, ConfigItem, ConfigListing, ConfigReason, ConfigState, LocalConfigState, McpConfig, SkillConfig } from '../../../protocol/src/index.js';
import { CloudHttpError, CloudNetworkError } from './client.js';

// Static checks only. Nothing from a synced package is ever executed here: no install hint, no script, no MCP command.
export type ConfigMethod = keyof Pick<Api, 'configList' | 'configSkillPut' | 'configMcpPut' | 'configDelete' | 'configRecheck' | 'configSecretSet' | 'configSecretDelete'>;
export const configMethods: ReadonlySet<string> = new Set<ConfigMethod>(['configList', 'configSkillPut', 'configMcpPut', 'configDelete', 'configRecheck', 'configSecretSet', 'configSecretDelete']);
export interface ConfigHost { paired(): boolean; connected(): boolean; request<T>(method: string, path: string, body?: unknown): Promise<T>; keys: Credentials; db: DatabaseSync; dir: string; emit(): void; env?: { path?: string; platform?: string }; }
const EXTRA_BIN = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];
export const secretAccount = (name: string) => `mcp-secret:${name}`;

const toSkill = (c: any): SkillConfig => ({ name: c.name, description: c.description ?? '', content: c.content, files: c.files ?? [], runtime: c.runtime, enabled: c.enabled, requires: { commands: c.requires?.commands ?? [], platforms: c.requires?.platforms ?? [], scripts: c.requires?.scripts ?? [], mcp: c.requires?.mcp ?? [] }, installHint: c.install_hint ?? null });
const fromSkill = (c: SkillConfig) => ({ name: c.name, description: c.description, content: c.content, files: c.files, runtime: c.runtime, enabled: c.enabled, requires: c.requires, install_hint: c.installHint });
const toMcp = (c: any): McpConfig => ({ name: c.name, transport: c.transport, command: c.command ?? null, args: c.args ?? [], url: c.url ?? null, timeoutMs: c.timeout_ms, env: (c.env ?? []).map((e: any) => ({ name: e.name, value: e.value ?? null, secretRef: e.secret_ref ?? null })), runtime: c.runtime, enabled: c.enabled, disabledTools: c.disabled_tools ?? [] });
const fromMcp = (c: McpConfig) => ({ name: c.name, transport: c.transport, command: c.command, args: c.args, url: c.url, timeout_ms: c.timeoutMs, env: c.env.map(e => ({ name: e.name, value: e.value, secret_ref: e.secretRef })), runtime: c.runtime, enabled: c.enabled, disabled_tools: c.disabledTools });
const devices = (d: any) => (d.devices ?? []).map((x: any) => ({ deviceId: x.device_id, label: x.label, state: x.state, checkedVersion: x.checked_version, appliedVersion: x.applied_version, reasons: x.reasons }));
interface Check { state: ConfigState; reasons: ConfigReason[]; }

export class ConfigSync {
  private timer?: NodeJS.Timeout; private stopped = false; private running?: Promise<void>; private error?: string; private syncedAt: number | null = null;
  constructor(private h: ConfigHost, private intervalMs = 5000) { this.timer = setTimeout(() => void this.tick(), 500); }
  async stop() { this.stopped = true; clearTimeout(this.timer); await this.running?.catch(() => {}); }

  private get(kind: string, id: string): any { return JSON.parse((this.h.db.prepare('SELECT data FROM shared_state WHERE kind=? AND id=?').get(kind, id) as any)?.data ?? 'null'); }
  private put(kind: string, id: string, data: any) { this.h.db.prepare('INSERT INTO shared_state VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data').run(kind, id, JSON.stringify(data)); }
  private drop(kind: string, id: string) { this.h.db.prepare('DELETE FROM shared_state WHERE kind=? AND id=?').run(kind, id); }
  private all(kind: string): { id: string; data: any }[] { return (this.h.db.prepare('SELECT id,data FROM shared_state WHERE kind=?').all(kind) as any[]).map(r => ({ id: r.id, data: JSON.parse(r.data) })); }
  private bundle(): { skills: any[]; mcp_servers: any[] } { return this.get('cfg-bundle', 'current') ?? { skills: [], mcp_servers: [] }; }

  private async tick() {
    if (this.stopped) return;
    try { if (this.h.paired() && this.h.connected()) await this.serial(() => this.pull(false)); }
    catch (e) { this.error = e instanceof CloudHttpError ? `配置同步被拒绝（${e.status}）` : '配置同步暂时失败，将自动重试'; }
    finally { if (!this.stopped) this.timer = setTimeout(() => void this.tick(), this.intervalMs); }
  }
  private async serial(fn: () => Promise<void>) { while (this.running) await this.running.catch(() => {}); this.running = fn(); try { await this.running; } finally { this.running = undefined; } }

  async pull(force: boolean) {
    const next = await this.h.request<{ skills: any[]; mcp_servers: any[] }>('GET', '/device/configs/bundle');
    const changed = JSON.stringify(next) !== JSON.stringify(this.bundle());
    this.put('cfg-bundle', 'current', next); this.error = undefined; this.syncedAt = Date.now();
    if (changed || force) await this.evaluate(force);
    if (changed || force) this.h.emit();
  }

  async evaluate(force: boolean) {
    const b = this.bundle(); const platform = this.h.env?.platform ?? process.platform;
    const secretNames = new Set(b.mcp_servers.flatMap(m => (m.config.env ?? []).map((e: any) => e.secret_ref).filter(Boolean)));
    for (const n of secretNames) if (force || this.get('cfg-secret', n) === null) this.put('cfg-secret', n, { present: !!(await this.h.keys.get(secretAccount(n)).catch(() => null)) });
    const mcpState = new Map<string, { enabled: boolean; runtime: string; check: Check }>();
    for (const m of b.mcp_servers) {
      const check = await this.checkMcp(toMcp(m.config));
      mcpState.set(m.config.name, { enabled: m.config.enabled, runtime: m.config.runtime, check });
      await this.record('mcp', m, check);
    }
    for (const s of b.skills) await this.record('skill', s, await this.checkSkill(toSkill(s.config), platform, mcpState));
    const live = new Set([...b.skills, ...b.mcp_servers].map(d => d.id));
    for (const { id } of this.all('cfg')) if (!live.has(id)) { this.drop('cfg', id); await rm(join(this.h.dir, id), { recursive: true, force: true }); }
  }

  private async record(kind: 'skill' | 'mcp', d: any, check: Check) {
    const prev: LocalConfigState & { reported?: string } = this.get('cfg', d.id) ?? { state: 'pending', reasons: [], checkedVersion: 0, activeVersion: 0, activeHash: null };
    let next: LocalConfigState = { ...prev, state: check.state, reasons: check.reasons, checkedVersion: d.version };
    if (check.state === 'available' || check.state === 'not_applicable') {
      if (kind === 'skill' && check.state === 'available') {
        try { await this.materialize(d.id, d.content_hash, toSkill(d.config)); }
        catch { next = { ...next, state: 'failed', reasons: [{ code: 'write_failed', detail: '无法写入技能包目录' }] }; }
      }
      if (next.state !== 'failed') next = { ...next, activeVersion: d.version, activeHash: d.content_hash };
    }
    const report = JSON.stringify([d.version, d.content_hash, next.state, next.reasons]);
    this.put('cfg', d.id, { ...next, reported: prev.reported });
    if (prev.reported === report) return;
    try {
      const updated = await this.h.request<any>('POST', `/device/configs/${kind === 'skill' ? 'skills' : 'mcp-servers'}/${d.id}/applied`, { version: d.version, hash: d.content_hash, state: next.state, reasons: next.reasons });
      this.put('cfg', d.id, { ...next, reported: report });
      const b = this.bundle(), list = kind === 'skill' ? b.skills : b.mcp_servers, i = list.findIndex(x => x.id === d.id);
      if (i >= 0 && updated?.id === d.id) { list[i] = updated; this.put('cfg-bundle', 'current', b); }
    } catch (e) { if (!(e instanceof CloudHttpError && e.status === 409)) throw e; }
  }

  private async materialize(id: string, hash: string, skill: SkillConfig) {
    const root = join(this.h.dir, id), target = join(root, hash);
    if (!(await stat(target).catch(() => null))) {
      const tmp = join(root, `.tmp-${hash}`); await rm(tmp, { recursive: true, force: true }); await mkdir(tmp, { recursive: true, mode: 0o755 });
      for (const f of [{ path: 'SKILL.md', content: skill.content }, ...skill.files]) {
        const file = resolve(tmp, f.path);
        if (!file.startsWith(tmp + sep)) throw new Error('invalid path');
        await mkdir(dirname(file), { recursive: true, mode: 0o755 });
        // Scripts are stored as data: no executable bit, so nothing synced can be launched by accident.
        await writeFile(file, f.content, { mode: 0o644 });
      }
      await rename(tmp, target);
    }
    for (const entry of await readdir(root)) if (entry !== hash) await rm(join(root, entry), { recursive: true, force: true });
  }

  async findCommand(command: string): Promise<boolean> {
    const executable = async (p: string) => { try { await access(p, constants.X_OK); return (await stat(p)).isFile(); } catch { return false; } };
    if (command.includes('/')) return isAbsolute(command) && executable(command);
    const dirs = [...new Set([...(this.h.env?.path ?? process.env.PATH ?? '').split(':'), ...(this.h.env?.path !== undefined ? [] : EXTRA_BIN)])].filter(d => isAbsolute(d));
    for (const d of dirs) if (await executable(join(d, command))) return true;
    return false;
  }

  private async checkMcp(m: McpConfig): Promise<Check> {
    if (m.runtime === 'cloud') return { state: 'not_applicable', reasons: [] };
    const reasons: ConfigReason[] = [];
    if (m.transport === 'stdio') {
      if (!m.command) reasons.push({ code: 'invalid_config', detail: '缺少命令' });
      else if (m.command.includes('/') && !isAbsolute(m.command)) reasons.push({ code: 'invalid_config', detail: `命令需为绝对路径或 PATH 中的名称：${m.command}` });
      else if (!(await this.findCommand(m.command))) reasons.push({ code: 'command_missing', detail: m.command });
    } else {
      try { const u = new URL(m.url ?? ''); if (!['http:', 'https:'].includes(u.protocol)) throw new Error(); } catch { reasons.push({ code: 'invalid_config', detail: 'URL 无效' }); }
    }
    for (const e of m.env) if (e.secretRef && !this.get('cfg-secret', e.secretRef)?.present) reasons.push({ code: 'secret_missing', detail: e.secretRef });
    return { state: reasons.length ? 'unavailable' : 'available', reasons };
  }

  private async checkSkill(s: SkillConfig, platform: string, mcp: Map<string, { enabled: boolean; runtime: string; check: Check }>): Promise<Check> {
    if (s.runtime === 'cloud') return { state: 'not_applicable', reasons: [] };
    const reasons: ConfigReason[] = [];
    if (s.requires.platforms.length && !s.requires.platforms.includes(platform as never)) reasons.push({ code: 'platform_unsupported', detail: `仅支持 ${s.requires.platforms.join('、')}` });
    for (const c of s.requires.commands) if (!(await this.findCommand(c))) reasons.push({ code: 'command_missing', detail: c });
    for (const p of s.requires.scripts) if (!s.files.some(f => f.path === p)) reasons.push({ code: 'script_missing', detail: p });
    for (const n of s.requires.mcp) {
      const m = mcp.get(n);
      if (!m) reasons.push({ code: 'mcp_missing', detail: n });
      else if (!m.enabled) reasons.push({ code: 'mcp_unavailable', detail: `${n} 已停用` });
      else if (m.runtime === 'cloud') reasons.push({ code: 'mcp_unavailable', detail: `${n} 只在云端运行` });
      else if (m.check.state !== 'available') reasons.push({ code: 'mcp_unavailable', detail: n });
    }
    return { state: reasons.length ? 'unavailable' : 'available', reasons };
  }

  listing(): ConfigListing {
    const b = this.bundle();
    const item = <T>(d: any, config: T): ConfigItem<T> => {
      const { reported: _r, ...local } = this.get('cfg', d.id) ?? { state: 'pending', reasons: [], checkedVersion: 0, activeVersion: 0, activeHash: null };
      return { id: d.id, version: d.version, hash: d.content_hash, config, local: local.checkedVersion === d.version ? local : { ...local, state: 'pending', reasons: [] }, devices: devices(d) };
    };
    return {
      paired: this.h.paired(), connected: this.h.connected(), syncedAt: this.syncedAt, error: this.error,
      skills: b.skills.map(d => item(d, toSkill(d.config))), mcpServers: b.mcp_servers.map(d => item(d, toMcp(d.config))),
      secrets: this.all('cfg-secret').map(r => ({ name: r.id, present: !!r.data.present })).sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  async dispatch<M extends ConfigMethod>(method: M, input: Api[M]['input']): Promise<Api[M]['output']> {
    const data = input as any;
    switch (method) {
      case 'configList': return this.listing();
      case 'configRecheck': await this.online(() => this.serial(() => this.pull(true))); return this.listing();
      case 'configSecretSet': await this.h.keys.set(secretAccount(data.name), data.value); this.put('cfg-secret', data.name, { present: true }); await this.serial(() => this.evaluate(false)).catch(() => {}); this.h.emit(); return this.listing();
      case 'configSecretDelete': await this.h.keys.delete(secretAccount(data.name)); this.put('cfg-secret', data.name, { present: false }); await this.serial(() => this.evaluate(false)).catch(() => {}); this.h.emit(); return this.listing();
      case 'configSkillPut': return this.write('PUT', `/device/configs/skills/${data.id}`, { expected_version: data.expectedVersion, request_id: data.requestId, config: fromSkill(data.config) });
      case 'configMcpPut': return this.write('PUT', `/device/configs/mcp-servers/${data.id}`, { expected_version: data.expectedVersion, request_id: data.requestId, config: fromMcp(data.config) });
      case 'configDelete': return this.write('POST', `/device/configs/${data.kind === 'skill' ? 'skills' : 'mcp-servers'}/${data.id}/delete`, { expected_version: data.expectedVersion, request_id: data.requestId });
    }
    throw new Error('不支持的请求');
  }

  private async online(fn: () => Promise<void>) {
    if (!this.h.paired()) throw new Error('Skills 与 MCP 配置需要先配对云端');
    try { await fn(); }
    catch (e) { if (e instanceof CloudNetworkError) throw new Error('修改共享配置需要连接云端，请检查网络后重试'); throw e; }
  }
  private async write(method: string, path: string, body: unknown): Promise<ConfigListing> {
    await this.online(async () => {
      try { await this.h.request(method, path, body); }
      catch (e) {
        if (e instanceof CloudHttpError && e.status === 409 && e.message !== '名称已存在') { await this.serial(() => this.pull(true)).catch(() => {}); throw new Error('配置已被其他端修改，已刷新到最新版本，请重新编辑'); }
        if (e instanceof CloudHttpError && e.status === 410) { await this.serial(() => this.pull(true)).catch(() => {}); throw new Error('配置已被删除'); }
        throw e;
      }
      await this.serial(() => this.pull(true));
    });
    return this.listing();
  }
}
