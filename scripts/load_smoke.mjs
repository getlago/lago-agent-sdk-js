#!/usr/bin/env node
/** Load smoke (WP6): sustained RPS against the compose stack, then assert
 * zero billing-event loss and a drained outbox.
 *
 *   node scripts/load_smoke.mjs [--rps 100] [--seconds 60]
 *
 * Requires the stack from docker-compose.yml (or GW_URL/LAGO_TEST_URL).
 * Every 200 response in price mode produces exactly one llm_cost event, so
 * loss shows up as a count mismatch.
 */

const args = process.argv.slice(2);
function arg(name, dflt) {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? dflt : Number(args[i + 1]);
}

const RPS = arg("rps", 100);
const SECONDS = arg("seconds", 60);
const GW_URL = process.env.GW_URL ?? "http://localhost:8090";
const LAGO_TEST_URL = process.env.LAGO_TEST_URL ?? "http://localhost:3001";
const ADMIN_TOKEN = process.env.GW_ADMIN_TOKEN ?? "dev-admin-token-for-harness-only";

async function main() {
  await fetch(`${LAGO_TEST_URL}/_test/events`, { method: "DELETE" });

  const keyResp = await fetch(`${GW_URL}/admin/keys`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN_TOKEN}` },
    body: JSON.stringify({ external_subscription_id: "sub_load_smoke" }),
  });
  const { key } = await keyResp.json();

  const models = ["openai/gpt-4o", "anthropic/claude-sonnet-4"];
  let sent = 0;
  let ok = 0;
  let failed = 0;
  const started = Date.now();
  const inflight = new Set();

  console.log(`load smoke: ${RPS} rps for ${SECONDS}s against ${GW_URL}`);
  for (let tick = 0; tick < SECONDS; tick++) {
    const tickStart = Date.now();
    for (let i = 0; i < RPS; i++) {
      const model = models[(tick * RPS + i) % models.length];
      const stream = i % 4 === 0;
      sent++;
      const p = fetch(`${GW_URL}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, stream, messages: [{ role: "user", content: "load" }] }),
      })
        .then(async (r) => {
          await r.text();
          if (r.status === 200) ok++;
          else failed++;
        })
        .catch(() => failed++);
      inflight.add(p);
      p.finally(() => inflight.delete(p));
    }
    const elapsed = Date.now() - tickStart;
    if (elapsed < 1000) await new Promise((r) => setTimeout(r, 1000 - elapsed));
    if (tick % 10 === 9) console.log(`  t=${tick + 1}s sent=${sent} ok=${ok} failed=${failed}`);
  }
  await Promise.allSettled([...inflight]);
  const wallSeconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`traffic done in ${wallSeconds}s: sent=${sent} ok=${ok} failed=${failed}`);

  if (failed > 0) {
    console.error(`FAIL: ${failed} requests did not return 200`);
    process.exit(1);
  }

  // Outbox must drain and every 200 must have produced exactly one event.
  const deadline = Date.now() + 60_000;
  let depth = -1;
  let eventCount = 0;
  for (;;) {
    const health = await (await fetch(`${GW_URL}/healthz`)).json();
    depth = health.outbox_depth;
    const { events } = await (await fetch(`${LAGO_TEST_URL}/_test/events`)).json();
    eventCount = events.length;
    if (depth === 0 && eventCount >= ok) break;
    if (Date.now() > deadline) {
      console.error(`FAIL: outbox_depth=${depth}, events=${eventCount}/${ok} after drain window`);
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  if (eventCount !== ok) {
    console.error(`FAIL: ${ok} successful requests but ${eventCount} events (duplicates?)`);
    process.exit(1);
  }
  const metrics = await (await fetch(`${GW_URL}/metrics`)).text();
  if (!metrics.includes("gw_billing_events_dropped_total 0")) {
    console.error("FAIL: gw_billing_events_dropped_total != 0");
    process.exit(1);
  }
  console.log(`LOAD SMOKE PASSED: ${ok} requests -> ${eventCount} events, zero loss, outbox drained`);
}

main().catch((err) => {
  console.error("load smoke crashed:", err);
  process.exit(1);
});
