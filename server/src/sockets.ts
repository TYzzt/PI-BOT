import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { Database, HttpError, type Row } from "./db.js";
import type { Settings } from "./config.js";
import { user, device } from "./security.js";
import { commands, ackCommand, events } from "./tasks.js";
export async function sockets(
  app: FastifyInstance,
  db: Database,
  s: Settings,
  ajv: any,
) {
  const listener = await db.pool.connect();
  await listener.query("LISTEN tagent_changes");
  const wakes = new Set<() => void>();
  listener.on("notification", () => {
    for (const wake of wakes) wake();
  });
  listener.on("error", () => {
    for (const wake of wakes) wake();
  });
  app.addHook("onClose", async () => {
    await listener.query("UNLISTEN *").catch(() => {});
    listener.release();
    await db.close();
  });
  const validate = (name: string) =>
    ajv.compile({ $ref: `contract#/components/schemas/${name}` });
  const ackValid = validate("WsAckMessage"),
    pingValid = validate("WsPingMessage"),
    subscribeValid = validate("WsSubscribeMessage");
  const send = (ws: WebSocket, value: Row) => {
    if (ws.readyState === 1) {
      if (ws.bufferedAmount > 2_000_000) ws.close(4400);
      else ws.send(JSON.stringify(value));
    }
  };
  for (const path of ["/ws/device", "/ws/events"])
    app.get(path, { websocket: true }, (ws, req) => {
      let ready: Promise<void>,
        deviceId: string | undefined,
        expires = Infinity,
        cursor: number | undefined,
        closed = false,
        cycling = false,
        dirty = false;
      const sent = new Set<string>();
      const timeout = setTimeout(() => {
        if (path === "/ws/events" && cursor === undefined) ws.close(4400);
      }, 30000);
      const cycle = async () => {
        if (closed) return;
        if (cycling) {
          dirty = true;
          return;
        }
        cycling = true;
        try {
          await ready;
          if (expires <= Date.now() / 1000) {
            ws.close(4401);
            return;
          }
          if (deviceId) {
            const cs = await db.tx(async (tx) => {
              const d = await tx.get("devices", deviceId!);
              return !d || d.revoked_at ? null : commands(tx, deviceId!);
            });
            if (!cs) {
              ws.close(4401);
              return;
            }
            for (const c of cs)
              if (!sent.has(c.command_id)) {
                send(ws, { type: "command", ...c });
                sent.add(c.command_id);
              }
          } else if (cursor !== undefined) {
            let more = true;
            while (more && !closed) {
              const page = await db.tx((tx) => events(tx, cursor, 500));
              for (const e of page.events)
                send(ws, { type: "event", event: e });
              cursor = page.next_cursor;
              more = page.has_more;
            }
          }
        } catch {
          ws.close(4401);
        } finally {
          cycling = false;
          if (dirty) {
            dirty = false;
            void cycle();
          }
        }
      };
      ready = db
        .tx(async (tx) => {
          if (path === "/ws/device") {
            const d = await device(
              tx,
              req.headers,
              "GET",
              path,
              Buffer.alloc(0),
              s,
              true,
            );
            deviceId = d.device_id;
          } else {
            const u = await user(tx, req.headers, s);
            expires = u.exp!;
          }
        })
        .catch(() => {
          ws.close(4401);
          closed = true;
        });
      const wake = () => void cycle();
      wakes.add(wake);
      const interval = setInterval(
        wake,
        Math.max(1000, Math.min(15000, (s.presenceTtl * 1000) / 3)),
      );
      void cycle();
      let receive = Promise.resolve();
      ws.on("message", (raw) => {
        receive = receive
          .then(async () => {
            await ready;
            if (closed) return;
            let data: Row;
            try {
              data = JSON.parse(raw.toString());
            } catch {
              send(ws, { type: "error", detail: "消息格式错误" });
              return;
            }
            if (path === "/ws/events" && cursor === undefined) {
              if (!subscribeValid(data)) {
                ws.close(4400);
                return;
              }
              cursor = data.after;
              clearTimeout(timeout);
              await cycle();
              return;
            }
            if (data.type === "ping" && pingValid(data)) {
              if (deviceId)
                await db.tx((tx) =>
                  tx.rows(
                    "UPDATE devices SET last_seen_at=now() WHERE device_id=$1",
                    [deviceId],
                  ),
                );
              send(ws, { type: "pong" });
              return;
            }
            if (deviceId && data.type === "ack" && ackValid(data)) {
              try {
                await db.tx(async (tx) => {
                  const d = await tx.get("devices", deviceId!);
                  if (!d || d.revoked_at)
                    throw new HttpError(401, "设备认证失败");
                  await ackCommand(tx, data.command_id, deviceId!);
                });
                send(ws, {
                  type: "ack_result",
                  command_id: data.command_id,
                  ok: true,
                });
              } catch (e) {
                send(ws, {
                  type: "ack_result",
                  command_id: data.command_id,
                  ok: false,
                  detail: e instanceof HttpError ? e.detail : "请求失败",
                });
              }
              return;
            }
            send(ws, { type: "error", detail: "无法识别的消息" });
          })
          .catch(() => ws.close(4400));
      });
      ws.on("close", () => {
        closed = true;
        clearTimeout(timeout);
        clearInterval(interval);
        wakes.delete(wake);
      });
    });
}
