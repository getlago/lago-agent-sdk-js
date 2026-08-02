# ADR-001: Transport architecture for the AI Billing Gateway

Status: Accepted. Revised 2026-08-02. (v1, accepted 2026-07-31, made Bifrost the required transport; revised after the launch architecture review on PR #19. The v1 proxy evaluation is retained below because it still decides the optional-adapter question.)

## Context

The product is the **Lago AI Billing Gateway**: the financial layer between model consumption and customer revenue. The launch claim is "build with any leading model provider; monetize with Lago" — not a routing gateway, not an AI-governance gateway, and not a Bifrost distribution. v1 of this ADR made Bifrost a required runtime that owned transport, translation, routing, fallbacks, virtual keys, and rate limits. That created dependency and positioning risk (Bifrost is expanding into budgets, cost controls, and enterprise AI governance) and put a third party between Lago and the raw usage record. The launch review set constraints v1 does not meet:

- Lago owns the customer identity, the raw usage record, the pricing context, and the billable ledger. No third-party runtime sits between the billing edge and the provider bytes.
- The transport boundary is explicit and pluggable. The certified paths must not require Bifrost or LiteLLM.
- OpenAI and Anthropic are supported natively, covering streaming, tool calls, provider-specific errors, and full usage dimensions — including Anthropic prompt-cache reads and the 5-minute/1-hour cache-write split.
- A customer migrates by changing the base URL in the stock `openai` or `@anthropic-ai/sdk` package.

Dimension fidelity (cache TTL split, reasoning tokens, tool calls) remains the differentiation. The SDK's native adapters already extract it from raw provider payloads, sync and stream, with fixtures — that asset is transport-independent.

## Decision

**The gateway speaks two protocol transports natively and dials certified providers directly. Proxies are optional upstream adapters behind the same interface, never required.**

1. **Protocol transports.** Two ingress surfaces, each relayed to upstreams that speak the same protocol, with no translation layer in the certified paths:
   - **OpenAI-compatible**: `POST /v1/chat/completions` first; the Responses API where a certified model requires it.
   - **Anthropic-compatible**: native `POST /v1/messages`.
2. **Certified provider profiles.** Launch certifies five profiles on those transports: OpenAI direct; Anthropic direct; Groq via OpenAI compatibility; Mistral via OpenAI compatibility; Amazon Bedrock via `bedrock-mantle`, using its OpenAI or Anthropic compatibility surface. A profile is data plus tests, and must define: endpoint and authentication; model identifiers; usage extraction, including cached-token dimensions; streaming and tool-call behavior; error behavior; a versioned cost catalog by model, region, and effective date; and explicit compatibility limitations. "Certified" means the profile's contract tests pass; there is no "any supported model" claim, only the published matrix.
3. **Upstream boundary.** The billing edge selects an upstream per request through one `UpstreamTransport` interface: a direct-dial HTTPS transport parameterized by provider profile (the certified default), or an optional proxy adapter. Bifrost stays available as such an adapter (LiteLLM can be another); adapters get the same contract tests as direct profiles and are never required for the certified paths. Generic routing, fallback, and gateway governance are not launch requirements and live only behind adapters.
4. **Lago-owned financial record.** For every accepted request the gateway persists, in its own store before the client response completes: Lago customer and subscription; provider, model, and region; input, output, and cached usage; provider cost from the profile's cost catalog; the customer-specific selling price; gross margin; credits or commitment consumed; and Lago event/invoice lineage. Lago is the system of record; no proxy's usage or cost numbers are ever trusted for billing.
5. **AWS boundary.** Launch supports only `bedrock-mantle` with Bedrock API-key authentication, on selected on-demand models and regions. AWS-native Converse/InvokeModel, SigV4, provisioned throughput, batch inference, and custom deployments are excluded.

## Migration from the current implementation (smallest path)

The WP1–WP7 build (PRs #20–#26) survives largely intact because the durability point and the extraction already live in our process:

- **Unchanged**: workspaces (ADR-002); SQLite WAL outbox, crash semantics, fail-closed backpressure (ADR-003); virtual keys and BYOK at rest; budget enforcement; SSE relay including abort-still-bills; metrics; redaction proofs. None of these know what the upstream is.
- **`packages/gateway/src/billing.ts`**: already extracts from raw provider payloads via the SDK's native adapters. On a direct transport the response body *is* the raw payload, so the certified paths feed the adapters directly; the `extra_fields.raw_response` unwrap and the normalized-usage fallback move into the Bifrost adapter, the only place they apply.
- **`packages/gateway/src/server.ts`**: the hardcoded Bifrost upstream (`GW_BIFROST_URL`) becomes an `UpstreamTransport` chosen per request from the provider profile. Add the `/v1/messages` ingress next to `/v1/chat/completions`.
- **Pricing**: the OpenRouter-sourced price table is replaced by the per-profile versioned cost catalog (model, region, effective date) plus customer-specific selling prices; the never-under-bill fallback keeps its semantics.
- **Rate limits**: v1 delegated per-key rate limits to Bifrost governance. On certified paths this moves into the edge or is descoped for launch; it is not a launch requirement.
- **New work**: direct-dial transport, `/v1/messages` ingress, provider profiles for Groq/Mistral/`bedrock-mantle`, the financial record, the commercial decision engine (ADR-004), and per-profile contract tests published as the compatibility matrix. See PLAN.md WP8–WP13.

## Proxy evaluation (v1, 2026-07-31 — retained for the adapter decision)

All licenses and capabilities were verified against current sources on 2026-07-31, not from memory.

| Criterion (priority order)                                         | LiteLLM                                                                         | Portkey                                                    | Bifrost                                                                                       | Helicone GW                                            | Envoy AI GW                      | Kong                        |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------ | -------------------------------- | --------------------------- |
| 1. Raw provider payload in hooks                                   | No. Normalized `ModelResponse`; loses cache 5m/1h split (issues #29432, #27763) | No. Hooks see OpenAI shape; streams read-only              | **Yes.** `send_back_raw_response` returns the original payload in `extra_fields.raw_response` | No                                                     | No. ExtProc, normalized metadata | No                          |
| 2. OpenAI ingress + translation (Anthropic/Gemini/Mistral/Bedrock) | Yes                                                                             | Yes                                                        | Yes                                                                                           | Partial                                                | Partial                          | Partial                     |
| 3. SSE passthrough, usage at stream end                            | Yes                                                                             | Partial                                                    | Yes (verified by spike below)                                                                 | Partial                                                | Partial                          | Partial                     |
| 4. Virtual keys, budgets, BYOK in OSS                              | Yes, needs Postgres                                                             | No. Moved to cloud product after the Palo Alto acquisition | **Yes.** Governance is OSS: VKs, budgets, rate limits, provider-key mapping                   | No                                                     | No                               | No. Enterprise-gated        |
| 5. Routing/fallback/LB via config                                  | Yes                                                                             | Yes                                                        | Yes (adaptive LB is enterprise; weighted + fallbacks OSS)                                     | Partial                                                | Yes                              | Partial                     |
| 6. License                                                         | MIT + commercial `enterprise/` dir                                              | MIT                                                        | **Apache-2.0**                                                                                | GPLv3, maintenance mode since the Mintlify acquisition | Apache-2.0                       | OSS core, AI features gated |
| 7. Runtime                                                         | Python sidecar + Postgres                                                       | TS, embeddable                                             | Go binary/image                                                                               | Rust                                                   | Go + Envoy                       | Lua                         |

This evaluation stands for what it now decides: which proxies are worth an optional adapter. Bifrost remains the first adapter because it is the only one whose hooks preserve the raw payload (criterion 1). LiteLLM is the recorded second adapter candidate despite losing the cache TTL split, because translation-only routes through it never carry that split anyway.

### Spike evidence (2026-07-31, bifrost:latest, mock providers)

- Non-stream, OpenAI and Anthropic: `extra_fields.raw_response` is byte-faithful, including vendor-specific usage fields and the full Anthropic `cache_creation.ephemeral_5m/1h` split.
- Stream: each relayed chunk carries `extra_fields.raw_response` with the raw provider SSE event (Anthropic `message_start` arrives with full cache usage). The final chunk is synthesized by Bifrost (no `raw_response`) but its normalized usage preserves the TTL split (`cached_write_token_details.cached_write_tokens_5m/1h`).
- Extraction strategy: parse raw events per chunk and feed the existing native adapters; fall back to the final chunk's normalized usage only when a raw frame is absent. `network_config.allow_private_network: true` is required for compose-internal provider URLs.

## Consequences

- The certified paths have no third-party runtime: fewer moving parts, no dependency or positioning risk, and the latency of one process instead of two. The durability point (SQLite WAL write) stays in our process either way.
- Two ingress protocols to maintain instead of one; translation is nobody's job on certified paths, so an Anthropic model is reached through the Anthropic transport, not through Chat Completions.
- Each certified profile carries a contract-test bill: non-streaming, streaming, tool calls, provider errors, usage extraction (cached dimensions where applicable), cost calculation, and Lago customer attribution. The published compatibility matrix is generated from these tests.
- The Bifrost image, when used as an adapter, stays pinned by digest with its contract tests in CI. A custom Go binary registering Bifrost's `PostLLMHook` remains the contingency if a future version drops per-chunk raw access.

## Out of launch scope

Intelligent routing and model selection beyond ADR-004's commercial decision outputs. Fallbacks. Generic governance. Prompt observability. Universal provider coverage. Partnership and startup-program workflows.

## NEEDS-HUMAN-CONFIRMATION

1. Apache-2.0 dependency (Bifrost) consumed as an unmodified image from an MIT repo, now optional. Clean by our reading, but legal should confirm before we distribute or document the adapter. If we ever vendor or patch Bifrost code, that code stays Apache-2.0 with NOTICE preserved.
2. Gateway package license defaults to MIT to match the repo.
3. `bedrock-mantle` scope: confirm the exact on-demand models and regions to certify at launch, and that Bedrock API-key auth is acceptable for the target design partners (SigV4 is explicitly excluded).
