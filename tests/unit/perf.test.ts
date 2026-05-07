/** Wrap-overhead benchmark — fails if p99 > 5ms. */
import { describe, expect, it } from "vitest";

import { LagoSDK } from "../../src/index.js";

class FakeBedrockClient {
  config = { serviceId: "bedrock-runtime" };
  async send(_cmd: unknown) {
    return { usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30, serverToolUsage: {} } };
  }
}

class FakeConverseCommand {
  constructor(public input: { modelId: string; messages?: unknown[] }) {}
}
Object.defineProperty(FakeConverseCommand, "name", { value: "ConverseCommand" });

function p99(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(0.99 * sorted.length)] ?? 0;
}

describe("Wrap-overhead benchmark", () => {
  it("p99 wrap overhead is under 5ms for 1000 calls", async () => {
    const sdk = new LagoSDK({ apiKey: "x", defaultSubscriptionId: "sub" });
    sdk._setSender(async () => {});

    const baseline = new FakeBedrockClient();
    const wrapped = sdk.wrap(new FakeBedrockClient());

    const baseDurs: number[] = [];
    for (let i = 0; i < 1000; i++) {
      const cmd = new FakeConverseCommand({ modelId: "eu.amazon.nova-lite-v1:0" });
      const t0 = performance.now();
      await baseline.send(cmd as never);
      baseDurs.push(performance.now() - t0);
    }

    const wrapDurs: number[] = [];
    for (let i = 0; i < 1000; i++) {
      const cmd = new FakeConverseCommand({ modelId: "eu.amazon.nova-lite-v1:0" });
      const t0 = performance.now();
      await wrapped.send(cmd as never);
      wrapDurs.push(performance.now() - t0);
    }

    await sdk.shutdown(1000);

    const baseP99 = p99(baseDurs);
    const wrapP99 = p99(wrapDurs);
    const overheadMs = wrapP99 - baseP99;
    console.log(
      `p99 baseline=${baseP99.toFixed(3)}ms wrapped=${wrapP99.toFixed(3)}ms overhead=${overheadMs.toFixed(3)}ms`,
    );
    expect(overheadMs).toBeLessThan(5);
  });
});
