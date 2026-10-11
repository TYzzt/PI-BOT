import { createServer, type IncomingMessage } from "node:http";
import { generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import WebSocket from "ws";
import { sha256 } from "../src/security.js";

export const TEST_DB = process.env.PI_BOT_TEST_DATABASE_URL;

export async function resetDatabase(url: string) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  await c.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await c.end();
}

export function tempDir() {
  const path = mkdtempSync(join(tmpdir(), "pi-bot-test-"));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}
export function vaultFile(dir: string) {
  const id = randomUUID(),
    path = join(dir, "vault.json");
  writeFileSync(path, JSON.stringify({ active: id, keys: { [id]: randomBytes(32).toString("base64") } }));
  return path;
}

async function body(req: IncomingMessage) {
  let text = "";
  for await (const chunk of req) text += chunk;
  return text ? JSON.parse(text) : {};
}
/** OpenAI-compatible provider double that records what the proxy forwarded. */
export async function mockProvider() {
  const requests: { headers: IncomingMessage["headers"]; body: any }[] = [];
  const server = createServer(async (req, res) => {
    if (req.url !== "/v1/chat/completions") return void res.writeHead(404).end();
    const json = await body(req);
    requests.push({ headers: req.headers, body: json });
    const text = (c: any): string => (Array.isArray(c) ? c.map((p) => p.text ?? "").join("") : String(c ?? ""));
    const last = text(json.messages.filter((m: any) => m.role === "user").at(-1)?.content);
    const all = JSON.stringify(json.messages);
    const answer = last.includes("新增对话")
      ? "用户喜欢蓝鲸。"
      : last.includes("记住")
        ? "好的，我记住了蓝鲸。"
        : last.includes("之前")
          ? all.includes("蓝鲸") ? "你之前说的是蓝鲸。" : "没有记录。"
          : `收到：${last.slice(0, 20)}`;
    if (!json.stream) {
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: answer } }], usage: { prompt_tokens: 11, completion_tokens: 3 } }));
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (delta: object, finish: string | null = null) =>
      res.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 1, model: json.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    for (const piece of Array.from(answer)) chunk({ content: piece });
    chunk({}, "stop");
    res.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 1, model: json.model, choices: [], usage: { prompt_tokens: 42, completion_tokens: answer.length } })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

export function deviceKeys() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  let id = "";
  return {
    publicKey: raw.toString("base64"),
    setId: (value: string) => void (id = value),
    headers(method: string, path: string, payload = "") {
      const timestamp = String(Math.floor(Date.now() / 1000)),
        nonce = randomBytes(16).toString("hex");
      const signature = sign(null, Buffer.from(`${timestamp}.${nonce}.${method}.${path}.${sha256(payload)}`), privateKey).toString("base64");
      return {
        "x-pibot-device-id": id,
        "x-pibot-timestamp": timestamp,
        "x-pibot-nonce": nonce,
        "x-pibot-signature": signature,
      };
    },
  };
}

/** Collects JSON frames from a socket so tests can await specific messages. */
export function socket(url: string, headers: Record<string, string>) {
  const ws = new WebSocket(url, { headers });
  const frames: any[] = [];
  const waiters: { match: (m: any) => boolean; resolve: (m: any) => void }[] = [];
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    frames.push(m);
    for (const w of [...waiters])
      if (w.match(m)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(m);
      }
  });
  const closed = new Promise<number>((r) => ws.on("close", (code) => r(code)));
  return {
    ws,
    frames,
    closed,
    send: (m: object) => ws.send(JSON.stringify(m)),
    next(match: (m: any) => boolean, timeout = 10000) {
      const found = frames.find(match);
      if (found) {
        frames.splice(frames.indexOf(found), 1);
        return Promise.resolve(found);
      }
      return new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("等待 WebSocket 消息超时")), timeout);
        waiters.push({ match, resolve: (m) => { clearTimeout(timer); frames.splice(frames.indexOf(m), 1); resolve(m); } });
      });
    },
    close: () => ws.close(),
  };
}

export async function eventually<T>(fn: () => Promise<T | undefined | false> | T | undefined | false, timeout = 10000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value as T;
    if (Date.now() - start > timeout) throw new Error("等待条件超时");
    await new Promise((r) => setTimeout(r, 50));
  }
}
