import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Tests must never depend on the wall clock; pin it via FixedClock instead.
    env: { NODE_ENV: "test", LOG_LEVEL: "silent" },
  },
});
