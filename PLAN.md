# AI Gateway for Billing: build plan

Goal: a design-partner beta where any OpenAI-compatible SDK pointed at the gateway's base URL, authenticated with a Lago virtual key, produces correctly priced, correctly attributed usage events in Lago within 60 seconds. Zero events lost, zero double-billed, across a gateway crash.

Architecture (see ADR-001): stock Bifrost image for transport, translation, and routing; a TypeScript billing edge in `packages/gateway` in front of it running `@getlago/agent-sdk/core` in-process; SQLite WAL outbox for durable delivery (ADR-003); npm workspaces (ADR-002).

## Work packages to PRs

| PR   | Work package              | Contents                                                                                                                                      |
| ---- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| #18  | WP0                       | Package rename to `@getlago/agent-sdk`, CI trigger widened for stacked PRs                                                                    |
| ADRs | Phase 0                   | ADR-001/002/003, this plan                                                                                                                    |
| WP1  | Core extraction           | Workspaces conversion, `@getlago/agent-sdk/core` subpath export, adapter export gaps closed, `transaction_id` build-time test                 |
| WP2  | Durable delivery          | `EventTransport` interface, `DurableEventQueue` (SQLite WAL), kill -9 crash test in CI, fail-closed backpressure                              |
| WP3  | Gateway service           | Bifrost wiring, `/v1/chat/completions` (stream + non-stream, 2+ providers), virtual keys (hashed), BYOK (AES-256-GCM), admin REST, `/healthz` |
| WP4  | Enforcement               | Lago-backed budget checks with TTL cache, 402 semantics, fail-open default + per-key strict, rate limits via Bifrost                          |
| WP5  | Streaming + observability | SSE relay, abort-still-bills, Prometheus `gw_*` metrics, structured logs with `request_id`                                                    |
| WP6  | Test hardening            | Integration harness (mock providers + mock Lago), adversarial suite, load smoke, `npm run verify:gateway`                                     |
| WP7  | Demo + docs               | docker compose, `npm run demo` (prints `DEMO PASSED`), gateway README, `DEFINITION_OF_DONE.md`                                                |

## Schedule (3 to 6 week window)

- W1: WP0, ADRs, WP1
- W2 to W3: WP2, WP3
- W4: WP4, WP5
- W5: WP6, WP7, review cycle with the reviewer agent
- W6: buffer

## Verified repo facts the plan builds on

- All five providers (OpenAI, Anthropic, Gemini, Mistral, Bedrock) already have JS usage extraction, sync and stream, with fixtures. WP1 exports them; it does not port them.
- `transaction_id` is already assigned at event-build time (`src/sdk.ts`), which is what makes outbox replay safe.
- CanonicalUsage carries 11 dimensions including `audio_output`.
- Pricing math is BigInt fixed-point (1e12), floor rounding, with a never-under-bill fallback to token events plus `onError` when a price is missing.

## Out of scope for this beta

Admin UI. Multi-region or HA topology. SOC 2 controls. Python SDK parity (follow-up: port the gateway-facing `core` surface to the Python SDK after beta). Custom router or load balancer. New Lago-core features. `/v1/embeddings`, images, audio endpoints.
