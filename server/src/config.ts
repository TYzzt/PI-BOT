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
    databaseUrl: z.string().min(1).parse(env.T_AGNET_DATABASE_URL),
    adminPassword: z.string().min(8).parse(env.T_AGNET_ADMIN_PASSWORD),
    jwtSecret: z.string().min(32).parse(env.T_AGNET_JWT_SECRET),
    jwtTtl: integer(env.T_AGNET_JWT_TTL_SECONDS, 3600, 60, 86400),
    presenceTtl: integer(env.T_AGNET_PRESENCE_TTL_SECONDS, 60, 5, 3600),
    pairingTtl: integer(env.T_AGNET_PAIRING_TTL_SECONDS, 600, 30, 3600),
    signatureSkew: integer(env.T_AGNET_SIGNATURE_SKEW_SECONDS, 300, 30, 3600),
    approvalTtl: integer(env.T_AGNET_APPROVAL_TTL_SECONDS, 900, 60, 86400),
    commandTtl: integer(env.T_AGNET_COMMAND_TTL_SECONDS, 86400, 60, 604800),
    leaseSeconds: integer(env.T_AGNET_WORKER_LEASE_SECONDS, 60, 15, 3600),
    pollSeconds: z.coerce
      .number()
      .positive()
      .max(60)
      .parse(env.T_AGNET_WORKER_POLL_SECONDS ?? 1),
    vaultFile: env.T_AGNET_SYNC_KEY_FILE,
    runnerUrl: env.T_AGNET_RUNNER_URL ?? "http://runner:8001",
    runnerToken: env.T_AGNET_RUNNER_TOKEN,
    tavilyKey: env.T_AGNET_TAVILY_API_KEY,
  };
}
export type Settings = ReturnType<typeof settings>;
