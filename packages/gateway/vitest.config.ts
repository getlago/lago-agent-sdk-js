import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts", "tests/crash/**/*.test.ts", "tests/integration/**/*.test.ts"],
    environment: "node",
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // Crash tests spawn child processes against a shared outbox dir; keep
    // files sequential so ports and paths never collide.
    fileParallelism: false,
  },
});
