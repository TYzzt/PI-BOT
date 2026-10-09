import { generateKeyPairSync, sign, randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { password, safeUrl, jsonRequest } from "./client.js";
import { canonical, sha256 } from "../src/security.js";
const { values } = parseArgs({
    options: { url: { type: "string" }, demo: { type: "boolean" } },
  }),
  base = safeUrl(values.url ?? "http://127.0.0.1:8000"),
  keys = generateKeyPairSync("ed25519");
const token = (
    await jsonRequest(base, "/auth/login", "POST", {
      password: await password(),
    })
  ).access_token,
  userHeaders = { Authorization: `Bearer ${token}` },
  code = (
    await jsonRequest(
      base,
      "/devices/pairing-codes",
      "POST",
      undefined,
      userHeaders,
    )
  ).pairing_code;
const device = await jsonRequest(base, "/devices/pair", "POST", {
  pairing_code: code,
  public_key: keys.publicKey
    .export({ format: "der", type: "spki" })
    .subarray(-32)
    .toString("base64"),
  label: "Node fake Mac",
  capabilities: ["plan", "shared_v1"],
});
async function call(method: string, path: string, p?: unknown) {
  const body = p === undefined ? "" : JSON.stringify(p),
    timestamp = String(Math.floor(Date.now() / 1000)),
    nonce = randomUUID();
  return jsonRequest(base, path, method, p, {
    "X-TAgnet-Device-Id": device.device_id,
    "X-TAgnet-Timestamp": timestamp,
    "X-TAgnet-Nonce": nonce,
    "X-TAgnet-Signature": sign(
      null,
      Buffer.from(`${timestamp}.${nonce}.${method}.${path}.${sha256(body)}`),
      keys.privateKey,
    ).toString("base64"),
  });
}
const project = await call("POST", "/projects", { display_name: "Node demo" });
let seq = 0;
const versions = new Map<string, number>();
let taskId: string | undefined;
if (values.demo)
  taskId = (
    await jsonRequest(
      base,
      "/tasks",
      "POST",
      {
        project_id: project.project_id,
        requirement: "模拟任务，不修改实际项目",
        idempotency_key: randomUUID(),
      },
      userHeaders,
    )
  ).task_id;
let stopped = false;
process.once("SIGINT", () => {
  stopped = true;
});
console.log("设备已配对，等待命令");
while (!stopped) {
  for (const c of await call("GET", "/device/commands")) {
    await call("POST", `/device/commands/${c.command_id}/ack`);
    if (["plan_request", "plan_revise"].includes(c.command_type)) {
      const version = (versions.get(c.task_id) ?? 0) + 1;
      versions.set(c.task_id, version);
      const body = {
          goal: "模拟实现",
          scope: ["demo"],
          non_goals: [],
          modules: ["demo"],
          steps: [
            { step_id: "s1", title: "模拟执行", description: "不修改实际文件" },
          ],
          commands: [],
          external_actions: [],
          verification: ["模拟验证"],
          acceptance: ["完成"],
          questions: [],
        },
        fingerprint = sha256("fake-workspace"),
        material = {
          task_id: c.task_id,
          version,
          project_id: project.project_id,
          device_id: device.device_id,
          body,
          workspace_fingerprint: fingerprint,
          config_snapshot_id: "fake-config-1",
        };
      await call("POST", `/tasks/${c.task_id}/plans`, {
        run_id: c.run_id,
        version,
        content_hash: sha256(canonical(material)),
        body,
        workspace_fingerprint: fingerprint,
        config_snapshot_id: "fake-config-1",
      });
    } else {
      const type =
        c.command_type === "cancel" ? "run.cancelled" : "run.completed";
      await call("POST", "/device/events", {
        events: [
          {
            event_id: randomUUID(),
            producer_seq: ++seq,
            task_id: c.task_id,
            run_id: c.run_id,
            type,
            occurred_at: new Date().toISOString(),
            payload: { summary: "模拟执行完成" },
          },
        ],
      });
    }
  }
  if (taskId) {
    const t = await jsonRequest(
      base,
      `/tasks/${taskId}`,
      "GET",
      undefined,
      userHeaders,
    );
    if (t.status === "awaiting_review") {
      const p = await jsonRequest(
        base,
        `/plans/${t.latest_plan_id}`,
        "GET",
        undefined,
        userHeaders,
      );
      if (p.version === 1)
        await jsonRequest(
          base,
          `/plans/${p.plan_id}/revise`,
          "POST",
          { feedback: "补充模拟验证", idempotency_key: randomUUID() },
          userHeaders,
        );
      else
        await jsonRequest(
          base,
          `/plans/${p.plan_id}/approve`,
          "POST",
          {
            version: p.version,
            content_hash: p.content_hash,
            idempotency_key: randomUUID(),
          },
          userHeaders,
        );
    }
    if (t.status === "completed") {
      console.log("演示完成");
      break;
    }
  }
  await new Promise((r) => setTimeout(r, 500));
}
