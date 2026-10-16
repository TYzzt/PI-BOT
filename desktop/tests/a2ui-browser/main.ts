/** Development fixture only: mounts the real Mac app with a local in-memory service double. */
import {
  applyUiMessages,
  EXAMPLE,
  updateUiState,
  validateUiAction,
  type UiDocument,
} from "@pi-bot/a2ui";
import { DEFAULT_AVATAR } from "@pi-bot/bot-face";
import type {
  AppEvent,
  Message,
  Bot,
} from "../../packages/protocol/src/index.js";
const id = "12345678-1234-4234-8234-123456789000",
  messageId = "12345678-1234-4234-8234-123456789001";
const listeners = new Set<(e: AppEvent) => void>();
const now = () => new Date().toISOString();
const stored = localStorage.getItem("a2ui-test-calculator-document");
let doc: UiDocument = stored
  ? JSON.parse(stored)
  : applyUiMessages(null, EXAMPLE);
const bot: Bot = {
  id,
  name: "Pi Bot",
  slug: "pi-bot",
  persona: "正式时间线组件 · 本地测试数据",
  model_id: null,
  avatar: DEFAULT_AVATAR,
  is_main: true,
  created_at: now(),
  last_active_at: now(),
  latest_run: null,
  last_message: {
    role: "assistant",
    preview: "交互工具已生成",
    status: "completed",
    created_at: now(),
  },
  pending_approvals: [],
};
const messages: Message[] = [
  {
    id: "12345678-1234-4234-8234-123456789002",
    bot_id: id,
    run_id: null,
    seq: 1,
    role: "user",
    content: "做一个数值计算器，调整滑块时结果一起变化。",
    status: "completed",
    executor: null,
    tools: [],
    created_at: now(),
    updated_at: now(),
  },
  {
    id: messageId,
    bot_id: id,
    run_id: null,
    seq: 2,
    role: "assistant",
    content:
      "调整下面的滑块，计算结果会同步更新。也可以提交当前数值，让我继续处理。",
    status: "completed",
    executor: "mac",
    tools: [],
    ui: doc,
    created_at: now(),
    updated_at: now(),
  },
];
const persist = () => {
  localStorage.setItem("a2ui-test-calculator-document", JSON.stringify(doc));
  messages[1].ui = doc;
  messages[1].updated_at = now();
  for (const l of listeners) l({ type: "bot", bot_id: id });
};
window.agent = {
  call: async (method, input: any) => {
    switch (method) {
      case "status":
        return {
          connection: "online",
          serverUrl: "http://localhost",
          user: { id, username: "local-test", display_name: "本地验证" },
          deviceLabel: "Mac",
          libraryRoot: "~/pi-bot",
          activities: [],
        };
      case "bots":
        return { bots: [bot] };
      case "models":
        return [];
      case "messages":
        return { messages: [...messages], has_more: false };
      case "uiState":
        if (input.revision !== doc.revision) throw new Error("界面版本已变化");
        doc = updateUiState(doc, input.states);
        persist();
        return { ...messages[1] };
      case "uiAction": {
        if (input.revision !== doc.revision) throw new Error("界面版本已变化");
        doc = updateUiState(doc, input.states);
        const action = validateUiAction(doc, input.action);
        persist();
        const seq = messages.length + 1;
        const appended: Message[] = [
          {
            id: crypto.randomUUID(),
            bot_id: id,
            run_id: null,
            seq,
            role: "user",
            content: "在交互工具中选择了「交给 Bot 继续处理」",
            status: "completed",
            executor: null,
            tools: [],
            created_at: now(),
            updated_at: now(),
          },
          {
            id: crypto.randomUUID(),
            bot_id: id,
            run_id: null,
            seq: seq + 1,
            role: "assistant",
            content: `收到当前数值：${Number(action.context.amount)}。这是本地验证回复；正式运行时由 Bot 处理。`,
            status: "completed",
            executor: "mac",
            tools: [],
            created_at: now(),
            updated_at: now(),
          },
        ];
        messages.push(...appended);
        return { messages: appended };
      }
      default:
        return {};
    }
  },
  subscribe: (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  computerName: async () => "Mac",
  defaultServerUrl: async () => "http://localhost",
  openLibrary: async () => {},
  openExternal: async () => {},
};
await import("../../apps/desktop/ui/main.js");
