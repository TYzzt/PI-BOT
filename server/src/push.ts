import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { cert, deleteApp, initializeApp } from "firebase-admin/app";
import { getMessaging, type Message } from "firebase-admin/messaging";
import { decodeJwt } from "jose";
import { z } from "zod";
import type { Settings } from "./config.js";
import { fail, type Database, type Row, type Tx } from "./db.js";
import type { Route } from "./routes.js";

const androidPackage = "dev.pibot.android";
const publicConfigSchema = z.object({
  project_id: z.string().min(1).max(128),
  application_id: z.string().regex(/^1:\d+:android:[0-9a-f]+$/),
  sender_id: z.string().regex(/^\d+$/),
  api_key: z.string().regex(/^A[\w-]{38}$/),
  package_name: z.literal(androidPackage),
});
export type AndroidPushConfig = z.infer<typeof publicConfigSchema>;

/** Only allowlisted Android identifiers leave the server, never the service account or raw JSON. */
export function parseAndroidPushConfig(document: unknown, projectId: string): AndroidPushConfig {
  const input = z.object({
    project_info: z.object({ project_id: z.string(), project_number: z.string() }),
    client: z.array(z.object({
      client_info: z.object({ mobilesdk_app_id: z.string(), android_client_info: z.object({ package_name: z.string() }) }),
      api_key: z.array(z.object({ current_key: z.string() })),
    })),
  }).parse(document);
  const clients = input.client.filter(c => c.client_info.android_client_info.package_name === androidPackage);
  if (input.project_info.project_id !== projectId || clients.length !== 1)
    throw new Error("FCM Android 配置必须匹配 PI_BOT_FCM_PROJECT_ID 和 dev.pibot.android");
  const client = clients[0];
  const config = publicConfigSchema.parse({
    project_id: input.project_info.project_id, sender_id: input.project_info.project_number,
    application_id: client.client_info.mobilesdk_app_id, package_name: androidPackage,
    api_key: client.api_key[0]?.current_key,
  });
  if (config.application_id.split(":")[1] !== config.sender_id)
    throw new Error("FCM Android 配置的 Sender ID 与应用 ID 不匹配");
  return config;
}

export async function loadAndroidPushConfig(s: Settings): Promise<AndroidPushConfig | undefined> {
  if (!s.fcmProjectId) {
    if (s.fcmAndroidConfigFile) throw new Error("配置 Android FCM 文件时需要 PI_BOT_FCM_PROJECT_ID");
    return;
  }
  if (!s.fcmAndroidConfigFile) throw new Error("启用 FCM 需要 PI_BOT_FCM_ANDROID_CONFIG_FILE（google-services.json）");
  // Do not include file contents or schema errors (which may contain input values) in startup errors.
  try {
    return parseAndroidPushConfig(JSON.parse(await readFile(s.fcmAndroidConfigFile, "utf8")), s.fcmProjectId);
  } catch {
    throw new Error("FCM Android 配置不可读或无效，请检查项目、包名、Sender ID 和 API Key");
  }
}

export const pushRoutes: Route[] = [
  {
    method: "GET", path: "/push/config", auth: "user", tag: "push", summary: "获取当前服务器的 Android 推送公共配置",
    handler: async ({ pushConfig, reply }) => {
      reply.header("cache-control", "no-store");
      return { enabled: !!pushConfig, firebase: pushConfig ?? null };
    },
  },
  {
    method: "PUT", path: "/push/installations/:id", auth: "user", tag: "push", summary: "注册当前 Android 推送安装",
    body: z.object({ fcm_token: z.string().trim().min(1).max(4096), binding_id: z.string().uuid(), firebase_project_id: z.string().min(1).max(128).optional() }).strict(),
    handler: async ({ tx, s, user, params, req, body }) => {
      if (s.fcmProjectId && body.firebase_project_id !== s.fcmProjectId) fail(409, "推送项目已更新，请重新获取服务器配置");
      // The route has already verified this bearer; never accept expiry from the client.
      const token = req.headers.authorization!.replace(/^Bearer\s+/i, "");
      const claims = decodeJwt(token);
      const expires = claims.exp!;
      // Token migration (e.g. restore/reinstall) must not leave two recipients.
      await tx.rows("DELETE FROM push_installations WHERE fcm_token=$1 AND installation_id<>$2", [body.fcm_token, params.id]);
      // Keep the stale-session check in the upsert: a separate SELECT cannot lock a missing row.
      const issued = claims.iat ?? 0;
      const registered = await tx.one(`INSERT INTO push_installations(installation_id,user_id,fcm_token,binding_id,session_expires_at,session_issued_at)
        VALUES($1,$2,$3,$4,to_timestamp($5),$6) ON CONFLICT(installation_id) DO UPDATE SET
        user_id=EXCLUDED.user_id,fcm_token=EXCLUDED.fcm_token,binding_id=EXCLUDED.binding_id,
        session_expires_at=EXCLUDED.session_expires_at,session_issued_at=EXCLUDED.session_issued_at,disabled_at=NULL,updated_at=now()
        WHERE push_installations.binding_id=EXCLUDED.binding_id OR push_installations.session_issued_at<=EXCLUDED.session_issued_at
        RETURNING installation_id`,
      [params.id, user.user_id, body.fcm_token, body.binding_id, expires, issued]);
      if (!registered) fail(409, "推送绑定已更新");
      return { ok: true, enabled: !!s.fcmProjectId };
    },
  },
  {
    method: "DELETE", path: "/push/installations/:id", auth: "user", tag: "push", summary: "注销当前账号的推送绑定",
    query: z.object({ binding_id: z.string().uuid() }),
    handler: async ({ tx, user, params, query }) => {
      await tx.rows("DELETE FROM push_installations WHERE installation_id=$1 AND user_id=$2 AND binding_id=$3", [params.id, user.user_id, query.binding_id]);
      return { ok: true };
    },
  },
];

export function pushSummary(text: string, fallback: string) {
  return Array.from(text.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim() || fallback).slice(0, 120).join("");
}

async function enqueue(tx: Tx, userId: string, botId: string, kind: "message" | "approval", sourceId: string,
  title: string, body: string, expires: Date) {
  if (!tx.pushEnabled) return;
  await tx.rows(`INSERT INTO push_deliveries(event_id,installation_id,binding_id,user_id,bot_id,kind,source_id,title,body,expires_at)
    SELECT $1,installation_id,binding_id,user_id,$3,$4,$5,$6,$7,$8 FROM push_installations
    WHERE user_id=$2 AND disabled_at IS NULL AND session_expires_at>now()
    ON CONFLICT(event_id,installation_id) DO NOTHING`,
  [`${kind}:${sourceId}`, userId, botId, kind, sourceId, title, body, expires]);
}

export async function enqueueMessage(tx: Tx, run: Row) {
  if (!tx.pushEnabled || run.origin === "voice") return;
  const m = await tx.one(`SELECT m.*,b.name FROM bot_messages m JOIN bots b USING(bot_id)
    WHERE m.message_id=$1 AND m.visibility='public' AND m.role='assistant'
    AND m.status IN ('completed','failed') AND b.archived_at IS NULL`, [run.assistant_message_id]);
  if (!m) return;
  await enqueue(tx, run.user_id, run.bot_id, "message", m.message_id, m.name,
    pushSummary(m.content || run.error || "", m.status === "failed" ? "运行失败，请打开会话查看" : "有新的回复或交互内容"),
    new Date(Date.now() + 86400_000));
}

export async function enqueueApproval(tx: Tx, approval: Row) {
  if (!tx.pushEnabled) return;
  const b = await tx.one("SELECT name FROM bots WHERE bot_id=$1 AND archived_at IS NULL", [approval.bot_id]);
  if (!b) return;
  const path = approval.detail?.path;
  const reason = String(approval.detail?.reason ?? "");
  const preview = typeof path === "string" && path ? reason.split(path).join("所请求的文件") : reason;
  await enqueue(tx, approval.user_id, approval.bot_id, "approval", approval.approval_id, `${b.name} · 待审批`,
    pushSummary(preview, "有访问请求需要你批准"), new Date(approval.expires_at));
}

export interface PushTransport {
  send(message: Message): Promise<unknown>;
  close(): Promise<unknown>;
}

export async function firebaseTransport(s: Settings): Promise<PushTransport | undefined> {
  if (!s.fcmProjectId) return;
  if (!s.fcmCredentialsFile) throw new Error("启用 FCM 需要 GOOGLE_APPLICATION_CREDENTIALS");
  // Read/parse/cert now, so invalid explicit configuration fails startup.
  const account = JSON.parse(await readFile(s.fcmCredentialsFile, "utf8"));
  const credential = cert(account);
  const app = initializeApp({ projectId: s.fcmProjectId, credential }, `push-${randomUUID()}`);
  return { send: message => getMessaging(app).send(message), close: () => deleteApp(app) };
}

export function pushErrorCode(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" ? code : "network-error";
}

export class PushDispatcher {
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  constructor(private db: Database, private transport: PushTransport, private now = () => new Date()) {}
  start() {
    const kick = () => { if (!this.running) this.running = this.once().catch(() => console.error("push dispatch cycle failed")).finally(() => { this.running = undefined; }); };
    this.timer = setInterval(kick, 1000);
    this.timer.unref();
    kick();
  }
  async stop() {
    clearInterval(this.timer);
    await this.running;
    await this.transport.close();
  }
  async once() {
    const now = this.now(), lease = randomUUID();
    const rows = await this.db.tx(tx => tx.rows(`WITH pending AS (
      SELECT event_id,installation_id FROM push_deliveries WHERE finished_at IS NULL AND available_at<=$1
      AND (lease_until IS NULL OR lease_until<$1) ORDER BY available_at LIMIT 25 FOR UPDATE SKIP LOCKED
    ) UPDATE push_deliveries d SET lease_id=$2,lease_until=$1::timestamptz+interval '2 minutes',attempts=attempts+1
      FROM pending p WHERE d.event_id=p.event_id AND d.installation_id=p.installation_id RETURNING d.*`, [now, lease]));
    await Promise.all(rows.map(row => this.deliver(row, lease)));
    // Retain a bounded dedup history; never retain notification previews indefinitely.
    await this.db.tx(tx => tx.rows("DELETE FROM push_deliveries WHERE finished_at < $1::timestamptz-interval '7 days'", [now]));
  }
  private async deliver(row: Row, lease: string) {
    const now = this.now();
    const active = await this.db.tx(tx => tx.one(`SELECT i.fcm_token FROM push_installations i JOIN users u USING(user_id)
      JOIN bots b ON b.bot_id=$4 AND b.user_id=i.user_id
      WHERE i.installation_id=$1 AND i.user_id=$2 AND i.binding_id=$3 AND i.disabled_at IS NULL
      AND NOT u.disabled AND b.archived_at IS NULL AND i.session_expires_at>$5`,
    [row.installation_id, row.user_id, row.binding_id, row.bot_id, now]));
    let valid = !!active && new Date(row.expires_at) > now;
    if (valid && row.kind === "approval") valid = !!await this.db.tx(tx => tx.one(
      "SELECT 1 FROM approvals WHERE approval_id=$1 AND status='pending' AND expires_at>$2", [row.source_id, now]));
    if (valid && row.kind === "message") valid = !!await this.db.tx(tx => tx.one(
      "SELECT 1 FROM bot_messages WHERE message_id=$1 AND visibility='public' AND status IN ('completed','failed')", [row.source_id]));
    let outcome = "skipped";
    if (valid) {
      try {
        await this.transport.send({ token: active!.fcm_token, data: {
          event_id: row.event_id, kind: row.kind, user_id: row.user_id, binding_id: row.binding_id,
          bot_id: row.bot_id, [row.kind === "message" ? "message_id" : "approval_id"]: row.source_id,
          title: row.title, body: row.body, expires_at: new Date(row.expires_at).toISOString(),
        }, android: { priority: "high", ttl: Math.max(0, new Date(row.expires_at).getTime() - now.getTime()) } });
        outcome = "sent";
      } catch (error) {
        const code = pushErrorCode(error);
        if (["messaging/registration-token-not-registered", "messaging/invalid-registration-token"].includes(code)) {
          await this.db.tx(tx => tx.rows(`UPDATE push_installations SET disabled_at=now()
            WHERE installation_id=$1 AND binding_id=$2 AND fcm_token=$3`, [row.installation_id, row.binding_id, active!.fcm_token]));
          outcome = "invalid-token";
        } else if (["messaging/invalid-argument", "messaging/mismatched-credential", "messaging/invalid-package-name"].includes(code)) {
          outcome = "permanent-error";
        } else {
          // Only log an allowlisted classification; SDK errors can include tokens/payloads.
          console.error("push delivery temporarily unavailable");
          await this.db.tx(tx => tx.rows(`UPDATE push_deliveries SET lease_id=NULL,lease_until=NULL,available_at=$4
            WHERE event_id=$1 AND installation_id=$2 AND lease_id=$3`,
          [row.event_id, row.installation_id, lease, new Date(now.getTime() + Math.min(3600, 5 * 2 ** Math.min(row.attempts, 10)) * 1000)]));
          return;
        }
      }
    }
    await this.db.tx(tx => tx.rows(`UPDATE push_deliveries SET finished_at=$4,outcome=$5,lease_id=NULL,lease_until=NULL
      WHERE event_id=$1 AND installation_id=$2 AND lease_id=$3`, [row.event_id, row.installation_id, lease, now, outcome]));
  }
}
