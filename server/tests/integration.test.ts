import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import {
  generateKeyPairSync,
  sign,
  randomUUID,
  randomBytes,
} from "node:crypto";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../src/db.js";
import { createApp } from "../src/app.js";
import { settings } from "../src/config.js";
import { sha256, canonical, Vault } from "../src/security.js";
import { createRunner, workspaceTools } from "../src/runner.js";
import { Worker } from "../src/worker.js";
import { endpoint } from "../../desktop/tests/helpers.js";
import { WebSocket } from "ws";
const url = process.env.T_AGNET_TEST_DATABASE_URL;
test(
  "Node API, migration, device/task protocol, shared documents and Pi cloud worker",
  { skip: !url, timeout: 120000 },
  async (t) => {
    const admin = new Database(url!),
      name = `tagent_test_${randomUUID().replaceAll("-", "")}`;
    await admin.pool.query(`CREATE DATABASE ${name}`);
    const u = new URL(url!);
    u.pathname = "/" + name;
    const db = new Database(u.toString()),
      dir = await mkdtemp(join(tmpdir(), "tagent-node-"));
    const vaultFile = join(dir, "vault.json");
    await writeFile(
      vaultFile,
      JSON.stringify({
        active: "test",
        keys: { test: randomBytes(32).toString("base64") },
      }),
    );
    const s = settings({
      T_AGNET_DATABASE_URL: u.toString(),
      T_AGNET_ADMIN_PASSWORD: "test-password",
      T_AGNET_JWT_SECRET: "test-jwt-secret-must-be-32-characters",
      T_AGNET_SYNC_KEY_FILE: vaultFile,
      T_AGNET_RUNNER_TOKEN: "test-runner-token-at-least-32-characters",
    });
    const app = await createApp(s, db);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const base = app.listeningOrigin;
    let token = "",
      deviceId = "",
      projectId = "",
      taskId = "",
      plan: any;
    const key = generateKeyPairSync("ed25519");
    const signed = (method: string, path: string, body = "") => {
      const timestamp = String(Math.floor(Date.now() / 1000)),
        nonce = randomUUID();
      return {
        "x-tagnet-device-id": deviceId,
        "x-tagnet-timestamp": timestamp,
        "x-tagnet-nonce": nonce,
        "x-tagnet-signature": sign(
          null,
          Buffer.from(
            `${timestamp}.${nonce}.${method}.${path}.${sha256(body)}`,
          ),
          key.privateKey,
        ).toString("base64"),
      };
    };
    async function call(
      method: string,
      path: string,
      body?: any,
      device = false,
      expected = 200,
    ) {
      const payload = body === undefined ? "" : JSON.stringify(body),
        r = await app.inject({
          method: method as any,
          url: path,
          headers: {
            ...(device
              ? signed(method, path.split("?")[0], payload)
              : token
                ? { authorization: `Bearer ${token}` }
                : {}),
            ...(body === undefined
              ? {}
              : { "content-type": "application/json" }),
          },
          ...(body === undefined ? {} : { payload }),
        });
      assert.equal(r.statusCode, expected, `${method} ${path}: ${r.body}`);
      return r.json();
    }
    try {
      await t.test("health, login, validation and pairing", async () => {
        await call("GET", "/health");
        await call(
          "POST",
          "/auth/login",
          { password: "incorrect" },
          false,
          401,
        );
        token = (
          await call("POST", "/auth/login", { password: "test-password" })
        ).access_token;
        const code = (await call("POST", "/devices/pairing-codes"))
            .pairing_code,
          p = {
            pairing_code: code,
            public_key: key.publicKey
              .export({ format: "der", type: "spki" })
              .subarray(-32)
              .toString("base64"),
            label: "Mac",
            capabilities: ["shared_v1", "plan"],
          };
        deviceId = (await call("POST", "/devices/pair", p)).device_id;
        await call("POST", "/devices/pair", p, false, 400);
        await call("POST", `/devices/${deviceId}/heartbeat`, undefined, true);
        const payload = JSON.stringify({ display_name: "Test" }),
          headers = signed("POST", "/projects", payload);
        const one = await app.inject({
          method: "POST",
          url: "/projects",
          headers: { ...headers, "content-type": "application/json" },
          payload,
        });
        assert.equal(one.statusCode, 200, one.body);
        projectId = one.json().project_id;
        const replay = await app.inject({
          method: "POST",
          url: "/projects",
          headers: { ...headers, "content-type": "application/json" },
          payload,
        });
        assert.equal(replay.statusCode, 401);
        await call(
          "POST",
          "/projects",
          { display_name: "Test", source: "must-not-store" },
          true,
          422,
        );
        const id = randomUUID(),
          first = await call(
            "POST",
            "/projects",
            { display_name: "Retry", request_id: id },
            true,
          ),
          second = await call(
            "POST",
            "/projects",
            { display_name: "Retry", request_id: id },
            true,
          );
        assert.equal(first.project_id, second.project_id);
      });
      await t.test(
        "task plan hash, approval idempotency, execution and event cursor",
        async () => {
          const p = {
              project_id: projectId,
              requirement: "测试实现",
              idempotency_key: randomUUID(),
            },
            created = await call("POST", "/tasks", p);
          taskId = created.task_id;
          assert.equal((await call("POST", "/tasks", p)).task_id, taskId);
          await call(
            "POST",
            "/tasks",
            { ...p, requirement: "其他" },
            false,
            409,
          );
          const cs = await call("GET", "/device/commands", undefined, true),
            command = cs.find((c: any) => c.task_id === taskId);
          await call(
            "POST",
            `/device/commands/${command.command_id}/ack`,
            undefined,
            true,
          );
          const body = {
              goal: "测试",
              scope: ["测试模块"],
              non_goals: [],
              modules: [],
              steps: [{ step_id: "s1", title: "测试", description: "测试" }],
              commands: [],
              external_actions: [],
              verification: ["测试通过"],
              acceptance: ["完成测试"],
              questions: [],
            },
            material = {
              task_id: taskId,
              version: 1,
              project_id: projectId,
              device_id: deviceId,
              body,
              workspace_fingerprint: "a".repeat(64),
              config_snapshot_id: "test",
            };
          const publish = {
            run_id: command.run_id,
            version: 1,
            content_hash: sha256(canonical(material)),
            body,
            workspace_fingerprint: material.workspace_fingerprint,
            config_snapshot_id: "test",
          };
          await call(
            "POST",
            `/tasks/${taskId}/plans`,
            { ...publish, content_hash: "0".repeat(64) },
            true,
            400,
          );
          plan = await call("POST", `/tasks/${taskId}/plans`, publish, true);
          assert.equal(
            (await call("POST", `/tasks/${taskId}/plans`, publish, true))
              .plan_id,
            plan.plan_id,
          );
          const approval = {
              version: 1,
              content_hash: plan.content_hash,
              idempotency_key: randomUUID(),
            },
            a = await call("POST", `/plans/${plan.plan_id}/approve`, approval),
            b = await call(
              "POST",
              `/device/plans/${plan.plan_id}/approve`,
              { ...approval, idempotency_key: randomUUID() },
              true,
            );
          assert.equal(a.run_id, b.run_id);
          assert.equal(b.actor, "user");
          const execute = (
            await call("GET", "/device/commands", undefined, true)
          ).find((c: any) => c.command_type === "execute");
          await call(
            "POST",
            `/device/commands/${execute.command_id}/ack`,
            undefined,
            true,
          );
          const batch = {
            events: [
              {
                event_id: randomUUID(),
                producer_seq: 2,
                task_id: taskId,
                run_id: a.run_id,
                type: "run.completed",
                occurred_at: new Date().toISOString(),
                payload: { summary: "完成", exit_code: 0, duration_ms: 0 },
              },
            ],
          };
          const result = await call("POST", "/device/events", batch, true);
          assert.equal(result.accepted, 1);
          assert.deepEqual(result.gaps, [{ expected: 1, received: 2 }]);
          assert.equal(
            (await call("POST", "/device/events", batch, true)).duplicates,
            1,
          );
          assert.equal(
            (await call("GET", `/tasks/${taskId}`)).status,
            "completed",
          );
          const stored = await call("GET", `/events?task_id=${taskId}`);
          assert.equal(
            stored.events.find((e: any) => e.type === "run.completed").payload
              .exit_code,
            0,
          );
          assert.equal(
            stored.events.find((e: any) => e.type === "run.completed").payload
              .duration_ms,
            0,
          );
          const page = await call("GET", "/events?after=0&limit=2");
          assert.equal(page.events.length, 2);
          assert.equal(page.has_more, true);
          const next = await call("GET", `/events?after=${page.next_cursor}`);
          assert.ok(
            next.events.every((e: any) => e.server_cursor > page.next_cursor),
          );
        },
      );
      await t.test(
        "shared model vault, cloud mirror, conversation upload and remote chat routing",
        async () => {
          const modelId = randomUUID(),
            config = {
              name: "Fixture",
              base_url: "http://127.0.0.1:1/v1",
              model_id: "fixture",
              context_window: 32000,
              max_tokens: 1000,
              is_default: true,
            };
          const m = await call(
            "PUT",
            `/device/configs/models/${modelId}`,
            {
              expected_version: 0,
              request_id: randomUUID(),
              device_id: deviceId,
              config,
              api_key: "fixture-secret",
            },
            true,
          );
          assert.equal(m.has_key, true);
          assert.ok(!JSON.stringify(m).includes("fixture-secret"));
          assert.equal(
            (
              await call(
                "GET",
                `/device/configs/models/${modelId}/credential?version=1`,
                undefined,
                true,
              )
            ).api_key,
            "fixture-secret",
          );
          assert.equal((await call("GET", "/cloud/models")).length, 1);
          const id = randomUUID();
          await call(
            "PUT",
            `/device/conversations/${id}`,
            {
              expected_version: 0,
              request_id: randomUUID(),
              device_id: deviceId,
              title: "Local",
              kind: "ask",
              model_config_id: modelId,
            },
            true,
          );
          await call(
            "POST",
            `/device/conversations/${id}/messages`,
            {
              share_version: 1,
              messages: [
                {
                  id: randomUUID(),
                  run_id: randomUUID(),
                  role: "user",
                  content: "历史蓝鲸",
                  status: "completed",
                  revision: 1,
                  sequence: 1,
                },
              ],
            },
            true,
          );
          assert.equal(
            (await call("GET", `/conversations/${id}/messages`)).messages
              .length,
            1,
          );
          const run = await call("POST", `/conversations/${id}/messages`, {
            request_id: randomUUID(),
            text: "远程问答",
          });
          assert.equal(run.device_id, deviceId);
          await call(
            "POST",
            `/device/chat-runs/${run.id}/ack`,
            undefined,
            true,
          );
          await call(
            "POST",
            `/device/chat-runs/${run.id}/result`,
            { state: "completed", local_run_id: randomUUID() },
            true,
          );
          assert.equal(
            (await call("GET", `/chat-runs/${run.id}`)).state,
            "completed",
          );
          assert.ok(
            (await call("GET", "/device/shared/snapshot", undefined, true))
              .documents.length,
          );
          assert.ok(
            (await call("GET", "/device/shared/changes", undefined, true))
              .changes.length,
          );
        },
      );
      await t.test(
        "Skills/MCP validation, revisions, device application and conflicts",
        async () => {
          const id = randomUUID(),
            p = {
              expected_version: 0,
              request_id: randomUUID(),
              config: {
                name: "fixture",
                content: "测试技能",
                runtime: "both",
                enabled: true,
              },
            };
          const skill = await call("PUT", `/configs/skills/${id}`, p);
          assert.equal(skill.config.files.length, 0);
          assert.equal(skill.config.requires.commands.length, 0);
          assert.equal(
            (await call("PUT", `/configs/skills/${id}`, p)).version,
            1,
          );
          const legacy = {
            expected_version: 0,
            request_id: p.request_id,
            config: {
              name: "fixture",
              description: "",
              content: "测试技能",
              files: [],
              runtime: "both",
              enabled: true,
              requires: { commands: [], platforms: [], scripts: [], mcp: [] },
              install_hint: null,
            },
          };
          await db.tx((tx) =>
            tx.rows("UPDATE shared_receipts SET digest=$1 WHERE id=$2", [
              sha256(JSON.stringify(legacy)),
              `skill:${p.request_id}`,
            ]),
          );
          assert.equal(
            (await call("PUT", `/configs/skills/${id}`, p)).version,
            1,
          );
          await call(
            "PUT",
            `/configs/skills/${id}`,
            { ...p, config: { ...p.config, content: "different" } },
            false,
            409,
          );
          await call(
            "PUT",
            `/configs/skills/${id}`,
            { ...p, request_id: randomUUID() },
            false,
            409,
          );
          const applied = await call(
            "POST",
            `/device/configs/skills/${id}/applied`,
            {
              version: 1,
              hash: skill.content_hash,
              state: "available",
              reasons: [],
            },
            true,
          );
          assert.equal(applied.devices[0].state, "available");
          assert.equal(
            (await call("GET", `/configs/skills/${id}/revisions`)).length,
            1,
          );
          await call(
            "PUT",
            `/configs/skills/${randomUUID()}`,
            {
              ...p,
              request_id: randomUUID(),
              config: {
                ...p.config,
                name: "bad",
                files: [{ path: "../secret", content: "bad" }],
              },
            },
            false,
            422,
          );
          await call(
            "PUT",
            `/configs/mcp-servers/${randomUUID()}`,
            {
              expected_version: 0,
              request_id: randomUUID(),
              config: {
                name: "bad",
                transport: "stdio",
                command: "node",
                env: [{ name: "API_KEY", value: "secret" }],
              },
            },
            false,
            422,
          );
        },
      );
      await t.test("WebSocket delivery and event replay", async () => {
        const ws = new WebSocket(base.replace("http", "ws") + "/ws/events", {
          headers: { authorization: `Bearer ${token}` },
        });
        const seen: any[] = [];
        ws.on("message", (data) => seen.push(JSON.parse(data.toString())));
        await new Promise<void>((resolve, reject) => {
          ws.once("open", resolve);
          ws.once("error", reject);
        });
        ws.send(JSON.stringify({ type: "subscribe", after: 0 }));
        const until = Date.now() + 5000;
        while (!seen.length && Date.now() < until)
          await new Promise((r) => setTimeout(r, 20));
        assert.ok(seen.some((e) => e.type === "event"));
        ws.close();
        await new Promise((r) => ws.once("close", r));
        const ds = new WebSocket(base.replace("http", "ws") + "/ws/device", {
          headers: signed("GET", "/ws/device"),
        });
        await new Promise<void>((resolve, reject) => {
          ds.once("open", resolve);
          ds.once("error", reject);
        });
        const pong = new Promise<any>((r) =>
          ds.once("message", (data) => r(JSON.parse(data.toString()))),
        );
        ds.send(JSON.stringify({ type: "ping" }));
        assert.equal((await pong).type, "pong");
        ds.close();
        await new Promise((r) => ds.once("close", r));
      });
      await t.test(
        "real Pi cloud harness: history, snapshots, cancellation and credential isolation",
        async () => {
          const api = await endpoint(),
            runner = await createRunner({
              token: s.runnerToken!,
              dir: join(dir, "runner"),
            });
          await runner.listen({ host: "127.0.0.1", port: 0 });
          s.runnerUrl = runner.listeningOrigin;
          const worker = new Worker(db, s);
          try {
            const modelId = randomUUID();
            await call("PUT", `/cloud/models/${modelId}`, {
              expected_version: 0,
              request_id: randomUUID(),
              config: {
                name: "Pi",
                base_url: api.url,
                model_id: "fixture",
                context_window: 32000,
                max_tokens: 1000,
              },
              api_key: "fixture-secret",
            });
            const id = randomUUID();
            await call("PUT", `/cloud/conversations/${id}`, {
              expected_version: 0,
              request_id: randomUUID(),
              title: "Pi",
              model_config_id: modelId,
            });
            const first = await call("POST", `/conversations/${id}/messages`, {
              request_id: randomUUID(),
              text: "记住蓝鲸",
            });
            assert.equal(await worker.runOnce(), true);
            assert.equal(
              (await call("GET", `/chat-runs/${first.id}`)).state,
              "completed",
            );
            const next = await call(
              "POST",
              `/device/cloud/conversations/${id}/messages`,
              { request_id: randomUUID(), text: "之前是什么？" },
              true,
            );
            await worker.runOnce();
            assert.equal(
              (await call("GET", `/chat-runs/${next.id}`)).state,
              "completed",
            );
            const page = await call("GET", `/conversations/${id}/messages`);
            assert.match(page.messages.at(-1).content, /蓝鲸/);
            const slow = await call("POST", `/conversations/${id}/messages`, {
              request_id: randomUUID(),
              text: "慢慢回复",
            });
            const running = worker.runOnce();
            await new Promise((r) => setTimeout(r, 300));
            await call("POST", `/chat-runs/${slow.id}/cancel`);
            await running;
            assert.equal(
              (await call("GET", `/chat-runs/${slow.id}`)).state,
              "cancelled",
            );
            const cloudState = (await call("GET", "/configs/skills"))[0].cloud;
            assert.equal(cloudState.state, "available");
            const tools = await workspaceTools(join(dir, "sandbox"));
            await assert.rejects(() =>
              tools[0].execute(
                "test",
                { path: "/etc/passwd" },
                undefined,
                undefined,
                {} as any,
              ),
            );
            const queued = await call("POST", `/conversations/${id}/messages`, {
              request_id: randomUUID(),
              text: "租约中断",
            });
            const other = new Worker(db, s);
            const claims = await Promise.all([
              worker.claim(),
              other.claim(),
              other.claim(),
            ]);
            assert.equal(claims.filter(Boolean).length, 1);
            await db.tx(async (tx) => {
              const r = await tx.get("shared_documents", queued.id);
              r!.data.lease_until = new Date(0).toISOString();
              await tx.save("shared_documents", r!);
            });
            assert.equal(await other.claim(), undefined);
            assert.equal(
              (await call("GET", `/chat-runs/${queued.id}`)).state,
              "interrupted",
            );
            const resumed = await call(
              "POST",
              `/conversations/${id}/messages`,
              { request_id: randomUUID(), text: "之前是什么？" },
            );
            await worker.runOnce();
            assert.equal(
              (await call("GET", `/chat-runs/${resumed.id}`)).state,
              "completed",
            );
            assert.match(
              (await call("GET", `/conversations/${id}/messages`)).messages.at(
                -1,
              ).content,
              /蓝鲸/,
            );
            const secretRows = await db.tx((tx) =>
              tx.rows("SELECT payload FROM events"),
            );
            assert.ok(!JSON.stringify(secretRows).includes("fixture-secret"));
          } finally {
            worker.stop();
            await runner.close();
            await api.close();
          }
        },
      );
      await t.test("Node fake device completes pairing, revision and approval demo", async () => {
      const result = await promisify(execFile)(process.execPath, ["--import", import.meta.resolve("tsx"), new URL("../scripts/fake-device.ts", import.meta.url).pathname, "--url", base, "--demo"], { timeout: 15000, env: { ...process.env, T_AGNET_CLIENT_PASSWORD: "test-password" } });
      assert.match(result.stdout, /演示完成/);
    });
    await t.test("approval expiry and queued cancellation", async () => {
        const p = {
            project_id: projectId,
            requirement: "取消任务",
            idempotency_key: randomUUID(),
          },
          r = await call("POST", "/tasks", p);
        assert.equal(
          (await call("POST", `/tasks/${r.task_id}/cancel`, {})).status,
          "cancelled",
        );
        await call("POST", `/devices/${deviceId}/revoke`);
        await call("GET", "/device/commands", undefined, true, 401);
      });
    } finally {
      await app.close();
      await admin.pool.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await admin.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
