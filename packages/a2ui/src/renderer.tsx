import React, { useEffect, useRef, useState } from "react";
import { A2uiSurface, createComponentImplementation } from "@a2ui/react/v0_9";
import { Catalog } from "@a2ui/web_core/v0_9";
import {
  basicCatalog,
  injectBasicCatalogStyles,
  setMarkdownRenderer,
} from "@a2ui/web_core/v0_9/basic_catalog";
import { renderMarkdown } from "@a2ui/markdown-it";
import {
  GridApi,
  MetricApi,
  ChartApi,
  TableApi,
  CATALOG_ID,
  FUNCTIONS,
} from "./catalog.js";
import { UiSession, type UiCallbacks } from "./session.js";
import type { UiDocument } from "./index.js";
export { UiSession };
let initialized = false;
function initialize() {
  if (!initialized) {
    injectBasicCatalogStyles();
    setMarkdownRenderer(renderMarkdown);
    initialized = true;
  }
}
const Grid = createComponentImplementation(GridApi, ({ props, buildChild }) => (
  <div
    className={`pi-ui-grid pi-ui-cols-${props.columns} ${props.panel ? "pi-ui-grid-panel" : ""}`}
  >
    {(props.children as (string | { id: string; basePath: string })[]).map(
      (child) => (
        <div
          key={
            typeof child === "string" ? child : `${child.id}:${child.basePath}`
          }
        >
          {typeof child === "string"
            ? buildChild(child)
            : buildChild(child.id, child.basePath)}
        </div>
      ),
    )}
  </div>
));
const Metric = createComponentImplementation(MetricApi, ({ props }) => (
  <div className={`pi-ui-metric ${props.highlight ? "pi-ui-highlight" : ""}`}>
    <span>{props.label}</span>
    <strong>
      {Number.isFinite(props.value)
        ? props.value.toLocaleString("zh-CN", { maximumFractionDigits: 1 })
        : "—"}
    </strong>
    {props.unit && <small>{props.unit}</small>}
    {props.detail && <small>{props.detail}</small>}
  </div>
));
const COLORS = [
  "#ff7a2f",
  "#318cc9",
  "#2f9e6a",
  "#bc8e2b",
  "#906ac4",
  "#db6479",
];
const Chart = createComponentImplementation(ChartApi, ({ props }) => {
  const labels = Array.isArray(props.labels) ? props.labels.slice(0, 100) : [];
  const series = props.series.map((s) => ({
    label: typeof s.label === "string" ? s.label : "",
    values: Array.isArray(s.values)
      ? s.values
          .slice(0, 100)
          .map((n) => (typeof n === "number" && Number.isFinite(n) ? n : 0))
      : [],
  }));
  const totals = series[0]?.values ?? [];
  const sum = totals.reduce((s, n) => s + Math.max(0, n), 0);
  let offset = 0;
  const max = Math.max(1, ...series.flatMap((s) => s.values));
  const min = Math.min(0, ...series.flatMap((s) => s.values));
  const range = max - min || 1;
  const x = (i: number) => 46 + ((i + 0.5) / Math.max(1, labels.length)) * 388;
  const y = (v: number) => 195 - ((v - min) / range) * 150;
  const legend =
    props.kind === "doughnut"
      ? labels.map((label, i) => ({ label, color: COLORS[i % 6] }))
      : series.map((s, i) => ({ label: s.label, color: COLORS[i % 6] }));
  return (
    <section className="pi-ui-chart">
      <h3>
        {props.title}
        {props.unit && <small> · {props.unit}</small>}
      </h3>
      {props.kind === "doughnut" ? (
        <svg
          viewBox="0 0 260 225"
          role="img"
          aria-label={labels.map((l, i) => `${l} ${totals[i] ?? 0}`).join("，")}
        >
          <g transform="rotate(-90 130 112)">
            {totals.map((n, i) => {
              const pct = sum ? (Math.max(0, n) / sum) * 100 : 0;
              const start = offset;
              offset += pct;
              return (
                <circle
                  key={i}
                  cx="130"
                  cy="112"
                  r="80"
                  fill="none"
                  stroke={COLORS[i % 6]}
                  strokeWidth="27"
                  pathLength="100"
                  strokeDasharray={`${Math.max(0, pct - 0.8)} ${100 - Math.max(0, pct - 0.8)}`}
                  strokeDashoffset={-start}
                >
                  <title>
                    {labels[i]}：{n}
                  </title>
                </circle>
              );
            })}
          </g>
          <text
            x="130"
            y="110"
            textAnchor="middle"
            className="pi-ui-chart-total"
          >
            {sum.toLocaleString("zh-CN", { maximumFractionDigits: 1 })}
          </text>
          <text x="130" y="135" textAnchor="middle">
            {props.unit ?? "合计"}
          </text>
        </svg>
      ) : (
        <svg
          viewBox="0 0 455 235"
          role="img"
          aria-label={series
            .map((s) => `${s.label}：${s.values.join("，")}`)
            .join("；")}
        >
          {[0, 0.5, 1].map((k) => (
            <g key={k}>
              <line x1="40" x2="434" y1={195 - k * 150} y2={195 - k * 150} />
              <text x="33" y={199 - k * 150} textAnchor="end">
                {(min + k * range).toLocaleString("zh-CN", {
                  maximumFractionDigits: 1,
                })}
              </text>
            </g>
          ))}
          {series.map((s, j) =>
            props.kind === "line" ? (
              <polyline
                key={j}
                points={s.values.map((n, i) => `${x(i)},${y(n)}`).join(" ")}
                fill="none"
                stroke={COLORS[j % 6]}
                strokeWidth="2.5"
              />
            ) : (
              <g key={j}>
                {s.values.map((n, i) => {
                  const w = Math.min(
                    28,
                    388 /
                      Math.max(1, labels.length) /
                      Math.max(1, series.length) -
                      3,
                  );
                  return (
                    <rect
                      key={i}
                      x={x(i) + (j - series.length / 2) * (w + 3)}
                      y={Math.min(y(n), y(0))}
                      width={Math.max(2, w)}
                      height={Math.abs(y(n) - y(0))}
                      rx="3"
                      fill={COLORS[j % 6]}
                    >
                      <title>
                        {labels[i]} · {s.label}：{n}
                        {props.unit}
                      </title>
                    </rect>
                  );
                })}
              </g>
            ),
          )}
          {labels.map(
            (label, i) =>
              (labels.length <= 10 ||
                i % Math.ceil(labels.length / 10) === 0) && (
                <text key={i} x={x(i)} y="222" textAnchor="middle">
                  {label.length > 8 ? label.slice(0, 7) + "…" : label}
                </text>
              ),
          )}
        </svg>
      )}
      <div className="pi-ui-legend">
        {legend.map((s, i) => (
          <span key={i}>
            <i style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
      </div>
    </section>
  );
});
const Table = createComponentImplementation(TableApi, ({ props }) => {
  const rows = (Array.isArray(props.rows) ? props.rows : []).slice(
    0,
    100,
  ) as Record<string, unknown>[];
  return (
    <div className="pi-ui-table">
      <table>
        {props.title && <caption>{props.title}</caption>}
        <thead>
          <tr>
            {props.columns.map((c) => (
              <th key={c.key}>{String(c.title)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {props.columns.map((c) => (
                <td key={c.key}>
                  {typeof row[c.key] === "object"
                    ? JSON.stringify(row[c.key])
                    : String(row[c.key] ?? "")}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
});
export const renderCatalog = new Catalog(
  CATALOG_ID,
  "v0.9",
  [...basicCatalog.components.values(), Grid, Metric, Chart, Table],
  FUNCTIONS,
  basicCatalog.themeSchema,
);
function UiContent({
  document,
  disabled = false,
  save,
  action,
}: { document: UiDocument; disabled?: boolean } & Pick<
  UiCallbacks,
  "save" | "action"
>) {
  initialize();
  const [, redraw] = useState(0);
  const callbacks = useRef({ save, action });
  callbacks.current = { save, action };
  const [session] = useState(
    () =>
      new UiSession(document, renderCatalog, {
        save: (...args) => callbacks.current.save(...args),
        action: (i) => callbacks.current.action(i),
      }),
  );
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    session.callbacks.changed = () => {
      if (mounted.current) redraw((n) => n + 1);
    };
    return () => {
      mounted.current = false;
      session.callbacks.changed = undefined;
      queueMicrotask(() => {
        if (!mounted.current) void session.dispose();
      });
    };
  }, [session]);
  useEffect(() => {
    session.receive(document);
  }, [session, document]);
  session.enabled = !disabled;
  return (
    <section className="pi-a2ui" aria-label="Bot 交互工具">
      <fieldset disabled={disabled || session.busy} className="pi-ui-content">
        <div {...(disabled || session.busy ? { inert: true } : {})}>
          {[...session.processor.getSurfaces().values()].map((s) => (
            <A2uiSurface key={s.id} surface={s} />
          ))}
        </div>
      </fieldset>
      {session.busy && (
        <p className="pi-ui-status" role="status">
          正在提交…
        </p>
      )}
      {session.error && (
        <div className="pi-ui-error" role="alert">
          {session.error}
          <button type="button" onClick={() => session.reload(document)}>
            重新载入
          </button>
        </div>
      )}
    </section>
  );
}

class UiGuard extends React.Component<
  { revision: number; children: React.ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidUpdate(previous: { revision: number }) {
    if (this.state.failed && previous.revision !== this.props.revision)
      this.setState({ failed: false });
  }
  render() {
    return this.state.failed ? (
      <div className="pi-ui-error" role="alert">
        交互界面无法显示，请让 Bot 修正后重新生成。
      </div>
    ) : (
      this.props.children
    );
  }
}
export function UiView(props: Parameters<typeof UiContent>[0]) {
  return (
    <UiGuard revision={props.document.revision}>
      <UiContent {...props} />
    </UiGuard>
  );
}
