# Lago AI Gateway (beta)

An OpenAI-compatible gateway that turns LLM traffic into billing-grade Lago usage events. Point any OpenAI SDK at it, authenticate with a Lago-issued virtual key, call any supported model, and correctly priced, correctly attributed usage events land in Lago. Zero events lost, zero double-billed, across a gateway crash.

## Architecture

```
                        ┌─────────────────────────────────────────────┐
 openai / any           │ gateway (this package, Node >= 24)          │
 OpenAI-compatible ───► │  auth: lago_vk_* (SHA-256 hash at rest)     │      ┌──────────────┐
 SDK                    │  budget check (Lago wallet, TTL cache)      │ ───► │ Bifrost      │ ───► providers
                        │  backpressure gate (fail-closed)            │      │ (stock image,│
                        │  SSE relay (client abort still bills)       │ ◄─── │  pinned)     │ ◄─── raw payloads
                        │  raw usage → CanonicalUsage → price+markup  │      └──────────────┘
                        │  → durable SQLite-WAL outbox ───────────────┼───► Lago /events/batch
                        │  /healthz /metrics /admin                   │      (at-least-once + dedupe
                        └─────────────────────────────────────────────┘       by transaction_id)
```

Bifrost (ADR-001) does transport, request translation, routing, fallbacks, and rate limits. This service owns the client socket and the billing core: usage is extracted from the **raw provider payload** (`extra_fields.raw_response`), so dimension fidelity survives, including the Anthropic cache 5m/1h TTL split. Bifrost's own usage and cost numbers are never trusted for billing.

## Quickstart

```bash
docker compose up --build     # gateway + Bifrost + mock providers + mock Lago
npm run demo                  # end-to-end proof, prints DEMO PASSED
```

Create a key and call the gateway:

```bash
curl -X POST localhost:8090/admin/keys \
  -H "Authorization: Bearer $GW_ADMIN_TOKEN" -H "content-type: application/json" \
  -d '{"external_subscription_id": "sub_acme", "external_customer_id": "cust_acme",
       "budget": {"limit_usd": 100}}'
# -> { "key": "lago_vk_..." }   (returned exactly once)
```

```typescript
import OpenAI from "openai";
const client = new OpenAI({ apiKey: "lago_vk_...", baseURL: "http://localhost:8090/v1" });
await client.chat.completions.create({
  model: "anthropic/claude-sonnet-4", // provider/model; Bifrost translates
  messages: [{ role: "user", content: "hello" }],
  stream: true,
});
```

## Endpoints

| Route | Purpose |
| --- | --- |
| `POST /v1/chat/completions` | OpenAI-compatible, stream + non-stream, any provider Bifrost routes |
| `GET /healthz` | liveness + outbox depth/lag |
| `GET /metrics` | Prometheus text exposition |
| `POST /admin/keys` | create virtual key (plaintext returned once) |
| `GET /admin/keys` | list keys (safe fields) |
| `DELETE /admin/keys/{id}` | revoke (immediate) |
| `POST /admin/provider-keys` | store BYOK provider key (write-only) |
| `DELETE /admin/provider-keys/{ref}` | remove provider key |

Admin routes require `Authorization: Bearer $GW_ADMIN_TOKEN`.

## Configuration

| Env | Default | Meaning |
| --- | --- | --- |
| `GW_PORT` | `8090` | listen port |
| `GW_BIFROST_URL` | `http://127.0.0.1:8080` | Bifrost base URL |
| `LAGO_API_URL` | `https://api.getlago.com/api/v1` | Lago API |
| `LAGO_API_KEY` | required | Lago API key |
| `GW_ADMIN_TOKEN` | required, >= 16 chars | admin bearer token |
| `GW_MASTER_KEY` | required, 32 bytes base64 | BYOK envelope-encryption master key |
| `GW_DATA_DIR` | `./data` | SQLite files (outbox, keys) |
| `GW_PRICING_MODE` | `price` | `price` emits `llm_cost`; `tokens` emits per-dimension counts |
| `GW_MARKUP` | `1.0` | cost multiplier |
| `GW_OPENROUTER_URL` | unset | override price-table URL (harness/demo) |
| `GW_PRICING_TTL_MS` | `3600000` | price table refresh interval |
| `GW_BUDGET_TTL_MS` | `5000` | budget check cache window |
| `GW_BACKPRESSURE_DEPTH` | `50000` | outbox depth that triggers fail-closed 503s |
| `GW_BACKPRESSURE_HEADROOM` | `10000` | outbox hard bound above the soft gate |
| `GW_UPSTREAM_TIMEOUT_MS` | `120000` | non-streaming upstream timeout |

Routing, fallbacks, and per-key rate limits are Bifrost config (`ops/bifrost/config.json`, governance API). A virtual key can carry a `bifrost_vk` so the proxy's per-key rate limits apply to it.

## Failure semantics

| Situation | Behavior |
| --- | --- |
| Budget confirmed exhausted | `402` with machine-readable body (`code: exhausted`, `spent_usd`, `limit_usd`); `gw_budget_denials_total` increments |
| Lago unreachable during budget check | fail-open + `gw_budget_check_failures_total` (alert on it); keys with `budget.strict: true` fail closed with `402` |
| Billing outbox full | fail-closed: `503` (`type: billing_backpressure`) **before** any provider call. Refusing work beats losing billing data |
| Gateway killed (SIGKILL) | accepted events are already in the WAL outbox; restart replays with the same `transaction_id`, Lago dedupes. Zero loss, zero duplicates |
| Client aborts mid-stream | the gateway keeps draining the provider stream; consumed usage is billed, tagged `aborted_by_client` |
| Provider/proxy error (4xx/5xx) | relayed to the client; nothing billed; `gw_provider_errors_total` increments. Request-level `fallbacks` are served and billed against the provider that actually answered |
| Malformed/truncated provider stream | relay degrades cleanly, nothing billed (a missing usage frame means unknowable usage; inventing an event would be phantom billing) |
| Model missing from the price table | never under-bill: token events are emitted instead of `llm_cost` and `onError` fires; nothing is silently dropped |
| Unknown/revoked virtual key | `401` (`code: invalid_virtual_key`) |

## Observability

Prometheus metrics: `gw_requests_total{provider,model,status}`, `gw_request_duration_seconds`, `gw_ttfb_seconds`, `gw_tokens_total{dimension}`, `gw_billing_events_emitted_total`, `gw_billing_outbox_depth`, `gw_billing_events_dropped_total` (must stay 0), `gw_budget_denials_total`, `gw_budget_check_failures_total`, `gw_provider_errors_total{provider}`, `gw_backpressure_rejections_total`.

Logs are structured JSON, metadata only. Prompts, completions, provider keys, and virtual keys never appear in logs or event payloads; every event carries a `request_id` that also appears in the logs, so any invoice line traces back to a request.

## Verification

```bash
npm run verify:gateway   # build + typecheck + lint + unit + crash + compose + integration + load smoke
```

## Beta boundaries

Single gateway instance per outbox file (SQLite single-writer; Redis Streams is the recorded path past that, ADR-003). No admin UI. `/v1/chat/completions` only.
