import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["e2e/helpers/**/*.test.ts"],
    maxWorkers: 1,
  },
});
