import type { Settings } from "./config.js";
import { fail, HttpError } from "./db.js";

export const searchAvailable = (s: Settings) => Boolean(s.searxngUrl || s.tavilyKey);
interface SearchResult { title: string; url: string; content: string }
interface SearchPage { results: SearchResult[]; warnings: string[] }
const clean = (value: unknown, limit: number) => String(value ?? "").replace(/<[^>]*>/g, "").trim().slice(0, limit);

/** Shared search gateway. The destination is deployment configuration, never user input. */
export class WebSearch {
  private cache = new Map<string, { until: number; page: SearchPage }>();
  constructor(private s: Settings) {}
  async search(query: string, language: string, signal?: AbortSignal): Promise<SearchPage> {
    if (!searchAvailable(this.s)) fail(503, "管理员尚未配置联网搜索服务");
    const key = JSON.stringify([query, language]);
    const cached = this.cache.get(key);
    if (cached && cached.until > Date.now()) return cached.page;
    const abort = signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000);
    try {
      let response: Response;
      if (this.s.searxngUrl) {
        const url = new URL(`${this.s.searxngUrl}/search`);
        url.search = new URLSearchParams({ q: query, format: "json", categories: "general", language, safesearch: "0" }).toString();
        response = await fetch(url, { signal: abort, redirect: "error", headers: { Accept: "application/json" } });
      } else {
        response = await fetch("https://api.tavily.com/search", {
          method: "POST", signal: abort, redirect: "error",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ api_key: this.s.tavilyKey, query, max_results: 8 }),
        });
      }
      if (!response.ok) fail(502, "搜索服务暂时不可用，请稍后重试");
      const data = await response.json() as { results?: unknown; unresponsive_engines?: unknown };
      if (!Array.isArray(data.results)) fail(502, "搜索服务返回格式异常");
      const seen = new Set<string>();
      const results: SearchResult[] = [];
      for (const entry of data.results as any[]) {
        if (!entry || typeof entry.url !== "string") continue;
        let url: URL;
        try { url = new URL(entry.url); } catch { continue; }
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || seen.has(url.href)) continue;
        seen.add(url.href);
        results.push({ title: clean(entry.title, 300), url: url.href, content: clean(entry.content, 2000) });
        if (results.length === 8) break;
      }
      const partial = Array.isArray(data.unresponsive_engines) && data.unresponsive_engines.length > 0;
      if (!results.length && partial) fail(502, "搜索源暂时无法访问，没有取得结果，请稍后重试");
      const page: SearchPage = { results, warnings: partial ? ["部分搜索源未响应，结果可能不完整。"] : [] };
      // Keep only successful searches, with a bounded five-minute cache.
      if (results.length) {
        this.cache.delete(key);
        this.cache.set(key, { until: Date.now() + 300000, page });
        if (this.cache.size > 100) this.cache.delete(this.cache.keys().next().value!);
      }
      return page;
    } catch (error) {
      if (error instanceof HttpError) throw error;
      return fail(502, "联网搜索超时或连接失败，请稍后重试");
    }
  }
}
