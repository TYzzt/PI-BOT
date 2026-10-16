import test from "node:test";
import assert from "node:assert/strict";
import { a2uiTools } from "../src/a2ui.js";
import { EXAMPLE } from "@pi-bot/a2ui";
test("show_ui validates before emitting and preserves the previous surface for incremental updates", async () => {
  const batches: unknown[] = [];
  const tools = a2uiTools((m) => {
    batches.push(m);
  });
  const show = tools.find((t) => t.name === "show_ui")!;
  await show.execute(
    "1",
    { messages: EXAMPLE } as any,
    undefined,
    undefined,
    {} as any,
  );
  await show.execute(
    "2",
    {
      messages: [
        {
          version: "v0.9",
          updateDataModel: {
            surfaceId: "calculator",
            path: "/amount",
            value: 80,
          },
        },
      ],
    } as any,
    undefined,
    undefined,
    {} as any,
  );
  assert.equal(batches.length, 2);
  await assert.rejects(
    show.execute(
      "3",
      {
        messages: [
          {
            version: "v0.9",
            createSurface: { surfaceId: "invalid", catalogId: "unknown" },
          },
        ],
      } as any,
      undefined,
      undefined,
      {} as any,
    ),
  );
  assert.equal(batches.length, 2);
});
