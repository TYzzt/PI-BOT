import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

/** Provider credentials and image bytes stay on the API, for both cloud and desktop. */
export function imageGenerationTools(base: string, token: () => string, runId: string, writable: boolean): ToolDefinition[] {
  const call = async (path: string, body: object, signal?: AbortSignal) => {
    const response = await fetch(`${base.replace(/\/+$/, "")}${path}`, {
      method: "POST", redirect: "error",
      headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, run_id: runId }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(195000)]) : AbortSignal.timeout(195000),
    });
    const value = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(typeof value.detail === "string" ? value.detail : "生图服务不可用，请稍后重试");
    return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: value };
  };
  const tools: ToolDefinition[] = [{
    name: "image_models", label: "查询生图模型",
    description: "查询管理员启用的生图模型和默认模型；未配置时返回空列表，不臆造可用模型。",
    parameters: Type.Object({}), execute: (_id, _args, signal) => call("/agent/image-models", {}, signal),
  }];
  if (writable) tools.push({
    name: "image_generate", label: "生成图片",
    description: "根据用户提示词生成一张图片并保存为本次任务的附件。可先用 image_models 查询，再按用户指定选择模型；省略 model 使用默认模型。可选横纵比 1:1、3:2、2:3。生成后的附件会在聊天中自动显示预览并支持下载；需要定制布局时用 show_ui 的 AuiImage.artifact_id 引用返回的 artifact.id。返回元数据不含图片字节。超时、中断或结果未确认时不要自动再次生图，避免重复计费；说明情况，等待用户明确要求重试。",
    parameters: Type.Object({ prompt: Type.String({ minLength: 1, maxLength: 8000 }),
      model: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
      aspect_ratio: Type.Optional(Type.Union(["1:1", "3:2", "2:3"].map(value => Type.Literal(value)))),
    }),
    execute: (id, args: any, signal) => call("/agent/images/generate", { ...args, request_id: id }, signal),
  });
  return tools;
}
