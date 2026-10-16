import test from "node:test";
import assert from "node:assert/strict";
import {
  applyUiMessages,
  boundedJson,
  calculate,
  EXAMPLE,
  getUiCatalog,
  updateUiState,
  validateUiAction,
  validateUiDocument,
} from "../src/index.js";
import { UiSession } from "../src/session.js";
import { protocolCatalog } from "../src/catalog.js";

test("real A2UI messages normalize into persisted, replayable surfaces; updates replace rather than accumulate", () => {
  let doc = applyUiMessages(null, EXAMPLE);
  assert.equal(doc.surfaces[0].data.amount, 50);
  for (let i = 0; i < 30; i++)
    doc = applyUiMessages(doc, [
      {
        version: "v0.9",
        updateDataModel: { surfaceId: "calculator", path: "/amount", value: i },
      },
    ]);
  assert.equal(doc.surfaces[0].data.amount, 29);
  assert.equal(doc.revision, 31);
  assert.equal(doc.surfaces[0].components.length, 5);
  assert.deepEqual(validateUiDocument(JSON.parse(JSON.stringify(doc))), doc);
});
test("cycles, missing children, unknown types, scripts, prototype paths and oversized data are rejected", () => {
  const change = (fn: (c: any[]) => void) => {
    const input = structuredClone(EXAMPLE);
    fn(input[2].updateComponents!.components);
    return input;
  };
  assert.throws(
    () =>
      applyUiMessages(
        null,
        change((c) => (c[0].children = ["root"])),
      ),
    /循环|cycle|circular/i,
  );
  assert.throws(
    () =>
      applyUiMessages(
        null,
        change((c) => (c[0].children = ["missing"])),
      ),
    /不存在/,
  );
  assert.throws(
    () =>
      applyUiMessages(
        null,
        change((c) => (c[1].component = "iframe")),
      ),
    /组件|catalog|unknown/i,
  );
  assert.throws(
    () =>
      applyUiMessages(
        null,
        change(
          (c) =>
            (c[2].value = {
              call: "eval",
              args: { code: "alert(1)" },
              returnType: "number",
            }),
        ),
      ),
    /函数/,
  );
  assert.throws(
    () =>
      applyUiMessages(null, [
        {
          version: "v0.9",
          createSurface: {
            surfaceId: "bad",
            catalogId: "https://attacker.example/catalog",
          },
        },
      ]),
    /目录/,
  );
  assert.throws(
    () =>
      applyUiMessages(null, [
        {
          version: "v0.9",
          updateDataModel: {
            surfaceId: "calculator",
            path: "/__proto__/polluted",
            value: true,
          },
        },
      ]),
    /路径/,
  );
  assert.throws(() => boundedJson(JSON.parse('{"constructor":{}}')), /键/);
  assert.throws(() => boundedJson({ text: "x".repeat(180000) }), /过大/);
  assert.equal(({} as any).polluted, undefined);
});
test("only a published action name on the published component can be submitted; state targets are scoped", () => {
  const doc = applyUiMessages(null, EXAMPLE);
  assert.deepEqual(
    validateUiAction(doc, {
      name: "submit",
      surfaceId: "calculator",
      sourceComponentId: "submit",
      context: { amount: 999 },
    }).context,
    { amount: 50 },
  );
  assert.throws(
    () =>
      validateUiAction(doc, {
        name: "run_command",
        surfaceId: "calculator",
        sourceComponentId: "submit",
        context: {},
      }),
    /操作/,
  );
  assert.throws(
    () =>
      validateUiAction(doc, {
        name: "submit",
        surfaceId: "foreign",
        sourceComponentId: "submit",
        context: {},
      }),
    /操作/,
  );
  assert.throws(
    () => updateUiState(doc, [{ surfaceId: "foreign", data: { amount: 1 } }]),
    /失效/,
  );
  const next = updateUiState(doc, [
    { surfaceId: "calculator", data: { amount: 60 } },
  ]);
  assert.equal(next.revision, doc.revision + 1);
  assert.equal(next.surfaces[0].data.amount, 60);
  assert.equal(doc.surfaces[0].data.amount, 50);
});
test("arithmetic is bounded and has no JavaScript access", () => {
  assert.equal(
    calculate("(weight*10 + height*6.25 - age*5 + 5)*activity - deficit", {
      weight: 70,
      height: 175,
      age: 36,
      activity: 1.55,
      deficit: 300,
    }),
    2209.0625,
  );
  assert.equal(calculate("round(max(2, 3)*sqrt(16))"), 12);
  assert.equal(calculate("-2^2"), -4);
  assert.equal(calculate("2^-2"), 0.25);
  assert.equal(calculate("2^3^2"), 512);
  for (const expression of [
    "process.exit()",
    "constructor.constructor(1)",
    "1/0",
    "2^999",
    "Math.random()",
    "1;2",
    "unknown+1",
  ])
    assert.throws(() => calculate(expression));
  assert.throws(() => calculate("(".repeat(30) + "1" + ")".repeat(30)), /嵌套/);
});
test("catalog exposes the official components plus registered extensions and the exact requested schema", () => {
  const catalog = getUiCatalog();
  assert.ok(
    "components" in catalog &&
      catalog.components?.includes("Slider") &&
      catalog.components?.includes("Chart"),
  );
  assert.equal("example" in catalog, false);
  assert.equal("examples" in catalog, false);
  const entry = getUiCatalog("Chart");
  assert.ok("schema" in entry && entry.schema);
  assert.throws(() => getUiCatalog("Html"));
});
test("session serializes saves and actions, keeps latest edits and retries with the same action id", async () => {
  const doc = applyUiMessages(null, EXAMPLE);
  const order: string[] = [];
  const ids: string[] = [];
  let first = true;
  const session = new UiSession(doc, protocolCatalog, {
    save: async (states, revision) => {
      order.push("save");
      assert.equal(revision, 1);
      return updateUiState(doc, states);
    },
    action: async (input) => {
      order.push("action");
      ids.push(input.request_id);
      assert.equal(input.revision, 2);
      assert.equal(input.states[0].data.amount, 80);
      if (first) {
        first = false;
        throw new Error("response lost");
      }
    },
  });
  session.processor.getSurface("calculator")!.dataModel.set("/amount", 80);
  const event = {
    name: "submit",
    surfaceId: "calculator",
    sourceComponentId: "submit",
    context: { amount: 80 },
    timestamp: new Date().toISOString(),
  };
  await session.submit(event);
  assert.equal(session.error, "response lost");
  await session.submit(event);
  assert.deepEqual(order, ["save", "action", "action"]);
  assert.equal(ids[0], ids[1]);
  assert.equal(session.enabled, false);
  await session.dispose();
});


test("repeated DAG references cannot expand into an enormous rendered tree", () => {
  const batch = structuredClone(EXAMPLE);
  const components = batch[2].updateComponents!.components as {
    id: string;
    component: string;
    [key: string]: unknown;
  }[];
  components.splice(0, components.length, {
    id: "root",
    component: "Column",
    children: ["level0"],
  });
  for (let i = 0; i < 12; i++)
    components.push({
      id: `level${i}`,
      component: "Column",
      children: [`level${i + 1}`, `level${i + 1}`],
    });
  components.push({ id: "level12", component: "Text", text: "bounded" });
  assert.throws(() => applyUiMessages(null, batch), /展开/);
});
