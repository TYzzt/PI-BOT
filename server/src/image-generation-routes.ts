import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { callerRun } from "./agents.js";
import { fail, type Row } from "./db.js";
import { generateImage, generateImageBody, imageConfig, imageConfigBody, saveImageConfig } from "./image-generation.js";
import { artifactOut } from "./reports.js";
import type { Route } from "./routes.js";
import { Vault } from "./security.js";

function writableImageRun(run: Row) {
  if (run.lane !== "task" || run.automation_readonly || run.origin === "automation" || run.cancel_requested)
    fail(403, "生图只能在已授权的可写后台任务中执行");
}

export const imageGenerationRoutes: Route[] = [
  { method: "GET", path: "/admin/api/image-generation", auth: "admin", tag: "admin", summary: "生图配置（不返回密钥）",
    handler: async ({ tx }) => imageConfig(tx) },
  { method: "PUT", path: "/admin/api/image-generation", auth: "admin", tag: "admin", summary: "配置 CLIProxy 生图模型", body: imageConfigBody,
    handler: async ({ tx, s, body }) => saveImageConfig(tx, s, body) },
  { method: "POST", path: "/agent/image-models", auth: "llm", internal: true, tag: "images", summary: "查询可用生图模型",
    body: z.object({ run_id: z.string().uuid() }).strict(),
    handler: async ({ tx, user, llm, body }) => {
      await callerRun(tx, user.user_id, llm!, body.run_id);
      const config = await imageConfig(tx);
      return { models: config.enabled && config.configured ? config.models : [],
        default_model: config.enabled && config.configured ? config.default_model : null };
    } },
  { method: "POST", path: "/agent/images/generate", auth: "llm", internal: true, tag: "images", summary: "生成图片并保存为任务附件",
    body: generateImageBody, tx: false,
    handler: async ({ db, s, user, llm, body, reply }) => {
      const hash = createHash("sha256").update(JSON.stringify([body.prompt, body.model ?? null, body.aspect_ratio])).digest("hex");
      const reserved = await db.tx(async tx => {
        const run = await callerRun(tx, user.user_id, llm!, body.run_id);
        writableImageRun(run);
        const previous = await tx.one("SELECT * FROM image_generation_jobs WHERE run_id=$1 AND call_id=$2", [body.run_id, body.request_id]);
        if (previous) {
          if (previous.request_hash !== hash) fail(409, "同一生图调用不能更换提示词、模型或尺寸");
          if (previous.status === "completed" && previous.artifact_id) {
            const artifact = await tx.get("report_artifacts", previous.artifact_id, true);
            return { cached: { artifact: artifactOut(artifact), model: previous.model } };
          }
          fail(409, "这次生图已提交，结果尚未确认；请勿重新生成以免重复计费");
        }
        const config = await tx.one("SELECT * FROM image_generation_config WHERE singleton");
        if (!config?.enabled || !config.secret || !config.base_url) return fail(503, "尚未启用生图，请管理员配置 CLIProxy");
        const selected = body.model ?? config.default_model;
        if (!config.models.includes(selected)) fail(422, "所选生图模型未启用，请先用 image_models 查询可用模型");
        // Serialize reservations for one user, across runs and API processes.
        await tx.rows("SELECT pg_advisory_xact_lock(hashtextextended($1,95))", [user.user_id]);
        await tx.rows("UPDATE image_generation_jobs SET status='unknown' WHERE user_id=$1 AND status='accepted' AND created_at<now()-interval '5 minutes'", [user.user_id]);
        if (await tx.one("SELECT 1 FROM image_generation_jobs WHERE user_id=$1 AND status='accepted'", [user.user_id]))
          fail(429, "已有图片正在生成，请等待完成后再生成下一张");
        const key = new Vault(s.vaultFile, "image-generation").open(config.secret, "config");
        await tx.rows(`INSERT INTO image_generation_jobs(run_id,call_id,user_id,request_hash,model,status)
          VALUES($1,$2,$3,$4,$5,'accepted')`, [body.run_id, body.request_id, user.user_id, hash, selected]);
        return { base: config.base_url as string, key, model: selected as string };
      });
      if (reserved.cached) return reserved.cached;
      const controller = new AbortController();
      const close = () => { if (!reply.raw.writableEnded) controller.abort(); };
      reply.raw.once("close", close);
      if (reply.raw.destroyed) controller.abort();
      const poll = setInterval(() => {
        void db.tx(async tx => {
          const run = await callerRun(tx, user.user_id, llm!, body.run_id);
          writableImageRun(run);
        }).catch(() => controller.abort());
      }, 1000);
      try {
        const image = await generateImage(reserved.base!, reserved.key!, { ...body, model: reserved.model }, controller.signal);
        return await db.tx(async tx => {
          const run = await callerRun(tx, user.user_id, llm!, body.run_id);
          if (controller.signal.aborted || run.cancel_requested) fail(499, "生图已取消，未发布图片");
          writableImageRun(run);
          const id = randomUUID();
          const row = await tx.insert("report_artifacts", {
            artifact_id: id, user_id: user.user_id, bot_id: run.bot_id, run_id: run.run_id, call_id: `image:${body.request_id}`,
            title: body.prompt.slice(0, 80), name: `${id}.${image.extension}`, mime: image.mime, size: image.bytes.length,
            body: image.bytes, summary: `使用 ${reserved.model} 生成的图片`,
          });
          await tx.rows("INSERT INTO message_artifacts(message_id,artifact_id) VALUES($1,$2) ON CONFLICT DO NOTHING", [run.assistant_message_id, id]);
          await tx.rows(`INSERT INTO message_artifacts(message_id,artifact_id)
            SELECT p.assistant_message_id,$2 FROM agent_tasks t JOIN bot_runs p ON p.run_id=t.parent_run_id
            WHERE t.child_run_id=$1 AND t.mode='wait' ON CONFLICT DO NOTHING`, [run.run_id, id]);
          await tx.rows("UPDATE image_generation_jobs SET status='completed',artifact_id=$3 WHERE run_id=$1 AND call_id=$2", [run.run_id, body.request_id, id]);
          await tx.notify({ user_id: user.user_id, bot_id: run.bot_id });
          return { artifact: artifactOut(row), model: reserved.model };
        });
      } catch (error) {
        // Conservatively retain uncertain submissions: replay must never call a paid provider again.
        await db.tx(tx => tx.rows("UPDATE image_generation_jobs SET status='unknown' WHERE run_id=$1 AND call_id=$2 AND status='accepted'", [body.run_id, body.request_id])).catch(() => {});
        throw error;
      } finally {
        clearInterval(poll);
        reply.raw.off("close", close);
      }
    } },
];
