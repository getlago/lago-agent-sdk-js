# AI Gateway for Billing: build plan

Goal: a design-partner beta where any OpenAI-compatible SDK pointed at the gateway's base URL, authenticated with a Lago virtual key, produces correctly priced, correctly attributed usage events in Lago within 60 seconds. Zero events lost, zero double-billed, across a gateway crash.

Architecture (see ADR-001): stock Bifrost image for transport, translation, and routing; a TypeScript billing edge in `packages/gateway` in front of it running `@getlago/agent-sdk/core` in-process; SQLite WAL outbox for durable delivery (ADR-003); npm workspaces (ADR-002).

## Work packages to PRs

All nine PRs shipped as a stacked draft series. Statuses below reflect what landed.

| PR  | Work package              | Contents                                                                                                                                      |
| --- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| #18 | WP0                       | Package rename to `@getlago/agent-sdk`, CI trigger widened for stacked PRs                                                                    |
| #19 | Phase 0                   | ADR-001/002/003, this plan                                                                                                                    |
| #20 | WP1                       | Workspaces conversion, `@getlago/agent-sdk/core` subpath export, adapter export gaps closed, `transaction_id` build-time test                 |
| #21 | WP2                       | `EventTransport` interface, `DurableEventQueue` (SQLite WAL), kill -9 crash test in CI, fail-closed backpressure                              |
| #22 | WP3                       | Bifrost wiring, `/v1/chat/completions` (stream + non-stream, 2+ providers), virtual keys (hashed), BYOK (AES-256-GCM), admin REST, `/healthz` |
| #23 | WP4                       | Lago-backed budget checks with TTL cache, 402 semantics, fail-open default + per-key strict                                                   |
| #24 | WP5                       | Abort-still-bills, traceability, metrics completeness, and redaction proofs (the plumbing shipped in #22)                                     |
| #25 | WP6                       | Integration harness against real Bifrost, rate limits via Bifrost governance VKs, load smoke, `npm run verify:gateway`                        |
| #26 | WP7                       | docker compose, `npm run demo` (prints `DEMO PASSED`), gateway README, `DEFINITION_OF_DONE.md`                                                |

## Schedule (3 to 6 week window)

- W1: WP0, ADRs, WP1 (done)
- W2 to W3: WP2, WP3 (done)
- W4: WP4, WP5 (done)
- W5: WP6, WP7 (done), review cycle with the reviewer agent
- W6: buffer

## Verified repo facts the plan builds on

- All five providers (OpenAI, Anthropic, Gemini, Mistral, Bedrock) already have JS usage extraction, sync and stream, with fixtures. WP1 exports them; it does not port them.
- `transaction_id` is already assigned at event-build time (`src/sdk.ts`), which is what makes outbox replay safe.
- CanonicalUsage carries 11 dimensions including `audio_output`.
- Pricing math is BigInt fixed-point (1e12), floor rounding, with a never-under-bill fallback to token events plus `onError` when a price is missing.

## Out of scope for this beta

Admin UI. Multi-region or HA topology. SOC 2 controls. Python SDK parity (follow-up: port the gateway-facing `core` surface to the Python SDK after beta). Custom router or load balancer. New Lago-core features. `/v1/embeddings`, images, audio endpoints.
