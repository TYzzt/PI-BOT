import test from "node:test";
import assert from "node:assert/strict";
import { settings } from "../src/config.js";
import { WebSearch, searchAvailable, SEARCH_QUOTA_REACHED } from "../src/search.js";
import { HttpError } from "../src/db.js";

const config = (key = "tvly-test-secret") => settings({
  PI_BOT_DATABASE_URL: "unused", PI_BOT_JWT_SECRET: "j".repeat(40), PI_BOT_TAVILY_API_KEY: key,
});
const result = { results: [{ title: "原文", url: "https://example.com/1", content: "摘要" }] };
const quota = (used = 0, limit = 1000, keyLimit: number | null = null, keyUsed = used) => ({
  key: { usage: keyUsed, limit: keyLimit },
  account: { current_plan: "Researcher", plan_usage: used, plan_limit: limit, paygo_usage: 0, paygo_limit: 1000 },
});
const reached = (error: unknown) => error instanceof HttpError && error.status === 402 && error.detail === SEARCH_QUOTA_REACHED;

function fixture() {
  let now = 1_000_000;
  const calls: { url: string; init?: RequestInit }[] = [];
  const state = {
    usage: quota(), usageStatus: 200, usageBody: undefined as unknown,
    searchBody: result as unknown, searchStatus: 200,
    searchWait: undefined as Promise<void> | undefined,
  };
  const request: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    assert.equal(new URL(url).origin, "https://api.tavily.com");
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer tvly-test-secret");
    init?.signal?.throwIfAborted();
    if (url.endsWith("/usage")) return Response.json(state.usageBody ?? state.usage, { status: state.usageStatus });
    if (state.searchWait) await state.searchWait;
    return Response.json(state.searchBody, { status: state.searchStatus });
  };
  return {
    gateway: new WebSearch(config(), request, () => now), state, calls,
    searches: () => calls.filter(c => c.url.endsWith("/search")),
    advance: () => { now += 60_001; },
  };
}

test("only an env Tavily key enables SaaS search; missing keys never make requests", async () => {
  let requests = 0;
  const gateway = new WebSearch(config(""), async () => { requests++; throw new Error("unexpected"); });
  assert.equal(searchAvailable(config("")), false);
  assert.equal(searchAvailable(settings({ PI_BOT_DATABASE_URL: "unused", PI_BOT_JWT_SECRET: "j".repeat(40), PI_BOT_SEARXNG_URL: "http://legacy" })), false);
  assert.equal(config("  tvly-trimmed  ").tavilyKey, "tvly-trimmed");
  assert.equal((await gateway.usage()).status, "not_configured");
  await assert.rejects(gateway.search("query", "auto"), error => error instanceof HttpError && error.status === 503);
  assert.equal(requests, 0);
});

test("fast SaaS search bounds safe results, forwards language and caches without charging twice", async () => {
  const f = fixture();
  f.state.searchBody = { results: [
    { title: "<b>原文</b>", url: "https://example.com/1", content: "<em>摘要</em>" },
    { title: "重复", url: "https://example.com/1" },
    { url: "javascript:alert(1)" }, { url: "https://user:password@example.com" },
    ...Array.from({ length: 15 }, (_, i) => ({ title: `结果${i}`, url: `https://example.com/page/${i}`, content: "x".repeat(3000) })),
  ] };
  const page = await f.gateway.search("中文 & site:gov.cn", "zh-CN");
  assert.equal(page.results.length, 8);
  assert.deepEqual(page.results[0], result.results[0]);
  assert.equal(page.results[1].content.length, 2000);
  assert.deepEqual(page.warnings, []);
  const request = f.searches()[0];
  assert.equal(request.init?.method, "POST");
  assert.deepEqual(JSON.parse(String(request.init?.body)), {
    query: "中文 & site:gov.cn", max_results: 8, search_depth: "fast", auto_parameters: false,
    include_answer: false, include_raw_content: false, include_usage: true, language: "zh-cn",
  });
  assert.deepEqual(await f.gateway.search("中文 & site:gov.cn", "zh-CN"), page);
  assert.equal(f.searches().length, 1);
  assert.equal((await f.gateway.usage()).remaining, 999);
  await f.gateway.search("中文 & site:gov.cn", "auto");
  assert.equal(f.searches().length, 2);
  assert.equal("language" in JSON.parse(String(f.searches()[1].init?.body)), false);
  assert.equal(f.calls.filter(c => c.url.endsWith("/usage")).length, 1);
});

test("plan cap and per-key cap both stop searches, even when paygo credits are available", async () => {
  for (const data of [quota(1000), quota(5, 1000, 5), quota(0, 1000, 0)]) {
    const f = fixture();
    f.state.usage = data;
    await assert.rejects(f.gateway.search("query", "auto"), reached);
    const usage = await f.gateway.usage();
    assert.equal(usage.status, "exhausted");
    assert.equal(usage.remaining, 0);
    assert.equal(f.searches().length, 0);
  }
  const f = fixture();
  f.state.usage = quota(80, 1000, 100, 10);
  const usage = await f.gateway.usage();
  assert.equal(usage.remaining, 90, "use remaining credits from the tighter scope");
  assert.equal(usage.key_used, 10);
  assert.ok(!JSON.stringify(usage).includes("tvly-test-secret"));
});

test("parallel searches reserve the last credit; exhaustion recovers after a refreshed monthly balance", async () => {
  const f = fixture();
  f.state.usage = quota(999);
  let release!: () => void;
  f.state.searchWait = new Promise(resolve => { release = resolve; });
  const running = f.gateway.search("first", "auto");
  // Let the shared usage query and first reservation settle.
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(f.gateway.search("second", "auto"), reached);
  assert.equal(f.searches().length, 1);
  release();
  await running;
  assert.equal((await f.gateway.usage()).remaining, 0);
  await assert.rejects(f.gateway.search("first", "auto"), reached, "stop even when a result is cached");
  f.state.usage = quota(0);
  f.advance();
  await f.gateway.search("new month", "auto");
  assert.equal((await f.gateway.usage()).remaining, 999);
});

test("provider 432/433 quota responses block subsequent calls, while 429 remains a rate limit", async () => {
  for (const status of [432, 433]) {
    const f = fixture();
    f.state.searchStatus = status;
    f.state.searchBody = { detail: { error: "provider detail tvly-secret" } };
    await assert.rejects(f.gateway.search("query", "auto"), reached);
    await assert.rejects(f.gateway.search("other", "auto"), reached);
    assert.equal(f.searches().length, 1);
    assert.equal((await f.gateway.usage()).status, "exhausted");
  }
  const f = fixture();
  f.state.searchStatus = 429;
  await assert.rejects(f.gateway.search("query", "auto"), /搜索请求过于频繁/);
  assert.equal((await f.gateway.usage()).remaining, 1000);
  f.state.searchStatus = 401;
  await assert.rejects(f.gateway.search("query", "auto"), /API Key 无效/);
});

test("unavailable or malformed usage fails closed and retries at most once per minute", async () => {
  for (const status of [401, 429, 500]) {
    const f = fixture();
    f.state.usageStatus = status;
    assert.equal((await f.gateway.usage()).status, "unavailable");
    await assert.rejects(f.gateway.search("query", "auto"), error => error instanceof HttpError && error.status === 503);
    assert.equal(f.calls.length, 1);
    assert.equal(f.searches().length, 0);
    f.state.usageStatus = 200;
    f.advance();
    assert.equal((await f.gateway.usage()).remaining, 1000);
  }
  const f = fixture();
  f.state.usageBody = { key: { usage: 1, limit: null }, account: { current_plan: "Researcher" } };
  assert.equal((await f.gateway.usage()).status, "unavailable");
  await assert.rejects(f.gateway.search("query", "auto"), /用量数据格式异常/);
  assert.equal(f.searches().length, 0);
});

test("empty or malformed successful searches consume a credit; aborted calls do not dispatch", async () => {
  const f = fixture();
  f.state.searchBody = { results: [] };
  assert.deepEqual((await f.gateway.search("empty", "auto")).results, []);
  assert.equal((await f.gateway.usage()).remaining, 999);
  f.state.searchBody = {};
  await assert.rejects(f.gateway.search("malformed", "auto"), /返回格式异常/);
  assert.equal((await f.gateway.usage()).remaining, 998);
  await assert.rejects(f.gateway.search("abort", "auto", AbortSignal.abort()), /连接失败/);
  assert.equal(f.searches().length, 2);
  f.state.searchStatus = 500;
  await assert.rejects(f.gateway.search("error", "auto"), /搜索服务暂时不可用/);
  assert.equal((await f.gateway.usage()).remaining, 998);
});

test("admin polls and search requests share a single usage refresh", async () => {
  const f = fixture();
  await Promise.all([f.gateway.usage(), f.gateway.usage(), f.gateway.search("q1", "auto"), f.gateway.search("q2", "auto")]);
  assert.equal(f.calls.filter(c => c.url.endsWith("/usage")).length, 1);
  assert.equal((await f.gateway.usage()).remaining, 998);
});

test("a lost search response pauses new spending until the balance can be verified", async () => {
  let now = 1_000_000, searches = 0;
  const gateway = new WebSearch(config(), async input => {
    if (String(input).endsWith("/usage")) return Response.json(quota(searches));
    searches++;
    throw new Error("connection reset after upstream may have charged");
  }, () => now);
  await assert.rejects(gateway.search("first", "auto"), /连接失败/);
  assert.equal((await gateway.usage()).status, "unavailable");
  await assert.rejects(gateway.search("second", "auto"), /无法确认剩余额度/);
  assert.equal(searches, 1);
  now += 60_001;
  assert.equal((await gateway.usage()).remaining, 999);
});
