import {
  mkdir,
  writeFile,
  access,
  stat,
  readFile,
  realpath,
  lstat,
} from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve, isAbsolute, dirname, sep } from "node:path";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Type } from "typebox";
import type { Skill, ToolDefinition } from "@earendil-works/pi-coding-agent";
export interface PluginDocument {
  id: string;
  version: number;
  content_hash: string;
  config: any;
}
export interface PluginSnapshot {
  runtime: "mac" | "cloud";
  dir: string;
  cwd: string;
  skills: PluginDocument[];
  mcp_servers: PluginDocument[];
  secret(name: string): Promise<string | null>;
  allowMcp?: boolean;
  platform?: string;
  path?: string;
  report?(
    doc: PluginDocument,
    state: string,
    reasons: { code: string; detail: string }[],
  ): Promise<void>;
}
export interface LoadedPlugins {
  skills: Skill[];
  tools: ToolDefinition[];
  secrets: string[];
  close(): Promise<void>;
}
export async function findCommand(
  command: string,
  path = process.env.PATH ?? "",
): Promise<boolean> {
  const paths = command.includes("/")
    ? isAbsolute(command)
      ? [command]
      : []
    : path
        .split(":")
        .filter(isAbsolute)
        .map((p) => join(p, command));
  for (const p of paths)
    try {
      await access(p, constants.X_OK);
      if ((await stat(p)).isFile()) return true;
    } catch {}
  return false;
}
export async function loadPlugins(p: PluginSnapshot): Promise<LoadedPlugins> {
  const result: LoadedPlugins = {
      skills: [],
      tools: [],
      secrets: [],
      close: async () => {
        await Promise.allSettled(clients.map((c) => c.close()));
      },
    },
    clients: Client[] = [],
    available = new Set<string>();
  const applies = (d: PluginDocument) =>
    d.config.enabled && [p.runtime, "both"].includes(d.config.runtime);
  const report = async (
    d: PluginDocument,
    state: string,
    reasons: { code: string; detail: string }[] = [],
  ) => {
    try {
      await p.report?.(d, state, reasons);
    } catch {}
  };
  for (const d of p.mcp_servers) {
    const c = d.config;
    if (!applies(d)) {
      await report(d, "not_applicable");
      continue;
    }
    if (p.allowMcp === false) continue;
    const env: Record<string, string> = {
        PATH: p.path ?? process.env.PATH ?? "",
        HOME: p.cwd,
      },
      reasons: { code: string; detail: string }[] = [];
    for (const e of c.env ?? []) {
      const value = e.secret_ref ? await p.secret(e.secret_ref) : e.value;
      if (value == null)
        reasons.push({
          code: "secret_missing",
          detail: e.secret_ref ?? e.name,
        });
      else {
        env[e.name] = value;
        if (e.secret_ref) result.secrets.push(value);
      }
    }
    if (c.transport === "stdio" && !(await findCommand(c.command, p.path)))
      reasons.push({ code: "command_missing", detail: c.command });
    if (reasons.length) {
      await report(d, "unavailable", reasons);
      continue;
    }
    const client = new Client({ name: "t-agnet", version: "0.3.0" });
    clients.push(client);
    try {
      const transport =
        c.transport === "stdio"
          ? new StdioClientTransport({
              command: c.command,
              args: c.args ?? [],
              env,
              stderr: "ignore",
              cwd: p.cwd,
            })
          : new StreamableHTTPClientTransport(new URL(c.url));
      const timeout = c.timeout_ms ?? 30000;
      await client.connect(transport, { timeout });
      const tools: any[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined, {
          timeout,
        });
        tools.push(...page.tools);
        cursor = page.nextCursor;
      } while (cursor);
      for (const tool of tools) {
        if ((c.disabled_tools ?? []).includes(tool.name)) continue;
        const name =
          `mcp_${c.name.replace(/[^a-zA-Z0-9_]/g, "_")}_${tool.name.replace(/[^a-zA-Z0-9_]/g, "_")}`.slice(
            0,
            110,
          ) +
          "_" +
          createHash("sha256")
            .update(d.id + ":" + tool.name)
            .digest("hex")
            .slice(0, 8);
        result.tools.push({
          name,
          label: `${c.name}: ${tool.name}`,
          description: tool.description ?? tool.name,
          parameters: Type.Unsafe(tool.inputSchema),
          execute: async (_id, args, signal) => {
            try {
              const response = await client.callTool(
                { name: tool.name, arguments: args as Record<string, unknown> },
                undefined,
                { timeout, signal },
              );
              return {
                content: [{ type: "text", text: JSON.stringify(response) }],
                details: {},
              };
            } catch {
              throw new Error(`MCP 工具调用失败：${c.name}`);
            }
          },
        });
      }
      available.add(c.name);
      await report(d, "available");
    } catch {
      await client.close().catch(() => {});
      await report(d, "failed", [
        { code: "invalid_config", detail: "MCP 连接或工具发现失败" },
      ]);
    }
  }
  const skillFiles = new Map<string, Map<string, string>>();
  for (const d of p.skills) {
    const c = d.config;
    if (!applies(d)) {
      await report(d, "not_applicable");
      continue;
    }
    const reasons: { code: string; detail: string }[] = [],
      requires = c.requires ?? {};
    if (
      requires.platforms?.length &&
      !requires.platforms.includes(p.platform ?? process.platform)
    )
      reasons.push({
        code: "platform_unsupported",
        detail: requires.platforms.join(","),
      });
    for (const command of requires.commands ?? [])
      if (!(await findCommand(command, p.path)))
        reasons.push({ code: "command_missing", detail: command });
    for (const name of requires.mcp ?? [])
      if (!available.has(name))
        reasons.push({ code: "mcp_unavailable", detail: name });
    for (const file of requires.scripts ?? [])
      if (!(c.files ?? []).some((f: any) => f.path === file))
        reasons.push({ code: "script_missing", detail: file });
    if (reasons.length) {
      await report(d, "unavailable", reasons);
      continue;
    }
    try {
      if (
        !/^[0-9a-f-]{36}$/i.test(d.id) ||
        !/^[0-9a-f]{64}$/.test(d.content_hash)
      )
        throw new Error();
      await mkdir(p.dir, { recursive: true, mode: 0o700 });
      const root = await realpath(p.dir);
      const dir = resolve(root, d.id, d.content_hash),
        files = new Map<string, string>([
          ["SKILL.md", c.content],
          ...(c.files ?? []).map((f: any) => [f.path, f.content]),
        ]);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      if ((await realpath(dir)) !== dir)
        throw new Error("技能目录不能包含符号链接");
      for (const [path, content] of files) {
        if (
          path.includes("\\") ||
          path.split("/").some((x) => !x || x === "." || x === "..")
        )
          throw new Error();
        const full = resolve(dir, path);
        if (!full.startsWith(dir + sep)) throw new Error();
        await mkdir(dirname(full), { recursive: true, mode: 0o700 });
        if (
          (await realpath(dirname(full))) !== dirname(full) ||
          (await lstat(full).catch(() => null))?.isSymbolicLink()
        )
          throw new Error("技能路径不能包含符号链接");
        await writeFile(full, content, { mode: 0o600 });
      }
      const filePath = join(dir, "SKILL.md");
      result.skills.push({
        name: c.name,
        description: c.description || c.name,
        filePath,
        baseDir: dir,
        disableModelInvocation: false,
        sourceInfo: {
          path: filePath,
          source: "t-agnet",
          scope: "temporary",
          origin: "package",
          baseDir: dir,
        },
      });
      skillFiles.set(c.name, files);
      await report(d, "available");
    } catch {
      await report(d, "failed", [
        { code: "write_failed", detail: "无法加载技能包" },
      ]);
    }
  }
  if (result.skills.length)
    result.tools.push({
      name: "read_skill",
      label: "读取技能",
      description:
        "读取已启用技能的 SKILL.md 或包内文件。技能脚本必须经过当前宿主的命令工具执行。",
      parameters: Type.Object({
        name: Type.String(),
        path: Type.Optional(Type.String()),
      }),
      execute: async (_id, args: any) => {
        const text = skillFiles.get(args.name)?.get(args.path ?? "SKILL.md");
        if (text === undefined) throw new Error("技能文件不可用");
        return { content: [{ type: "text", text }], details: {} };
      },
    });
  return result;
}
