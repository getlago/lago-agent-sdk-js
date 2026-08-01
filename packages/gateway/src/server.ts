/** The gateway HTTP surface.
 *
 *   POST /v1/chat/completions   client-facing, OpenAI-compatible
 *   GET  /healthz               liveness + outbox depth
 *   GET  /metrics               Prometheus text exposition
 *   POST /admin/keys            create virtual key (returns plaintext once)
 *   GET  /admin/keys            list keys (safe fields only)
 *   DELETE /admin/keys/{id}     revoke
 *   POST /admin/provider-keys   store BYOK provider key (write-only)
 *   DELETE /admin/provider-keys/{ref}
 *
 * Request order on the hot path: auth → model allow-list → budget →
 * backpressure gate → forward to Bifrost → relay → extract usage from raw
 * payload → persist billing events to the outbox → ack to the client.
 * The outbox write happens BEFORE the response completes (ADR-003).
 */
import http from "node:http";
import { randomUUID } from "node:crypto";

import type { GatewayConfig } from "./config.js";
import type { KeyStore, VirtualKeyRecord } from "./store.js";
import type { DurableEventQueue } from "./outbox.js";
import type { BudgetChecker } from "./budget.js";
import type { Logger } from "./logger.js";
import { safeEqual } from "./crypto.js";
import { billUsage, usageFromResponse, usageFromStream, type BillingContext } from "./billing.js";
import { renderMetrics, type Metrics } from "./metrics.js";

export interface GatewayDeps {
  config: GatewayConfig;
  store: KeyStore;
  outbox: DurableEventQueue;
  billing: BillingContext;
  budget: BudgetChecker;
  metrics: Metrics;
  logger: Logger;
}

const MAX_BODY_BYTES = 20 * 1024 * 1024;

export function createGatewayServer(deps: GatewayDeps): http.Server {
  return http.createServer((req, res) => {
    handle(deps, req, res).catch((err) => {
      deps.logger.error("unhandled request error", { error: String(err) });
      if (!res.headersSent) {
        sendJson(res, 500, { error: { message: "internal error", type: "internal_error" } });
      } else {
        res.end();
      }
    });
  });
}

async function handle(deps: GatewayDeps, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = req.url ?? "/";
  const method = req.method ?? "GET";

  if (method === "GET" && url === "/healthz") {
    sendJson(res, 200, {
      status: "ok",
      outbox_depth: deps.outbox.depth(),
      outbox_lag_ms: deps.outbox.lagMs(),
    });
    return;
  }
  if (method === "GET" && url === "/metrics") {
    res.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
    res.end(renderMetrics(deps.metrics));
    return;
  }
  if (url.startsWith("/admin/")) {
    await handleAdmin(deps, req, res, method, url);
    return;
  }
  if (method === "POST" && url === "/v1/chat/completions") {
    await handleCompletion(deps, req, res);
    return;
  }
  sendJson(res, 404, { error: { message: `no route for ${method} ${url}`, type: "not_found" } });
}

// ----------------------------------------------------------------------
// Admin surface
// ----------------------------------------------------------------------
async function handleAdmin(
  deps: GatewayDeps,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  url: string,
): Promise<void> {
  const token = bearer(req);
  if (!token || !safeEqual(token, deps.config.adminToken)) {
    sendJson(res, 401, { error: { message: "invalid admin token", type: "auth_error" } });
    return;
  }

  if (method === "POST" && url === "/admin/keys") {
    const body = await readJson(req);
    if (!body || typeof body.external_subscription_id !== "string" || !body.external_subscription_id) {
      sendJson(res, 400, {
        error: { message: "external_subscription_id required", type: "invalid_request" },
      });
      return;
    }
    const { key, record } = deps.store.createVirtualKey({
      external_subscription_id: body.external_subscription_id,
      external_customer_id: strOrUndef(body.external_customer_id),
      allowed_models: Array.isArray(body.allowed_models) ? body.allowed_models.map(String) : undefined,
      budget: isObj(body.budget) ? body.budget : undefined,
      provider_key_ref: strOrUndef(body.provider_key_ref),
    });
    deps.logger.info("virtual key created", {
      key_id: record.id,
      subscription: record.external_subscription_id,
    });
    // The only moment the plaintext key ever leaves the gateway.
    sendJson(res, 201, { key, record });
    return;
  }
  if (method === "GET" && url === "/admin/keys") {
    sendJson(res, 200, { keys: deps.store.listVirtualKeys() });
    return;
  }
  if (method === "DELETE" && url.startsWith("/admin/keys/")) {
    const id = url.slice("/admin/keys/".length);
    const revoked = deps.store.revokeVirtualKey(id);
    deps.logger.info("virtual key revocation", { key_id: id, revoked });
    sendJson(res, revoked ? 200 : 404, { revoked });
    return;
  }
  if (method === "POST" && url === "/admin/provider-keys") {
    const body = await readJson(req);
    if (
      !body ||
      typeof body.ref !== "string" ||
      typeof body.provider !== "string" ||
      typeof body.key !== "string"
    ) {
      sendJson(res, 400, { error: { message: "ref, provider, key required", type: "invalid_request" } });
      return;
    }
    deps.store.setProviderKey(body.ref, body.provider, body.key);
    deps.logger.info("provider key stored", { ref: body.ref, provider: body.provider });
    // Write-only: the response never echoes the key.
    sendJson(res, 201, { ref: body.ref, provider: body.provider });
    return;
  }
  if (method === "DELETE" && url.startsWith("/admin/provider-keys/")) {
    const ref = url.slice("/admin/provider-keys/".length);
    sendJson(res, deps.store.deleteProviderKey(ref) ? 200 : 404, { ref });
    return;
  }
  sendJson(res, 404, { error: { message: `no admin route for ${method} ${url}`, type: "not_found" } });
}

// ----------------------------------------------------------------------
// The hot path
// ----------------------------------------------------------------------
async function handleCompletion(
  deps: GatewayDeps,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const { config, store, outbox, metrics, logger } = deps;
  const start = process.hrtime.bigint();
  const requestId = randomUUID();

  // 1. Virtual-key auth.
  const token = bearer(req);
  const vk = token ? store.resolveVirtualKey(token) : null;
  if (!vk) {
    metrics.requestsTotal.inc({ provider: "unknown", model: "unknown", status: "401" });
    sendJson(res, 401, {
      error: { message: "invalid or revoked virtual key", type: "auth_error", code: "invalid_virtual_key" },
    });
    return;
  }

  // 2. Body.
  const body = await readJson(req);
  if (!body || typeof body.model !== "string") {
    sendJson(res, 400, { error: { message: "model is required", type: "invalid_request" } });
    return;
  }
  const model = body.model;
  const stream = body.stream === true;

  // 3. Model allow-list.
  if (vk.allowed_models && !modelAllowed(model, vk.allowed_models)) {
    metrics.requestsTotal.inc({ provider: providerOf(model), model, status: "403" });
    sendJson(res, 403, {
      error: {
        message: `model ${model} not allowed for this key`,
        type: "permission_error",
        code: "model_not_allowed",
      },
    });
    return;
  }

  // 4. Budget.
  const decision = await deps.budget.check(vk.external_subscription_id, vk.budget);
  if (!decision.allow) {
    metrics.budgetDenials.inc();
    metrics.requestsTotal.inc({ provider: providerOf(model), model, status: "402" });
    sendJson(res, 402, {
      error: {
        message:
          decision.reason === "exhausted"
            ? "budget exhausted for this key"
            : "billing backend unreachable and this key is strict (fail-closed)",
        type: "budget_error",
        code: decision.reason,
        spent_usd: decision.spent_usd,
        limit_usd: decision.limit_usd,
      },
    });
    return;
  }

  // 5. Backpressure gate (fail-closed, ADR-003): refuse work BEFORE any
  // provider call once the outbox is at the soft limit.
  if (outbox.depth() >= config.backpressureDepth) {
    metrics.backpressureRejections.inc();
    metrics.requestsTotal.inc({ provider: providerOf(model), model, status: "503" });
    sendJson(res, 503, {
      error: {
        message: "billing outbox is full; refusing work rather than risking unbilled usage",
        type: "billing_backpressure",
        code: "outbox_full",
      },
    });
    return;
  }

  // 6. Forward to Bifrost. BYOK: decrypt the tenant's provider key and pass
  // it as a direct key; otherwise Bifrost uses its configured key pool.
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (vk.provider_key_ref) {
    const pk = store.getProviderKey(vk.provider_key_ref);
    if (pk) {
      headers["x-bf-direct-key"] = "true";
      headers["authorization"] = `Bearer ${pk.key}`;
    }
  }
  if (stream && isObj(body) && body.stream_options === undefined) {
    // Ask for the final usage frame on OpenAI-style streams; translated
    // providers report usage regardless.
    (body as Record<string, unknown>).stream_options = { include_usage: true };
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${config.bifrostUrl}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: stream ? undefined : AbortSignal.timeout(config.upstreamTimeoutMs),
    });
  } catch (err) {
    metrics.providerErrors.inc({ provider: providerOf(model) });
    metrics.requestsTotal.inc({ provider: providerOf(model), model, status: "502" });
    logger.error("upstream unreachable", { request_id: requestId, model, error: String(err) });
    sendJson(res, 502, { error: { message: "upstream proxy unreachable", type: "upstream_error" } });
    return;
  }
  metrics.ttfb.observe({ provider: providerOf(model) }, elapsedSec(start));

  if (stream && upstream.ok) {
    await relayStream(deps, upstream, res, { vk, model, requestId, start });
    return;
  }

  // Non-streaming (and upstream errors, streamed or not).
  const text = await upstream.text();
  if (!upstream.ok) {
    metrics.providerErrors.inc({ provider: providerOf(model) });
    metrics.requestsTotal.inc({ provider: providerOf(model), model, status: String(upstream.status) });
    logger.warn("upstream error", { request_id: requestId, model, status: upstream.status });
    res.writeHead(upstream.status, { "content-type": "application/json" });
    res.end(text);
    return;
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(text) as Record<string, unknown>;
  } catch {
    metrics.providerErrors.inc({ provider: providerOf(model) });
    sendJson(res, 502, { error: { message: "upstream returned malformed JSON", type: "upstream_error" } });
    return;
  }

  const provider = String(
    (payload.extra_fields as Record<string, unknown> | undefined)?.provider ?? providerOf(model),
  );
  const usage = usageFromResponse(payload);
  if (usage) {
    const outcome = billUsage(deps.billing, usage, vk.external_subscription_id, requestId);
    recordBilling(metrics, usage, outcome, provider);
  } else {
    logger.error("no usage extractable from upstream response; nothing billed", {
      request_id: requestId,
      model,
      provider,
    });
  }
  delete payload.extra_fields;

  // Billing events are on disk; now ack to the client (persist-before-ack).
  metrics.requestsTotal.inc({ provider, model, status: "200" });
  metrics.requestDuration.observe({ provider }, elapsedSec(start));
  logger.info("completion", { request_id: requestId, model, provider, stream: false, status: 200 });
  sendJson(res, 200, payload);
}

// ----------------------------------------------------------------------
// SSE relay: strip extra_fields, collect raw frames, bill before [DONE].
// On client abort, keep draining the upstream so consumed usage still bills.
// ----------------------------------------------------------------------
async function relayStream(
  deps: GatewayDeps,
  upstream: Response,
  res: http.ServerResponse,
  ctx: { vk: VirtualKeyRecord; model: string; requestId: string; start: bigint },
): Promise<void> {
  const { metrics, logger } = deps;
  const { vk, model, requestId, start } = ctx;

  let clientGone = false;
  res.on("close", () => {
    clientGone = res.writableEnded === false;
  });
  // A write can race the client teardown; that error must never kill the
  // relay (the upstream drain is what captures billable usage).
  res.on("error", () => {
    clientGone = true;
  });
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });

  const rawEvents: string[] = [];
  let finalUsage: Record<string, unknown> | null = null;
  let provider = providerOf(model);
  let billed = false;

  const finalize = (): void => {
    if (billed) return;
    billed = true;
    const usage = usageFromStream(provider, model, rawEvents, finalUsage);
    if (usage) {
      const outcome = billUsage(deps.billing, usage, vk.external_subscription_id, requestId, {
        aborted_by_client: clientGone || undefined,
      });
      recordBilling(metrics, usage, outcome, provider);
    } else {
      // No usage frame arrived (malformed/truncated upstream): bill nothing.
      // A missing frame means unserved or unknowable usage; inventing an
      // event here would be phantom billing.
      logger.error("stream ended without extractable usage; nothing billed", {
        request_id: requestId,
        model,
        provider,
        frames: rawEvents.length,
      });
    }
  };

  const decoder = new TextDecoder();
  let buffer = "";
  try {
    const reader = (upstream.body as ReadableStream<Uint8Array>).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const out = processBlock(block);
        if (out !== null && !clientGone) res.write(out);
      }
    }
  } catch (err) {
    metrics.providerErrors.inc({ provider });
    logger.error("stream relay error", { request_id: requestId, model, error: String(err) });
  }

  // Upstream finished (or broke). Bill exactly once, then close out.
  finalize();
  metrics.requestsTotal.inc({ provider, model, status: clientGone ? "499" : "200" });
  metrics.requestDuration.observe({ provider }, elapsedSec(start));
  logger.info("completion", {
    request_id: requestId,
    model,
    provider,
    stream: true,
    aborted_by_client: clientGone,
  });
  if (!clientGone) res.end();

  function processBlock(block: string): string | null {
    const dataLines = block
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trimStart());
    if (dataLines.length === 0) return block + "\n\n"; // comments/heartbeats pass through
    const data = dataLines.join("\n");
    if (data === "[DONE]") {
      // Persist billing BEFORE relaying the terminating frame (ADR-003).
      finalize();
      return "data: [DONE]\n\n";
    }
    try {
      const chunk = JSON.parse(data) as Record<string, unknown>;
      const extra = chunk.extra_fields as Record<string, unknown> | undefined;
      if (extra) {
        if (typeof extra.provider === "string") provider = extra.provider;
        if (typeof extra.raw_response === "string") rawEvents.push(extra.raw_response);
        delete chunk.extra_fields;
      }
      if (isObj(chunk.usage)) finalUsage = chunk.usage as Record<string, unknown>;
      return `data: ${JSON.stringify(chunk)}\n\n`;
    } catch {
      // Unparseable chunk from upstream: relay as-is, never crash the relay.
      return `data: ${data}\n\n`;
    }
  }
}

// ----------------------------------------------------------------------
// helpers
// ----------------------------------------------------------------------
function recordBilling(
  metrics: Metrics,
  usage: { input: number; output: number; provider: string },
  outcome: { events: number; rejected: number },
  provider: string,
): void {
  metrics.eventsEmitted.inc({}, outcome.events);
  if (outcome.rejected > 0) {
    // Served usage whose billing event was refused post-serve. The soft gate
    // exists to keep this at zero; any increment is an incident.
    metrics.eventsDropped.inc({}, outcome.rejected);
  }
  metrics.tokensTotal.inc({ dimension: "input", provider }, usage.input);
  metrics.tokensTotal.inc({ dimension: "output", provider }, usage.output);
}

function bearer(req: http.IncomingMessage): string | null {
  const h = req.headers.authorization;
  if (!h || !h.startsWith("Bearer ")) return null;
  return h.slice("Bearer ".length).trim();
}

function providerOf(model: string): string {
  const i = model.indexOf("/");
  return i === -1 ? "unknown" : model.slice(0, i);
}

function modelAllowed(model: string, allowed: string[]): boolean {
  return allowed.some((a) => (a.endsWith("*") ? model.startsWith(a.slice(0, -1)) : model === a));
}

function elapsedSec(start: bigint): number {
  return Number(process.hrtime.bigint() - start) / 1e9;
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
      } catch {
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

function strOrUndef(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
