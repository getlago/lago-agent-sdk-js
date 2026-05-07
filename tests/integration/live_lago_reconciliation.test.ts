/** Live Lago reconciliation — emit N synthetic events, poll current_usage, verify exact match. */
import { describe, expect, it } from "vitest";

import { LagoSDK, makeCanonicalUsage } from "../../src/index.js";

const API_URL = (process.env.LAGO_API_URL || "").replace(/\/$/, "");
const API_KEY = process.env.LAGO_API_KEY || "";
const SUB_ID = process.env.LAGO_EXTERNAL_SUBSCRIPTION_ID || "";
const CUST_ID = process.env.LAGO_EXTERNAL_CUSTOMER_ID || "cust_demo";

const SKIP = !(API_URL && API_KEY && SUB_ID);

async function readUsage(): Promise<Record<string, number>> {
  const url = `${API_URL}/customers/${CUST_ID}/current_usage?external_subscription_id=${encodeURIComponent(SUB_ID)}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${API_KEY}` } });
  if (!r.ok) throw new Error(`Lago ${r.status}: ${await r.text()}`);
  const body = (await r.json()) as {
    customer_usage?: { charges_usage?: Array<{ billable_metric: { code: string }; units: string }> };
  };
  const out: Record<string, number> = {};
  for (const c of body.customer_usage?.charges_usage ?? []) {
    out[c.billable_metric.code] = parseFloat(c.units || "0");
  }
  return out;
}

describe.skipIf(SKIP)("Live Lago reconciliation", () => {
  it("emits 5 known-shape events; current_usage delta matches", async () => {
    const sdk = new LagoSDK({ apiKey: API_KEY, apiUrl: API_URL, defaultSubscriptionId: SUB_ID });

    const before = await readUsage();
    const inBefore = before.llm_input_tokens ?? 0;
    const outBefore = before.llm_output_tokens ?? 0;

    for (let i = 0; i < 5; i++) {
      sdk.emit(
        makeCanonicalUsage({
          input: 100,
          output: 200,
          model: "claude-sonnet-4-6",
          provider: "anthropic",
          api: "bedrock_invoke",
        }),
      );
    }
    expect(await sdk.flush(10000)).toBe(true);
    await sdk.shutdown(3000);

    const deadline = Date.now() + 30_000;
    let after = before;
    while (Date.now() < deadline) {
      after = await readUsage();
      if (
        (after.llm_input_tokens ?? 0) - inBefore >= 500 &&
        (after.llm_output_tokens ?? 0) - outBefore >= 1000
      ) {
        break;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    expect((after.llm_input_tokens ?? 0) - inBefore).toBe(500);
    expect((after.llm_output_tokens ?? 0) - outBefore).toBe(1000);
  });
});
