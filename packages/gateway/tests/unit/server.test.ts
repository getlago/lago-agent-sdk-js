/** End-to-end server behavior against a fake Bifrost and mock Lago. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startTestGateway, type TestGateway } from "../helpers/test_gateway.js";

let gw: TestGateway;

beforeEach(async () => {
  gw = await startTestGateway();
});

afterEach(async () => {
  await gw.close();
});

async function createKey(body: Record<string, unknown> = {}): Promise<string> {
  const resp = await fetch(`${gw.url}/admin/keys`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${gw.adminToken}` },
    body: JSON.stringify({ external_subscription_id: "sub_acme", ...body }),
  });
  expect(resp.status).toBe(201);
  const json = (await resp.json()) as { key: string };
  return json.key;
}

async function completion(
  key: string,
  body: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const resp = await fetch(`${gw.url}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ messages: [{ role: "user", content: "hi" }], ...body }),
  });
  return { status: resp.status, json: (await resp.json()) as Record<string, unknown> };
}

describe("auth", () => {
  it("rejects missing, unknown, and revoked keys with machine-readable 401s", async () => {
    const noAuth = await fetch(`${gw.url}/v1/chat/completions`, { method: "POST", body: "{}" });
    expect(noAuth.status).toBe(401);

    const bogus = await completion("lago_vk_bogus", { model: "openai/gpt-4o" });
    expect(bogus.status).toBe(401);
    expect((bogus.json.error as Record<string, unknown>).code).toBe("invalid_virtual_key");

    const key = await createKey();
    const ok = await completion(key, { model: "openai/gpt-4o" });
    expect(ok.status).toBe(200);

    const keys = (await (
      await fetch(`${gw.url}/admin/keys`, { headers: { authorization: `Bearer ${gw.adminToken}` } })
    ).json()) as { keys: Array<{ id: string }> };
    const del = await fetch(`${gw.url}/admin/keys/${keys.keys[0].id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${gw.adminToken}` },
    });
    expect(del.status).toBe(200);

    const afterRevoke = await completion(key, { model: "openai/gpt-4o" });
    expect(afterRevoke.status).toBe(401);
  });

  it("admin surface requires the admin token", async () => {
    const resp = await fetch(`${gw.url}/admin/keys`, {
      method: "POST",
      headers: { authorization: "Bearer wrong-token" },
      body: "{}",
    });
    expect(resp.status).toBe(401);
  });
});

describe("non-streaming completion", () => {
  it("relays the response, strips extra_fields, and bills exactly one priced event", async () => {
    const key = await createKey();
    const { status, json } = await completion(key, { model: "openai/gpt-4o" });
    expect(status).toBe(200);
    expect(json.extra_fields).toBeUndefined();
    expect((json.choices as unknown[]).length).toBe(1);

    await gw.outbox.flush(5000);
    expect(gw.lago.store.size).toBe(1);
    const event = [...gw.lago.store.values()][0] as Record<string, unknown>;
    expect(event.code).toBe("llm_cost");
    expect(event.external_subscription_id).toBe("sub_acme");
    const props = event.properties as Record<string, unknown>;
    expect(typeof props.request_id).toBe("string");
    // Raw payload wins: 120 input / 80 cached / 45 output priced from the
    // test table: (120-80)*0.0000025 + 45*0.00001 + 80*0.00000125 = 0.00065
    expect(props.value).toBe("0.00065");
  });

  it("bills the anthropic cache TTL split from the raw payload", async () => {
    const key = await createKey();
    const { status } = await completion(key, { model: "anthropic/claude-sonnet-4" });
    expect(status).toBe(200);
    await gw.outbox.flush(5000);
    const event = [...gw.lago.store.values()][0] as Record<string, unknown>;
    const props = event.properties as Record<string, unknown>;
    // input 10, cache_read 200, cache_write 44 (5m:33 + 1h:11), output 45
    expect(props.cache_write_tokens).toBe("44");
    expect(props.cache_read_tokens).toBe("200");
  });

  it("enforces allowed_models with 403", async () => {
    const key = await createKey({ allowed_models: ["anthropic/*"] });
    const denied = await completion(key, { model: "openai/gpt-4o" });
    expect(denied.status).toBe(403);
    const allowed = await completion(key, { model: "anthropic/claude-sonnet-4" });
    expect(allowed.status).toBe(200);
  });

  it("relays provider errors without billing", async () => {
    gw.bifrost.setMode("http_429");
    const key = await createKey();
    const { status } = await completion(key, { model: "openai/gpt-4o" });
    expect(status).toBe(429);
    await gw.outbox.flush(1000);
    expect(gw.lago.store.size).toBe(0);
    expect(gw.metrics.providerErrors.total()).toBe(1);
  });
});

describe("streaming completion", () => {
  it("relays SSE without extra_fields and bills once from raw frames", async () => {
    const key = await createKey();
    const resp = await fetch(`${gw.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: "anthropic/claude-sonnet-4", stream: true, messages: [] }),
    });
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toContain("text/event-stream");
    const text = await resp.text();
    expect(text).toContain("data: [DONE]");
    expect(text).not.toContain("extra_fields");
    expect(text).not.toContain("raw_response");

    await gw.outbox.flush(5000);
    expect(gw.lago.store.size).toBe(1);
    const event = [...gw.lago.store.values()][0] as Record<string, unknown>;
    expect(event.code).toBe("llm_cost");
    const props = event.properties as Record<string, unknown>;
    // From raw message_start/message_delta: input 10, output 45, cache_read
    // 200, cache_write 44. Priced: 10*0.000003 + 45*0.000015 + 200*0.0000003
    // + 44*0.00000375 = 0.00003 + 0.000675 + 0.00006 + 0.000165 = 0.00093
    expect(props.value).toBe("0.00093");
    expect(props.cache_write_tokens).toBe("44");
  });

  it("does not bill malformed streams (no phantom events), and does not crash", async () => {
    gw.bifrost.setMode("malformed_sse");
    const key = await createKey();
    const resp = await fetch(`${gw.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: "openai/gpt-4o", stream: true, messages: [] }),
    });
    await resp.text();
    await gw.outbox.flush(500);
    expect(gw.lago.store.size).toBe(0);
    // The gateway is still alive.
    const health = await fetch(`${gw.url}/healthz`);
    expect(health.status).toBe(200);
  });

  it("does not bill truncated streams that never carried usage", async () => {
    gw.bifrost.setMode("truncated_sse");
    const key = await createKey();
    const resp = await fetch(`${gw.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: "openai/gpt-4o", stream: true, messages: [] }),
    });
    await resp.text().catch(() => "");
    await gw.outbox.flush(500);
    expect(gw.lago.store.size).toBe(0);
  });
});

describe("backpressure", () => {
  it("rejects new work with 503 when the outbox is at the soft limit", async () => {
    gw.lago.setHanging(true);
    const small = await startTestGateway({ backpressureDepth: 2 });
    try {
      small.lago.setHanging(true);
      const key = await (async () => {
        const resp = await fetch(`${small.url}/admin/keys`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${small.adminToken}` },
          body: JSON.stringify({ external_subscription_id: "sub_bp" }),
        });
        return ((await resp.json()) as { key: string }).key;
      })();
      // Two token-mode... two price events fill depth 2.
      for (let i = 0; i < 2; i++) {
        const r = await fetch(`${small.url}/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
          body: JSON.stringify({ model: "openai/gpt-4o", messages: [] }),
        });
        expect(r.status).toBe(200);
      }
      const rejected = await fetch(`${small.url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: "openai/gpt-4o", messages: [] }),
      });
      expect(rejected.status).toBe(503);
      const err = ((await rejected.json()) as { error: { type: string; code: string } }).error;
      expect(err.type).toBe("billing_backpressure");
      expect(err.code).toBe("outbox_full");
      expect(small.metrics.backpressureRejections.total()).toBe(1);
      expect(small.metrics.eventsDropped.total()).toBe(0);
      // No request reached Bifrost for the rejected call: 2 forwards only.
      expect(small.bifrost.requests.length).toBe(2);
    } finally {
      await small.close();
    }
  });
});

describe("BYOK", () => {
  it("forwards the decrypted tenant key as a Bifrost direct key; never logs it", async () => {
    const setKey = await fetch(`${gw.url}/admin/provider-keys`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${gw.adminToken}` },
      body: JSON.stringify({ ref: "acme-openai", provider: "openai", key: "sk-tenant-secret-abc" }),
    });
    expect(setKey.status).toBe(201);
    expect(JSON.stringify(await setKey.json())).not.toContain("sk-tenant-secret-abc");

    const key = await createKey({ provider_key_ref: "acme-openai" });
    const { status } = await completion(key, { model: "openai/gpt-4o" });
    expect(status).toBe(200);

    const forwarded = gw.bifrost.requests.at(-1)!;
    expect(forwarded.headers["x-bf-direct-key"]).toBe("true");
    expect(forwarded.headers.authorization).toBe("Bearer sk-tenant-secret-abc");

    // The tenant key appears nowhere in the gateway's own logs.
    expect(gw.logLines.join("\n")).not.toContain("sk-tenant-secret-abc");
  });
});

describe("observability surface", () => {
  it("healthz and metrics respond", async () => {
    const health = (await (await fetch(`${gw.url}/healthz`)).json()) as Record<string, unknown>;
    expect(health.status).toBe("ok");
    const metricsText = await (await fetch(`${gw.url}/metrics`)).text();
    expect(metricsText).toContain("gw_requests_total");
    expect(metricsText).toContain("gw_billing_outbox_depth");
    expect(metricsText).toContain("gw_billing_events_dropped_total 0");
  });
});
