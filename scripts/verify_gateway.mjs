#!/usr/bin/env node
/** `npm run verify:gateway` — the whole gate, from a clean clone:
 * build + typecheck + lint + format + unit (SDK and gateway, incl. the
 * kill -9 crash and idempotency tests) + compose stack + integration suite
 * + load smoke. Exits 0 only if everything passed.
 *
 * Env knobs: SMOKE_RPS / SMOKE_SECONDS (default 100 / 60),
 * KEEP_STACK=1 to leave the compose stack running afterwards.
 */
import { spawnSync } from "node:child_process";

const KEEP_STACK = process.env.KEEP_STACK === "1";
const SMOKE_RPS = process.env.SMOKE_RPS ?? "100";
const SMOKE_SECONDS = process.env.SMOKE_SECONDS ?? "60";

const GW_URL = "http://localhost:8090";
const LAGO_TEST_URL = "http://localhost:3001";
const BIFROST_URL = "http://localhost:8080";

let composeUp = false;

function run(title, cmd, cmdArgs, env = {}) {
  console.log(`\n=== ${title} ===`);
  const res = spawnSync(cmd, cmdArgs, {
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  if (res.status !== 0) {
    console.error(`\nverify:gateway FAILED at: ${title}`);
    teardown();
    process.exit(res.status ?? 1);
  }
}

function teardown() {
  if (composeUp && !KEEP_STACK) {
    spawnSync("docker", ["compose", "down", "-v"], { stdio: "inherit" });
  }
}

async function waitHealthy(url, name, timeoutMs = 180_000) {
  console.log(`waiting for ${name} at ${url} ...`);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (resp.ok) {
        console.log(`${name} is up`);
        return;
      }
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) {
      console.error(`${name} did not become healthy in time`);
      spawnSync("docker", ["compose", "logs", "--tail", "50"], { stdio: "inherit" });
      teardown();
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

// 1. Static gates + unit suites (includes crash-recovery and idempotency).
run("build", "npm", ["run", "build"]);
run("typecheck", "npm", ["run", "typecheck"]);
run("lint", "npm", ["run", "lint"]);
run("format:check", "npm", ["run", "format:check"]);
run("sdk unit tests", "npm", ["run", "test:unit"]);
run("gateway unit + crash tests", "npm", ["run", "-w", "@getlago/ai-gateway", "test"]);

// 2. The real stack.
run("docker compose up", "docker", ["compose", "up", "-d", "--build"]);
composeUp = true;
await waitHealthy(`${GW_URL}/healthz`, "gateway");
await waitHealthy(`${LAGO_TEST_URL}/healthz`, "mock-lago");
await waitHealthy(`${BIFROST_URL}/api/providers`, "bifrost");

// End-to-end warmup: a full completion through gateway -> bifrost -> mock
// provider must succeed before the suite runs (first boot initializes
// Bifrost's store and the gateway's price table).
{
  console.log("warming up the request path ...");
  const keyResp = await fetch(`${GW_URL}/admin/keys`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer dev-admin-token-for-harness-only",
    },
    body: JSON.stringify({ external_subscription_id: "sub_warmup" }),
  });
  const { key } = await keyResp.json();
  const deadline = Date.now() + 120_000;
  for (;;) {
    try {
      const resp = await fetch(`${GW_URL}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: "openai/gpt-4o", messages: [{ role: "user", content: "warmup" }] }),
        signal: AbortSignal.timeout(5000),
      });
      if (resp.status === 200) {
        const body = await resp.json();
        if (body.usage) {
          console.log("request path is warm");
          break;
        }
      } else {
        await resp.text();
      }
    } catch {
      /* retry */
    }
    if (Date.now() > deadline) {
      console.error("warmup request never succeeded");
      spawnSync("docker", ["compose", "logs", "--tail", "80"], { stdio: "inherit" });
      teardown();
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

// 3. Integration suite against the stack.
run(
  "integration suite (gateway + Bifrost + mocks)",
  "npm",
  ["run", "-w", "@getlago/ai-gateway", "test", "--", "tests/integration"],
  { GW_URL, LAGO_TEST_URL, BIFROST_URL },
);

// 4. Load smoke: zero loss, outbox drains.
run(
  `load smoke (${SMOKE_RPS} rps x ${SMOKE_SECONDS}s)`,
  "node",
  ["scripts/load_smoke.mjs", "--rps", SMOKE_RPS, "--seconds", SMOKE_SECONDS],
  { GW_URL, LAGO_TEST_URL },
);

teardown();
console.log("\nverify:gateway PASSED");
