import path from "node:path";
import { defineConfig } from "vitest/config";

const projectRoot = import.meta.dirname;

export default defineConfig({
  resolve: { alias: { "@": path.resolve(projectRoot) } },
  test: {
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
    restoreMocks: true,
  },
});
