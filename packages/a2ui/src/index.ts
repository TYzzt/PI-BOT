import { z } from "zod";
import {
  MessageProcessor,
  DataContext,
  getComponentReferences,
  type ProcessableMessage,
  type ActionPayload,
} from "@a2ui/web_core/v0_9";
import { zodToJsonSchema } from "zod-to-json-schema";
import { CATALOG_ID, protocolCatalog } from "./catalog.js";
export { CATALOG_ID, protocolCatalog } from "./catalog.js";
export { calculate } from "./math.js";
export type UiComponent = {
  id: string;
  component: string;
  [key: string]: unknown;
};
export interface UiSurface {
  id: string;
  components: UiComponent[];
  data: Record<string, unknown>;
}
export interface UiDocument {
  version: "v0.9";
  catalogId: typeof CATALOG_ID;
  revision: number;
  surfaces: UiSurface[];
}
export type UiAction = Pick<
  ActionPayload,
  "name" | "surfaceId" | "sourceComponentId"
> & { context: Record<string, unknown> };
export interface UiState {
  surfaceId: string;
  data: Record<string, unknown>;
}
const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
export const uiActionSchema = z
  .object({
    name: z.string().min(1).max(80),
    surfaceId: identifier,
    sourceComponentId: identifier,
    context: z.record(z.unknown()),
  })
  .strict();
export const uiStateSchema = z
  .array(
    z.object({ surfaceId: identifier, data: z.record(z.unknown()) }).strict(),
  )
  .max(4);
export const uiBatchSchema = z.array(z.record(z.unknown())).min(1).max(20);
export const MAX_UI_BYTES = 180_000;
export function boundedJson(value: unknown, maxBytes = MAX_UI_BYTES) {
  const text = JSON.stringify(value);
  if (!text || new TextEncoder().encode(text).length > maxBytes)
    throw new Error("交互界面数据过大");
  let count = 0;
  const walk = (v: unknown, depth: number) => {
    if (depth > 40 || ++count > 12_000) throw new Error("交互界面数据过于复杂");
    if (typeof v === "number" && !Number.isFinite(v))
      throw new Error("交互界面数值无效");
    if (v && typeof v === "object")
      for (const [key, item] of Object.entries(v)) {
        if (["__proto__", "prototype", "constructor"].includes(key))
          throw new Error("交互界面数据键无效");
        walk(item, depth + 1);
      }
  };
  walk(value, 0);
  return text;
}
export function documentMessages(doc: UiDocument): ProcessableMessage[] {
  return JSON.parse(
    JSON.stringify(
      doc.surfaces.flatMap(
        (s) =>
          [
            {
              version: "v0.9",
              createSurface: {
                surfaceId: s.id,
                catalogId: CATALOG_ID,
                sendDataModel: true,
              },
            },
            {
              version: "v0.9",
              updateDataModel: { surfaceId: s.id, path: "/", value: s.data },
            },
            {
              version: "v0.9",
              updateComponents: { surfaceId: s.id, components: s.components },
            },
          ] as ProcessableMessage[],
      ),
    ),
  );
}
const allowedOps = [
  "createSurface",
  "updateComponents",
  "updateDataModel",
  "deleteSurface",
];
function assertPayloadSafe(value: unknown) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach(assertPayloadSafe);
    return;
  }
  const obj = value as Record<string, unknown>;
  if (
    typeof obj.path === "string" &&
    obj.path
      .split("/")
      .some((p) =>
        ["__proto__", "constructor", "prototype"].includes(
          p.replaceAll("~1", "/").replaceAll("~0", "~"),
        ),
      )
  )
    throw new Error("数据路径无效");
  if (typeof obj.call === "string" && !protocolCatalog.functions.has(obj.call))
    throw new Error(`不支持的界面函数：${obj.call}`);
  if (
    obj.component &&
    typeof obj.component === "string" &&
    !protocolCatalog.components.has(obj.component)
  )
    throw new Error(`不支持的界面组件：${obj.component}`);
  if (obj.component === "TextField" && obj.variant === "obscured")
    throw new Error("交互界面不能收集密码");
  if (
    typeof obj.url === "string" &&
    !/^https:\/\/[^\s]+$|^data:(image\/(png|jpeg|webp|gif)|audio\/(mpeg|wav)|video\/mp4);base64,[A-Za-z0-9+/=]+$/.test(
      obj.url,
    )
  )
    throw new Error("媒体地址无效");
  for (const v of Object.values(obj)) assertPayloadSafe(v);
}
function validateSurfaces(doc: UiDocument) {
  if (doc.surfaces.length > 4) throw new Error("每条消息最多包含 4 个交互界面");
  for (const s of doc.surfaces) {
    identifier.parse(s.id);
    if (s.components.length > 200) throw new Error("交互界面组件过多");
    const all = new Map(s.components.map((c) => [c.id, c]));
    if (all.size !== s.components.length) throw new Error("组件 ID 重复");
    for (const c of s.components) {
      identifier.parse(c.id);
      assertPayloadSafe(c);
    }
    if (!all.has("root")) throw new Error("交互界面缺少 root 组件");
    const costs = new Map<string, number>();
    const visit = (id: string, path: Set<string>, depth: number): number => {
      if (depth > 24 || path.has(id))
        throw new Error("交互界面存在循环或嵌套过深");
      const cached = costs.get(id);
      if (cached !== undefined) return cached;
      const c = all.get(id);
      if (!c) throw new Error(`交互界面引用不存在的组件：${id}`);
      const next = new Set(path).add(id);
      const template = c.children as { path?: string } | undefined;
      let factor = 1;
      if (
        template &&
        !Array.isArray(template) &&
        typeof template.path === "string"
      ) {
        const rows = template.path
          .split("/")
          .slice(1)
          .reduce<unknown>(
            (value, key) =>
              value && typeof value === "object"
                ? (value as Record<string, unknown>)[
                    key.replaceAll("~1", "/").replaceAll("~0", "~")
                  ]
                : undefined,
            s.data,
          );
        factor = Array.isArray(rows) ? rows.length : 100;
      }
      let cost = 1;
      for (const [child] of getComponentReferences(c, protocolCatalog))
        cost += visit(child, next, depth + 1) * factor;
      if (cost > 1500) throw new Error("交互界面展开后的组件过多");
      costs.set(id, cost);
      return cost;
    };
    visit("root", new Set(), 0);
    const checkArrays = (value: unknown) => {
      if (value && typeof value === "object") {
        if (Array.isArray(value) && value.length > 100)
          throw new Error("界面数据列表最多 100 项");
        Object.values(value).forEach(checkArrays);
      }
    };
    checkArrays(s.data);
  }
  boundedJson(doc);
}
/** Apply real A2UI messages and keep a bounded canonical snapshot instead of an unbounded replay log. */
export function applyUiMessages(
  previous: UiDocument | null,
  messages: unknown,
): UiDocument {
  const batch = uiBatchSchema.parse(JSON.parse(boundedJson(messages)));
  for (const m of batch) {
    if (m.version !== "v0.9" || Object.keys(m).length !== 2)
      throw new Error("仅支持 A2UI v0.9 消息");
    const op = allowedOps.find((k) => Object.hasOwn(m, k));
    if (!op) throw new Error("不支持的 A2UI 消息");
    const p = m[op] as Record<string, unknown>;
    identifier.parse(p?.surfaceId);
    if (op === "createSurface" && p.catalogId !== CATALOG_ID)
      throw new Error("组件目录不受支持");
    if (p?.catalogId && p.catalogId !== CATALOG_ID)
      throw new Error("组件目录不受支持");
    assertPayloadSafe(m);
  }
  const p = new MessageProcessor([protocolCatalog]);
  try {
    if (previous) p.processMessages(documentMessages(previous));
    p.processMessages(batch as ProcessableMessage[]);
    const doc: UiDocument = {
      version: "v0.9",
      catalogId: CATALOG_ID,
      revision: (previous?.revision ?? 0) + 1,
      surfaces: Array.from(p.getSurfaces().values()).map((s) => ({
        id: s.id,
        components: Array.from(s.componentsModel.values).map((c) => ({
          id: c.id,
          component: c.type,
          ...c.properties,
        })),
        data: s.dataModel.get("/") ?? {},
      })),
    };
    validateSurfaces(doc);
    return doc;
  } finally {
    p.dispose();
  }
}
export function validateUiDocument(value: unknown): UiDocument {
  boundedJson(value);
  const d = value as UiDocument;
  if (
    !d ||
    d.version !== "v0.9" ||
    d.catalogId !== CATALOG_ID ||
    !Number.isInteger(d.revision) ||
    d.revision < 1 ||
    !Array.isArray(d.surfaces)
  )
    throw new Error("交互界面格式无效");
  const result = applyUiMessages(null, documentMessages(d));
  result.revision = d.revision;
  return result;
}
export function updateUiState(doc: UiDocument, states: unknown): UiDocument {
  boundedJson(states, 60_000);
  const parsed = uiStateSchema.parse(states);
  if (new Set(parsed.map((s) => s.surfaceId)).size !== parsed.length)
    throw new Error("界面状态重复");
  for (const state of parsed)
    if (!doc.surfaces.some((s) => s.id === state.surfaceId))
      throw new Error("交互界面已失效");
  const next = {
    ...doc,
    revision: doc.revision + 1,
    surfaces: doc.surfaces.map((s) => ({
      ...s,
      data: parsed.find((v) => v.surfaceId === s.id)?.data ?? s.data,
    })),
  };
  validateSurfaces(next);
  return next;
}
export function validateUiAction(doc: UiDocument, input: unknown): UiAction {
  boundedJson(input, 60_000);
  const action = uiActionSchema.parse(input);
  const surface = doc.surfaces.find((s) => s.id === action.surfaceId);
  const source = surface?.components.find(
    (c) => c.id === action.sourceComponentId,
  );
  const event = (source?.action as { event?: { name?: string } } | undefined)
    ?.event;
  if (!event || event.name !== action.name)
    throw new Error("操作不属于当前交互界面");
  const processor = new MessageProcessor([protocolCatalog]);
  try {
    processor.processMessages(documentMessages(doc));
    const model = processor.getSurface(action.surfaceId)!;
    const context = new DataContext(model, "/");
    for (const check of (source!.checks ?? []) as {
      condition: unknown;
      message?: string;
    }[]) {
      if (context.resolveDynamicValue(check.condition) !== true)
        throw new Error(check.message ?? "请检查表单输入");
    }
    const resolved = context.resolveAction(
      source!.action as Record<string, unknown>,
    ) as { event?: { context?: Record<string, unknown> } };
    const canonical = { ...action, context: resolved.event?.context ?? {} };
    boundedJson(canonical, 60000);
    return canonical;
  } finally {
    processor.dispose();
  }
}
export function getUiCatalog(component?: string, fn?: string) {
  const entry = component
    ? protocolCatalog.components.get(component)
    : fn
      ? protocolCatalog.functions.get(fn)
      : undefined;
  if ((component || fn) && !entry) throw new Error("组件或函数不存在");
  const convert = zodToJsonSchema as (
    schema: unknown,
    options: unknown,
  ) => unknown;
  return entry
    ? {
        name: entry.name,
        schema: convert(entry.schema, { $refStrategy: "root" }),
      }
    : {
        catalogId: CATALOG_ID,
        version: "v0.9",
        components: [...protocolCatalog.components.keys()],
        functions: [...protocolCatalog.functions.keys()],
        instructions: UI_INSTRUCTIONS,
      };
}
export const UI_INSTRUCTIONS = `你可以用 get_ui_catalog 查看可用组件和函数的准确参数，用 show_ui 给用户展示 A2UI 交互工具。普通问答、解释和排查问题默认用文字回答；用户明确要求交互界面，或当前任务确实需要用户操作滑块、表单或方案选择时再使用。界面内容必须围绕用户当前需求，不要展示无关界面；对已有界面的追问先解释，不要重复创建。先查询要用的组件/函数参数，不要猜字段。输入绑定和操作参数绑定请使用绝对路径。界面只能使用目录 ${CATALOG_ID}，协议 v0.9。一次 show_ui 接收 messages 数组（createSurface、updateDataModel、updateComponents、deleteSurface）；必须包含完整可渲染的 root 组件和有效引用。单条回复最多 4 个 surface、每个 200 个组件，展开后的节点最多 1500 个，数据列表最多 100 项。调用同一个 surfaceId 可增量更新。绑定 {path:'/field'} 双向联动，函数 {call:'calculate',args:{expression:'amount*2',variables:{amount:{path:'/amount'}}},returnType:'number'} 在客户端实时计算，无需逐次调用模型。Chart、DataTable、Metric、Grid 是已注册扩展。按钮使用 action:{event:{name:'submit',context:{selection:{path:'/field'}}}}；用户点击后操作和当前状态会作为下一条消息交给你；这是用户输入，沿用既有权限与审批规则。不要收集密码或身份凭据。不得输出脚本、iframe 或让用户运行 HTML 代替 show_ui。媒体使用内联 data: 资源，外部地址不会载入。UI 展示成功后简短说明如何使用。`;
export const EXAMPLE = [
  {
    version: "v0.9",
    createSurface: {
      surfaceId: "calculator",
      catalogId: CATALOG_ID,
      sendDataModel: true,
    },
  },
  {
    version: "v0.9",
    updateDataModel: {
      surfaceId: "calculator",
      path: "/",
      value: { amount: 50 },
    },
  },
  {
    version: "v0.9",
    updateComponents: {
      surfaceId: "calculator",
      components: [
        {
          id: "root",
          component: "Column",
          children: ["input", "result", "submit"],
        },
        {
          id: "input",
          component: "Slider",
          label: "输入数值",
          min: 0,
          max: 100,
          value: { path: "/amount" },
        },
        {
          id: "result",
          component: "Metric",
          label: "实时计算 × 2",
          value: {
            call: "calculate",
            args: {
              expression: "amount*2",
              variables: { amount: { path: "/amount" } },
            },
            returnType: "number",
          },
        },
        {
          id: "submit",
          component: "Button",
          child: "submitText",
          variant: "primary",
          action: {
            event: { name: "submit", context: { amount: { path: "/amount" } } },
          },
        },
        { id: "submitText", component: "Text", text: "交给 Bot 继续处理" },
      ],
    },
  },
];
