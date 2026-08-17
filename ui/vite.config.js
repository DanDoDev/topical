import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root,
  build: {
    outDir: path.resolve(root, "../ui-dist"),
    emptyOutDir: true,
    sourcemap: false
  },
  server: {
    host: "127.0.0.1",
    proxy: { "/api": "http://127.0.0.1:43110" }
  }
});
