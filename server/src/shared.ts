import { randomUUID, createHash } from "node:crypto";
import { fail, type Tx, type Row } from "./db.js";
import { canonical, sha256, Vault } from "./security.js";
import type { Settings } from "./config.js";
import { createTask, revisePlan } from "./tasks.js";
export const terminal = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);
export function uuid5(namespace: string, value: string) {
  const b = createHash("sha1")
    .update(Buffer.from(namespace.replaceAll("-", ""), "hex"))
    .update(value)
    .digest()
    .subarray(0, 16);
  b[6] = (b[6] & 15) | 80;
  b[8] = (b[8] & 63) | 128;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
const privateFields = new Set([
  "secret",
  "worker_id",
  "lease_until",
  "generation",
]);
export const publicDoc = (d: Row) => ({
  id: d.id,
  device_id: d.device_id,
  version: d.version,
  ...Object.fromEntries(
    Object.entries(d.data).filter(([k]) => !privateFields.has(k)),
  ),
});
export async function loadDoc(
  tx: Tx,
  id: string,
  kind: string,
  owner?: string | null,
) {
  const d = await tx.get("shared_documents", id);
  if (!d || d.kind !== kind || (owner !== undefined && d.device_id !== owner))
    fail(404, "记录不存在");
  return d;
}
export async function docs(tx: Tx, kind: string, owner?: string | null) {
  return owner === undefined
    ? tx.rows(
        "SELECT * FROM shared_documents WHERE kind=$1 ORDER BY position",
        [kind],
      )
    : tx.rows(
        "SELECT * FROM shared_documents WHERE kind=$1 AND device_id IS NOT DISTINCT FROM $2::uuid ORDER BY position",
        [kind, owner],
      );
}
export async function change(tx: Tx, d: Row) {
  await tx.save("shared_documents", d);
  if (
    d.device_id === null &&
    ["conversation", "chat_run", "message"].includes(d.kind)
  ) {
    const c =
      d.kind === "conversation"
        ? d
        : await tx.get("shared_documents", d.data.conversation_id);
    if (c) {
      c.data = { ...c.data, updated_at: Date.now() };
      await tx.save("shared_documents", c);
    }
  }
  await tx.insert("shared_changes", {
    device_id: d.device_id,
    kind: d.kind,
    entity_id: d.id,
    version: d.version,
  });
  await tx.event(`${d.kind}.changed`, null, {
    id: d.id,
    version: d.version,
    device_id: d.device_id,
  });
  return d;
}
export async function newDoc(
  tx: Tx,
  id: string,
  kind: string,
  owner: string | null,
  data: Row,
  version = 1,
) {
  return tx.insert("shared_documents", {
    id,
    kind,
    device_id: owner,
    version,
    data,
  });
}
export async function revision(tx: Tx, d: Row) {
  await tx.insert("shared_revisions", {
    document_id: d.id,
    version: d.version,
    data: d.data,
  });
}
export async function reviseDoc(tx: Tx, d: Row, data: Row) {
  d.version++;
  d.data = data;
  await revision(tx, d);
  await change(tx, d);
  return d;
}
export function checkVersion(d: Row | undefined, version: number) {
  if ((d?.version ?? 0) !== version)
    fail(409, { message: "版本冲突", current: d ? publicDoc(d) : null });
  if (d?.data.deleted) fail(410, "记录已删除");
}
function legacyDigest(key: string, p: Row) {
  const ordered = (value: Row, fields: string) =>
    Object.fromEntries(
      fields
        .split(" ")
        .filter((k) => k in value)
        .map((k) => [k, value[k]]),
    );
  let fields = "expected_version request_id";
  if (key.startsWith("model:")) fields += " device_id config api_key";
  else if (key.startsWith("cloud-model:")) fields += " config api_key";
  else if (key.includes("model-copy")) fields = "request_id model_id";
  else if (key.includes("model-delete") || key.startsWith("delete-model:"))
    fields += " replacement_id";
  else if (key.startsWith("conversation:"))
    fields +=
      " device_id title kind model_config_id project_id shared deleted task_id";
  else if (key.startsWith("cloud-conversation:"))
    fields += " title model_config_id deleted";
  else if (key.startsWith("send:")) fields = "request_id text mode";
  else if (key.startsWith("cloud-handoff:"))
    fields = "request_id model_config_id title";
  else if (key.startsWith("skill:") || key.startsWith("mcp_server:"))
    fields += " config";
  const value = ordered(p, fields);
  if (value.config) {
    const c = value.config;
    if (c.base_url)
      value.config = ordered(
        c,
        "name base_url model_id context_window max_tokens is_default",
      );
    else if (c.content !== undefined) {
      value.config = ordered(
        c,
        "name description content files runtime enabled requires install_hint",
      );
      value.config.files = c.files.map((f: Row) => ordered(f, "path content"));
      value.config.requires = ordered(
        c.requires,
        "commands platforms scripts mcp",
      );
    } else {
      value.config = ordered(
        c,
        "name transport command args url timeout_ms env runtime enabled disabled_tools",
      );
      value.config.env = c.env.map((e: Row) =>
        ordered(e, "name value secret_ref"),
      );
    }
  }
  return sha256(JSON.stringify(value));
}
export async function withReceipt(
  tx: Tx,
  key: string,
  p: Row,
  fn: () => Promise<any>,
) {
  const digest = sha256(canonical(p)),
    r = await tx.get("shared_receipts", key);
  if (r) {
    if (r.digest !== digest && r.digest !== legacyDigest(key, p))
      fail(409, "幂等 ID 内容不一致");
    return r.result;
  }
  const result = await fn();
  await tx.insert("shared_receipts", { id: key, digest, result });
  return result;
}
async function target(tx: Tx, id: string) {
  const d = await tx.get("devices", id);
  if (!d || d.revoked_at || !d.capabilities.includes("shared_v1"))
    fail(409, "目标设备不可用或需升级");
  return d;
}
async function clearDefault(
  tx: Tx,
  kind: string,
  id: string,
  owner: string | null,
) {
  for (const other of await docs(tx, kind, owner))
    if (other.id !== id && !other.data.deleted && other.data.config.is_default)
      await reviseDoc(tx, other, {
        ...other.data,
        config: { ...other.data.config, is_default: false },
        ...(kind === "model" ? { apply_state: "pending" } : {}),
      });
}
export async function mirror(tx: Tx, s: Settings, source: Row) {
  const vault = new Vault(s.vaultFile),
    models = await docs(tx, "cloud_model"),
    mirrors = models.filter((m) => m.data.source_model_id === source.id),
    old = mirrors.find((m) => !m.data.deleted) ?? mirrors[0],
    id = old?.id ?? randomUUID(),
    version = (old?.version ?? 0) + 1,
    others = models.filter((m) => !m.data.deleted && m.id !== id),
    config = {
      ...source.data.config,
      is_default:
        !!(old && !old.data.deleted && old.data.config.is_default) ||
        !others.length,
    };
  if (config.is_default) await clearDefault(tx, "cloud_model", id, null);
  const data = {
    config,
    secret: vault.seal(vault.open(source.data.secret, source.id), id, version),
    has_key: true,
    deleted: false,
    source_model_id: source.id,
  };
  if (old) return reviseDoc(tx, old, data);
  const d = await newDoc(tx, id, "cloud_model", null, data);
  await revision(tx, d);
  await change(tx, d);
  return d;
}
export async function putModel(
  tx: Tx,
  s: Settings,
  id: string,
  p: Row,
  cloud: boolean,
  actor?: string,
) {
  const kind = cloud ? "cloud_model" : "model",
    owner = cloud ? null : p.device_id;
  if (!cloud) {
    await target(tx, owner);
    if (actor && actor !== owner) fail(403, "无权修改其他设备配置");
  }
  return withReceipt(
    tx,
    cloud ? `cloud-model:${p.request_id}` : `model:${owner}:${p.request_id}`,
    p,
    async () => {
      const d = await tx.get("shared_documents", id);
      if (d && (d.kind !== kind || d.device_id !== owner))
        fail(403, "配置归属不匹配");
      checkVersion(d, p.expected_version);
      const u = new URL(p.config.base_url);
      if (
        !["http:", "https:"].includes(u.protocol) ||
        u.username ||
        u.password ||
        u.search ||
        u.hash ||
        p.config.max_tokens >= p.config.context_window
      )
        fail(422, "模型配置无效");
      const vault = new Vault(s.vaultFile),
        version = (d?.version ?? 0) + 1,
        secret = p.api_key
          ? vault.seal(p.api_key, id, version)
          : d?.data.secret;
      if (!secret) fail(422, "新模型必须提供 API Key");
      const data = {
        config: p.config,
        secret,
        has_key: true,
        deleted: false,
        ...(cloud
          ? { source_model_id: d?.data.source_model_id ?? null }
          : {
              credential_version: secret.version,
              applied_version: d?.data.applied_version ?? 0,
              apply_state: "pending",
              apply_error: null,
            }),
      };
      if (p.config.is_default) await clearDefault(tx, kind, id, owner);
      const saved = d
        ? await reviseDoc(tx, d, data)
        : await newDoc(tx, id, kind, owner, data);
      if (!d) {
        await revision(tx, saved);
        await change(tx, saved);
      }
      if (!cloud) await mirror(tx, s, saved);
      return publicDoc(saved);
    },
  );
}
export async function deleteModel(
  tx: Tx,
  id: string,
  p: Row,
  cloud: boolean,
  actor?: string,
) {
  const d = await loadDoc(tx, id, cloud ? "cloud_model" : "model", actor),
    key = cloud
      ? `cloud-model-delete:${p.request_id}`
      : `delete-model:${d.device_id}:${p.request_id}`;
  return withReceipt(tx, key, p, async () => {
    checkVersion(d, p.expected_version);
    const cs = (await docs(tx, "conversation", d.device_id)).filter(
      (c) => !c.data.deleted && c.data.model_config_id === id,
    );
    if (p.replacement_id) {
      const r = await loadDoc(tx, p.replacement_id, d.kind);
      if (r.id === id || r.device_id !== d.device_id || r.data.deleted)
        fail(409, "替代模型无效");
    } else if (cs.length) fail(409, "需选择替代模型");
    await reviseDoc(tx, d, {
      ...d.data,
      deleted: true,
      replacement_id: p.replacement_id ?? null,
      ...(cloud ? { secret: null } : { apply_state: "pending" }),
    });
    for (const c of cs)
      await reviseDoc(tx, c, { ...c.data, model_config_id: p.replacement_id });
    if (!cloud)
      for (const m of (await docs(tx, "cloud_model")).filter(
        (m) => !m.data.deleted && m.data.source_model_id === id,
      ))
        if (
          !(await docs(tx, "conversation", null)).some(
            (c) => !c.data.deleted && c.data.model_config_id === m.id,
          )
        )
          await reviseDoc(tx, m, { ...m.data, deleted: true, secret: null });
    return publicDoc(d);
  });
}
export async function putConversation(
  tx: Tx,
  id: string,
  p: Row,
  cloud: boolean,
  actor?: string,
) {
  const owner = cloud ? null : p.device_id;
  if (!cloud) {
    await target(tx, owner);
    if (actor && actor !== owner) fail(403, "会话归属不匹配");
  }
  return withReceipt(
    tx,
    cloud
      ? `cloud-conversation:${p.request_id}`
      : `conversation:${owner}:${p.request_id}`,
    p,
    async () => {
      const d = await tx.get("shared_documents", id);
      if (d && (d.kind !== "conversation" || d.device_id !== owner))
        fail(409, "会话 ID 已被占用");
      checkVersion(d, p.expected_version);
      const model = await loadDoc(
        tx,
        p.model_config_id,
        cloud ? "cloud_model" : "model",
      );
      if (model.data.deleted || model.device_id !== owner)
        fail(409, "模型不可用");
      if (!cloud && p.kind === "read_code") {
        const project = await tx.get("projects", p.project_id);
        if (
          !project ||
          project.device_id !== owner ||
          project.availability !== "available"
        )
          fail(409, "项目未共享或不可用");
      }
      if (
        !cloud &&
        d &&
        (d.data.kind !== p.kind || d.data.project_id !== (p.project_id ?? null))
      )
        fail(409, "不能切换会话项目或类型");
      if (p.task_id) {
        const t = await tx.get("tasks", p.task_id);
        if (!t || t.target_device_id !== owner) fail(403, "任务归属不匹配");
      }
      if (p.deleted && (await activeRun(tx, id, owner)))
        fail(409, "请先停止运行");
      const data = cloud
        ? {
            ...(d?.data ?? {
              kind: "ask",
              target: "cloud",
              project_id: null,
              task_id: null,
              shared: true,
              share_version: 1,
              handoff: null,
              generation: 0,
            }),
            title: p.title,
            model_config_id: p.model_config_id,
            deleted: p.deleted ?? false,
          }
        : {
            title: p.title,
            kind: p.kind,
            model_config_id: p.model_config_id,
            project_id: p.project_id ?? null,
            shared: p.shared ?? true,
            deleted: p.deleted ?? false,
            task_id: p.task_id ?? d?.data.task_id ?? null,
            share_version: d
              ? d.data.share_version +
                Number(d.data.shared !== (p.shared ?? true))
              : 1,
          };
      const saved = d
        ? await reviseDoc(tx, d, data)
        : await newDoc(tx, id, "conversation", owner, data);
      if (!d) await change(tx, saved);
      if (p.deleted)
        await tx.rows(
          "DELETE FROM shared_documents WHERE kind='message' AND data->>'conversation_id'=$1",
          [id],
        );
      return publicDoc(saved);
    },
  );
}
export async function activeRun(tx: Tx, id: string, owner: string | null) {
  return (await docs(tx, "chat_run", owner)).some(
    (r) => r.data.conversation_id === id && !terminal.has(r.data.state),
  );
}
export async function messagePage(
  tx: Tx,
  id: string,
  after = 0,
  limit = 100,
  cloudOnly = false,
) {
  const c = await loadDoc(tx, id, "conversation", cloudOnly ? null : undefined);
  if (c.data.deleted) fail(410, "会话已删除");
  const ms = await tx.rows(
    "SELECT * FROM shared_documents WHERE kind='message' AND device_id IS NOT DISTINCT FROM $1::uuid AND data->>'conversation_id'=$2 ORDER BY (data->>'sequence')::bigint",
    [c.device_id, id],
  );
  const rows = ms.filter((m) => m.data.sequence > after);
  return {
    pending_messages: ms.filter((m) => m.data.sequence === 0).map(publicDoc),
    messages: rows.slice(0, limit).map(publicDoc),
    next_cursor: rows.slice(0, limit).at(-1)?.data.sequence ?? after,
    has_more: rows.length > limit,
  };
}
export async function upload(tx: Tx, id: string, p: Row, actor: string) {
  const c = await loadDoc(tx, id, "conversation", actor);
  if (
    c.data.deleted ||
    !c.data.shared ||
    c.data.share_version !== p.share_version
  )
    fail(409, "会话共享状态已变化");
  for (const m of p.messages) {
    const d = await tx.get("shared_documents", m.id);
    if (
      d &&
      (d.kind !== "message" ||
        d.device_id !== actor ||
        d.data.conversation_id !== id)
    )
      fail(409, "消息归属不匹配");
    if (d && (d.version >= m.revision || terminal.has(d.data.status))) continue;
    const { id: _id, revision: _revision, ...fields } = m;
    const data = { ...fields, conversation_id: id };
    const saved = d
      ? Object.assign(d, { version: m.revision, data })
      : await newDoc(tx, m.id, "message", actor, data, m.revision);
    await change(tx, saved);
  }
  return { ok: true };
}
export async function send(
  tx: Tx,
  s: Settings,
  id: string,
  p: Row,
  cloudOnly = false,
) {
  const c = await loadDoc(tx, id, "conversation", cloudOnly ? null : undefined);
  if (c.device_id) await target(tx, c.device_id);
  return withReceipt(tx, `send:${id}:${p.request_id}`, p, async () => {
    if (c.data.deleted || !c.data.shared) fail(409, "会话已停止共享");
    if (await activeRun(tx, id, c.device_id))
      fail(409, "该会话已有未结束的请求");
    if (c.data.kind === "read_code") {
      const project = await tx.get("projects", c.data.project_id);
      if (
        !project ||
        project.device_id !== c.device_id ||
        project.availability !== "available"
      )
        fail(409, "项目不可用");
    }
    if (!c.device_id) {
      const m = await loadDoc(tx, c.data.model_config_id, "cloud_model");
      if (m.data.deleted) fail(409, "云端模型不可用，请更换模型");
    }
    const task = c.data.task_id
        ? await tx.get("tasks", c.data.task_id)
        : undefined,
      busy = new Set([
        "queued",
        "waiting_for_device",
        "planning",
        "approved",
        "running",
        "waiting_for_local_action",
      ]);
    if (task && busy.has(task.status))
      fail(409, "该会话已有未结束的规划或执行");
    if (p.mode === "plan") {
      if (!c.device_id || c.data.kind !== "read_code" || !c.data.project_id)
        fail(409, "只有项目会话可以请求计划");
      if (
        task?.cancel_requested_at &&
        !["completed", "failed", "cancelled", "rejected"].includes(task.status)
      )
        fail(409, "任务正在取消");
      const mid = uuid5(
          "6ba7b811-9dad-11d1-80b4-00c04fd430c8",
          `${id}:${p.request_id}`,
        ),
        links = { conversation_id: id, message_id: mid },
        rev =
          task &&
          [
            "awaiting_review",
            "waiting_for_input",
            "needs_replan",
            "interrupted",
          ].includes(task.status);
      if (rev && !task.latest_plan_id) fail(409, "计划尚未发布");
      const t = rev
          ? await revisePlan(
              tx,
              s,
              task.latest_plan_id,
              { feedback: p.text, idempotency_key: p.request_id },
              undefined,
              links,
            )
          : await createTask(
              tx,
              s,
              {
                project_id: c.data.project_id,
                requirement: p.text,
                idempotency_key: p.request_id,
              },
              links,
            ),
        r = await tx.one(
          "SELECT * FROM runs WHERE task_id=$1 ORDER BY created_at DESC LIMIT 1",
          [t.task_id],
        );
      if (!(await tx.get("shared_documents", mid)))
        await change(
          tx,
          await newDoc(
            tx,
            mid,
            "message",
            c.device_id,
            {
              conversation_id: id,
              run_id: r!.run_id,
              role: "user",
              content: p.text,
              status: "queued",
              sequence: 0,
            },
            0,
          ),
        );
      c.version++;
      c.data = { ...c.data, task_id: t.task_id };
      await change(tx, c);
      return {
        mode: "plan",
        conversation_id: id,
        message_id: mid,
        task_id: t.task_id,
        action: rev ? "plan_revise" : "plan_request",
      };
    }
    const rid = randomUUID(),
      mid = randomUUID();
    await newDoc(
      tx,
      mid,
      "message",
      c.device_id,
      {
        conversation_id: id,
        run_id: rid,
        role: "user",
        content: p.text,
        status: "queued",
        sequence: 0,
      },
      0,
    );
    const d = await newDoc(tx, rid, "chat_run", c.device_id, {
      conversation_id: id,
      message_id: mid,
      text: p.text,
      state: "queued",
      share_version: c.data.share_version,
      acked: false,
      cancel_requested: false,
      local_run_id: null,
    });
    await change(tx, d);
    return publicDoc(d);
  });
}
export async function finishPending(tx: Tx, run: Row) {
  const m = await tx.get("shared_documents", run.data.message_id);
  if (m && m.data.sequence === 0 && m.data.status === "queued") {
    m.version++;
    m.data = { ...m.data, status: run.data.state };
    await change(tx, m);
  }
}
export async function chatAction(
  tx: Tx,
  id: string,
  action: string,
  p: Row,
  actor?: string,
  cloudOnly = false,
) {
  const d = await loadDoc(tx, id, "chat_run", cloudOnly ? null : actor);
  if (action === "get") return publicDoc(d);
  if (action === "cancel") {
    if (!terminal.has(d.data.state)) {
      d.version++;
      d.data = {
        ...d.data,
        cancel_requested: true,
        state: d.data.acked ? d.data.state : "cancelled",
      };
      await change(tx, d);
    }
    if (terminal.has(d.data.state)) await finishPending(tx, d);
  } else if (!terminal.has(d.data.state)) {
    if (action === "ack") {
      const c = await loadDoc(
        tx,
        d.data.conversation_id,
        "conversation",
        actor,
      );
      if (
        c.data.deleted ||
        !c.data.shared ||
        c.data.share_version !== d.data.share_version
      ) {
        d.version++;
        d.data = { ...d.data, state: "cancelled" };
        await change(tx, d);
        await finishPending(tx, d);
      } else {
        d.data = { ...d.data, acked: true };
        await tx.save("shared_documents", d);
      }
    }
    if (action === "result") {
      if (!d.data.acked) fail(409, "请先确认接收");
      d.version++;
      d.data = {
        ...d.data,
        state: p.state,
        local_run_id: p.local_run_id ?? d.data.local_run_id,
      };
      await change(tx, d);
      if (terminal.has(p.state)) await finishPending(tx, d);
    }
  }
  return publicDoc(d);
}
export async function handoff(
  tx: Tx,
  id: string,
  sourceId: string,
  p: Row,
  actor?: string,
) {
  return withReceipt(tx, `cloud-handoff:${p.request_id}`, p, async () => {
    if (await tx.get("shared_documents", id)) fail(409, "会话 ID 已被占用");
    const c = await loadDoc(tx, sourceId, "conversation", actor);
    if (!c.device_id || c.data.deleted || !c.data.shared)
      fail(409, "只有已共享的会话可以转到云端");
    const model = await loadDoc(tx, p.model_config_id, "cloud_model");
    if (model.data.deleted) fail(409, "云端模型不可用");
    const ms = (
        await tx.rows(
          "SELECT * FROM shared_documents WHERE kind='message' AND data->>'conversation_id'=$1 ORDER BY (data->>'sequence')::bigint",
          [sourceId],
        )
      )
        .filter(
          (m) =>
            m.data.sequence > 0 &&
            m.data.status === "completed" &&
            m.data.content,
        )
        .slice(-40),
      kept: Row[] = [];
    let budget = 60000;
    for (const m of ms.reverse()) {
      if (m.data.content.length > budget) break;
      budget -= m.data.content.length;
      kept.unshift(m);
    }
    const d = await newDoc(tx, id, "conversation", null, {
        kind: "ask",
        target: "cloud",
        project_id: null,
        task_id: null,
        shared: true,
        share_version: 1,
        generation: 0,
        deleted: false,
        title: p.title ?? `${c.data.title}（云端）`.slice(0, 120),
        model_config_id: p.model_config_id,
        handoff: { from_conversation_id: sourceId, message_count: kept.length },
      }),
      rid = randomUUID();
    for (const [i, m] of kept.entries())
      await newDoc(tx, randomUUID(), "message", null, {
        conversation_id: id,
        run_id: rid,
        role: m.data.role,
        content: m.data.content,
        status: "completed",
        sequence: i + 1,
      });
    await change(tx, d);
    return publicDoc(d);
  });
}
export async function configPresent(tx: Tx, d: Row) {
  const labels = new Map(
    (await tx.rows("SELECT device_id,label FROM devices")).map((r) => [
      r.device_id,
      r.label,
    ]),
  );
  return {
    id: d.id,
    version: d.version,
    config: d.data.config,
    content_hash: d.data.content_hash,
    deleted: !!d.data.deleted,
    devices: Object.entries(d.data.devices ?? {}).map(([id, raw]) => {
      const st = raw as Row,
        state = st.checked_version === d.version ? st.state : "pending";
      return {
        ...st,
        device_id: id,
        label: labels.get(id) ?? "",
        state,
        reasons: state === "pending" ? [] : st.reasons,
      };
    }),
    ...(d.data.cloud ? { cloud: d.data.cloud } : {}),
  };
}
export async function configList(tx: Tx, kind: string) {
  return Promise.all(
    (await docs(tx, kind, null))
      .filter((d) => !d.data.deleted)
      .map((d) => configPresent(tx, d)),
  );
}
function configValidate(kind: string, c: Row) {
  const path = (p: string) =>
    !p.startsWith("/") &&
    !p.includes("\\") &&
    !p.includes("\0") &&
    p !== "SKILL.md" &&
    p.split("/").every((x) => x && x !== "." && x !== "..");
  if (kind === "skill") {
    const files = c.files ?? [],
      paths = files.map((f: Row) => f.path);
    if (
      paths.some((p: string) => !path(p)) ||
      new Set(paths).size !== paths.length ||
      (c.requires.scripts ?? []).some((p: string) => !paths.includes(p)) ||
      Buffer.byteLength(c.content) +
        files.reduce(
          (n: number, f: Row) => n + Buffer.byteLength(f.content),
          0,
        ) >
        1024 * 1024
    )
      fail(422, "技能包无效");
  } else {
    if (
      c.transport === "stdio"
        ? !c.command || c.url
        : !c.url || c.command || c.args.length
    )
      fail(422, "MCP transport 无效");
    if (c.url) {
      const u = new URL(c.url);
      if (!["http:", "https:"].includes(u.protocol) || u.username || u.password)
        fail(422, "URL 无效");
    }
    const names = new Set();
    for (const e of c.env) {
      if (
        names.has(e.name) ||
        (e.value == null) === (e.secret_ref == null) ||
        (e.value != null &&
          /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL/i.test(e.name))
      )
        fail(422, "环境变量无效");
      names.add(e.name);
    }
  }
}
export async function configWrite(
  tx: Tx,
  kind: string,
  id: string,
  p: Row,
  action: string,
  actor?: string,
) {
  const d = await tx.get("shared_documents", id);
  if (d && (d.kind !== kind || d.device_id !== null))
    fail(403, "配置类型不匹配");
  if (action === "applied") {
    if (!d) fail(404, "配置不存在");
    if (
      d.data.deleted ||
      d.version !== p.version ||
      d.data.content_hash !== p.hash
    )
      fail(409, "配置版本已变化");
    const prev = d.data.devices?.[actor!] ?? {
        applied_version: 0,
        applied_hash: null,
      },
      usable = ["available", "not_applicable"].includes(p.state),
      next = {
        checked_version: p.version,
        state: p.state,
        reasons: p.reasons ?? [],
        checked_at: new Date().toISOString(),
        applied_version: usable ? p.version : prev.applied_version,
        applied_hash: usable ? p.hash : prev.applied_hash,
      };
    d.data = { ...d.data, devices: { ...d.data.devices, [actor!]: next } };
    await change(tx, d);
    return configPresent(tx, d);
  }
  return withReceipt(
    tx,
    `${action === "delete" ? "delete-" : ""}${kind}:${p.request_id}`,
    p,
    async () => {
      checkVersion(d, p.expected_version);
      if (action === "delete") {
        if (!d) fail(404, "配置不存在");
        await reviseDoc(tx, d, { ...d.data, deleted: true });
        return configPresent(tx, d);
      }
      configValidate(kind, p.config);
      if (
        (await docs(tx, kind, null)).some(
          (o) =>
            o.id !== id &&
            !o.data.deleted &&
            o.data.config.name === p.config.name,
        )
      )
        fail(409, "名称已存在");
      const data = {
        config: p.config,
        content_hash: sha256(canonical(p.config)),
        deleted: false,
        devices: d?.data.devices ?? {},
      };
      const saved = d
        ? await reviseDoc(tx, d, data)
        : await newDoc(tx, id, kind, null, data);
      if (!d) {
        await revision(tx, saved);
        await change(tx, saved);
      }
      return configPresent(tx, saved);
    },
  );
}
