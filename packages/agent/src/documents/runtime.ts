import { fork } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { DocumentJob } from "./spec.js";
/** Workers receive only file bytes and explicit specs, never server credentials. */
export function processDocument(
  job: DocumentJob,
  bytes?: Buffer,
  signal?: AbortSignal,
): Promise<any> {
  if (signal?.aborted) return Promise.reject(new Error("文档处理已取消"));
  const built = new URL("./document-worker.mjs", import.meta.url);
  const worker = existsSync(built)
    ? built
    : new URL("./document-worker.ts", import.meta.url);
  return new Promise((resolve, reject) => {
    const child = fork(fileURLToPath(worker), [], {
      execArgv: [
        "--max-old-space-size=256",
        ...(worker === built ? [] : ["--import", "tsx"]),
      ],
      serialization: "advanced",
      windowsHide: true,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      env: {
        SystemRoot: process.env.SystemRoot,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
        PATH: process.env.PATH,
      },
    });
    let settled = false;
    const finish = (error?: Error, result?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      child.kill();
      error ? reject(error) : resolve(result);
    };
    const abort = () => finish(new Error("文档处理已取消"));
    const timer = setTimeout(
      () => finish(new Error("文档处理超时或超过资源限制")),
      30000,
    );
    signal?.addEventListener("abort", abort, { once: true });
    child.once("error", (e) => finish(e));
    child.once("exit", () =>
      finish(new Error("文档处理进程退出，文件可能过大或损坏")),
    );
    child.once("message", (m: any) =>
      m.ok ? finish(undefined, m.result) : finish(new Error(m.error)),
    );
    child.send({ job, bytes }, (error) => {
      if (error) finish(error);
    });
  });
}
