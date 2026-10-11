import { createApp } from "./app.js";
const app = await createApp();
await app.listen({
  host: process.env.PI_BOT_HOST ?? "0.0.0.0",
  port: Number(process.env.PI_BOT_PORT ?? 8000),
});
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => void app.close());
