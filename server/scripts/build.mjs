import { build } from "esbuild";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "../..");
const shared = {
  name: "shared-agent",
  setup(build) {
    build.onResolve({ filter: /^@t-agnet\/agent(?:\/plugins)?$/ }, (args) => ({
      path: resolve(
        root,
        "packages/agent/src",
        args.path.endsWith("/plugins") ? "plugins.ts" : "index.ts",
      ),
    }));
  },
};
await build({
  entryPoints: ["src/main.ts", "src/worker.ts", "src/runner.ts"],
  outdir: "dist",
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  packages: "external",
  plugins: [shared],
  sourcemap: true,
});
