import { randomUUID } from "node:crypto";
import { fail, type Row, type Tx } from "./db.js";
import { sha256, canonical } from "./security.js";
import type { Settings } from "./config.js";
export const terminalTask = new Set([
  "completed",
  "failed",
  "cancelled",
  "rejected",
]);
const active = new Set([
  "queued",
  "running",
  "waiting_for_input",
  "waiting_for_local_action",
]);
const planCommands = new Set(["plan_request", "plan_revise"]);
export const presence = (d: Row, s: Settings) =>
  !d.revoked_at &&
  d.last_seen_at &&
  Date.now() - new Date(d.last_seen_at).getTime() <= s.presenceTtl * 1000
    ? "online"
    : "offline";
const pick = (r: Row, names: string) =>
  Object.fromEntries(names.split(" ").map((k) => [k, r[k]]));
export const deviceOut = (d: Row, s: Settings) => ({
  ...pick(d, "device_id label public_key capabilities last_seen_at revoked_at"),
  presence: presence(d, s),
});
export const projectOut = (p: Row, d: Row) => ({
  ...p,
  availability: d.revoked_at ? "unavailable" : p.availability,
});
export const commandOut = (c: Row): Row => ({
  ...pick(c, "command_id task_id run_id payload expires_at created_at"),
  command_type: c.type,
});
export const eventOut = (e: Row) =>
  pick(
    e,
    "event_id server_cursor type task_id run_id producer_id producer_seq schema_version occurred_at payload",
  );
const planSummary = (p: Row) =>
  pick(p, "plan_id version content_hash created_at superseded_at");
export const planOut = (p: Row) => ({
  ...planSummary(p),
  ...pick(
    p,
    "task_id device_id project_id body workspace_fingerprint config_snapshot_id",
  ),
});
export async function taskOut(tx: Tx, t: Row, s: Settings, detail = true) {
  const d = await tx.get("devices", t.target_device_id);
  const result = {
    ...pick(
      t,
      "task_id project_id target_device_id requirement status cancel_requested_at latest_plan_id created_at updated_at",
    ),
    cancel_requested: !!t.cancel_requested_at,
    device_presence: presence(d, s),
  };
  return detail
    ? {
        ...result,
        plans: (
          await tx.rows(
            "SELECT * FROM plans WHERE task_id=$1 ORDER BY version",
            [t.task_id],
          )
        ).map(planSummary),
        runs: (
          await tx.rows(
            "SELECT * FROM runs WHERE task_id=$1 ORDER BY created_at,run_id",
            [t.task_id],
          )
        ).map((r) =>
          pick(
            r,
            "run_id phase attempt state approval_id created_at updated_at",
          ),
        ),
      }
    : result;
}
async function status(tx: Tx, t: Row, value: string) {
  if (t.status === value) return;
  const previous = t.status;
  t.status = value;
  t.updated_at = new Date();
  await tx.save("tasks", t);
  await tx.event("task.status_changed", t.task_id, { status: value, previous });
}
async function runState(tx: Tx, r: Row, state: string) {
  r.state = state;
  r.updated_at = new Date();
  await tx.save("runs", r);
}
async function newRun(
  tx: Tx,
  t: Row,
  phase: string,
  approval_id: string | null = null,
) {
  const n = await tx.one(
    "SELECT count(*) AS count FROM runs WHERE task_id=$1 AND phase=$2",
    [t.task_id, phase],
  );
  return tx.insert("runs", {
    run_id: randomUUID(),
    task_id: t.task_id,
    phase,
    attempt: Number(n?.count) + 1,
    approval_id,
    state: "queued",
    created_at: new Date(),
    updated_at: new Date(),
  });
}
async function newCommand(
  tx: Tx,
  t: Row,
  r: Row,
  type: string,
  payload: Row,
  ttl: number,
) {
  const c = await tx.insert("commands", {
    command_id: randomUUID(),
    device_id: t.target_device_id,
    task_id: t.task_id,
    run_id: r.run_id,
    type,
    payload,
    status: "pending",
    expires_at: new Date(Date.now() + ttl * 1000),
    created_at: new Date(),
    delivered_at: null,
    acked_at: null,
  });
  await tx.rows("SELECT pg_notify('tagent_changes','')");
  return c;
}
export async function createTask(tx: Tx, s: Settings, p: Row, links: Row = {}) {
  const old = await tx.one("SELECT * FROM tasks WHERE idempotency_key=$1", [
    p.idempotency_key,
  ]);
  if (old) {
    if (old.project_id !== p.project_id || old.requirement !== p.requirement)
      fail(409, "幂等键已用于其他请求");
    return old;
  }
  const project = await tx.get("projects", p.project_id, true),
    d = await tx.get("devices", project.device_id);
  if (!d || d.revoked_at || project.availability !== "available")
    fail(409, "项目不可用");
  const t = await tx.insert("tasks", {
    task_id: randomUUID(),
    project_id: project.project_id,
    target_device_id: d.device_id,
    requirement: p.requirement,
    status: presence(d, s) === "online" ? "queued" : "waiting_for_device",
    idempotency_key: p.idempotency_key,
    cancel_requested_at: null,
    latest_plan_id: null,
    created_at: new Date(),
    updated_at: new Date(),
  });
  const r = await newRun(tx, t, "plan");
  await newCommand(
    tx,
    t,
    r,
    "plan_request",
    {
      task_id: t.task_id,
      run_id: r.run_id,
      project_id: t.project_id,
      requirement: t.requirement,
      ...links,
    },
    s.commandTtl,
  );
  await tx.event(
    "task.created",
    t.task_id,
    {
      status: t.status,
      project_id: t.project_id,
      target_device_id: d.device_id,
    },
    r.run_id,
  );
  return t;
}
export async function publishPlan(tx: Tx, d: Row, id: string, p: Row) {
  const t = await tx.get("tasks", id, true);
  if (t.target_device_id !== d.device_id) fail(404, "任务不存在");
  const project = await tx.get("projects", t.project_id);
  if (project?.device_id !== d.device_id) fail(409, "项目已改绑到其他设备");
  const old = await tx.one(
    "SELECT * FROM plans WHERE task_id=$1 AND version=$2",
    [id, p.version],
  );
  if (old) {
    if (old.content_hash === p.content_hash) return old;
    fail(409, "该版本已发布，不能改写");
  }
  const r = await tx.get("runs", p.run_id);
  if (!r || r.task_id !== id || r.phase !== "plan") fail(400, "规划运行无效");
  if (
    !active.has(r.state) ||
    terminalTask.has(t.status) ||
    t.cancel_requested_at
  )
    fail(409, "规划运行已结束或任务正在取消");
  const v = await tx.one(
    "SELECT coalesce(max(version),0) AS version FROM plans WHERE task_id=$1",
    [id],
  );
  if (p.version !== v!.version + 1) fail(409, "版本号不连续");
  const material = {
    task_id: id,
    version: p.version,
    project_id: t.project_id,
    device_id: d.device_id,
    body: p.body,
    workspace_fingerprint: p.workspace_fingerprint,
    config_snapshot_id: p.config_snapshot_id,
  };
  if (sha256(canonical(material)) !== p.content_hash)
    fail(400, "content_hash 与计划内容不符");
  const plan = await tx.insert("plans", {
    plan_id: randomUUID(),
    ...material,
    content_hash: p.content_hash,
    created_at: new Date(),
    superseded_at: null,
  });
  for (const old of await tx.rows(
    "SELECT * FROM plans WHERE task_id=$1 AND superseded_at IS NULL AND plan_id<>$2",
    [id, plan.plan_id],
  )) {
    old.superseded_at = new Date();
    await tx.save("plans", old);
    await tx.event("plan.superseded", id, {
      plan_id: old.plan_id,
      version: old.version,
      superseded_by: plan.plan_id,
    });
  }
  await tx.rows(
    "UPDATE commands SET status='acked',delivered_at=coalesce(delivered_at,now()),acked_at=now() WHERE run_id=$1 AND status IN ('pending','delivered')",
    [r.run_id],
  );
  t.latest_plan_id = plan.plan_id;
  await tx.save("tasks", t);
  await runState(tx, r, "completed");
  await tx.event(
    "plan.published",
    id,
    {
      plan_id: plan.plan_id,
      version: plan.version,
      content_hash: plan.content_hash,
    },
    r.run_id,
  );
  await status(
    tx,
    t,
    p.body.questions?.length ? "waiting_for_input" : "awaiting_review",
  );
  return plan;
}
async function planTask(tx: Tx, id: string, deviceId?: string) {
  const p = await tx.get("plans", id, true),
    t = await tx.get("tasks", p.task_id, true);
  if (deviceId && t.target_device_id !== deviceId)
    fail(403, "只有任务的执行设备可以审批");
  return { p, t, actor: deviceId ? "device" : "user" };
}
function latest(t: Row, p: Row) {
  if (p.superseded_at || t.latest_plan_id !== p.plan_id)
    fail(409, "计划已被新版本取代");
}
async function usable(tx: Tx, t: Row) {
  const d = await tx.get("devices", t.target_device_id),
    p = await tx.get("projects", t.project_id);
  if (!d || d.revoked_at) fail(409, "执行设备已撤销");
  if (p?.device_id !== t.target_device_id) fail(409, "项目已改绑到其他设备");
  return d;
}
export async function approvePlan(
  tx: Tx,
  s: Settings,
  id: string,
  data: Row,
  deviceId?: string,
) {
  const { p, t, actor } = await planTask(tx, id, deviceId);
  if (data.version !== p.version || data.content_hash !== p.content_hash)
    fail(409, "计划版本或 hash 不匹配");
  let a = await tx.one("SELECT * FROM approvals WHERE idempotency_key=$1", [
    data.idempotency_key,
  ]);
  if (a && (a.plan_id !== id || a.status === "rejected"))
    fail(409, "幂等键已用于其他请求");
  a ??= await tx.one(
    "SELECT * FROM approvals WHERE plan_id=$1 AND status='recorded'",
    [id],
  );
  if (a) {
    const r = await tx.one("SELECT * FROM runs WHERE approval_id=$1", [
      a.approval_id,
    ]);
    return { ...a, run_id: r!.run_id, idempotency_key: undefined };
  }
  latest(t, p);
  if (
    t.status !== "awaiting_review" ||
    t.cancel_requested_at ||
    p.body.questions?.length
  )
    fail(409, "任务当前不能批准");
  await usable(tx, t);
  a = await tx.insert("approvals", {
    approval_id: randomUUID(),
    plan_id: id,
    task_id: t.task_id,
    version: p.version,
    content_hash: p.content_hash,
    device_id: t.target_device_id,
    project_id: t.project_id,
    status: "recorded",
    actor,
    expires_at: new Date(Date.now() + s.approvalTtl * 1000),
    idempotency_key: data.idempotency_key,
    created_at: new Date(),
  });
  const r = await newRun(tx, t, "execute", a.approval_id);
  await newCommand(
    tx,
    t,
    r,
    "execute",
    {
      task_id: t.task_id,
      run_id: r.run_id,
      project_id: t.project_id,
      approval_id: a.approval_id,
      plan_id: id,
      version: p.version,
      content_hash: p.content_hash,
      expires_at: a.expires_at.toISOString(),
    },
    s.approvalTtl,
  );
  await tx.event(
    "approval.recorded",
    t.task_id,
    {
      approval_id: a.approval_id,
      plan_id: id,
      version: p.version,
      expires_at: a.expires_at.toISOString(),
      actor,
    },
    r.run_id,
  );
  await status(tx, t, "approved");
  return { ...a, run_id: r.run_id, idempotency_key: undefined };
}
export async function rejectPlan(
  tx: Tx,
  id: string,
  data: Row,
  deviceId?: string,
) {
  const { p, t, actor } = await planTask(tx, id, deviceId),
    old = await tx.one("SELECT * FROM approvals WHERE idempotency_key=$1", [
      data.idempotency_key,
    ]);
  if (old) {
    if (old.plan_id !== id || old.status !== "rejected")
      fail(409, "幂等键已用于其他请求");
    return t;
  }
  latest(t, p);
  if (!["awaiting_review", "waiting_for_input"].includes(t.status))
    fail(409, "任务当前不能拒绝");
  const a = await tx.insert("approvals", {
    approval_id: randomUUID(),
    plan_id: id,
    task_id: t.task_id,
    version: p.version,
    content_hash: p.content_hash,
    device_id: t.target_device_id,
    project_id: t.project_id,
    status: "rejected",
    actor,
    expires_at: null,
    idempotency_key: data.idempotency_key,
    created_at: new Date(),
  });
  await tx.event("approval.rejected", t.task_id, {
    approval_id: a.approval_id,
    plan_id: id,
    version: p.version,
    actor,
  });
  await status(tx, t, "rejected");
  return t;
}
export async function revisePlan(
  tx: Tx,
  s: Settings,
  id: string,
  data: Row,
  deviceId?: string,
  links: Row = {},
) {
  const { p, t, actor } = await planTask(tx, id, deviceId),
    old = await tx.one("SELECT * FROM plan_feedback WHERE idempotency_key=$1", [
      data.idempotency_key,
    ]);
  if (old) {
    if (old.plan_id !== id) fail(409, "幂等键已用于其他请求");
    return t;
  }
  latest(t, p);
  if (
    ![
      "awaiting_review",
      "waiting_for_input",
      "needs_replan",
      "interrupted",
    ].includes(t.status) ||
    t.cancel_requested_at
  )
    fail(409, "任务当前不能修改计划");
  const d = await usable(tx, t),
    r = await newRun(tx, t, "plan");
  await tx.insert("plan_feedback", {
    feedback_id: randomUUID(),
    task_id: t.task_id,
    plan_id: id,
    run_id: r.run_id,
    feedback: data.feedback,
    actor,
    idempotency_key: data.idempotency_key,
    created_at: new Date(),
  });
  await newCommand(
    tx,
    t,
    r,
    "plan_revise",
    {
      task_id: t.task_id,
      run_id: r.run_id,
      project_id: t.project_id,
      base_plan_id: id,
      base_version: p.version,
      feedback: data.feedback,
      ...links,
    },
    s.commandTtl,
  );
  await tx.event(
    "plan.revision_requested",
    t.task_id,
    { plan_id: id, version: p.version, actor },
    r.run_id,
  );
  await status(
    tx,
    t,
    presence(d, s) === "online" ? "queued" : "waiting_for_device",
  );
  return t;
}
export async function cancelTask(tx: Tx, s: Settings, id: string) {
  const t = await tx.get("tasks", id, true);
  if (t.status === "cancelled" || t.cancel_requested_at) return t;
  if (terminalTask.has(t.status)) fail(409, "任务已结束");
  await tx.rows(
    "UPDATE commands SET status='superseded' WHERE task_id=$1 AND status IN ('pending','delivered') AND type<>'cancel'",
    [id],
  );
  const runs = (
    await tx.rows(
      "SELECT * FROM runs WHERE task_id=$1 ORDER BY created_at DESC",
      [id],
    )
  ).filter((r) => active.has(r.state));
  const acked = new Set(
    (
      await tx.rows(
        "SELECT run_id FROM commands WHERE task_id=$1 AND acked_at IS NOT NULL AND type<>'cancel'",
        [id],
      )
    ).map((c) => c.run_id),
  );
  const running = runs.filter((r) => acked.has(r.run_id));
  if (!running.length) {
    for (const r of runs) await runState(tx, r, "cancelled");
    await status(tx, t, "cancelled");
  } else {
    t.cancel_requested_at = new Date();
    t.updated_at = new Date();
    await tx.save("tasks", t);
    await newCommand(
      tx,
      t,
      running[0],
      "cancel",
      { task_id: id, run_id: running[0].run_id },
      s.commandTtl,
    );
    await tx.event("task.cancel_requested", id, {}, running[0].run_id);
  }
  return t;
}
export async function expireDue(tx: Tx, deviceId?: string) {
  const commands = await tx.rows(
    "SELECT * FROM commands WHERE status IN ('pending','delivered') AND expires_at<=now() AND ($1::uuid IS NULL OR device_id=$1) ORDER BY created_at",
    [deviceId ?? null],
  );
  for (const c of commands) {
    c.status = "expired";
    await tx.save("commands", c);
    const t = await tx.get("tasks", c.task_id),
      r = c.run_id ? await tx.get("runs", c.run_id) : null;
    if (c.type === "execute" && r) {
      await runState(tx, r, "expired");
      const a = r.approval_id ? await tx.get("approvals", r.approval_id) : null;
      if (a?.status === "recorded") {
        a.status = "expired";
        await tx.save("approvals", a);
        await tx.event(
          "approval.expired",
          t.task_id,
          { approval_id: a.approval_id, plan_id: a.plan_id },
          r.run_id,
        );
      }
      if (t.status === "approved") await status(tx, t, "awaiting_review");
    } else if (planCommands.has(c.type)) {
      if (r && active.has(r.state)) await runState(tx, r, "expired");
      await tx.event(
        "command.expired",
        t.task_id,
        { command_id: c.command_id, command_type: c.type },
        c.run_id,
      );
      if (["queued", "waiting_for_device", "planning"].includes(t.status))
        await status(tx, t, "interrupted");
    } else if (c.type === "cancel") {
      t.cancel_requested_at = null;
      t.updated_at = new Date();
      await tx.save("tasks", t);
      await tx.event(
        "task.cancel_expired",
        t.task_id,
        { command_id: c.command_id },
        c.run_id,
      );
    }
  }
}
export async function commands(tx: Tx, id: string) {
  await tx.rows("UPDATE devices SET last_seen_at=now() WHERE device_id=$1", [
    id,
  ]);
  await expireDue(tx, id);
  const cs = await tx.rows(
    "SELECT * FROM commands WHERE device_id=$1 AND status IN ('pending','delivered') AND expires_at>now() ORDER BY created_at,command_id",
    [id],
  );
  for (const c of cs)
    if (c.status === "pending") {
      c.status = "delivered";
      c.delivered_at = new Date();
      await tx.save("commands", c);
      const t = await tx.get("tasks", c.task_id);
      if (planCommands.has(c.type) && t.status === "waiting_for_device")
        await status(tx, t, "queued");
    }
  return cs.map(commandOut);
}
export async function ackCommand(tx: Tx, id: string, deviceId: string) {
  await expireDue(tx, deviceId);
  const c = await tx.get("commands", id);
  if (!c || c.device_id !== deviceId) fail(404, "命令不存在");
  if (["expired", "superseded"].includes(c.status))
    fail(409, c.status === "expired" ? "命令已过期" : "命令已失效");
  if (c.status !== "acked") {
    c.status = "acked";
    c.delivered_at ??= new Date();
    c.acked_at = new Date();
    await tx.save("commands", c);
    if (planCommands.has(c.type) && c.run_id) {
      const r = await tx.get("runs", c.run_id),
        t = await tx.get("tasks", c.task_id);
      if (r?.state === "queued") await runState(tx, r, "running");
      if (["queued", "waiting_for_device"].includes(t.status))
        await status(tx, t, "planning");
    }
    await tx.rows("SELECT pg_notify('tagent_changes','')");
  }
  return { command_id: id, status: "acked", acked_at: c.acked_at };
}
export async function ingest(tx: Tx, deviceId: string, batch: Row) {
  let last = Number(
      (
        await tx.one(
          "SELECT last_seq FROM device_event_sequences WHERE device_id=$1",
          [deviceId],
        )
      )?.last_seq ?? 0,
    ),
    accepted = 0,
    duplicates = 0;
  const gaps: Row[] = [];
  for (const e of [...batch.events].sort(
    (a, b) => a.producer_seq - b.producer_seq,
  )) {
    if (await tx.get("events", e.event_id)) {
      duplicates++;
      continue;
    }
    const t = await tx.get("tasks", e.task_id);
    if (!t || t.target_device_id !== deviceId) fail(404, "任务不存在");
    const r = e.run_id ? await tx.get("runs", e.run_id) : null;
    if (e.run_id && (!r || r.task_id !== t.task_id)) fail(400, "运行无效");
    if (e.type.startsWith("run.") && !r) fail(400, "运行事件必须带 run_id");
    if (e.producer_seq > last + 1)
      gaps.push({ expected: last + 1, received: e.producer_seq });
    last = Math.max(last, e.producer_seq);
    await tx.event(
      e.type,
      t.task_id,
      Object.fromEntries(
        Object.entries(e.payload).filter(([, v]) => v !== null),
      ),
      e.run_id ?? null,
      {
        event_id: e.event_id,
        producer_id: deviceId,
        producer_seq: e.producer_seq,
        occurred_at: new Date(e.occurred_at),
      },
    );
    accepted++;
    const state = e.type === "run.started" ? "running" : e.type.slice(4);
    if (
      r &&
      e.type.startsWith("run.") &&
      [
        "running",
        "waiting_for_input",
        "waiting_for_local_action",
        "interrupted",
        "needs_replan",
        "completed",
        "failed",
        "cancelled",
      ].includes(state)
    ) {
      await runState(tx, r, state);
      if (
        t.status !== "rejected" &&
        (state !== "completed" || r.phase === "execute")
      )
        await status(
          tx,
          t,
          state === "running" && r.phase === "plan" ? "planning" : state,
        );
    }
  }
  await tx.rows(
    "INSERT INTO device_event_sequences(device_id,last_seq) VALUES($1,$2) ON CONFLICT(device_id) DO UPDATE SET last_seq=excluded.last_seq",
    [deviceId, last],
  );
  await tx.rows("UPDATE devices SET last_seen_at=now() WHERE device_id=$1", [
    deviceId,
  ]);
  return { accepted, duplicates, gaps, last_seq: last };
}
export async function events(tx: Tx, after = 0, limit = 100, taskId?: string) {
  const rs = await tx.rows(
    "SELECT * FROM events WHERE server_cursor>$1 AND ($2::uuid IS NULL OR task_id=$2) ORDER BY server_cursor LIMIT $3",
    [after, taskId ?? null, limit + 1],
  );
  return {
    events: rs.slice(0, limit).map(eventOut),
    next_cursor: rs.slice(0, limit).at(-1)?.server_cursor ?? after,
    has_more: rs.length > limit,
  };
}
