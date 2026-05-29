# Changelog

All notable changes to this project will be documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org).

## [Unreleased]

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
