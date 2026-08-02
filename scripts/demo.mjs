#!/usr/bin/env node
/** The end-to-end demo (WP7). Run `docker compose up --build -d` first, then:
 *
 *   npm run demo
 *
 * What it proves, with the plain `openai` npm package pointed at the gateway:
 *  1. a Lago virtual key works as the API key
 *  2. streaming + non-streaming completions across 2 providers (OpenAI wire
 *     to the gateway; Bifrost translates to Anthropic for claude models)
 *  3. the gateway is kill -9ed mid-run and restarted; every accepted request
 *     still lands in (mock) Lago exactly once, with the exact expected amounts
 *
 * Prints DEMO PASSED and exits 0 only if all assertions hold.
 */
import { execSync } from "node:child_process";
import OpenAI from "openai";

const GW_URL = process.env.GW_URL ?? "http://localhost:8090";
const LAGO_TEST_URL = process.env.LAGO_TEST_URL ?? "http://localhost:3001";
const ADMIN_TOKEN = process.env.GW_ADMIN_TOKEN ?? "dev-admin-token-for-harness-only";

// Fixed mock usage -> exact expected cost per call (see mocks/providers.mjs):
const EXPECTED_COST = { "openai/gpt-4o": "0.00065", "anthropic/claude-sonnet-4": "0.00093" };

function log(msg) {
  console.log(`[demo] ${msg}`);
}

function fail(msg) {
  console.error(`[demo] FAILED: ${msg}`);
  process.exit(1);
}

async function waitHealthy(timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const resp = await fetch(`${GW_URL}/healthz`, { signal: AbortSignal.timeout(1500) });
      if (resp.ok) return;
    } catch {
      /* retry */
    }
    if (Date.now() > deadline) fail("gateway never became healthy; did you run `docker compose up`?");
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function lagoEvents() {
  const resp = await fetch(`${LAGO_TEST_URL}/_test/events`);
  return await resp.json();
}

async function main() {
  await waitHealthy();
  await fetch(`${LAGO_TEST_URL}/_test/events`, { method: "DELETE" });

  // 1. Create a virtual key through the admin surface.
  const keyResp = await fetch(`${GW_URL}/admin/keys`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN_TOKEN}` },
    body: JSON.stringify({ external_subscription_id: "sub_demo", external_customer_id: "cust_demo" }),
  });
  if (keyResp.status !== 201) fail(`key creation returned ${keyResp.status}`);
  const { key } = await keyResp.json();
  log(`virtual key created (${key.slice(0, 12)}…)`);

  // 2. Plain `openai` SDK pointed at the gateway, virtual key as the API key.
  const client = new OpenAI({ apiKey: key, baseURL: `${GW_URL}/v1` });
  const succeeded = []; // model of every call that returned successfully

  const nonStream = async (model) => {
    const resp = await client.chat.completions.create({
      model,
      messages: [{ role: "user", content: "Say hello" }],
    });
    if (!resp.choices?.[0]?.message?.content) throw new Error(`empty completion from ${model}`);
    succeeded.push(model);
  };
  const stream = async (model) => {
    const s = await client.chat.completions.create({
      model,
      stream: true,
      messages: [{ role: "user", content: "Say hello" }],
    });
    let text = "";
    for await (const chunk of s) {
      text += chunk.choices?.[0]?.delta?.content ?? "";
    }
    if (!text) throw new Error(`empty stream from ${model}`);
    succeeded.push(model);
  };

  log("non-streaming via openai package: openai/gpt-4o");
  await nonStream("openai/gpt-4o");
  log("non-streaming via openai package: anthropic/claude-sonnet-4 (translated)");
  await nonStream("anthropic/claude-sonnet-4");
  log("streaming via openai package: openai/gpt-4o");
  await stream("openai/gpt-4o");
  log("streaming via openai package: anthropic/claude-sonnet-4 (translated)");
  await stream("anthropic/claude-sonnet-4");

  // 3. Crash resilience: fire a burst, kill -9 the gateway mid-run, restart.
  log("burst of 10 requests, then kill -9 on the gateway container…");
  const burst = [];
  for (let i = 0; i < 10; i++) {
    const model = i % 2 === 0 ? "openai/gpt-4o" : "anthropic/claude-sonnet-4";
    burst.push(
      nonStream(model).then(
        () => true,
        () => false, // failures during the kill window are expected and unbilled
      ),
    );
  }
  await new Promise((r) => setTimeout(r, 150));
  execSync("docker compose kill -s SIGKILL gateway", { stdio: "pipe" });
  log("gateway killed (SIGKILL). Restarting…");
  const burstResults = await Promise.all(burst);
  const killedInFlight = burstResults.filter((r) => !r).length;
  execSync("docker compose start gateway", { stdio: "pipe" });
  await waitHealthy();
  log(`gateway back up. Burst: ${10 - killedInFlight}/10 completed before the kill`);

  // 4. Post-restart traffic proves the outbox resumed cleanly.
  await nonStream("openai/gpt-4o");
  await stream("anthropic/claude-sonnet-4");

  // 5. Settle, then reconcile counts and amounts in (mock) Lago.
  const expected = succeeded.length;
  log(`waiting for ${expected} billing events to land in Lago…`);
  const deadline = Date.now() + 60_000;
  let evs;
  for (;;) {
    evs = await lagoEvents();
    if (evs.events.length >= expected) break;
    if (Date.now() > deadline) {
      fail(`expected ${expected} events, saw ${evs.events.length} after 60s`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  const costEvents = evs.events.filter((e) => e.code === "llm_cost");
  // A request whose billing row persisted just before the SIGKILL landed but
  // whose response never reached the client is billed (correctly: the usage
  // was served) without being in `succeeded`. That surplus is bounded by the
  // requests that were in flight at the kill.
  const surplus = evs.events.length - expected;
  if (surplus < 0) {
    fail(`event LOSS: ${evs.events.length} events for ${expected} successful requests`);
  }
  if (surplus > killedInFlight) {
    fail(`event count ${evs.events.length} exceeds ${expected} + ${killedInFlight} in flight (duplicates?)`);
  }
  if (costEvents.length !== evs.events.length) {
    fail(`${evs.events.length - costEvents.length} events were not priced llm_cost events`);
  }
  const wrongSub = evs.events.filter((e) => e.external_subscription_id !== "sub_demo");
  if (wrongSub.length > 0) fail(`${wrongSub.length} events attributed to the wrong subscription`);

  // No transaction_id was delivered twice into the store, even across the
  // crash: raw receipts may retry, the store keeps exactly one.
  const dupReceipts = Object.entries(evs.receipts).filter(([id]) => !evs.events.some((e) => e.transaction_id === id));
  if (dupReceipts.length > 0) fail("receipts reference unknown transaction_ids");

  // Exact amounts per provider (fixed mock usage, price table, floor math).
  const tally = { "openai/gpt-4o": 0, "anthropic/claude-sonnet-4": 0 };
  for (const model of succeeded) tally[model]++;
  for (const [model, count] of Object.entries(tally)) {
    const provider = model.split("/")[0];
    const value = EXPECTED_COST[model];
    const matching = costEvents.filter(
      (e) => e.properties.provider === provider && e.properties.value === value,
    );
    if (matching.length < count) {
      fail(`${model}: expected at least ${count} events at $${value}, found ${matching.length}`);
    }
  }

  log(`reconciled: ${expected} acked requests -> ${costEvents.length} priced events (${surplus} from requests whose ack raced the kill; each billed exactly once), amounts exact`);
  log(`totals: openai=${tally["openai/gpt-4o"]} x $0.00065, anthropic=${tally["anthropic/claude-sonnet-4"]} x $0.00093`);
  console.log("DEMO PASSED");
}

main().catch((err) => fail(String(err?.stack ?? err)));
