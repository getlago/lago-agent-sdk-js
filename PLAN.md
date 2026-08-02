# Lago AI Billing Gateway: build plan

Goal: a design-partner beta that proves the full financial chain — `model request → Lago customer → usage → provider cost → customer-specific price → margin → credits → real invoice line` — across certified providers. Any stock OpenAI or Anthropic SDK pointed at the gateway's base URL, authenticated with a Lago virtual key, produces correctly priced, correctly attributed usage in Lago within 60 seconds. Zero events lost, zero double-billed, across a gateway crash.

Architecture (see ADR-001, revised 2026-08-02): the TypeScript billing edge in `packages/gateway` runs `@getlago/agent-sdk/core` in-process and dials certified providers directly over two native protocol transports (OpenAI-compatible and Anthropic-compatible). Proxies (Bifrost, LiteLLM) are optional upstream adapters behind the same interface, never required. SQLite WAL outbox for durable delivery (ADR-003); npm workspaces (ADR-002).

## Work packages to PRs

WP0–WP7 shipped as the stacked draft series #18–#26 on the v1 (required-Bifrost) architecture. The durability, extraction, key, budget, and observability layers are upstream-agnostic and carry over; WP8–WP12 are the migration to the revised architecture, not a restart.

| PR   | Work package                  | Contents                                                                                                                                      |
| ---- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| #18  | WP0                           | Package rename to `@getlago/agent-sdk`, CI trigger widened for stacked PRs                                                                    |
| #19  | Phase 0                       | ADR-001/002/003, this plan                                                                                                                    |
| #20  | WP1                           | Workspaces conversion, `@getlago/agent-sdk/core` subpath export, adapter export gaps closed, `transaction_id` build-time test                 |
| #21  | WP2                           | `EventTransport` interface, `DurableEventQueue` (SQLite WAL), kill -9 crash test in CI, fail-closed backpressure                              |
| #22  | WP3                           | `/v1/chat/completions` (stream + non-stream, 2+ providers), virtual keys (hashed), BYOK (AES-256-GCM), admin REST, `/healthz` — built against Bifrost |
| #23  | WP4                           | Lago-backed budget checks with TTL cache, 402 semantics, fail-open default + per-key strict                                                   |
| #24  | WP5                           | Abort-still-bills, traceability, metrics completeness, and redaction proofs (the plumbing shipped in #22)                                     |
| #25  | WP6                           | Integration harness against real Bifrost, rate limits via Bifrost governance VKs, load smoke, `npm run verify:gateway`                        |
| #26  | WP7                           | docker compose, `npm run demo` (prints `DEMO PASSED`), gateway README, `DEFINITION_OF_DONE.md`                                                |
| next | WP8: native transports        | `UpstreamTransport` interface, direct-dial HTTPS upstream, `/v1/messages` Anthropic ingress; Bifrost demoted to an optional adapter behind the interface |
| next | WP9: provider profiles        | Certified profiles for OpenAI, Anthropic, Groq, Mistral, Bedrock via `bedrock-mantle` (API-key auth, scoped models/regions); versioned cost catalog by model, region, effective date |
| next | WP10: financial record        | Per-request Lago-owned record: customer/subscription, provider/model/region, usage incl. cached dimensions, provider cost, customer price, margin, credits/commitment, event/invoice lineage |
| next | WP11: contract tests          | Per-profile suite (non-stream, stream, tool calls, errors, usage extraction, cost, attribution); published compatibility matrix generated from results |
| next | WP12: request-to-revenue demo | Demo against a real Lago OSS instance: two customers on different pricing, credits/commitment, invoice-line reconciliation, restart survival; `DEFINITION_OF_DONE.md` launch acceptance criteria |

## Schedule

- W1: WP0, ADRs, WP1 (done)
- W2 to W3: WP2, WP3 (done)
- W4: WP4, WP5 (done)
- W5: WP6, WP7 (done), launch architecture review → this revision
- W6+: WP8–WP9, then WP10–WP11, then WP12 as the launch gate

## Verified repo facts the plan builds on

- All five certified-path providers already have JS usage extraction in the SDK's native adapters, sync and stream, with fixtures — extraction is transport-independent, which is what makes WP8 a rewiring rather than a rewrite.
- `transaction_id` is already assigned at event-build time (`src/sdk.ts`), which is what makes outbox replay safe.
- CanonicalUsage carries 11 dimensions including `audio_output` and the Anthropic cache 5m/1h write split.
- Pricing math is BigInt fixed-point (1e12), floor rounding, with a never-under-bill fallback to token events plus `onError` when a price is missing.

## Out of scope for the launch

Intelligent routing and model selection. Fallbacks. Generic governance. Prompt observability. Universal provider coverage. Partnership and startup-program workflows. AWS-native Converse/InvokeModel, SigV4, provisioned throughput, batch inference, custom deployments. Admin UI. Multi-region or HA topology. SOC 2 controls. Python SDK parity (follow-up: port the gateway-facing `core` surface after beta). New Lago-core features. `/v1/embeddings`, images, audio endpoints.
