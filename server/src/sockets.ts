import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { CHANNEL, type Database, type Row } from "./db.js";
import type { Settings } from "./config.js";
import { user, device } from "./security.js";
import type { DeviceConnection, Hub } from "./hub.js";
import { failDeviceRuns, handleRunEvent } from "./runs.js";

const send = (ws: WebSocket, value: Row) => {
  if (ws.readyState !== 1) return;
  if (ws.bufferedAmount > 4_000_000) ws.close(4400);
  else ws.send(JSON.stringify(value));
};

/**
 * `/ws/device`: the Mac harness (signed handshake) receives runs, cancels,
 * approval decisions and file RPCs. `/ws/events`: phones and the Mac UI get
 * change notifications for the signed-in user.
 */
export async function sockets(
  app: FastifyInstance,
  db: Database,
  s: Settings,
  hub: Hub,
) {
  const listener = await db.pool.connect();
  await listener.query(`LISTEN ${CHANNEL}`);
  listener.on("notification", (n) => {
    try {
      const c = JSON.parse(n.payload ?? "{}") as Row;
      if (typeof c.user_id !== "string") return;
      if (c.message_id && typeof c.content === "string")
        hub.publish(c.user_id, { type: "delta", bot_id: c.bot_id, message_id: c.message_id, content: c.content });
      else if (c.bot_id) hub.publish(c.user_id, { type: "bot", bot_id: c.bot_id });
      else hub.publish(c.user_id, { type: "bots" });
    } catch {
      /* malformed payloads are ignored */
    }
  });
  listener.on("error", () => {});
  app.addHook("onClose", async () => {
    await listener.query("UNLISTEN *").catch(() => {});
    listener.release();
    await db.close();
  });

  app.get("/ws/device", { websocket: true }, (ws, req) => {
    let conn: DeviceConnection | undefined;
    let seen = 0;
    let queue = Promise.resolve();
    const ready = db
      .tx((tx) => device(tx, req.headers, "GET", "/ws/device", Buffer.alloc(0), s))
      .then(async ({ device: d, user: u }) => {
        if (ws.readyState !== 1) return;
        conn = {
          deviceId: d.device_id,
          userId: u.user_id,
          send: (m) => send(ws, m),
          close: (code) => ws.close(code),
        };
        hub.attach(conn);
        send(ws, { type: "hello", user_id: u.user_id, device_id: d.device_id });
        await db.tx((tx) => tx.rows("UPDATE devices SET last_seen_at=now() WHERE device_id=$1", [d.device_id]));
      })
      .catch(() => ws.close(4401));
    ws.on("message", (raw) => {
      queue = queue
        .then(async () => {
          await ready;
          if (!conn) return;
          let m: Row;
          try {
            m = JSON.parse(raw.toString());
          } catch {
            return;
          }
          if (m.type === "ping") {
            send(ws, { type: "pong" });
            if (Date.now() - seen > 30000) {
              seen = Date.now();
              const revoked = await db.tx(async (tx) => {
                const d = await tx.get("devices", conn!.deviceId);
                if (!d || d.revoked_at) return true;
                await tx.rows("UPDATE devices SET last_seen_at=now() WHERE device_id=$1", [conn!.deviceId]);
                return false;
              });
              if (revoked) ws.close(4401);
            }
          } else if (m.type === "run_event") await handleRunEvent(db, s, hub, conn, m);
          else if (m.type === "rpc_result") hub.resolveRpc(conn.deviceId, m);
        })
        .catch(() => {});
    });
    ws.on("close", () => {
      void ready.then(async () => {
        if (!conn) return;
        const current = hub.detach(conn);
        if (current || hub.device(conn.userId)?.deviceId !== conn.deviceId)
          await failDeviceRuns(db, conn.deviceId).catch(() => {});
      });
    });
  });

  app.get("/ws/events", { websocket: true }, (ws, req) => {
    let unsubscribe: (() => void) | undefined;
    const token = new URL(req.url, "http://x").searchParams.get("token");
    const headers = token ? { authorization: `Bearer ${token}` } : req.headers;
    db.tx((tx) => user(tx, headers, s))
      .then((u) => {
        if (ws.readyState !== 1) return;
        unsubscribe = hub.subscribe(u.user_id, (event) => send(ws, { type: "event", event }));
        send(ws, { type: "hello", user_id: u.user_id, mac_online: hub.online(u.user_id) });
      })
      .catch(() => ws.close(4401));
    ws.on("message", (raw) => {
      if (raw.toString().includes('"ping"')) send(ws, { type: "pong" });
    });
    ws.on("close", () => unsubscribe?.());
  });
}
