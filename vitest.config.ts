import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts"],
    environment: "node",
    testTimeout: 30000,
    // Sealed against the network for every file in the suite — see the module's own
    // docstring for why the guard sits at the dispatcher and why loopback is exempt.
    setupFiles: ["./tests/support/no_network.ts"],
  },
});
