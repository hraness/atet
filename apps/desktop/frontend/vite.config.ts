import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { defineConfig } from "vite";

const frontendRoot = resolve(import.meta.dirname);

export default defineConfig({
  base: "./",
  build: {
    emptyOutDir: true,
    outDir: resolve(frontendRoot, "dist"),
  },
  plugins: [react()],
  root: frontendRoot,
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
  },
});
