import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { openapi } from "../src/app.js";
import { routes } from "../src/routes.js";

test("push and report routes coexist without duplicate registrations", () => {
  const keys = routes.map(route => `${route.method} ${route.path}`);
  assert.equal(new Set(keys).size, keys.length);
  for (const key of [
    "GET /push/config",
    "PUT /push/installations/:id",
    "DELETE /push/installations/:id",
    "POST /agent/reports",
    "POST /reports/:id/open",
    "GET /reports/:id/content",
  ]) assert.ok(keys.includes(key), `missing route: ${key}`);
  const spec = openapi();
  assert.ok(spec.paths["/push/config"].get);
  assert.ok(spec.paths["/push/installations/{id}"].put);
  assert.ok(spec.paths["/reports/{id}/open"].post);
  assert.ok(spec.paths["/reports/{id}/content"].get);
});

test("checked-in OpenAPI matches the complete route registry", async () => {
  const documented = JSON.parse(await readFile(new URL("../openapi.json", import.meta.url), "utf8"));
  assert.deepEqual(documented, openapi());
});
