import { z } from "zod";
import {
  Catalog,
  CommonSchemas,
  createFunctionImplementation,
} from "@a2ui/web_core/v0_9";
import { basicCatalog } from "@a2ui/web_core/v0_9/basic_catalog";
import { calculate } from "./math.js";
export const CATALOG_ID = "urn:pi-bot:a2ui:catalog:v1";
const N = CommonSchemas.DynamicNumber,
  S = CommonSchemas.DynamicString;
export const GridApi = {
  name: "Grid",
  schema: z
    .object({
      children: CommonSchemas.ChildList,
      columns: z.number().int().min(1).max(4).default(2),
      panel: z.boolean().optional(),
    })
    .strict(),
};
export const MetricApi = {
  name: "Metric",
  schema: z
    .object({
      label: S,
      value: N,
      unit: S.optional(),
      detail: S.optional(),
      highlight: z.boolean().optional(),
    })
    .strict(),
};
export const ChartApi = {
  name: "Chart",
  schema: z
    .object({
      title: S,
      kind: z.enum(["doughnut", "bar", "line"]),
      labels: CommonSchemas.DynamicStringList,
      series: z
        .array(
          z
            .object({
              label: S,
              values: z.union([
                z.array(N).min(1).max(100),
                CommonSchemas.DataBinding,
              ]),
            })
            .strict(),
        )
        .min(1)
        .max(6),
      unit: S.optional(),
    })
    .strict(),
};
export const TableApi = {
  name: "DataTable",
  schema: z
    .object({
      title: S.optional(),
      columns: z
        .array(z.object({ key: z.string().min(1).max(64), title: S }).strict())
        .min(1)
        .max(10),
      rows: z.union([
        z.array(z.record(z.unknown())).max(100),
        CommonSchemas.DataBinding,
      ]),
    })
    .strict(),
};
export const CUSTOM_APIS = [GridApi, MetricApi, ChartApi, TableApi];
const safeFunctions = [...basicCatalog.functions.values()].filter(
  (f) => f.name !== "openUrl",
);
export const FUNCTIONS = [
  ...safeFunctions,
  createFunctionImplementation(
    {
      name: "calculate",
      returnType: "number",
      description:
        "纯算术表达式，支持 + - * / % ^、括号及 min/max/round/floor/ceil/abs/sqrt。变量可绑定数据模型。",
      schema: z
        .object({
          expression: z.string().min(1).max(500),
          variables: z.record(N).optional(),
        })
        .strict(),
    },
    (args) => calculate(args.expression, args.variables),
  ),
  createFunctionImplementation(
    {
      name: "numberValue",
      returnType: "number",
      schema: z
        .object({
          value: z.union([S, CommonSchemas.DynamicStringList]),
          fallback: z.number().finite().default(0),
        })
        .strict(),
    },
    (args) => {
      const value = Number(
        Array.isArray(args.value) ? args.value[0] : args.value,
      );
      return Number.isFinite(value) ? value : args.fallback;
    },
  ),
  createFunctionImplementation(
    {
      name: "displayNumber",
      returnType: "string",
      schema: z
        .object({
          value: N,
          suffix: z.string().max(80).default(""),
          digits: z.number().int().min(0).max(4).default(0),
        })
        .strict(),
    },
    (args) =>
      Number.isFinite(args.value)
        ? `${args.value.toLocaleString("zh-CN", { maximumFractionDigits: args.digits })}${args.suffix}`
        : "—",
  ),
];
export const protocolCatalog = new Catalog(
  CATALOG_ID,
  "v0.9",
  [...basicCatalog.components.values(), ...CUSTOM_APIS],
  FUNCTIONS,
  basicCatalog.themeSchema,
);
