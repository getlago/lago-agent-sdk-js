# ADR-001: Proxy selection for the AI Gateway

Status: Accepted. 2026-07-31.

## Context

Lago wants to ship an AI Gateway for Billing beta in 3 to 6 weeks. The strategy: adopt an open-source proxy for transport, translation, and routing. Reuse this repo's usage, pricing, and event logic as the billing engine. The billing hook must see the raw provider payload. Dimension fidelity (cache 5m/1h TTL split, reasoning tokens, tool calls) is the differentiation. All licenses and capabilities below were verified against current sources on 2026-07-31, not from memory.

## Options

| Criterion (priority order)                                         | LiteLLM                                                                         | Portkey                                                    | Bifrost                                                                                       | Helicone GW                                            | Envoy AI GW                      | Kong                        |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------ | -------------------------------- | --------------------------- |
| 1. Raw provider payload in hooks                                   | No. Normalized `ModelResponse`; loses cache 5m/1h split (issues #29432, #27763) | No. Hooks see OpenAI shape; streams read-only              | **Yes.** `send_back_raw_response` returns the original payload in `extra_fields.raw_response` | No                                                     | No. ExtProc, normalized metadata | No                          |
| 2. OpenAI ingress + translation (Anthropic/Gemini/Mistral/Bedrock) | Yes                                                                             | Yes                                                        | Yes                                                                                           | Partial                                                | Partial                          | Partial                     |
| 3. SSE passthrough, usage at stream end                            | Yes                                                                             | Partial                                                    | Yes (verified by spike below)                                                                 | Partial                                                | Partial                          | Partial                     |
| 4. Virtual keys, budgets, BYOK in OSS                              | Yes, needs Postgres                                                             | No. Moved to cloud product after the Palo Alto acquisition | **Yes.** Governance is OSS: VKs, budgets, rate limits, provider-key mapping                   | No                                                     | No                               | No. Enterprise-gated        |
| 5. Routing/fallback/LB via config                                  | Yes                                                                             | Yes                                                        | Yes (adaptive LB is enterprise; weighted + fallbacks OSS)                                     | Partial                                                | Yes                              | Partial                     |
| 6. License                                                         | MIT + commercial `enterprise/` dir                                              | MIT                                                        | **Apache-2.0**                                                                                | GPLv3, maintenance mode since the Mintlify acquisition | Apache-2.0                       | OSS core, AI features gated |
| 7. Runtime                                                         | Python sidecar + Postgres                                                       | TS, embeddable                                             | Go binary/image                                                                               | Rust                                                   | Go + Envoy                       | Lua                         |

Helicone is eliminated on license alone. Portkey fails criterion 4 and its hooks fail criterion 1. LiteLLM is the runner-up but demonstrably loses the cache TTL split, and forces a Python sidecar plus Postgres.

## Decision

**Bifrost (maximhq/bifrost, Apache-2.0), consumed as a stock pinned Docker image. No fork.** A thin TypeScript "billing edge" service (`packages/gateway`) sits in front of it, owns the client socket, and runs `@getlago/agent-sdk/core` in-process: auth, budget check, backpressure, SSE relay, raw usage extraction, pricing, durable outbox. Bifrost stays transport-only. Its usage and cost fields are never trusted for billing; we price from raw payloads.

Criterion 7 is resolved by this split, not by picking a weaker TS proxy: the durability point (SQLite WAL write) lives in our process, so a proxy crash loses no billing data and a shim crash recovers from WAL.

### Spike evidence (2026-07-31, bifrost:latest, mock providers)

- Non-stream, OpenAI and Anthropic: `extra_fields.raw_response` is byte-faithful, including vendor-specific usage fields and the full Anthropic `cache_creation.ephemeral_5m/1h` split.
- Stream: each relayed chunk carries `extra_fields.raw_response` with the raw provider SSE event (Anthropic `message_start` arrives with full cache usage). The final chunk is synthesized by Bifrost (no `raw_response`) but its normalized usage preserves the TTL split (`cached_write_token_details.cached_write_tokens_5m/1h`).
- Extraction strategy: parse raw events per chunk and feed the existing native adapters; fall back to the final chunk's normalized usage only when a raw frame is absent. `network_config.allow_private_network: true` is required for compose-internal provider URLs.

## Consequences

- No Go code in the beta path. A custom Go binary registering Bifrost's `PostLLMHook` is the recorded contingency if a future Bifrost version drops per-chunk raw access.
- The shim adds one local hop. Measured by `gw_ttfb_seconds` in the load smoke; compose runs both on one network.
- Image is pinned by digest. Contract tests run our fixtures against the pinned image in CI.

## NEEDS-HUMAN-CONFIRMATION

1. Apache-2.0 dependency consumed as an unmodified image from an MIT repo. Clean by our reading, but legal should confirm. If we ever vendor or patch Bifrost code, that code stays Apache-2.0 with NOTICE preserved.
2. Gateway package license defaults to MIT to match the repo.
3. Single-vendor OSS risk: Portkey and Helicone were both acquired in 2026. We accept the risk for beta with the image pinned and the `PostLLMHook` contingency recorded.
