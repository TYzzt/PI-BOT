import { randomUUID } from "node:crypto";
import { HttpError, type Row } from "./db.js";

export interface DeviceConnection {
  deviceId: string;
  userId: string;
  send(message: Row): void;
  close(code: number): void;
}
export type UserEvent =
  | { type: "bot"; bot_id: string }
  | { type: "delta"; bot_id: string; message_id: string; content: string }
  | { type: "presence"; online: boolean }
  | { type: "bots" };
type Pending = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
  deviceId: string;
};

/**
 * Live Mac connections and user event fan-out for this API process.
 * The API runs as a single replica because device sockets terminate here.
 */
export class Hub {
  private devices = new Map<string, DeviceConnection>();
  private listeners = new Map<string, Set<(event: UserEvent) => void>>();
  private pending = new Map<string, Pending>();
  attach(conn: DeviceConnection) {
    const previous = this.devices.get(conn.userId);
    if (previous && previous !== conn) previous.close(4409);
    this.devices.set(conn.userId, conn);
    this.publish(conn.userId, { type: "presence", online: true });
  }
  detach(conn: DeviceConnection) {
    if (this.devices.get(conn.userId) !== conn) return false;
    this.devices.delete(conn.userId);
    for (const [id, p] of this.pending)
      if (p.deviceId === conn.deviceId) {
        clearTimeout(p.timer);
        this.pending.delete(id);
        p.reject(new HttpError(503, "Mac 已离线，资料库不可用"));
      }
    this.publish(conn.userId, { type: "presence", online: false });
    return true;
  }
  device(userId: string) {
    return this.devices.get(userId);
  }
  online(userId: string) {
    return this.devices.has(userId);
  }
  kick(deviceId: string) {
    for (const conn of this.devices.values())
      if (conn.deviceId === deviceId) conn.close(4401);
  }
  rpc(userId: string, method: string, params: Row, timeoutMs: number) {
    const conn = this.devices.get(userId);
    if (!conn)
      return Promise.reject(new HttpError(503, "Mac 离线，资料库不可用"));
    const id = randomUUID();
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new HttpError(504, "Mac 响应超时，请稍后重试"));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, deviceId: conn.deviceId });
      conn.send({ type: "rpc", id, method, params });
    });
  }
  resolveRpc(deviceId: string, message: Row) {
    const p = this.pending.get(message.id);
    if (!p || p.deviceId !== deviceId) return;
    clearTimeout(p.timer);
    this.pending.delete(message.id);
    if (message.ok) p.resolve(message.result);
    else
      p.reject(
        new HttpError(
          400,
          typeof message.error === "string"
            ? message.error.slice(0, 300)
            : "Mac 无法完成请求",
        ),
      );
  }
  subscribe(userId: string, listener: (event: UserEvent) => void) {
    let set = this.listeners.get(userId);
    if (!set) this.listeners.set(userId, (set = new Set()));
    set.add(listener);
    return () => {
      set!.delete(listener);
      if (!set!.size) this.listeners.delete(userId);
    };
  }
  publish(userId: string, event: UserEvent) {
    for (const listener of this.listeners.get(userId) ?? []) {
      try {
        listener(event);
      } catch {
        /* one broken socket must not stop fan-out */
      }
    }
    this.devices.get(userId)?.send({ type: "event", event });
  }
}
