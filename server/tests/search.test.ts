import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { settings } from "../src/config.js";
import { WebSearch } from "../src/search.js";
import { HttpError } from "../src/db.js";

const config = (url?: string) => settings({ PI_BOT_DATABASE_URL: "unused", PI_BOT_JWT_SECRET: "j".repeat(40), PI_BOT_SEARXNG_URL: url });

test("search normalizes safe links, bounds results and caches successful queries per language", async () => {
  let requests = 0;
  const server = createServer((req, res) => {
    requests++;
    const url = new URL(req.url!, "http://localhost");
    assert.equal(url.pathname, "/search");
    assert.equal(url.searchParams.get("q"), "中文 & site:gov.cn");
    assert.equal(url.searchParams.get("format"), "json");
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ results: [
      { title: "<b>原文</b>", url: "https://example.com/1", content: "<em>摘要</em>" },
      { title: "重复", url: "https://example.com/1" },
      { url: "javascript:alert(1)" }, { url: "https://user:password@example.com" },
      ...Array.from({ length: 15 }, (_, i) => ({ title: `结果${i}`, url: `https://example.com/page/${i}`, content: "x".repeat(3000) })),
    ], unresponsive_engines: [["brave", "blocked"]] }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const gateway = new WebSearch(config(`http://127.0.0.1:${(server.address() as any).port}`));
  try {
    const page = await gateway.search("中文 & site:gov.cn", "zh-CN");
    assert.equal(page.results.length, 8);
    assert.deepEqual(page.results[0], { title: "原文", url: "https://example.com/1", content: "摘要" });
    assert.equal(page.results[1].content.length, 2000);
    assert.equal(page.warnings.length, 1);
    assert.deepEqual(await gateway.search("中文 & site:gov.cn", "zh-CN"), page);
    assert.equal(requests, 1);
    await gateway.search("中文 & site:gov.cn", "en");
    assert.equal(requests, 2);
  } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
});

test("missing configuration and failed upstream searches give useful errors instead of empty success", async () => {
  await assert.rejects(new WebSearch(config()).search("query", "auto"), error => error instanceof HttpError && error.status === 503);
  let mode = "unreachable";
  const server = createServer((_req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(mode === "unreachable" ? JSON.stringify({ results: [], unresponsive_engines: [["bing", "timeout"]] }) : "{}");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const gateway = new WebSearch(config(`http://127.0.0.1:${(server.address() as any).port}`));
  try {
    await assert.rejects(gateway.search("query", "auto"), /搜索源暂时无法访问/);
    mode = "malformed";
    await assert.rejects(gateway.search("query", "auto"), /返回格式异常/);
    await assert.rejects(gateway.search("query", "auto", AbortSignal.abort()), /连接失败/);
  } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
});
