import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  applyUiMessages,
  getUiCatalog,
  UI_INSTRUCTIONS,
  type UiDocument,
} from "@pi-bot/a2ui";
export { UI_INSTRUCTIONS };
/** Stateful within one reply; identical validation is repeated by the Server before persistence. */
export function a2uiTools(
  onUi: (messages: Record<string, unknown>[]) => void | Promise<void>,
): ToolDefinition[] {
  let document: UiDocument | null = null;
  return [
    {
      name: "get_ui_catalog",
      label: "查看界面组件",
      description:
        "查看 A2UI 组件和函数目录；传 component 或 function 查看其准确 JSON Schema。创建界面前先查询所需组件参数。",
      parameters: Type.Object({
        component: Type.Optional(Type.String({ maxLength: 80 })),
        function: Type.Optional(Type.String({ maxLength: 80 })),
      }),
      execute: async (_id, args: any) => ({
        content: [
          {
            type: "text",
            text: JSON.stringify(getUiCatalog(args.component, args.function)),
          },
        ],
        details: {},
      }),
    },
    {
      name: "show_ui",
      label: "展示交互界面",
      description:
        "在电脑和手机聊天中展示或增量更新 A2UI 交互工具。messages 为 v0.9 消息数组，仅使用 get_ui_catalog 返回的目录与参数，按用户当前需求构建界面。普通问答和解释直接用文字回答。",
      parameters: Type.Object({
        messages: Type.Array(Type.Record(Type.String(), Type.Unknown()), {
          minItems: 1,
          maxItems: 20,
        }),
      }),
      execute: async (_id, args: any, signal) => {
        if (signal?.aborted) throw new Error("CANCELLED");
        const messages = args.messages;
        const next = applyUiMessages(document, messages);
        await onUi(messages);
        document = next;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: true,
                surfaces: next.surfaces.map((s) => s.id),
                revision: next.revision,
              }),
            },
          ],
          details: {},
        };
      },
    },
  ];
}
