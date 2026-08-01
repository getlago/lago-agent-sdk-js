/** Integration suite against the real compose stack: gateway + stock Bifrost
 * (pinned digest) + mock providers + mock Lago.
 *
 * Skipped unless GW_URL is set; `npm run verify:gateway` boots the stack and
 * provides it. Also uses:
 *   LAGO_TEST_URL  (default http://localhost:3001)
 *   BIFROST_URL    (default http://localhost:8080)
 *   GW_ADMIN_TOKEN (default matches docker-compose.yml)
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const GW_URL = process.env.GW_URL ?? "";
const LAGO_TEST_URL = process.env.LAGO_TEST_URL ?? "http://localhost:3001";
const BIFROST_URL = process.env.BIFROST_URL ?? "http://localhost:8080";
const ADMIN_TOKEN = process.env.GW_ADMIN_TOKEN ?? "dev-admin-token-for-harness-only";

interface StoredEvent {
  transaction_id: string;
  external_subscription_id: string;
  code: string;
  properties: Record<string, unknown>;
  precise_total_amount_cents?: string;
}

async function resetEvents(): Promise<void> {
  // Drain the gateway outbox first so a previous test's in-flight events
  // can't land after the reset and pollute the next assertion.
  const deadline = Date.now() + 10_000;
  for (;;) {
    const health = (await (await fetch(`${GW_URL}/healthz`)).json()) as { outbox_depth: number };
    if (health.outbox_depth === 0) break;
    if (Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  await fetch(`${LAGO_TEST_URL}/_test/events`, { method: "DELETE" });
}

async function events(): Promise<{ events: StoredEvent[]; receipts: Record<string, number> }> {
  return (await (await fetch(`${LAGO_TEST_URL}/_test/events`)).json()) as {
    events: StoredEvent[];
    receipts: Record<string, number>;
  };
}

async function waitForEvents(n: number, timeoutMs = 15_000): Promise<StoredEvent[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { events: evs } = await events();
    if (evs.length >= n) return evs;
    if (Date.now() > deadline) throw new Error(`expected ${n} events, saw ${evs.length}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function admin(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const resp = await fetch(`${GW_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN_TOKEN}` },
    body: JSON.stringify(body),
  });
  if (resp.status >= 300) throw new Error(`${path} -> ${resp.status}: ${await resp.text()}`);
  return (await resp.json()) as Record<string, unknown>;
}

async function createKey(extra: Record<string, unknown> = {}): Promise<string> {
  const json = await admin("/admin/keys", { external_subscription_id: "sub_harness", ...extra });
  return json.key as string;
}

async function chat(key: string, body: Record<string, unknown>): Promise<{ status: number; text: string }> {
  const resp = await fetch(`${GW_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ messages: [{ role: "user", content: "hello" }], ...body }),
  });
  return { status: resp.status, text: await resp.text() };
}

describe.skipIf(!GW_URL)("gateway harness (compose stack)", () => {
  beforeEach(async () => {
    await resetEvents();
  });

  afterEach(async () => {
    await resetEvents();
  });

  describe("happy path x 2 providers x {stream, non-stream}", () => {
    it("openai non-stream: priced event, hand-recomputed", async () => {
      const key = await createKey();
      const { status, text } = await chat(key, { model: "openai/gpt-4o" });
      expect(status).toBe(200);
      expect(text).toContain("Hello from mock openai");
      expect(text).not.toContain("extra_fields");
      const evs = await waitForEvents(1);
      expect(evs[0].code).toBe("llm_cost");
      expect(evs[0].external_subscription_id).toBe("sub_harness");
      // (120-80)*0.0000025 + 45*0.00001 + 80*0.00000125 = 0.00065
      expect(evs[0].properties.value).toBe("0.00065");
      expect(evs[0].precise_total_amount_cents).toBe("0.065");
      expect(typeof evs[0].properties.request_id).toBe("string");
    });

    it("anthropic non-stream: priced event including cache write/read", async () => {
      const key = await createKey();
      const { status, text } = await chat(key, { model: "anthropic/claude-sonnet-4" });
      expect(status).toBe(200);
      expect(text).toContain("Hello from mock anthropic");
      const evs = await waitForEvents(1);
      // 10*0.000003 + 45*0.000015 + 200*0.0000003 + 44*0.00000375 = 0.00093
      expect(evs[0].properties.value).toBe("0.00093");
      expect(evs[0].properties.cache_read_tokens).toBe("200");
      expect(evs[0].properties.cache_write_tokens).toBe("44");
    });

    it("openai stream: relayed clean, billed from the raw usage frame", async () => {
      const key = await createKey();
      const { status, text } = await chat(key, { model: "openai/gpt-4o", stream: true });
      expect(status).toBe(200);
      expect(text).toContain("data: [DONE]");
      expect(text).not.toContain("extra_fields");
      expect(text).not.toContain("raw_response");
      const evs = await waitForEvents(1);
      expect(evs[0].properties.value).toBe("0.00065");
    });

    it("anthropic stream: TTL-split usage survives translation and streaming", async () => {
      const key = await createKey();
      const { status, text } = await chat(key, { model: "anthropic/claude-sonnet-4", stream: true });
      expect(status).toBe(200);
      expect(text).toContain("data: [DONE]");
      const evs = await waitForEvents(1);
      expect(evs[0].properties.value).toBe("0.00093");
      expect(evs[0].properties.cache_write_tokens).toBe("44");
    });
  });

  describe("enforcement", () => {
    it("budget exhaustion → 402 through the whole stack", async () => {
      await fetch(`${LAGO_TEST_URL}/_test/spend`, {
        method: "PUT",
        body: JSON.stringify({ customer_id: "cust_over", cents: 20_000 }),
      });
      const key = await createKey({ external_customer_id: "cust_over", budget: { limit_usd: 100 } });
      const { status, text } = await chat(key, { model: "openai/gpt-4o" });
      expect(status).toBe(402);
      expect(JSON.parse(text).error.code).toBe("exhausted");
    });

    it("rate limits via Bifrost governance VK (proxy primitive, not a gateway limiter)", async () => {
      // Provision a Bifrost VK with a 2-requests/minute limit.
      const vkResp = await fetch(`${BIFROST_URL}/api/governance/virtual-keys`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: `harness-rl-${Date.now()}`,
          provider_configs: [
            { provider: "openai", weight: 1.0, allowed_models: ["*"], allow_all_keys: true },
          ],
          rate_limit: { request_max_limit: 2, request_reset_duration: "1m" },
        }),
      });
      expect(vkResp.status).toBeLessThan(300);
      const bifrostVk = ((await vkResp.json()) as { virtual_key: { value: string } }).virtual_key.value;

      // BYOK direct key + the Bifrost VK on the Lago key.
      await admin("/admin/provider-keys", { ref: "rl-openai", provider: "openai", key: "sk-mock-direct" });
      const key = await createKey({ provider_key_ref: "rl-openai", bifrost_vk: bifrostVk });

      expect((await chat(key, { model: "openai/gpt-4o" })).status).toBe(200);
      expect((await chat(key, { model: "openai/gpt-4o" })).status).toBe(200);
      const third = await chat(key, { model: "openai/gpt-4o" });
      expect(third.status).toBe(429);
      expect(third.text).toContain("request_limited");
    });
  });

  describe("failure modes", () => {
    it("provider failure with request fallbacks → served and billed by the fallback provider", async () => {
      const key = await createKey();
      const { status, text } = await chat(key, {
        model: "openai/gpt-4o-always-500",
        fallbacks: ["anthropic/claude-sonnet-4"],
      });
      expect(status).toBe(200);
      expect(text).toContain("mock anthropic");
      const evs = await waitForEvents(1);
      // Billed against the provider that actually served (A6).
      expect(evs[0].properties.provider).toBe("anthropic");
      expect(evs[0].properties.value).toBe("0.00093");
    });

    it("malformed provider SSE: clean degradation, zero phantom events", async () => {
      const key = await createKey();
      const { status } = await chat(key, { model: "openai/gpt-4o-malformed", stream: true });
      // Bifrost surfaces the broken upstream as an error before streaming
      // starts (502 relayed), or the stream dies mid-flight after a 200.
      // Either way: no crash, and no phantom billing event.
      expect([200, 502, 500]).toContain(status);
      await new Promise((r) => setTimeout(r, 1500));
      expect((await events()).events.length).toBe(0);
      // Stack is still healthy.
      expect((await fetch(`${GW_URL}/healthz`)).status).toBe(200);
    });

    it("unknown model in price mode: never-under-bill token fallback", async () => {
      const key = await createKey();
      const { status } = await chat(key, { model: "openai/gpt-99-experimental" });
      expect(status).toBe(200);
      const evs = await waitForEvents(2);
      const codes = evs.map((e) => e.code).sort();
      expect(codes).toContain("llm_input_tokens");
      expect(codes).toContain("llm_output_tokens");
      expect(codes).not.toContain("llm_cost");
    });
  });

  describe("delivery semantics", () => {
    it("mock Lago is idempotent on transaction_id (replay lands once)", async () => {
      const event = {
        transaction_id: "harness-replay-1",
        external_subscription_id: "sub_harness",
        code: "llm_cost",
        timestamp: 1722400000,
        properties: { value: "1" },
      };
      for (let i = 0; i < 2; i++) {
        await fetch(`${LAGO_TEST_URL}/api/v1/events/batch`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ events: [event] }),
        });
      }
      const { events: evs, receipts } = await events();
      expect(evs.filter((e) => e.transaction_id === "harness-replay-1").length).toBe(1);
      expect(receipts["harness-replay-1"]).toBe(2);
    });

    it("gateway metrics: dropped stays 0 across the suite", async () => {
      const text = await (await fetch(`${GW_URL}/metrics`)).text();
      expect(text).toContain("gw_billing_events_dropped_total 0");
    });
  });
});
