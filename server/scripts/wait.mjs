import { createConnection } from "node:net";
const [kind, target] = process.argv.slice(2);
for (let i = 0; i < 90; i++) {
  try {
    if (kind === "http") {
      const response = await fetch(target, {
        signal: AbortSignal.timeout(2000),
      });
      if (!response.ok) throw new Error();
    } else {
      const [host, port] = target.split(":");
      await new Promise((ok, no) => {
        const socket = createConnection({ host, port: Number(port) }, () => {
          socket.destroy();
          ok();
        });
        socket.setTimeout(2000, () => {
          socket.destroy();
          no(new Error());
        });
        socket.once("error", no);
      });
    }
    process.exit(0);
  } catch {}
  await new Promise((r) => setTimeout(r, 2000));
}
throw new Error("依赖服务未就绪");
