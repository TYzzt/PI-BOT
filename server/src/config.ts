import { z } from "zod";
const integer = (
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
) =>
  z.coerce
    .number()
    .int()
    .min(min)
    .max(max)
    .parse(value ?? fallback);
export function settings(env = process.env) {
  return {
    databaseUrl: z.string().min(1).parse(env.PI_BOT_DATABASE_URL),
    adminUsername: z
      .string()
      .min(1)
      .max(64)
      .parse(env.PI_BOT_ADMIN_USERNAME ?? "admin"),
    /** Only needed to create the first administrator. */
    adminPassword: z.string().min(8).optional().parse(env.PI_BOT_ADMIN_PASSWORD || undefined),
    jwtSecret: z.string().min(32).parse(env.PI_BOT_JWT_SECRET),
    jwtTtl: integer(env.PI_BOT_JWT_TTL_SECONDS, 7 * 86400, 60, 30 * 86400),
    llmTokenTtl: integer(env.PI_BOT_LLM_TOKEN_TTL_SECONDS, 900, 900, 86400),
    signatureSkew: integer(env.PI_BOT_SIGNATURE_SKEW_SECONDS, 300, 30, 3600),
    approvalTtl: integer(env.PI_BOT_APPROVAL_TTL_SECONDS, 900, 60, 86400),
    rpcTimeoutMs: integer(env.PI_BOT_RPC_TIMEOUT_MS, 10000, 1000, 60000),
    leaseSeconds: integer(env.PI_BOT_WORKER_LEASE_SECONDS, 60, 15, 3600),
    pollSeconds: z.coerce
      .number()
      .positive()
      .max(60)
      .parse(env.PI_BOT_WORKER_POLL_SECONDS ?? 1),
    /** Cloud runs one worker executes at once; delegating runs wait on their children. */
    workerConcurrency: integer(env.PI_BOT_WORKER_CONCURRENCY, 4, 1, 64),
    historyLimit: integer(env.PI_BOT_HISTORY_LIMIT, 40, 4, 400),
    memoryThreshold: integer(env.PI_BOT_MEMORY_THRESHOLD, 60, 10, 2000),
    vaultFile: env.PI_BOT_VAULT_FILE,
    internalUrl: (env.PI_BOT_INTERNAL_URL ?? "http://api:8000").replace(
      /\/+$/,
      "",
    ),
    runnerUrl: env.PI_BOT_RUNNER_URL ?? "http://runner:8001",
    runnerToken: env.PI_BOT_RUNNER_TOKEN,
    tavilyKey: env.PI_BOT_TAVILY_API_KEY,
    searxngUrl: z.string().url().refine(value => {
      const url = new URL(value);
      return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
    }, "SearXNG 需要 HTTP(S) 根地址").optional().parse(env.PI_BOT_SEARXNG_URL?.replace(/\/+$/, "") || undefined),
    adminDir: env.PI_BOT_ADMIN_DIR,
  };
}
export type Settings = ReturnType<typeof settings>;
