/**
 * Live pricing — hits the real OpenRouter + AWS Bedrock bulk APIs.
 *
 * Skipped unless LAGO_LIVE_PRICING=1 (real network calls, no keys needed since
 * both sources are public). Validates the real fetchers build tables and that
 * known models resolve to sane USD-per-token prices — exercising the AWS
 * Bedrock offer-file parser against the live schema.
 */
import { describe, expect, it } from "vitest";

import { HttpPricingFetcher, lookupBedrock, lookupOpenRouter } from "../../src/pricing.js";

const SKIP = process.env.LAGO_LIVE_PRICING !== "1";

describe.skipIf(SKIP)("Live pricing", () => {
  it("OpenRouter table builds and known models resolve", async () => {
    const table = await new HttpPricingFetcher(30_000).fetchOpenRouter();
    expect(table.exact.size).toBeGreaterThan(50);
    let resolved = 0;
    for (const [provider, model] of [
      ["openai", "gpt-4o"],
      ["anthropic", "claude-3.5-sonnet"],
      ["google", "gemini-2.5-flash"],
    ] as const) {
      const mp = lookupOpenRouter(table, provider, model);
      if (mp && mp.input !== null && mp.input >= 0n) resolved++;
    }
    expect(resolved).toBeGreaterThanOrEqual(1);
  });

  it("Bedrock offer parses and resolves a known model", async () => {
    const table = await new HttpPricingFetcher(30_000).fetchBedrock("us-east-1");
    expect(table.size).toBeGreaterThan(0);
    const priced = [...table.values()].filter((mp) => mp.input !== null || mp.output !== null);
    expect(priced.length).toBeGreaterThan(0);
    // claude-3-haiku is reliably present in AWS's public bulk data.
    const mp = lookupBedrock(table, "anthropic.claude-3-haiku-20240307-v1:0");
    expect(mp).not.toBeNull();
    expect(mp!.input).not.toBeNull();
  });
});
