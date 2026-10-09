import {
  createHash,
  createPublicKey,
  verify,
  randomBytes,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import { readFileSync } from "node:fs";
import { SignJWT, jwtVerify } from "jose";
import { hash, verify as verifyPassword, argon2id } from "argon2";
import { fail, type Tx, type Row } from "./db.js";
import type { Settings } from "./config.js";
export const sha256 = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
export function canonical(value: any): string {
  return JSON.stringify(value, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, v[k]]),
        )
      : v,
  );
}
export const passwordHash = (password: string) =>
  hash(password, {
    type: argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 4,
  });
export async function passwordMatches(hashed: string, password: string) {
  try {
    return await verifyPassword(hashed, password);
  } catch {
    return false;
  }
}
export const issueToken = (id: string, s: Settings) =>
  new SignJWT({ sub: id })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + s.jwtTtl)
    .sign(new TextEncoder().encode(s.jwtSecret));
export async function user(tx: Tx, headers: Row, s: Settings) {
  const m = /^Bearer\s+(.+)$/i.exec(headers.authorization ?? "");
  if (!m) fail(401, "需要认证");
  try {
    const { payload } = await jwtVerify(
      m![1],
      new TextEncoder().encode(s.jwtSecret),
      { algorithms: ["HS256"] },
    );
    if (!payload.sub || !payload.exp || !(await tx.get("users", payload.sub)))
      fail(401, "认证失败");
    return payload;
  } catch {
    return fail(401, "认证失败");
  }
}
export function decodeBase64(value: string, size?: number) {
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  )
    throw new Error("Base64");
  const b = Buffer.from(value, "base64");
  if (size && b.length !== size) throw new Error("length");
  return b;
}
export async function device(
  tx: Tx,
  headers: Row,
  method: string,
  path: string,
  body: Buffer,
  s: Settings,
  allowBearer = false,
) {
  if (!allowBearer && headers.authorization)
    fail(403, "当前身份不能执行此操作");
  const id = headers["x-tagnet-device-id"],
    timestamp = headers["x-tagnet-timestamp"],
    nonce = headers["x-tagnet-nonce"],
    signature = headers["x-tagnet-signature"];
  if (
    !/^[0-9a-f-]{36}$/i.test(id ?? "") ||
    !/^-?\d+$/.test(timestamp ?? "") ||
    !nonce ||
    nonce.length < 16 ||
    nonce.length > 128 ||
    !signature ||
    signature.length > 512 ||
    Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) >
      s.signatureSkew
  )
    fail(401, "设备认证失败");
  const d = await tx.get("devices", id);
  if (!d || d.revoked_at) fail(401, "设备认证失败");
  try {
    const key = createPublicKey({
      key: Buffer.concat([
        Buffer.from("302a300506032b6570032100", "hex"),
        decodeBase64(d.public_key, 32),
      ]),
      format: "der",
      type: "spki",
    });
    if (
      !verify(
        null,
        Buffer.from(
          `${timestamp}.${nonce}.${method.toUpperCase()}.${path}.${sha256(body)}`,
        ),
        key,
        decodeBase64(signature, 64),
      )
    )
      fail(401, "设备认证失败");
  } catch {
    fail(401, "设备认证失败");
  }
  await tx.rows("DELETE FROM device_nonces WHERE expires_at < now()");
  const saved = await tx.one(
    "INSERT INTO device_nonces(device_id,nonce,expires_at) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING nonce",
    [id, nonce, new Date((Number(timestamp) + s.signatureSkew) * 1000)],
  );
  if (!saved) fail(401, "设备认证失败");
  return d;
}
export class Vault {
  private keys!: Record<string, string>;
  private active!: string;
  constructor(path?: string) {
    try {
      const d = JSON.parse(readFileSync(path!, "utf8"));
      this.keys = d.keys;
      this.active = d.active;
      if (
        !this.keys[this.active] ||
        Object.values(this.keys).some((k) => decodeBase64(k, 32).length !== 32)
      )
        throw new Error();
    } catch {
      return fail(503, "凭据同步不可用：请检查服务端加密密钥文件");
    }
  }
  seal(secret: string, id: string, version: number) {
    const nonce = randomBytes(12),
      c = createCipheriv(
        "aes-256-gcm",
        decodeBase64(this.keys[this.active], 32),
        nonce,
      );
    c.setAAD(Buffer.from(`${id}:${version}`));
    const ciphertext = Buffer.concat([
      c.update(secret, "utf8"),
      c.final(),
      c.getAuthTag(),
    ]);
    return {
      key_id: this.active,
      nonce: nonce.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      version,
    };
  }
  open(value: Row, id: string): string {
    try {
      const b = decodeBase64(value.ciphertext),
        d = createDecipheriv(
          "aes-256-gcm",
          decodeBase64(this.keys[value.key_id], 32),
          decodeBase64(value.nonce, 12),
        );
      d.setAAD(Buffer.from(`${id}:${value.version}`));
      d.setAuthTag(b.subarray(-16));
      return Buffer.concat([d.update(b.subarray(0, -16)), d.final()]).toString(
        "utf8",
      );
    } catch {
      return fail(503, "凭据无法解密，请检查加密密钥");
    }
  }
}
