# Changelog

All notable changes to this project will be documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org).

## [Unreleased]

### Added
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
