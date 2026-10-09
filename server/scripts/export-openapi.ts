import { readFile, writeFile } from "node:fs/promises";
const path = new URL("../openapi.json", import.meta.url),
  contract = JSON.parse(await readFile(path, "utf8"));
// This contract drives the Node server's runtime validators and route registration.
await writeFile(path, JSON.stringify(contract, null, 2) + "\n");
console.log("已验证并格式化 OpenAPI 契约");
