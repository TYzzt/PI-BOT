import { randomUUID } from "node:crypto";
import { z } from "zod";
import { fail, type Database, type Row, type Tx } from "./db.js";
import type { Settings } from "./config.js";
import type { DeviceConnection, Hub } from "./hub.js";
import {
  ACTIVE,
  approvalOut,
  buildContext,
  finishRun,
  markRunning,
  recordTool,
  setContent,
  setProgress,
} from "./bots.js";

import {recordUi} from "./ui.js";

export const MAC_OFFLINE = "Mac 已离线，可重新发送（将在云端运行）";

/** Sends a freshly created Mac run to the connected harness, or falls back to the cloud. */
export async function dispatchMac(db: Database, s: Settings, hub: Hub, runId: string) {
  const job = await db.tx(async (tx) => {
    const run = await tx.get("bot_runs", runId);
    if (!run || run.status !== "queued" || run.executor !== "mac") return null;
    const conn = hub.device(run.user_id);
    if (!conn || conn.deviceId !== run.device_id) {
      await tx.rows(
        "UPDATE bot_runs SET executor='cloud', device_id=NULL WHERE run_id=$1",
        [runId],
      );
      await tx.rows(
        "UPDATE bot_messages SET executor='cloud' WHERE message_id=$1",
        [run.assistant_message_id],
      );
      await tx.notify({ user_id: run.user_id, bot_id: run.bot_id });
      return null;
    }
    return { conn, context: await buildContext(tx, s, run) };
  });
  job?.conn.send({ type: "run", run: job.context });
}

const live = new Map<string, { content: string; written: number }>();
const runEvent = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("started") }),
  z.object({ kind: z.literal("ui"), messages: z.array(z.record(z.string(),z.unknown())).min(1).max(20) }),
  z.object({ kind: z.literal("text"), text: z.string().max(400000) }),
  z.object({ kind: z.literal("progress"), lines: z.array(z.string().max(200)).max(3) }),
  z.object({
    kind: z.literal("tool"),
    id: z.string().max(80),
    name: z.string().max(80),
    state: z.enum(["running", "completed", "failed"]),
    summary: z.string().max(2000).optional(),
  }),
  z.object({
    kind: z.literal("approval"),
    request_id: z.string().max(80),
    path: z.string().min(1).max(4000),
    reason: z.string().max(2000),
  }),
  z.object({
    kind: z.literal("done"),
    state: z.enum(["completed", "failed", "cancelled"]),
    error: z.string().max(500).nullish(),
    text: z.string().max(400000).optional(),
  }),
]);

export async function handleRunEvent(
  db: Database,
  s: Settings,
  hub: Hub,
  conn: DeviceConnection,
  message: Row,
) {
  const parsed = runEvent.safeParse(message.event);
  if (!parsed.success || typeof message.run_id !== "string") return;
  const e = parsed.data,
    runId = message.run_id;
  const own = (tx: Tx) =>
    tx.one(
      "SELECT * FROM bot_runs WHERE run_id=$1 AND device_id=$2 AND executor='mac'",
      [runId, conn.deviceId],
    );
  if (e.kind === "text") {
    const state = live.get(runId) ?? { content: "", written: 0 };
    state.content = e.text;
    live.set(runId, state);
    const run = await db.tx(async (tx) => {
      const r = await own(tx);
      if (!r || !ACTIVE.includes(r.status)) return null;
      if (Date.now() - state.written > 1000) {
        state.written = Date.now();
        await setContent(tx, r, e.text);
      }
      return r;
    });
    if (run)
      hub.publish(run.user_id, {
        type: "delta",
        bot_id: run.bot_id,
        message_id: run.assistant_message_id,
        content: e.text,
      });
    return;
  }
  if (e.kind === "done") {
    const content = e.text ?? live.get(runId)?.content;
    live.delete(runId);
    await db.tx(async (tx) => {
      if (!(await own(tx))) return;
      await finishRun(tx, runId, e.state, e.error ?? "Mac 运行失败", content);
    });
    return;
  }
  const reply = await db.tx(async (tx) => {
    const run = await own(tx);
    if (!run || !ACTIVE.includes(run.status)) return null;
    if (e.kind === "started") {
      await markRunning(tx, runId);
      await tx.notify({ user_id: run.user_id, bot_id: run.bot_id });
      return null;
    }
    if (e.kind === "ui") { await recordUi(tx,run,e.messages); return null; }
    if (e.kind === "tool") {
      await recordTool(tx, run, e);
      await tx.notify({ user_id: run.user_id, bot_id: run.bot_id });
      return null;
    }
    if (e.kind === "progress") {
      live.delete(runId);
      await setProgress(tx, run, e.lines);
      await tx.notify({ user_id: run.user_id, bot_id: run.bot_id });
      return null;
    }
    const approval = await tx.insert("approvals", {
      approval_id: randomUUID(),
      run_id: runId,
      bot_id: run.bot_id,
      user_id: run.user_id,
      kind: "outside_access",
      detail: { path: e.path, reason: e.reason },
      status: "pending",
      expires_at: new Date(Date.now() + s.approvalTtl * 1000),
    });
    await tx.rows(
      "UPDATE bot_runs SET status='waiting_approval' WHERE run_id=$1 AND status='running'",
      [runId],
    );
    await tx.notify({ user_id: run.user_id, bot_id: run.bot_id });
    return {
      type: "approval_created",
      run_id: runId,
      request_id: e.request_id,
      approval_id: approval.approval_id,
      expires_at: approval.expires_at,
    };
  });
  if (reply) conn.send(reply);
}

export async function failDeviceRuns(db: Database, deviceId: string, reason = MAC_OFFLINE) {
  await db.tx(async (tx) => {
    const runs = await tx.rows(
      "SELECT run_id FROM bot_runs WHERE executor='mac' AND device_id=$1 AND status = ANY($2)",
      [deviceId, ACTIVE],
    );
    for (const r of runs) {
      live.delete(r.run_id);
      await finishRun(tx, r.run_id, "failed", reason);
    }
  });
}
/** No device sockets survive a restart, so any Mac run still marked active is lost. */
export async function failOrphanedMacRuns(db: Database) {
  await db.tx(async (tx) => {
    const runs = await tx.rows(
      "SELECT run_id FROM bot_runs WHERE executor='mac' AND status = ANY($1)",
      [ACTIVE],
    );
    for (const r of runs) await finishRun(tx, r.run_id, "failed", MAC_OFFLINE);
  });
}

export async function cancelRun(tx: Tx, hub: Hub, userId: string, runId: string) {
  const run = await tx.one(
    "SELECT * FROM bot_runs WHERE run_id=$1 AND user_id=$2 FOR UPDATE",
    [runId, userId],
  );
  if (!run) fail(404, "运行不存在");
  if (!ACTIVE.includes(run!.status)) return { run: run!, notify: null };
  await tx.rows("UPDATE bot_runs SET cancel_requested=true WHERE run_id=$1", [runId]);
  const conn = run!.executor === "mac" ? hub.device(userId) : undefined;
  if (run!.executor === "mac" && conn?.deviceId === run!.device_id)
    return { run: run!, notify: conn };
  if (run!.executor === "cloud" && run!.status !== "queued")
    return { run: run!, notify: null };
  await finishRun(tx, runId, "cancelled", null);
  return { run: run!, notify: null };
}

export async function decideApproval(
  tx: Tx,
  hub: Hub,
  userId: string,
  approvalId: string,
  decision: "approve" | "reject",
) {
  const a = await tx.one(
    "SELECT * FROM approvals WHERE approval_id=$1 AND user_id=$2 FOR UPDATE",
    [approvalId, userId],
  );
  if (!a) fail(404, "审批不存在");
  if (a!.status !== "pending" || new Date(a!.expires_at) < new Date())
    fail(409, "审批已失效");
  const status = decision === "approve" ? "approved" : "rejected";
  const updated = await tx.update("approvals", approvalId, {
    status,
    decided_at: new Date(),
  });
  const pending = await tx.one(
    "SELECT 1 FROM approvals WHERE run_id=$1 AND status='pending'",
    [a!.run_id],
  );
  if (!pending) await markRunning(tx, a!.run_id);
  await tx.notify({ user_id: userId, bot_id: a!.bot_id });
  const run = await tx.get("bot_runs", a!.run_id);
  const conn = hub.device(userId);
  return {
    approval: approvalOut(updated),
    send:
      conn && run?.device_id === conn.deviceId
        ? () =>
            conn.send({
              type: "approval",
              approval_id: approvalId,
              run_id: a!.run_id,
              decision,
            })
        : null,
  };
}
