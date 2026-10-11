import { defineConfig } from "vite";

const target = process.env.PI_BOT_SERVER ?? "http://127.0.0.1:8000";

export default defineConfig({
  base: "./",
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    proxy: {
      "/auth": target,
      "/me": target,
      "/api": { target, rewrite: (path) => `/admin${path}` },
    },
  },
});
