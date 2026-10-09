import { randomBytes, randomUUID } from "node:crypto";
import { writeFile, lstat, readFile, rename, open } from "node:fs/promises";
const destination = process.argv[2];
if (!destination)
  throw new Error(
    "用法：node --import tsx server/scripts/vault-key.ts /absolute/path/vault.json",
  );
const existing = await lstat(destination).catch(() => null),
  rotate = process.argv.includes("--rotate");
if (existing && (!existing.isFile() || existing.isSymbolicLink()))
  throw new Error("vault 必须是普通文件");
if (existing && !rotate)
  throw new Error("文件已存在；使用 --rotate 保留旧密钥并添加新密钥");
if (!existing && rotate) throw new Error("无法轮换不存在的文件");
const data = existing
    ? JSON.parse(await readFile(destination, "utf8"))
    : { keys: {} },
  id = randomUUID();
data.active = id;
data.keys[id] = randomBytes(32).toString("base64");
const tmp = destination + "." + randomUUID() + ".tmp";
await writeFile(tmp, JSON.stringify(data) + "\n", { mode: 0o600, flag: "wx" });
const fd = await open(tmp, "r+");
try {
  await fd.sync();
} finally {
  await fd.close();
}
await rename(tmp, destination);
console.log("已保存 vault 文件，旧密钥已保留");
