import { resolve } from "node:path";
import { defineConfig } from "electron-vite";

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: { index: resolve("src/main/index.ts") },
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        input: { index: resolve("src/preload/index.ts") },
        // A sandboxed preload must be CommonJS
        output: { format: "cjs", entryFileNames: "[name].cjs" },
      },
    },
  },
  renderer: {
    root: resolve("src/renderer"),
    build: {
      target: "chrome130",
      rollupOptions: { input: resolve("src/renderer/index.html") },
    },
  },
});
