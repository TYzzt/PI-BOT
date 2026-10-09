import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import Ajv from "ajv/dist/2020.js";
import formats from "ajv-formats";
import { readFile } from "node:fs/promises";
import { randomUUID, randomBytes } from "node:crypto";
import { Database, HttpError, fail, type Tx, type Row } from "./db.js";
import { migrate } from "./migrate.js";
import {
  passwordHash,
  passwordMatches,
  issueToken,
  user,
  device,
  decodeBase64,
  sha256,
  Vault,
} from "./security.js";
import { settings, type Settings } from "./config.js";
import * as task from "./tasks.js";
import * as shared from "./shared.js";
import { sockets } from "./sockets.js";
export async function createApp(
  s: Settings = settings(),
  db = new Database(s.databaseUrl),
): Promise<FastifyInstance> {
  await migrate(db);
  await db.tx(async (tx) => {
    if (!(await tx.one("SELECT 1 FROM users LIMIT 1")))
      await tx.insert("users", {
        user_id: randomUUID(),
        password_hash: await passwordHash(s.adminPassword),
        singleton: true,
        created_at: new Date(),
      });
  });
  const app = Fastify({ logger: false, bodyLimit: 8 * 1024 * 1024 });
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (_req, body, done) => done(null, body),
  );
  const contract = JSON.parse(
    await readFile(new URL("../openapi.json", import.meta.url), "utf8"),
  );
  const ajv = new Ajv({
    strict: false,
    useDefaults: true,
    coerceTypes: true,
    allErrors: true,
  });
  formats(ajv);
  ajv.addSchema({ $id: "contract", components: contract.components });
  const bodyAjv = new Ajv({
    strict: false,
    useDefaults: true,
    coerceTypes: false,
    allErrors: true,
  });
  formats(bodyAjv);
  bodyAjv.addSchema({ $id: "contract", components: contract.components });
  const deref = (schema: Row): Row =>
    schema.$ref
      ? contract.components.schemas[schema.$ref.split("/").at(-1)]
      : schema;
  function normalize(value: any, schema: Row): any {
    schema = deref(schema);
    if (schema.anyOf) {
      const candidate = schema.anyOf.find((x: Row) => x.type !== "null");
      return value == null ? value : normalize(value, candidate);
    }
    if (schema.type === "array")
      return value.map((v: any) => normalize(v, schema.items));
    if (schema.properties && value) {
      const out: Row = {};
      for (const [k, raw] of Object.entries(schema.properties)) {
        const sub = raw as Row;
        let v = value[k];
        if (v === undefined && sub.default !== undefined)
          v = structuredClone(sub.default);
        if (
          v === undefined &&
          !schema.required?.includes(k) &&
          deref(sub).type === "object"
        )
          v = {};
        if (
          v === undefined &&
          !schema.required?.includes(k) &&
          deref(sub).type === "array"
        )
          v = [];
        // Pydantic emitted optional nullable fields as null even when omitted.
        if (
          v === undefined &&
          !schema.required?.includes(k) &&
          sub.anyOf?.some((x: Row) => x.type === "null")
        )
          v = null;
        if (v !== undefined) out[k] = normalize(v, sub);
      }
      return out;
    }
    if (schema.format === "uri" && typeof value === "string")
      return new URL(value).toString();
    return schema.format === "uuid" && typeof value === "string"
      ? value.toLowerCase()
      : value;
  }
  const validate = (fn: any, value: any, where: string) => {
    if (!fn(value))
      fail(
        422,
        (fn.errors ?? []).map((e: Row) => ({
          loc: [where, ...e.instancePath.split("/").filter(Boolean)],
          msg: e.message,
          type: e.keyword,
        })),
      );
  };
  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof HttpError)
      return reply.code(error.status).send({ detail: error.detail });
    if ((error as any).code === "23505")
      return reply.code(409).send({ detail: "记录冲突" });
    if ((error as any).statusCode === 413)
      return reply.code(413).send({ detail: "请求体过大" });
    reply.code(500).send({ detail: "服务暂时不可用" });
  });
  app.get("/openapi.json", () => contract);
  for (const [path, methods] of Object.entries(contract.paths))
    for (const [method, raw] of Object.entries(methods as Row)) {
      const op = raw as Row,
        bodySchema = op.requestBody?.content?.["application/json"]?.schema,
        bodyValidator = bodySchema
          ? bodyAjv.compile({ $ref: `contract${bodySchema.$ref}` })
          : null;
      const parameterSchema = (where: string) => {
        const ps = (op.parameters ?? []).filter((p: Row) => p.in === where);
        return {
          type: "object",
          properties: Object.fromEntries(
            ps.map((p: Row) => [p.name, p.schema]),
          ),
          required: ps.filter((p: Row) => p.required).map((p: Row) => p.name),
        };
      };
      const queryValidator = ajv.compile(parameterSchema("query")),
        pathValidator = ajv.compile(parameterSchema("path"));
      app.route({
        method: method.toUpperCase() as any,
        url: path.replace(/\{([^}]+)\}/g, ":$1"),
        handler: async (req, reply) => {
          const rawBody = Buffer.isBuffer(req.body)
              ? req.body
              : Buffer.alloc(0),
            params = req.params as Row,
            query = req.query as Row;
          return db.tx(async (tx) => {
            let actor: Row | undefined, deviceId: string | undefined;
            const securities = op.security ?? [];
            if (securities.length) {
              const mixed = securities.length > 1;
              if (
                mixed &&
                req.headers.authorization &&
                req.headers["x-tagnet-signature"]
              )
                fail(400, "不能同时使用用户令牌和设备签名");
              const wantsUser =
                securities.some((x: Row) => x.UserBearer) &&
                (!mixed || req.headers.authorization);
              if (wantsUser) actor = await user(tx, req.headers, s);
              else {
                actor = await device(
                  tx,
                  req.headers,
                  req.method,
                  path.replace(/\{([^}]+)\}/g, (_, k) => params[k]),
                  rawBody,
                  s,
                );
                deviceId = actor.device_id;
              }
            }
            validate(pathValidator, params, "path");
            validate(queryValidator, query, "query");
            let body: Row = {};
            if (rawBody.length)
              try {
                body = JSON.parse(rawBody.toString("utf8"));
              } catch {
                fail(422, "JSON 格式错误");
              }
            if (bodyValidator) {
              validate(bodyValidator, body, "body");
              body = normalize(body, bodySchema);
            }
            const result = await dispatch(
              tx,
              s,
              method.toUpperCase(),
              path,
              params,
              query,
              body,
              deviceId,
              req.headers,
              reply,
            );
            return result;
          });
        },
      });
    }
  await app.register(websocket, { options: { maxPayload: 8 * 1024 * 1024 } });
  await sockets(app, db, s, ajv);
  return app;
}
async function dispatch(
  tx: Tx,
  s: Settings,
  method: string,
  path: string,
  a: Row,
  q: Row,
  p: Row,
  actor: string | undefined,
  headers: Row,
  reply: any,
): Promise<any> {
  if (path === "/health") return { ok: true };
  if (path === "/auth/login") {
    const u = await tx.one("SELECT * FROM users LIMIT 1");
    if (!u || !(await passwordMatches(u.password_hash, p.password)))
      fail(401, "认证失败");
    return {
      access_token: await issueToken(u!.user_id, s),
      expires_in: s.jwtTtl,
    };
  }
  if (path === "/devices/pairing-codes") {
    const code = randomBytes(24).toString("base64url"),
      expires_at = new Date(Date.now() + s.pairingTtl * 1000);
    await tx.insert("pairing_codes", {
      pairing_code_id: randomUUID(),
      code_hash: sha256(code),
      expires_at,
      used_at: null,
      created_at: new Date(),
    });
    return { pairing_code: code, expires_at };
  }
  if (path === "/devices/pair") {
    if (p.previous_device_id) await user(tx, headers, s);
    try {
      decodeBase64(p.public_key, 32);
    } catch {
      fail(422, "公钥必须是 32 字节 Ed25519 的标准 Base64");
    }
    const consumed = await tx.one(
      "UPDATE pairing_codes SET used_at=now() WHERE code_hash=$1 AND used_at IS NULL AND expires_at>now() RETURNING pairing_code_id",
      [sha256(p.pairing_code)],
    );
    if (!consumed) fail(400, "配对码无效");
    let d = p.previous_device_id
      ? await tx.get("devices", p.previous_device_id)
      : undefined;
    const fields = {
      public_key: p.public_key,
      label: p.label,
      capabilities: p.capabilities ?? [],
      revoked_at: null,
      last_seen_at: null,
    };
    d = d
      ? await tx.save("devices", { ...d, ...fields })
      : await tx.insert("devices", {
          device_id: randomUUID(),
          ...fields,
          created_at: new Date(),
        });
    return task.deviceOut(d, s);
  }
  if (path === "/devices")
    return (
      await tx.rows("SELECT * FROM devices ORDER BY created_at,device_id")
    ).map((d) => task.deviceOut(d, s));
  if (path === "/devices/{device_id}/heartbeat") {
    if (actor !== a.device_id) fail(401, "设备认证失败");
    return task.deviceOut(
      (await tx.one(
        "UPDATE devices SET last_seen_at=now() WHERE device_id=$1 RETURNING *",
        [actor],
      ))!,
      s,
    );
  }
  if (path === "/devices/{device_id}/revoke") {
    const d = await tx.get("devices", a.device_id, true);
    d.revoked_at ??= new Date();
    await tx.save("devices", d);
    await tx.rows("SELECT pg_notify('tagent_changes','')");
    return task.deviceOut(d, s);
  }
  if (path === "/projects" && method === "GET") {
    const ps = await tx.rows(
      "SELECT * FROM projects ORDER BY created_at,project_id",
    );
    return Promise.all(
      ps.map(async (p) =>
        task.projectOut(p, await tx.get("devices", p.device_id)),
      ),
    );
  }
  if (path === "/projects" && method === "POST") {
    const id = p.request_id ? shared.uuid5(actor!, p.request_id) : randomUUID();
    const old = await tx.get("projects", id);
    const project =
      old ??
      (await tx.insert("projects", {
        project_id: id,
        device_id: actor,
        display_name: p.display_name,
        availability: p.availability ?? "available",
        created_at: new Date(),
        updated_at: new Date(),
      }));
    return task.projectOut(project, await tx.get("devices", actor!));
  }
  if (path === "/projects/{project_id}") {
    const project = await tx.get("projects", a.project_id, true);
    if (actor) {
      if (project.device_id !== actor) fail(404, "项目不存在");
      if (p.device_id) fail(403, "设备不能改绑项目");
    }
    if (p.device_id) {
      const d = await tx.get("devices", p.device_id, true);
      if (d.revoked_at) fail(400, "目标设备已撤销");
      project.device_id = p.device_id;
    }
    for (const k of ["display_name", "availability"])
      if (p[k] != null) project[k] = p[k];
    project.updated_at = new Date();
    await tx.save("projects", project);
    return task.projectOut(project, await tx.get("devices", project.device_id));
  }
  if (path === "/tasks" && method === "POST")
    return task.taskOut(tx, await task.createTask(tx, s, p), s);
  if (path === "/tasks" && method === "GET") {
    await task.expireDue(tx);
    return Promise.all(
      (
        await tx.rows("SELECT * FROM tasks ORDER BY created_at DESC,task_id")
      ).map((t) => task.taskOut(tx, t, s, false)),
    );
  }
  if (path === "/tasks/{task_id}") {
    await task.expireDue(tx);
    return task.taskOut(tx, await tx.get("tasks", a.task_id, true), s);
  }
  if (path === "/tasks/{task_id}/cancel") {
    await task.expireDue(tx);
    return task.taskOut(tx, await task.cancelTask(tx, s, a.task_id), s);
  }
  if (path === "/tasks/{task_id}/plans")
    return task.planOut(
      await task.publishPlan(tx, await tx.get("devices", actor!), a.task_id, p),
    );
  if (path === "/plans/{plan_id}")
    return task.planOut(await tx.get("plans", a.plan_id, true));
  if (/^\/(device\/)?plans\/\{plan_id\}\//.test(path)) {
    await task.expireDue(tx);
    if (actor)
      await tx.rows(
        "UPDATE devices SET last_seen_at=now() WHERE device_id=$1",
        [actor],
      );
    if (path.endsWith("/approve"))
      return task.approvePlan(tx, s, a.plan_id, p, actor);
    return task.taskOut(
      tx,
      path.endsWith("/reject")
        ? await task.rejectPlan(tx, a.plan_id, p, actor)
        : await task.revisePlan(tx, s, a.plan_id, p, actor),
      s,
    );
  }
  if (path === "/device/commands") return task.commands(tx, actor!);
  if (path === "/device/commands/{command_id}/ack")
    return task.ackCommand(tx, a.command_id, actor!);
  if (path === "/device/events") return task.ingest(tx, actor!, p);
  if (path === "/events")
    return task.events(tx, q.after ?? 0, q.limit ?? 100, q.task_id);
  const cloud = path.includes("/cloud/"),
    base = path.replace(/^\/device/, "").replace(/^\/cloud/, "");
  if (base === "/models" || base === "/configs/models") {
    const kind = cloud ? "cloud_model" : "model";
    return (await shared.docs(tx, kind)).map(shared.publicDoc);
  }
  if (base === "/models/from-mac")
    return shared.withReceipt(
      tx,
      `cloud-model-copy:${p.request_id}`,
      p,
      async () => {
        const d = await shared.loadDoc(tx, p.model_id, "model", actor);
        if (d.data.deleted) fail(404, "模型不存在");
        return shared.publicDoc(await shared.mirror(tx, s, d));
      },
    );
  if (base === "/models/{id}" || base === "/configs/models/{id}")
    return shared.putModel(tx, s, a.id, p, cloud, actor);
  if (base === "/models/{id}/delete" || base === "/configs/models/{id}/delete")
    return shared.deleteModel(tx, a.id, p, cloud, actor);
  if (base === "/configs/models/{id}/credential") {
    const d = await shared.loadDoc(tx, a.id, "model", actor);
    if (d.version !== q.version || d.data.deleted) fail(409, "配置版本已变化");
    reply.header("Cache-Control", "no-store");
    return { api_key: new Vault(s.vaultFile).open(d.data.secret, d.id) };
  }
  if (base === "/configs/models/{id}/applied") {
    const d = await shared.loadDoc(tx, a.id, "model", actor);
    if (d.version !== p.version) fail(409, "配置版本已变化");
    d.data = {
      ...d.data,
      apply_state: p.state,
      apply_error: p.error ?? null,
      applied_version:
        p.state === "applied" ? p.version : d.data.applied_version,
    };
    await shared.change(tx, d);
    return shared.publicDoc(d);
  }
  if (base === "/conversations")
    return (await shared.docs(tx, "conversation", cloud ? null : undefined))
      .filter((d) => !d.data.deleted)
      .reverse()
      .map(shared.publicDoc);
  if (base === "/conversations/{id}")
    return method === "GET"
      ? shared.publicDoc(await shared.loadDoc(tx, a.id, "conversation"))
      : shared.putConversation(tx, a.id, p, cloud, actor);
  if (base === "/conversations/{id}/handoff-from/{source_id}")
    return shared.handoff(tx, a.id, a.source_id, p, actor);
  if (base === "/conversations/{id}/messages") {
    if (method === "GET")
      return shared.messagePage(tx, a.id, q.after ?? 0, q.limit ?? 100, cloud);
    if (actor && !cloud) return shared.upload(tx, a.id, p, actor);
    return shared.send(tx, s, a.id, p, cloud);
  }
  if (base.startsWith("/chat-runs/{id}"))
    return shared.chatAction(
      tx,
      a.id,
      base.split("/")[3] ?? "get",
      p,
      actor,
      cloud,
    );
  if (path === "/device/shared/enable") {
    const d = await tx.get("devices", actor!);
    if (!d.capabilities.includes("shared_v1")) {
      d.capabilities.push("shared_v1");
      await tx.save("devices", d);
    }
    return { ok: true };
  }
  if (path === "/device/shared/snapshot")
    return {
      documents: (
        await tx.rows(
          "SELECT * FROM shared_documents WHERE device_id=$1 AND kind IN ('model','conversation','chat_run') ORDER BY position",
          [actor],
        )
      ).map((d) => ({ ...shared.publicDoc(d), entity_kind: d.kind })),
      tasks: (
        await tx.rows(
          "SELECT task_id,status FROM tasks WHERE target_device_id=$1",
          [actor],
        )
      ).map((t) => ({ id: t.task_id, state: t.status })),
    };
  if (path === "/device/shared/changes") {
    const after = q.after ?? 0,
      limit = q.limit ?? 100,
      rows = await tx.rows(
        "SELECT * FROM shared_changes WHERE device_id=$1 AND cursor>$2 ORDER BY cursor LIMIT $3",
        [actor, after, limit + 1],
      );
    return {
      changes: await Promise.all(
        rows.slice(0, limit).map(async (r) => {
          const d = await tx.get("shared_documents", r.entity_id);
          return {
            cursor: r.cursor,
            kind: r.kind,
            id: r.entity_id,
            document: d ? shared.publicDoc(d) : null,
          };
        }),
      ),
      next_cursor: rows.slice(0, limit).at(-1)?.cursor ?? after,
      has_more: rows.length > limit,
    };
  }
  if (base === "/configs/bundle")
    return {
      skills: await shared.configList(tx, "skill"),
      mcp_servers: await shared.configList(tx, "mcp_server"),
    };
  if (base.startsWith("/configs/")) {
    const resource = base.split("/")[2],
      kind =
        resource === "skills"
          ? "skill"
          : resource === "mcp-servers"
            ? "mcp_server"
            : a.kind === "skills"
              ? "skill"
              : "mcp_server";
    if (!a.id) return shared.configList(tx, kind);
    if (base.endsWith("/revisions")) {
      await shared.loadDoc(tx, a.id, kind, null);
      return (
        await tx.rows(
          "SELECT * FROM shared_revisions WHERE document_id=$1 ORDER BY version DESC",
          [a.id],
        )
      ).map((r) => ({
        version: r.version,
        content_hash: r.data.content_hash,
        deleted: !!r.data.deleted,
      }));
    }
    return shared.configWrite(
      tx,
      kind,
      a.id,
      p,
      base.endsWith("/applied")
        ? "applied"
        : base.endsWith("/delete")
          ? "delete"
          : "put",
      actor,
    );
  }
  return fail(404, "接口不存在");
}
