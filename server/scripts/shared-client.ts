import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { password, safeUrl, jsonRequest } from "./client.js";
const { values, positionals } = parseArgs({
    options: {
      conversation: { type: "string" },
      text: { type: "string" },
      models: { type: "boolean" },
      watch: { type: "boolean" },
    },
    allowPositionals: true,
  }),
  base = safeUrl(positionals[0] ?? "http://127.0.0.1:8000");
const login = await jsonRequest(base, "/auth/login", "POST", {
    password: await password(),
  }),
  headers = { Authorization: `Bearer ${login.access_token}` };
if (values.models)
  console.log(
    JSON.stringify(
      await jsonRequest(base, "/configs/models", "GET", undefined, headers),
      null,
      2,
    ),
  );
else if (!values.conversation)
  console.log(
    JSON.stringify(
      await jsonRequest(base, "/conversations", "GET", undefined, headers),
      null,
      2,
    ),
  );
else {
  let run: any;
  if (values.text) {
    run = await jsonRequest(
      base,
      `/conversations/${values.conversation}/messages`,
      "POST",
      { request_id: randomUUID(), text: values.text },
      headers,
    );
    console.log("run_id:", run.id);
  }
  while (true) {
    let after = 0,
      more = true;
    const messages = [];
    while (more) {
      const p = await jsonRequest(
        base,
        `/conversations/${values.conversation}/messages?after=${after}`,
        "GET",
        undefined,
        headers,
      );
      messages.push(...p.messages);
      after = p.next_cursor;
      more = p.has_more;
    }
    console.log(JSON.stringify(messages, null, 2));
    if (!values.watch || !run) break;
    const state = (
      await jsonRequest(base, `/chat-runs/${run.id}`, "GET", undefined, headers)
    ).state;
    if (["completed", "failed", "cancelled", "interrupted"].includes(state)) {
      console.log("state:", state);
      break;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}
