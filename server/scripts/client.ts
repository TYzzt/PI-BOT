import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
export async function password() {
  if (process.env.T_AGNET_CLIENT_PASSWORD)
    return process.env.T_AGNET_CLIENT_PASSWORD;
  const muted = new Writable({
      write(_chunk, _encoding, done) {
        done();
      },
    }),
    rl = createInterface({
      input: process.stdin,
      output: muted,
      terminal: true,
    });
  process.stdout.write("管理员密码：");
  try {
    return await rl.question("");
  } finally {
    rl.close();
    process.stdout.write("\n");
  }
}
export function safeUrl(value: string) {
  const u = new URL(value);
  if (
    u.protocol !== "https:" &&
    !(
      u.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)
    )
  )
    throw new Error("非本机地址必须使用 HTTPS");
  if (u.username || u.password) throw new Error("URL 不得含凭据");
  return value.replace(/\/$/, "");
}
export async function jsonRequest(
  base: string,
  path: string,
  method = "GET",
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const r = await fetch(base + path, {
    method,
    headers: {
      ...headers,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error(`请求失败（${r.status}）`);
  return r.json() as Promise<any>;
}
