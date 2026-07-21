import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [react()],
  root: ".",
  build: {
    outDir: "dist/client",
    emptyOutDir: true
  },
  resolve: {
    alias: {
      "@shared": resolve(__dirname, "src/shared"),
      "@client": resolve(__dirname, "src/client")
    }
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:4319"
    }
  }
});
