import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { UiView } from "../src/renderer.js";
import { validateUiDocument, type UiDocument } from "../src/index.js";
import "../src/style.css";
import "./style.css";
declare global {
  interface Window {
    PiBotUiHost?: { postMessage(value: string): void };
    piBotUi: {
      receive(value: { document: UiDocument; disabled: boolean }): void;
      respond(value: { id: string; result?: unknown; error?: string }): void;
    };
  }
}
const pending = new Map<
  string,
  {
    resolve: (v: any) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();
const post = (value: unknown) =>
  window.PiBotUiHost?.postMessage(JSON.stringify(value));
function request(type: string, payload: unknown): Promise<any> {
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("连接超时，请重试"));
    }, 20_000);
    pending.set(id, { resolve, reject, timer });
    post({ type, id, payload });
  });
}
let initial: { document: UiDocument; disabled: boolean } | null = null;
let receive: (v: { document: UiDocument; disabled: boolean }) => void = (v) => {
  initial = v;
};
window.piBotUi = {
  receive: (v) => receive(v),
  respond: (v) => {
    const p = pending.get(v.id);
    if (!p) return;
    clearTimeout(p.timer);
    pending.delete(v.id);
    if (v.error) p.reject(new Error(v.error));
    else p.resolve(v.result);
  },
};
function App() {
  const [value, setValue] = useState<{
    document: UiDocument;
    disabled: boolean;
  } | null>(initial);
  const [error, setError] = useState("");
  receive = (v) => {
    try {
      setValue({ ...v, document: validateUiDocument(v.document) });
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "界面无法显示");
    }
  };
  return error ? (
    <p role="alert">{error}</p>
  ) : value ? (
    <UiView
      document={value.document}
      disabled={value.disabled}
      save={(states, revision) => request("state", { states, revision })}
      action={(input) => request("action", input)}
    />
  ) : (
    <p className="loading">正在加载交互工具…</p>
  );
}
createRoot(document.getElementById("pi-bot-ui-root")!).render(<App />);
new ResizeObserver(() =>
  post({
    type: "height",
    height: Math.ceil(
      document.getElementById("pi-bot-ui-root")!.getBoundingClientRect().height,
    ),
  }),
).observe(document.getElementById("pi-bot-ui-root")!);
post({ type: "ready" });
