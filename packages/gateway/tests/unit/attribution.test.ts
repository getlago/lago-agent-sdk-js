/** A13: two tenants, concurrent interleaved streams and non-streams.
 * Every event must carry the subscription of the key that made the request.
 * Attribution is passed explicitly per request (no ambient async state), so
 * this pins the property that makes cross-tenant bleed structurally
 * impossible. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startTestGateway, type TestGateway } from "../helpers/test_gateway.js";

let gw: TestGateway;

beforeEach(async () => {
  gw = await startTestGateway();
});

afterEach(async () => {
  await gw.close();
});

async function createKey(subscription: string): Promise<string> {
  const resp = await fetch(`${gw.url}/admin/keys`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${gw.adminToken}` },
    body: JSON.stringify({ external_subscription_id: subscription }),
  });
  return ((await resp.json()) as { key: string }).key;
}

describe("concurrent attribution (A13)", () => {
  it("interleaved traffic from two keys never cross-bills", async () => {
    gw.bifrost.setMode("slow_stream"); // force real interleaving of chunks
    const keyA = await createKey("sub_tenant_a");
    const keyB = await createKey("sub_tenant_b");

    const call = async (key: string, model: string, stream: boolean): Promise<void> => {
      const resp = await fetch(`${gw.url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, stream, messages: [{ role: "user", content: "x" }] }),
      });
      await resp.text();
      expect(resp.status).toBe(200);
    };

    // 12 concurrent requests, alternating tenants, providers, and modes.
    const jobs: Array<Promise<void>> = [];
    for (let i = 0; i < 12; i++) {
      const key = i % 2 === 0 ? keyA : keyB;
      const model = i % 3 === 0 ? "anthropic/claude-sonnet-4" : "openai/gpt-4o";
      jobs.push(call(key, model, i % 2 === 0 || i % 5 === 0));
    }
    await Promise.all(jobs);
    await gw.outbox.flush(10_000);

    const events = [...gw.lago.store.values()] as Array<{
      external_subscription_id: string;
      properties: Record<string, unknown>;
    }>;
    expect(events.length).toBe(12);
    const bySub = { sub_tenant_a: 0, sub_tenant_b: 0 } as Record<string, number>;
    for (const ev of events) {
      bySub[ev.external_subscription_id] = (bySub[ev.external_subscription_id] ?? 0) + 1;
    }
    // Even split by construction of the loop above.
    expect(bySub.sub_tenant_a).toBe(6);
    expect(bySub.sub_tenant_b).toBe(6);
    // Each event has a distinct request_id (no shared/bled context).
    const requestIds = new Set(events.map((e) => e.properties.request_id));
    expect(requestIds.size).toBe(12);
  });
});
