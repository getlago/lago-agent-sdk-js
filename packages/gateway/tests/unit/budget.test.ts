/** WP4: budget enforcement semantics, end to end through the server.
 * 402 on confirmed exhaustion, fail-open by default when Lago is down,
 * fail-closed for strict keys, TTL cache bounds Lago calls. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LagoBudgetChecker } from "../../src/budget.js";
import { startMockLago, type MockLago } from "../helpers/mock_lago.js";
import { startTestGateway, type TestGateway } from "../helpers/test_gateway.js";

describe("LagoBudgetChecker (server-level)", () => {
  let gw: TestGateway;

  beforeEach(async () => {
    gw = await startTestGateway({ budgetFromLago: true });
  });

  afterEach(async () => {
    await gw.close();
  });

  async function budgetKey(budget: Record<string, unknown>): Promise<string> {
    const resp = await fetch(`${gw.url}/admin/keys`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${gw.adminToken}` },
      body: JSON.stringify({
        external_subscription_id: "sub_acme",
        external_customer_id: "cust_acme",
        budget,
      }),
    });
    return ((await resp.json()) as { key: string }).key;
  }

  async function call(key: string): Promise<{ status: number; json: Record<string, unknown> }> {
    const resp = await fetch(`${gw.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: "openai/gpt-4o", messages: [] }),
    });
    return { status: resp.status, json: (await resp.json()) as Record<string, unknown> };
  }

  it("402 with machine-readable body on confirmed exhaustion; denial metric increments", async () => {
    gw.lago.setSpendCents("cust_acme", 15_000); // $150 spent
    const key = await budgetKey({ limit_usd: 100 });
    const { status, json } = await call(key);
    expect(status).toBe(402);
    const err = json.error as Record<string, unknown>;
    expect(err.type).toBe("budget_error");
    expect(err.code).toBe("exhausted");
    expect(err.spent_usd).toBe(150);
    expect(err.limit_usd).toBe(100);
    expect(gw.metrics.budgetDenials.total()).toBe(1);
    // The denied request never reached the proxy.
    expect(gw.bifrost.requests.length).toBe(0);
  });

  it("allows under-budget traffic", async () => {
    gw.lago.setSpendCents("cust_acme", 5_000); // $50 spent
    const key = await budgetKey({ limit_usd: 100 });
    expect((await call(key)).status).toBe(200);
  });

  it("TTL cache: repeated calls in one window make a single Lago usage call", async () => {
    gw.lago.setSpendCents("cust_acme", 0);
    const key = await budgetKey({ limit_usd: 100 });
    for (let i = 0; i < 5; i++) expect((await call(key)).status).toBe(200);
    expect(gw.lago.usageCalls()).toBe(1);
  });

  it("fail-open by default when Lago is unreachable, with the alert metric", async () => {
    const key = await budgetKey({ limit_usd: 100 });
    await gw.lago.close(); // Lago goes dark; the outbox will buffer events
    const { status } = await call(key);
    expect(status).toBe(200);
    expect(gw.metrics.budgetCheckFailures.total()).toBe(1);
  });

  it("fail-closed for strict keys when Lago is unreachable", async () => {
    const key = await budgetKey({ limit_usd: 100, strict: true });
    await gw.lago.close();
    const { status, json } = await call(key);
    expect(status).toBe(402);
    expect((json.error as Record<string, unknown>).code).toBe("fail_closed");
    expect(gw.metrics.budgetDenials.total()).toBe(1);
    expect(gw.bifrost.requests.length).toBe(0);
  });
});

describe("LagoBudgetChecker (unit)", () => {
  let lago: MockLago;

  beforeEach(async () => {
    lago = await startMockLago();
  });

  afterEach(async () => {
    await lago.close();
  });

  const vk = (budget: { limit_usd?: number; strict?: boolean } | null, customer: string | null) => ({
    id: "vk_test",
    external_subscription_id: "sub_1",
    external_customer_id: customer,
    allowed_models: null,
    budget,
    provider_key_ref: null,
    created_at: 0,
  });

  it("no budget or no limit → allow without calling Lago", async () => {
    const checker = new LagoBudgetChecker({ lagoApiUrl: lago.url, lagoApiKey: "k" });
    expect((await checker.check(vk(null, "cust_1"))).reason).toBe("no_budget");
    expect((await checker.check(vk({ strict: true }, "cust_1"))).reason).toBe("no_budget");
    expect(lago.usageCalls()).toBe(0);
  });

  it("budget without customer id cannot be enforced: allow + onError", async () => {
    const errors: string[] = [];
    const checker = new LagoBudgetChecker({
      lagoApiUrl: lago.url,
      lagoApiKey: "k",
      onError: (err) => errors.push(String(err)),
    });
    const decision = await checker.check(vk({ limit_usd: 10 }, null));
    expect(decision.allow).toBe(true);
    expect(errors.length).toBe(1);
  });

  it("cache expires after ttlMs", async () => {
    const checker = new LagoBudgetChecker({ lagoApiUrl: lago.url, lagoApiKey: "k", ttlMs: 30 });
    lago.setSpendCents("cust_1", 0);
    await checker.check(vk({ limit_usd: 10 }, "cust_1"));
    await checker.check(vk({ limit_usd: 10 }, "cust_1"));
    expect(lago.usageCalls()).toBe(1);
    await new Promise((r) => setTimeout(r, 50));
    await checker.check(vk({ limit_usd: 10 }, "cust_1"));
    expect(lago.usageCalls()).toBe(2);
  });
});
