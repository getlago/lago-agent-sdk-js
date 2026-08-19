/** Live Lago reconciliation — emit N synthetic events, poll current_usage, verify exact match.
 *
 * This is the ONLY test that proves Lago *accepts* what the SDK emits. Every other
 * integration test points at an in-process mock, so a wrong metric code, a missing
 * `dynamic` charge model, or a rejected `precise_total_amount_cents` would pass
 * there and only surface in production.
 *
 * For a local dev Lago behind a self-signed cert (Traefik's default), set
 * LAGO_VERIFY_SSL=false — the SDK has `LagoConfig.verifySsl` for exactly that, and
 * this test honours the same switch on its own reads.
 */
import { Agent, setGlobalDispatcher } from "undici";
import { describe, expect, it } from "vitest";

import { LagoSDK, makeCanonicalUsage } from "../../src/index.js";

const API_URL = (process.env.LAGO_API_URL || "").replace(/\/$/, "");
const API_KEY = process.env.LAGO_API_KEY || "";
const SUB_ID = process.env.LAGO_EXTERNAL_SUBSCRIPTION_ID || "";
const CUST_ID = process.env.LAGO_EXTERNAL_CUSTOMER_ID || "cust_demo";
// Mirrors LagoConfig.verifySsl: a local dev instance on a self-signed cert is a
// real, common setup, and without this BOTH halves of this test fail on SSL — the
// SDK's POST and this module's own fetch.
const VERIFY_SSL = !["0", "false", "no"].includes(
  (process.env.LAGO_VERIFY_SSL || "true").trim().toLowerCase(),
);

// `fetch` has no per-call TLS option, so the dispatcher is the only lever here.
if (!VERIFY_SSL) {
  setGlobalDispatcher(new Agent({ connect: { rejectUnauthorized: false } }));
}

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
    const sdk = new LagoSDK({
      apiKey: API_KEY,
      apiUrl: API_URL,
      defaultSubscriptionId: SUB_ID,
      config: { verifySsl: VERIFY_SSL },
    });

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
