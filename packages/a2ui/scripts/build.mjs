import { build } from "vite";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
await build({
  root: root + "web",
  base: "./",
  configFile: false,
  build: {
    outDir: root + "dist",
    emptyOutDir: true,
    target: "es2020",
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        entryFileNames: "renderer.js",
        assetFileNames: "[name][extname]",
      },
    },
  },
});
