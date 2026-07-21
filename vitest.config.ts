import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@shared": resolve(__dirname, "src/shared"),
      "@client": resolve(__dirname, "src/client")
    }
  },
  test: {
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
    coverage: { reporter: ["text", "html"] }
  }
});
