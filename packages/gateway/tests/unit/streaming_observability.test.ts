/** WP5: client-abort-still-bills (A2), request traceability, metrics
 * completeness, and the log redaction contract (A11). */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startTestGateway, type TestGateway } from "../helpers/test_gateway.js";

let gw: TestGateway;

beforeEach(async () => {
  gw = await startTestGateway();
});

afterEach(async () => {
  await gw.close();
});

async function createKey(): Promise<string> {
  const resp = await fetch(`${gw.url}/admin/keys`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${gw.adminToken}` },
    body: JSON.stringify({ external_subscription_id: "sub_acme" }),
  });
  return ((await resp.json()) as { key: string }).key;
}

describe("client abort mid-stream (A2)", () => {
  it("bills the usage the provider consumed even though the client hung up", async () => {
    gw.bifrost.setMode("slow_stream"); // 120ms between chunks
    const key = await createKey();

    const ctrl = new AbortController();
    const resp = await fetch(`${gw.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: "anthropic/claude-sonnet-4", stream: true, messages: [] }),
      signal: ctrl.signal,
    });
    expect(resp.status).toBe(200);
    // Read exactly one chunk, then slam the connection shut.
    const reader = (resp.body as ReadableStream<Uint8Array>).getReader();
    await reader.read();
    ctrl.abort();

    // The gateway keeps draining the upstream; usage lands regardless.
    const deadline = Date.now() + 10_000;
    while (gw.lago.store.size === 0 && Date.now() < deadline) {
      await gw.outbox.flush(200);
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(gw.lago.store.size).toBe(1);
    const event = [...gw.lago.store.values()][0] as Record<string, unknown>;
    expect(event.code).toBe("llm_cost");
    const props = event.properties as Record<string, unknown>;
    // Full stream usage from raw frames: the provider served it all.
    expect(props.value).toBe("0.00093");
    expect(props.aborted_by_client).toBe(true);
    expect(typeof props.request_id).toBe("string");
  });
});

describe("traceability (WP5)", () => {
  it("the request_id in the event properties appears in the gateway's own logs", async () => {
    const key = await createKey();
    const resp = await fetch(`${gw.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: "openai/gpt-4o", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(resp.status).toBe(200);
    await gw.outbox.flush(5000);
    const event = [...gw.lago.store.values()][0] as Record<string, unknown>;
    const requestId = (event.properties as Record<string, unknown>).request_id as string;
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
    const logged = gw.logLines.filter((l) => l.includes(requestId));
    expect(logged.length).toBeGreaterThanOrEqual(1);
    expect(logged.some((l) => l.includes('"msg":"completion"'))).toBe(true);
  });
});

describe("metrics completeness (WP5)", () => {
  it("exposes every metric the spec lists, with sane values after traffic", async () => {
    const key = await createKey();
    // Non-stream + stream + provider error + budgetless allow.
    await fetch(`${gw.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: "openai/gpt-4o", messages: [] }),
    });
    const s = await fetch(`${gw.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: "anthropic/claude-sonnet-4", stream: true, messages: [] }),
    });
    await s.text();
    gw.bifrost.setMode("http_500");
    await fetch(`${gw.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: "openai/gpt-4o", messages: [] }),
    });

    const text = await (await fetch(`${gw.url}/metrics`)).text();
    for (const name of [
      "gw_requests_total",
      "gw_request_duration_seconds",
      "gw_ttfb_seconds",
      "gw_tokens_total",
      "gw_billing_events_emitted_total",
      "gw_billing_outbox_depth",
      "gw_billing_events_dropped_total",
      "gw_budget_denials_total",
      "gw_budget_check_failures_total",
      "gw_provider_errors_total",
      "gw_backpressure_rejections_total",
    ]) {
      expect(text, `missing metric ${name}`).toContain(name);
    }
    expect(text).toMatch(/gw_requests_total\{[^}]*model="openai\/gpt-4o"[^}]*status="200"[^}]*\} 1/);
    expect(text).toMatch(/gw_requests_total\{[^}]*status="500"[^}]*\} 1/);
    expect(text).toMatch(/gw_tokens_total\{[^}]*dimension="input"[^}]*\} \d+/);
    expect(text).toContain("gw_billing_events_dropped_total 0");
    expect(text).toMatch(/gw_request_duration_seconds_count\{[^}]*\} \d+/);
  });
});

describe("log redaction (A11)", () => {
  it("prompts, completions, and keys never reach the logs; events carry no content", async () => {
    const key = await createKey();
    const secretPrompt = "TOP-SECRET-PROMPT-CONTENT-a1b2c3";
    const r1 = await fetch(`${gw.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: "openai/gpt-4o", messages: [{ role: "user", content: secretPrompt }] }),
    });
    const completionText = JSON.stringify(await r1.json());
    const r2 = await fetch(`${gw.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: "anthropic/claude-sonnet-4",
        stream: true,
        messages: [{ role: "user", content: secretPrompt }],
      }),
    });
    await r2.text();
    await gw.outbox.flush(5000);

    const logs = gw.logLines.join("\n");
    expect(logs).not.toContain(secretPrompt);
    expect(logs).not.toContain(key);
    expect(logs).not.toContain("Hello world"); // the mock completion text
    expect(completionText).toContain("Hello world"); // the client still got it

    // Emitted event payloads carry usage metadata only, never content.
    const allEvents = JSON.stringify([...gw.lago.store.values()]);
    expect(allEvents).not.toContain(secretPrompt);
    expect(allEvents).not.toContain("Hello world");
    expect(allEvents).not.toContain("lago_vk_");
  });
});
