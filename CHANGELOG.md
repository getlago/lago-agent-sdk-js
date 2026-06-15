# Changelog

All notable changes to this project will be documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org).

## [Unreleased]

## [0.2.0] - 2026-06-15

### Added
- **Price mode — emit computed dollar cost instead of token counts.** New `pricingMode` config (`"tokens"` default | `"price"`), plus `markup`, `costMetricCode` (default `llm_cost`), `pricingTtlMs`, and `bedrockDefaultRegion`. In price mode the SDK emits one `llm_cost` event per call carrying a top-level `precise_total_amount_cents` (cost in cents, after markup) for Lago's **dynamic charge model**, with a full per-field breakdown in `properties` (value in USD, base, markup, source, per-field tokens/unit_price/cost). Live unit prices come from public, no-auth sources: OpenRouter (`/api/v1/models`) for native anthropic/openai/mistral/gemini, and the AWS Bedrock Price List **Bulk** API for Bedrock. Prices are fetched + cached on the background queue loop (never blocking the customer's call); a missing price falls back to token events and calls `onError` (never silently under-bills). Mode and markup are overridable per-call via `lago: { mode: "price", markup: 1.5 }` (Bedrock: command `__lago`). Money uses fixed-point BigInt floored to 12 dp, identical to the Python `Decimal` implementation (cross-repo golden fixture). New `pricing.ts` module + `PricingProvider`; default `pricingMode: "tokens"` keeps existing behavior unchanged.

### Fixed
- **Anthropic `messages.create({ stream: true })` under-billed input tokens.** The stream wrapper read only top-level `usage`, which on a basic stream appears only on `message_delta` as `{ output_tokens: N }` — the authoritative `input_tokens` / `cache_*` counts arrive nested under `message.usage` on the `message_start` event and were ignored, so input billed 0. The wrapper now merges usage from `message_start` (input/cache) and `message_delta` (cumulative output). Regression test uses the realistic wire shape (delta carries no input echo).
- **Legacy `@google/generative-ai` SDK silently emitted no events.** The detector matched both the new `@google/genai` (`GoogleGenAI`) and the deprecated `@google/generative-ai` (`GoogleGenerativeAI`) SDKs, but the wrapper only instruments the unified `models` / `aio` surface — a legacy client routed through and wrapped nothing. `wrap()` now rejects legacy clients with a clear pointer to migrate to `@google/genai`.

### Security
- Hardened the publish workflow: least-privilege `permissions: contents: read` default (only `publish` gets `id-token: write`, only `release` gets `contents: write`), and every third-party action pinned to a full commit SHA so a re-pointed tag can't inject code into the OIDC-token-minting job.
- The `publish` job builds from source (`npm ci` + `npm run build`) and publishes with `--provenance`, attaching a sigstore attestation ("Built and signed on GitHub Actions") to the package on npm. (npm has no supported path to attach provenance to a pre-packed tarball — provenance is bound to the build — so the job reinstalls from the committed lockfile, which keeps the build reproducible, and runs only on a `v*.*.*` tag behind the environment approval gate.)
- The `publish` job runs on **Node 24** (bundles npm ≥ 11.13). OIDC trusted publishing requires npm CLI ≥ 11.5.1, which Node 20/22 (npm 10.x) do not ship — the previous Node 20 publish job would have failed the OIDC handshake at release time.
- Added `if: startsWith(github.ref, 'refs/tags/v')` to the `publish` job as defense-in-depth — it refuses to run on a non-tag ref even if the environment's protected-tag rule is misconfigured.
- Added `.github/dependabot.yml` (github-actions ecosystem) so the SHA pins stay fresh — Dependabot bumps the SHA and version comment together rather than letting actions silently age.
- RELEASING.md now documents `npm` environment protection (required reviewers + protected-tag restriction) as a **required** setup step, not optional, since trusted publishing is only as strong as that environment's rules.

### Documentation
- README: clarified that `cache_read`, `audio_input`, and `image_input` are **subsets** of `input` for OpenAI and Gemini (not additive) — summing them with `llm_input_tokens` double-counts.

### Added
- Native `@google/genai` SDK wrapper covering `client.models.generateContent` + `generateContentStream`, sync + streaming. Handles both camelCase (SDK pydantic-like objects) and snake_case (serialized JSON) shapes of `usageMetadata` / `usage_metadata`.
- `extractGeminiNative` adapter: `promptTokenCount → input`, `candidatesTokenCount → output`, `cachedContentTokenCount → cache_read`, `thoughtsTokenCount → reasoning`, modality-tagged details → audio_input/audio_output/image_input, count of `candidates[0].content.parts[].functionCall → tool_calls`.
- **Gemini 2.5 surfaces reasoning tokens by default** — fires `llm_reasoning_tokens` automatically. Semantic note vs OpenAI: Gemini's reasoning is ADDITIVE to output (`candidates + thoughts = total billable output`); OpenAI's reasoning is a SUBSET of `completion_tokens`. Documented in adapter docstring + README.
- 20 new unit tests (14 adapter + 6 wrapper) and 4 live integration tests (gated on `GEMINI_API_KEY`). Total: 291 unit tests.
- 5 captured response fixtures from the real Gemini API.
- Detector now returns `gemini` (was `google`) for `@google/genai` clients.

### Added (OpenAI — earlier in this branch)
- Native `openai` SDK wrapper covering both APIs: `chat.completions.create` and `responses.create`, each sync + streaming. Wraps the APIPromise via Proxy with `.bind(target)` to preserve `.withResponse()` / `.asResponse()` calls.
- `extractOpenAINative` adapter auto-detects which API (Chat Completions vs Responses) and extracts the appropriate fields:
  - Chat Completions: `prompt_tokens`, `completion_tokens`, `prompt_tokens_details.{cached_tokens, audio_tokens}`, `completion_tokens_details.{reasoning_tokens, audio_tokens}`, count of `choices[0].message.tool_calls`.
  - Responses API: `input_tokens`, `output_tokens`, `input_tokens_details.cached_tokens`, `output_tokens_details.reasoning_tokens`, count of `output[].type === "function_call"`.
- **First provider to populate `llm_reasoning_tokens`** — OpenAI's o-series models (`o4-mini`, `o1`, etc.) surface reasoning tokens separately from completion tokens.
- Auto-injection of `stream_options: { include_usage: true }` when `stream: true` is set without it, so Chat Completions streaming emits usage on the final chunk.
- `audio_output` field added to `CanonicalUsage` (maps to `llm_audio_output_tokens`) — populated by GPT-4o-audio responses.
- Per-call override via `lago: { subscription, dimensions }` on the OpenAI options.
- 19 adapter tests + 9 wrapper tests + 5 live integration tests.
- 10 captured response fixtures from the real OpenAI API.

### Previously in unreleased (Anthropic)
- Native `@anthropic-ai/sdk` wrapper covering `messages.create` (sync + streaming) and `messages.stream` (`.finalMessage()` + `finalMessage` event).
- `extractAnthropicNative` adapter — verified against captured fixtures (plain, tool use, cache create). Maps `usage.input_tokens`, `usage.output_tokens`, `usage.cache_read_input_tokens`, `usage.cache_creation_input_tokens`, `usage.cache_creation.ephemeral_{5m,1h}_input_tokens`, and counts `content[].type === "tool_use"` for `tool_calls`.
- Per-call override via `lago: { subscription, dimensions }` in the create/stream options — stripped before forwarding so the Anthropic validator doesn't reject it.
- 6 wrapper tests + 7 adapter tests + 3 live integration tests.

## [0.1.0] — initial release

### Added
- `LagoSDK` core with batched async event queue, exponential backoff, bounded buffer, `AsyncLocalStorage`-based subscription resolution.
- AWS SDK v3 `BedrockRuntimeClient` wrapper covering `ConverseCommand`, `ConverseStreamCommand`, `InvokeModelCommand`, `InvokeModelWithResponseStreamCommand`.
- 7 InvokeModel family adapters (`anthropic`, `opus_4_7`, `nova`, `pixtral`, `mistral_legacy`, `openai_compat_basic`, `openai_compat_with_details`) with substring-match dispatch.
- `@mistralai/mistralai` native wrapper covering `chat.complete`, `chat.stream`, and async variants. Handles both snake_case and camelCase usage payloads.
- Three subscription-resolution tiers: per-call `__lago` on commands / `lago` on Mistral options, context-bound `withSubscription`/`setSubscription`, init-time default.
- 237 tests: 229 unit + 8 integration; verified against 159 fixtures captured from real provider responses.
- p99 wrap-overhead ≤ 5 ms benchmark.
