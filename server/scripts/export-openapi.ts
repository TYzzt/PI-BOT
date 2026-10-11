import { writeFile } from "node:fs/promises";
import { openapi } from "../src/app.js";
await writeFile(
  new URL("../openapi.json", import.meta.url),
  JSON.stringify(openapi(), null, 2) + "\n",
);
console.log("已根据路由注册表生成 openapi.json");
