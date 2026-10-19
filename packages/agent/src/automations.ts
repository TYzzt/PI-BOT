import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

const schedule = Type.Union([
  Type.Object({ type: Type.Literal("adaptive") }),
  Type.Object({ type: Type.Literal("once"), at: Type.String({ description: "ISO 8601，包含时区偏移" }) }),
  Type.Object({ type: Type.Literal("interval"), minutes: Type.Integer({ minimum: 1, maximum: 525600 }) }),
  Type.Object({ type: Type.Literal("daily"), time: Type.String({ pattern: "^([01][0-9]|2[0-3]):[0-5][0-9]$" }) }),
]);
export function automationTools(baseUrl: string, token: () => string, runId: string, automatic = false): ToolDefinition[] {
  const call = async (path: string, body: object, signal?: AbortSignal) => {
    const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/agent/automations${path}`, {
      method: "POST", headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, run_id: runId }), redirect: "error",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(typeof data.detail === "string" ? data.detail : "自动工作操作失败");
    return { content: [{ type: "text" as const, text: JSON.stringify(data) }], details: {} };
  };
  if (automatic) return [{
    name: "automation_finish", label: "保存本轮自动工作结果",
    description: "自动轮次结束前必须调用一次，然后立即结束本轮。保存进度及下次唤醒；无重要变化 notify=false，重要成果、风险、决策或约定提醒才回报。同一事项同一状态使用相同 notification_key；有新证据或状态才换 key。周期性工作 complete 仅代表完成本次。",
    parameters: Type.Object({
      state: Type.Union(["continue", "wait", "complete", "waiting_user"].map(x => Type.Literal(x))),
      summary: Type.String({ minLength: 1, maxLength: 12000 }),
      next_wake_at: Type.Optional(Type.String({ description: "至少一分钟后的 ISO 8601 时间，包含时区；不传遵循委托的时间规则" })),
      notify: Type.Boolean(), reason: Type.String({ minLength: 1, maxLength: 1000 }),
      category: Type.Optional(Type.Union(["milestone", "decision", "risk", "suggestion", "reminder"].map(x => Type.Literal(x)))),
      notification_key: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
      checkpoint: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    }),
    execute: async (_id, args: any, signal) => call("/finish", { decision: args }, signal),
  }] as ToolDefinition[];
  return [{
    name: "automation_manage", label: "管理长期委托与自主巡检",
    description: "用户要求持续关注、定期检查或以后继续时建立长期委托，立即返回。先 list 避免重复。create 必须给 goal、用户授权范围 authorization、schedule。list 可查检查点和 version；修改使用 expected_version。patrol=true 操作默认巡检；all=true 仅在用户明确要求全部时使用。暂停不再新建轮次并使旧结果失效，stop 还取消执行。全部自动工作等待绑定电脑在线。",
    parameters: Type.Object({
      action: Type.Union(["list", "create", "update", "pause", "resume", "stop"].map(x => Type.Literal(x))),
      automation_id: Type.Optional(Type.String({ format: "uuid" })), patrol: Type.Optional(Type.Boolean()), all: Type.Optional(Type.Boolean()),
      title: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })), goal: Type.Optional(Type.String({ minLength: 1, maxLength: 8000 })),
      authorization: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })), schedule: Type.Optional(schedule),
      timezone: Type.Optional(Type.String({ description: "IANA 时区，默认 Asia/Shanghai" })),
      dependency_task_id: Type.Optional(Type.Union([Type.String({ format: "uuid" }), Type.Null()])),
      expected_version: Type.Optional(Type.Integer({ minimum: 1 })),
    }),
    execute: async (id, args: any, signal) => call("", { ...args, request_id: id }, signal),
  }] as ToolDefinition[];
}
