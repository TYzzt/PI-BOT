import { z } from "zod";
import type { Settings } from "./config.js";
import { fail, HttpError } from "./db.js";

export const searchAvailable = (s: Settings) => Boolean(s.tavilyKey);
export const SEARCH_QUOTA_REACHED = "搜索额度到了";
const USAGE_TTL_MS = 60_000;
const credits = z.number().finite().nonnegative();
const usageSchema = z.object({
  key: z.object({ usage: credits, limit: credits.nullable() }),
  account: z.object({ current_plan: z.string(), plan_usage: credits, plan_limit: credits }),
});
type TavilyUsage = z.infer<typeof usageSchema>;

export interface SearchUsage {
  configured: boolean;
  status: "not_configured" | "available" | "exhausted" | "unavailable";
  plan: string | null;
  plan_used: number | null;
  plan_limit: number | null;
  key_used: number | null;
  key_limit: number | null;
  remaining: number | null;
  checked_at: string | null;
  error: string | null;
}
interface SearchResult { title: string; url: string; content: string }
interface SearchPage { results: SearchResult[]; warnings: string[] }
const clean = (value: unknown, limit: number) => String(value ?? "").replace(/<[^>]*>/g, "").trim().slice(0, limit);

/** Shared Tavily SaaS gateway. Only the API process holds the provider key. */
export class WebSearch {
  private cache = new Map<string, { until: number; page: SearchPage }>();
  private quota?: TavilyUsage;
  private checkedAt?: number;
  private nextUsageAt = 0;
  private usageError: string | null = null;
  private usageRequest?: Promise<void>;
  private spent = 0;
  private reserved = 0;
  private blocked = false;

  constructor(private s: Settings, private request: typeof fetch = fetch, private now = Date.now) {}

  private headers() { return { Authorization: `Bearer ${this.s.tavilyKey}`, "Content-Type": "application/json" }; }

  private remaining() {
    if (!this.quota) return 0;
    const { key, account } = this.quota;
    return this.blocked ? 0 : Math.max(0, Math.min(
      account.plan_limit - account.plan_usage,
      key.limit === null ? Infinity : key.limit - key.usage,
    ) - this.reserved);
  }

  private async syncUsage() {
    if (this.usageRequest) return this.usageRequest;
    if (this.now() < this.nextUsageAt) return;
    this.nextUsageAt = this.now() + USAGE_TTL_MS;
    const spentBefore = this.spent;
    this.usageRequest = (async () => {
      try {
        const response = await this.request("https://api.tavily.com/usage", {
          headers: this.headers(), signal: AbortSignal.timeout(8000), redirect: "error",
        });
        if (response.status === 401) fail(503, "Tavily API Key 无效，请管理员检查环境变量");
        if (response.status === 429) fail(503, "Tavily 用量查询频率受限，请稍后重试");
        if (!response.ok) fail(503, "暂时无法获取 Tavily 搜索额度，请稍后重试");
        const parsed = usageSchema.safeParse(await response.json());
        if (!parsed.success) fail(503, "Tavily 用量数据格式异常，请稍后重试");
        // Conservatively include searches completed while this snapshot was being fetched.
        const overlap = this.spent - spentBefore;
        const quota = parsed.data!;
        quota.key.usage += overlap;
        quota.account.plan_usage += overlap;
        this.quota = quota;
        this.checkedAt = this.now();
        this.usageError = null;
        this.blocked = false;
      } catch (error) {
        this.usageError = error instanceof HttpError && typeof error.detail === "string" ? error.detail : "暂时无法获取 Tavily 搜索额度，请稍后重试";
      }
    })();
    try { await this.usageRequest; }
    finally { this.usageRequest = undefined; }
  }

  /** Admin-safe snapshot; provider responses and credentials never leave this gateway. */
  async usage(): Promise<SearchUsage> {
    const configured = searchAvailable(this.s);
    if (configured) await this.syncUsage();
    return {
      configured,
      status: !configured ? "not_configured" : this.usageError ? "unavailable" : this.remaining() < 1 ? "exhausted" : "available",
      plan: this.quota?.account.current_plan ?? null,
      plan_used: this.quota?.account.plan_usage ?? null,
      plan_limit: this.quota?.account.plan_limit ?? null,
      key_used: this.quota?.key.usage ?? null,
      key_limit: this.quota?.key.limit ?? null,
      remaining: this.quota && !this.usageError ? this.remaining() : null,
      checked_at: this.checkedAt === undefined ? null : new Date(this.checkedAt).toISOString(),
      error: this.usageError,
    };
  }

  async search(query: string, language: string, signal?: AbortSignal): Promise<SearchPage> {
    if (!searchAvailable(this.s)) fail(503, "管理员尚未配置 Tavily 搜索 API Key");
    await this.syncUsage();
    // Fail closed when the balance cannot be checked. Never spill into pay-as-you-go credits.
    if (this.usageError) fail(503, this.usageError);
    if (this.remaining() < 1) fail(402, SEARCH_QUOTA_REACHED);
    const key = JSON.stringify([query, language]);
    const cached = this.cache.get(key);
    if (cached && cached.until > this.now()) return cached.page;
    const abort = signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000);
    // Reserve synchronously so parallel requests cannot all consume the last credit.
    this.reserved++;
    let charged = false;
    let dispatched = false;
    try {
      abort.throwIfAborted();
      dispatched = true;
      const response = await this.request("https://api.tavily.com/search", {
        method: "POST", signal: abort, redirect: "error", headers: this.headers(),
        body: JSON.stringify({
          query, max_results: 8, search_depth: "fast", auto_parameters: false,
          include_answer: false, include_raw_content: false, include_usage: true,
          ...(!["auto", "all"].includes(language) ? { language: language.toLowerCase() } : {}),
        }),
      });
      if ([432, 433].includes(response.status)) {
        this.blocked = true;
        fail(402, SEARCH_QUOTA_REACHED);
      }
      if (response.status === 401) fail(503, "Tavily API Key 无效，请管理员检查环境变量");
      if (response.status === 429) fail(503, "搜索请求过于频繁，请稍后重试");
      if (!response.ok) fail(502, "搜索服务暂时不可用，请稍后重试");
      charged = true; // Explicit fast searches cost one credit, including empty results.
      const data = await response.json() as { results?: unknown };
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
      const page: SearchPage = { results, warnings: [] };
      if (results.length) {
        this.cache.delete(key);
        this.cache.set(key, { until: this.now() + 300000, page });
        if (this.cache.size > 100) this.cache.delete(this.cache.keys().next().value!);
      }
      return page;
    } catch (error) {
      if (error instanceof HttpError) throw error;
      // A lost response may already have spent a credit upstream. Require a fresh
      // balance before another search instead of reusing an uncertain allowance.
      if (dispatched && !charged) this.usageError = "搜索连接中断，无法确认剩余额度，请稍后重试";
      return fail(502, "联网搜索超时或连接失败，请稍后重试");
    } finally {
      this.reserved--;
      if (charged) {
        this.spent++;
        if (this.quota) {
          this.quota.key.usage++;
          this.quota.account.plan_usage++;
        }
      }
    }
  }
}
