import { randomUUID, createHash } from "node:crypto";
import { posix } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import {
  documentFormat,
  DOCUMENT_LIMIT,
  DOCUMENT_CHUNK,
  DOCUMENT_MIMES,
  documentJob,
} from "../../packages/agent/src/documents/spec.js";
import { processDocument as runDocument } from "../../packages/agent/src/documents/runtime.js";
import { callerRun } from "./agents.js";
import { artifactOut } from "./reports.js";
import { ownBot } from "./bots.js";
import { fail, type Tx, type Row } from "./db.js";
import type { Route, Context } from "./routes.js";
async function processDocument(...args: Parameters<typeof runDocument>) {
  try {
    return await runDocument(...args);
  } catch (error) {
    fail(
      422,
      error instanceof Error ? error.message.slice(0, 500) : "文档处理失败",
    );
  }
}
export async function pruneDocuments(tx: Tx) {
  await tx.rows(
    "DELETE FROM document_uploads WHERE created_at<now()-interval '24 hours'",
  );
  await tx.rows(
    "DELETE FROM report_artifacts a WHERE a.run_id IS NULL AND a.created_at<now()-interval '24 hours' AND NOT EXISTS(SELECT 1 FROM message_artifacts m WHERE m.artifact_id=a.artifact_id)",
  );
}
async function processFor(
  c: Context,
  job: Parameters<typeof runDocument>[0],
  bytes?: Buffer,
  run?: Row,
) {
  const controller = new AbortController();
  const close = () => {
    if (!c.reply.raw.writableEnded) controller.abort();
  };
  c.reply.raw.once("close", close);
  const poll = run
    ? setInterval(() => {
        void c.db
          .tx((tx) => callerRun(tx, c.user.user_id, c.llm!, run.run_id))
          .catch(() => controller.abort());
      }, 1000)
    : undefined;
  try {
    return await processDocument(job, bytes, controller.signal);
  } finally {
    clearInterval(poll);
    c.reply.raw.off("close", close);
  }
}
const uuid = z.string().uuid();
const base64 = z
  .string()
  .min(1)
  .max(Math.ceil(DOCUMENT_LIMIT / 3) * 4)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
const cleanName = (name: string) => {
  if (name !== posix.basename(name) || /[\\\x00-\x1f]/.test(name))
    fail(422, "文件名无效");
  try {
    documentFormat(name);
  } catch (e) {
    fail(422, (e as Error).message);
  }
  return name;
};
export async function readableDocument(
  tx: Tx,
  userId: string,
  botId: string,
  id: string,
) {
  const file = await tx.one(
    `SELECT a.* FROM report_artifacts a WHERE a.artifact_id=$1 AND a.user_id=$2 AND
 (a.bot_id=$3 OR EXISTS(SELECT 1 FROM message_artifacts ma JOIN bot_messages m USING(message_id) WHERE ma.artifact_id=a.artifact_id AND m.bot_id=$3))`,
    [id, userId, botId],
  );
  if (!file) fail(404, "文件不存在或未共享给本智能体");
  try {
    documentFormat(file!.name);
  } catch {
    fail(422, "请使用 report_read 读取 Markdown 报告");
  }
  return file!;
}
async function save(
  tx: Tx,
  run: Row,
  requestId: string,
  name: string,
  bytes: Buffer,
  summary: string,
) {
  if (!bytes.length || bytes.length > DOCUMENT_LIMIT)
    fail(413, "单份文档最多 10 MiB");
  const old = await tx.one(
    "SELECT * FROM report_artifacts WHERE run_id=$1 AND call_id=$2",
    [run.run_id, requestId],
  );
  if (old) return old;
  const format = documentFormat(cleanName(name));
  return (await tx.one(
    `INSERT INTO report_artifacts(artifact_id,user_id,bot_id,run_id,call_id,title,name,mime,size,body,summary)
 VALUES($1,$2,$3,$4,$5,$6,$6,$7,$8,$9,$10) ON CONFLICT(run_id,call_id) DO UPDATE SET call_id=EXCLUDED.call_id RETURNING *`,
    [
      randomUUID(),
      run.user_id,
      run.bot_id,
      run.run_id,
      requestId,
      name,
      DOCUMENT_MIMES[format],
      bytes.length,
      bytes,
      summary,
    ],
  ))!;
}
const runBody = { run_id: uuid };
const writable = (run: Row) => {
  if (
    run.lane !== "task" ||
    run.automation_readonly ||
    run.origin === "automation"
  )
    fail(403, "文档写入和发布只能在已授权的后台任务中执行");
};
const safePath = (value: string) => {
  const p = posix.normalize(value.replace(/\\/g, "/"));
  if (posix.isAbsolute(p) || p === ".." || p.startsWith("../") || p === ".")
    fail(422, "云端文档路径必须在 Bot 资料库内");
  return p;
};
async function input(c: Context, run: Row, body: any) {
  if (body.artifact_id) {
    const row = await c.db.tx((tx) =>
      readableDocument(tx, run.user_id, run.bot_id, body.artifact_id),
    );
    return { name: row.name as string, bytes: Buffer.from(row.body) };
  }
  if (!body.path || !run.operation_target.startsWith("remote:"))
    fail(422, "需要文件引用，或当前云端资料库的相对路径");
  const path = safePath(body.path),
    file = await c.remote.file(
      run.user_id,
      run.bot_id,
      run.operation_target.slice(7),
      path,
    );
  try {
    const stream = file.sftp.createReadStream(file.path),
      chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of stream) {
      size += chunk.length;
      if (size > DOCUMENT_LIMIT) {
        stream.destroy();
        fail(413, "文件超过 10 MiB");
      }
      chunks.push(Buffer.from(chunk));
    }
    return { name: posix.basename(path), bytes: Buffer.concat(chunks) };
  } finally {
    file.sftp.end();
  }
}
export const documentRoutes: Route[] = [
  {
    method: "GET",
    path: "/documents/capabilities",
    auth: "actor",
    tag: "reports",
    summary: "文档处理能力",
    handler: async () => ({
      version: 1,
      max_bytes: DOCUMENT_LIMIT,
      max_files: 4,
      chunk_bytes: DOCUMENT_CHUNK,
      pdf: "read",
      docx: "read-write",
      xlsx: "read-write",
    }),
  },
  {
    method: "POST",
    path: "/bots/:id/documents/uploads",
    auth: "actor",
    tag: "reports",
    summary: "初始化文档上传",
    body: z
      .object({
        request_id: uuid,
        name: z.string().min(1).max(255),
        size: z.number().int().positive().max(DOCUMENT_LIMIT),
      })
      .strict(),
    handler: async ({ tx, user, params, body }) => {
      await ownBot(tx, user.user_id, params.id);
      cleanName(body.name);
      await pruneDocuments(tx);
      const previous = await tx.one(
        "SELECT * FROM document_uploads WHERE upload_id=$1",
        [body.request_id],
      );
      if (previous) {
        if (
          previous.user_id !== user.user_id ||
          previous.bot_id !== params.id ||
          previous.name !== body.name ||
          previous.size !== body.size
        )
          fail(409, "上传请求不匹配");
        return {
          upload_id: previous.upload_id,
          ...(previous.artifact_id
            ? {
                artifact: artifactOut(
                  (await tx.get("report_artifacts", previous.artifact_id))!,
                ),
              }
            : {}),
        };
      }
      const count = await tx.one(
        "SELECT count(*) AS n FROM document_uploads WHERE user_id=$1 AND artifact_id IS NULL",
        [user.user_id],
      );
      if (Number(count!.n) >= 16) fail(429, "未完成上传过多，请取消或稍后重试");
      await tx.insert("document_uploads", {
        upload_id: body.request_id,
        user_id: user.user_id,
        bot_id: params.id,
        name: body.name,
        size: body.size,
      });
      return { upload_id: body.request_id };
    },
  },
  {
    method: "POST",
    path: "/documents/uploads/:id/chunks",
    auth: "actor",
    tag: "reports",
    summary: "上传文档分块",
    body: z
      .object({
        part: z.number().int().min(0).max(39),
        data: base64.max(Math.ceil(DOCUMENT_CHUNK / 3) * 4),
      })
      .strict(),
    handler: async ({ tx, user, params, body }) => {
      const upload = await tx.one(
        "SELECT * FROM document_uploads WHERE upload_id=$1 AND user_id=$2 FOR UPDATE",
        [params.id, user.user_id],
      );
      if (!upload || upload.artifact_id) fail(409, "上传已结束或不存在");
      const bytes = Buffer.from(body.data, "base64"),
        expected = Math.min(
          DOCUMENT_CHUNK,
          upload!.size - body.part * DOCUMENT_CHUNK,
        );
      if (expected <= 0 || bytes.length !== expected)
        fail(422, "分块大小不匹配");
      const old = await tx.one(
        "SELECT body FROM document_chunks WHERE upload_id=$1 AND part=$2",
        [params.id, body.part],
      );
      if (old && !Buffer.from(old.body).equals(bytes))
        fail(409, "重复分块内容不一致");
      await tx.rows(
        "INSERT INTO document_chunks(upload_id,part,body) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
        [params.id, body.part, bytes],
      );
      return { received: bytes.length };
    },
  },
  {
    method: "POST",
    path: "/documents/uploads/:id/complete",
    auth: "actor",
    tag: "reports",
    summary: "完成文档上传",
    tx: false,
    body: z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict(),
    handler: async (c) => {
      const snapshot = await c.db.tx(async (tx) => {
        const upload = await tx.one(
          "SELECT * FROM document_uploads WHERE upload_id=$1 AND user_id=$2",
          [c.params.id, c.user.user_id],
        );
        if (!upload) fail(404, "上传不存在");
        if (upload!.artifact_id) return { upload: upload!, chunks: [] };
        return {
          upload: upload!,
          chunks: await tx.rows(
            "SELECT part,body FROM document_chunks WHERE upload_id=$1 ORDER BY part",
            [c.params.id],
          ),
        };
      });
      const { upload, chunks } = snapshot;
      if (upload.artifact_id)
        return c.db.tx(async (tx) => ({
          artifact: artifactOut(
            (await tx.get("report_artifacts", upload.artifact_id))!,
          ),
        }));
      if (
        chunks.length !== Math.ceil(upload.size / DOCUMENT_CHUNK) ||
        chunks.some((p, i) => p.part !== i)
      )
        fail(422, "分块不完整，请重试上传");
      const bytes = Buffer.concat(chunks.map((c) => Buffer.from(c.body)));
      if (
        bytes.length !== upload.size ||
        createHash("sha256").update(bytes).digest("hex") !== c.body.sha256
      )
        fail(422, "文件完整性校验失败");
      await processFor(c, { action: "inspect", name: upload.name }, bytes);
      return c.db.tx(async (tx) => {
        const current = await tx.one(
          "SELECT * FROM document_uploads WHERE upload_id=$1 AND user_id=$2 FOR UPDATE",
          [c.params.id, c.user.user_id],
        );
        if (!current) fail(409, "上传已取消");
        if (current!.artifact_id)
          return {
            artifact: artifactOut(
              (await tx.get("report_artifacts", current!.artifact_id))!,
            ),
          };
        const row = await tx.insert("report_artifacts", {
          artifact_id: randomUUID(),
          user_id: c.user.user_id,
          bot_id: upload.bot_id,
          run_id: null,
          call_id: upload.upload_id,
          title: upload.name,
          name: upload.name,
          mime: DOCUMENT_MIMES[documentFormat(upload.name)],
          size: bytes.length,
          body: bytes,
          summary: "用户上传文档",
        });
        await tx.update("document_uploads", upload.upload_id, {
          artifact_id: row.artifact_id,
        });
        await tx.rows("DELETE FROM document_chunks WHERE upload_id=$1", [
          upload.upload_id,
        ]);
        return { artifact: artifactOut(row) };
      });
    },
  },
  {
    method: "DELETE",
    path: "/documents/uploads/:id",
    auth: "actor",
    tag: "reports",
    summary: "取消文档上传",
    handler: async ({ tx, user, params }) => {
      await tx.rows(
        "DELETE FROM document_uploads WHERE upload_id=$1 AND user_id=$2",
        [params.id, user.user_id],
      );
      return { cancelled: true };
    },
  },
  {
    method: "POST",
    path: "/agent/documents/bytes",
    auth: "llm",
    internal: true,
    tag: "reports",
    summary: "执行端读取文档字节",
    body: z.object({ ...runBody, artifact_id: uuid }).strict(),
    handler: async ({ tx, user, llm, body }) => {
      const run = await callerRun(tx, user.user_id, llm!, body.run_id);
      const file = await readableDocument(
        tx,
        user.user_id,
        run.bot_id,
        body.artifact_id,
      );
      return {
        name: file.name,
        data: Buffer.from(file.body).toString("base64"),
      };
    },
  },
  {
    method: "POST",
    path: "/agent/documents/save",
    auth: "llm",
    internal: true,
    tag: "reports",
    summary: "保存本机生成文档",
    tx: false,
    body: z
      .object({
        ...runBody,
        request_id: z.string().min(1).max(200),
        name: z.string().max(255),
        data: base64,
      })
      .strict(),
    handler: async (c) => {
      const run = await c.db.tx((tx) =>
        callerRun(tx, c.user.user_id, c.llm!, c.body.run_id),
      );
      writable(run);
      const bytes = Buffer.from(c.body.data, "base64");
      await processFor(
        c,
        { action: "inspect", name: cleanName(c.body.name) },
        bytes,
        run,
      );
      return c.db.tx(async (tx) => {
        const fresh = await callerRun(tx, c.user.user_id, c.llm!, run.run_id);
        writable(fresh);
        return {
          artifact: artifactOut(
            await save(
              tx,
              fresh,
              c.body.request_id,
              c.body.name,
              bytes,
              "文档已生成",
            ),
          ),
        };
      });
    },
  },
  {
    method: "POST",
    path: "/agent/documents/action",
    auth: "llm",
    internal: true,
    tag: "reports",
    summary: "云端读取或生成文档",
    tx: false,
    body: z
      .object({
        ...runBody,
        request_id: z.string().min(1).max(200),
        artifact_id: uuid.optional(),
        path: z.string().max(2000).optional(),
        job: documentJob,
      })
      .strict(),
    handler: async (c) => {
      const run = await c.db.tx((tx) =>
        callerRun(tx, c.user.user_id, c.llm!, c.body.run_id),
      );
      const job = c.body.job;
      if (job.action === "inspect") fail(422, "内部操作不可调用");
      if (job.action !== "read") writable(run);
      if (job.action !== "read") {
        const previous = await c.db.tx((tx) =>
          tx.one(
            "SELECT * FROM report_artifacts WHERE run_id=$1 AND call_id=$2",
            [run.run_id, c.body.request_id],
          ),
        );
        if (previous) return { artifact: artifactOut(previous) };
      }
      const source =
        job.action === "write" ? undefined : await input(c, run, c.body);
      if (
        source &&
        job.action === "edit" &&
        documentFormat(source.name) !== documentFormat(job.name)
      )
        fail(422, "源文件和目标格式不一致，不支持格式转换");
      const result = await processFor(
        c,
        {
          ...job,
          name:
            source && job.action === "read" ? source.name : cleanName(job.name),
        },
        source?.bytes,
        run,
      );
      if (job.action === "read") return result;
      let libraryPath: string | undefined;
      if (run.operation_target.startsWith("remote:")) {
        const environment = await c.db.tx((tx) =>
          tx.get("remote_environments", run.operation_target.slice(7)),
        );
        const bot = await c.db.tx((tx) => tx.get("bots", run.bot_id));
        await c.db.tx((tx) =>
          callerRun(tx, c.user.user_id, c.llm!, run.run_id),
        );
        libraryPath =
          "documents/" +
          createHash("sha256")
            .update(c.body.request_id)
            .digest("hex")
            .slice(0, 16) +
          "-" +
          job.name;
        // The guest creates the parent path and canonicalizes it before any bytes are written.
        await c.remote.action(
          environment!,
          run,
          bot!.slug,
          c.body.request_id + "-document",
          "upload",
          {
            path: libraryPath,
            base64:
              result.bytes.length <= 4_000_000
                ? result.bytes.toString("base64")
                : "",
          },
        );
        if (result.bytes.length > 4_000_000) {
          const file = await c.remote.file(
            run.user_id,
            run.bot_id,
            environment!.environment_id,
            libraryPath,
            true,
          );
          try {
            await pipeline(
              Readable.from([result.bytes]),
              file.sftp.createWriteStream(file.path),
            );
          } finally {
            file.sftp.end();
          }
        }
      }

      return c.db.tx(async (tx) => {
        const fresh = await callerRun(tx, c.user.user_id, c.llm!, run.run_id);
        writable(fresh);
        return {
          artifact: artifactOut(
            await save(
              tx,
              fresh,
              c.body.request_id,
              job.name,
              result.bytes,
              "文档已生成",
            ),
          ),
          warnings: result.warnings,
          path: libraryPath,
        };
      });
    },
  },
  {
    method: "POST",
    path: "/agent/documents/publish",
    auth: "llm",
    internal: true,
    tag: "reports",
    summary: "发布文档附件",
    tx: false,
    body: z
      .object({
        ...runBody,
        artifact_id: uuid.optional(),
        path: z.string().max(2000).optional(),
        request_id: z.string().min(1).max(200).optional(),
      })
      .strict(),
    handler: async (c) => {
      const run = await c.db.tx((tx) =>
        callerRun(tx, c.user.user_id, c.llm!, c.body.run_id),
      );
      writable(run);
      let artifactId = c.body.artifact_id;
      if (!artifactId) {
        const source = await input(c, run, c.body);
        await processDocument(
          { action: "inspect", name: source.name },
          source.bytes,
        );
        const saved = await c.db.tx((tx) =>
          save(
            tx,
            run,
            c.body.request_id ?? randomUUID(),
            source.name,
            source.bytes,
            "文档附件",
          ),
        );
        artifactId = saved.artifact_id;
      }
      return c.db.tx(async (tx) => {
        const user = c.user,
          body = c.body;
        const fresh = await callerRun(tx, user.user_id, c.llm!, run.run_id);
        writable(fresh);
        const file = await readableDocument(
          tx,
          user.user_id,
          run.bot_id,
          artifactId,
        );
        await tx.rows(
          "INSERT INTO message_artifacts(message_id,artifact_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
          [run.assistant_message_id, file.artifact_id],
        );
        await tx.rows(
          "INSERT INTO message_artifacts(message_id,artifact_id) SELECT p.assistant_message_id,$2 FROM agent_tasks t JOIN bot_runs p ON p.run_id=t.parent_run_id WHERE t.child_run_id=$1 AND t.mode='wait' ON CONFLICT DO NOTHING",
          [run.run_id, file.artifact_id],
        );
        await tx.notify({ user_id: user.user_id, bot_id: run.bot_id });
        return { artifact: artifactOut(file) };
      });
    },
  },
];
