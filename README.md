# @getlago/agent-sdk

Instrument LLM clients and emit usage events to [Lago](https://www.getlago.com) for billing.
Authored in TypeScript, ships compiled JavaScript with `.d.ts` — works for both JS and TS consumers.

```text
                  ┌──────────────┐
your code ──────► │ wrapped client│ ──► provider (Bedrock / Mistral / …)
                  └──────┬───────┘
                         │ (extract usage)
                         ▼
                  ┌──────────────┐
                  │  Lago events │ ──► api.getlago.com
                  └──────────────┘
```

## What it does

- Wraps your existing LLM client in place — no API surface change for your application code.
- Extracts usage from each response into a normalized shape (`CanonicalUsage`).
- Buffers events in memory, flushes them in batches to Lago's `/events/batch` endpoint.
- Survives provider/Lago outages with exponential backoff and a bounded buffer.
- p99 wrap-overhead under 5 ms — your call is never blocked on Lago.

## Install

```bash
npm install @getlago/agent-sdk
# plus the provider SDK(s) you use:
npm install @aws-sdk/client-bedrock-runtime
npm install @anthropic-ai/sdk
npm install @mistralai/mistralai
npm install openai
```

## Quickstart — Bedrock

```typescript
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { LagoSDK } from "@getlago/agent-sdk";

const sdk = new LagoSDK({
  apiKey: process.env.LAGO_API_KEY!,
  defaultSubscriptionId: "sub_acme",
});
const client = sdk.wrap(new BedrockRuntimeClient({ region: "eu-west-1" }));

await client.send(new ConverseCommand({
  modelId: "eu.amazon.nova-lite-v1:0",
  messages: [{ role: "user", content: [{ text: "Hello" }] }],
}));
await sdk.flush();
```

The wrapped client behaves identically to the original — same arguments, same return shape, same exceptions. The SDK adds an in-memory queue that batches events to Lago in the background.

## Quickstart — Anthropic

```typescript
import Anthropic from "@anthropic-ai/sdk";
import { LagoSDK } from "@getlago/agent-sdk";

const sdk = new LagoSDK({ apiKey: process.env.LAGO_API_KEY!, defaultSubscriptionId: "sub_acme" });
const client = sdk.wrap(new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! }));

await client.messages.create({
  model: "claude-sonnet-4-6",
  max_tokens: 200,
  messages: [{ role: "user", content: "Hello" }],
});
await sdk.flush();
```

Both `messages.create({ ..., stream: true })` and the `messages.stream(...)` helper (with `.finalMessage()`) are instrumented automatically.

## Quickstart — Mistral

```typescript
import { Mistral } from "@mistralai/mistralai";
import { LagoSDK } from "@getlago/agent-sdk";

const sdk = new LagoSDK({ apiKey: process.env.LAGO_API_KEY!, defaultSubscriptionId: "sub_acme" });
const client = sdk.wrap(new Mistral({ apiKey: process.env.MISTRAL_API_KEY! }));

await client.chat.complete({
  model: "mistral-small-latest",
  messages: [{ role: "user", content: "Hello" }],
});
await sdk.flush();
```

## Quickstart — OpenAI

```typescript
import OpenAI from "openai";
import { LagoSDK } from "@getlago/agent-sdk";

const sdk = new LagoSDK({ apiKey: process.env.LAGO_API_KEY!, defaultSubscriptionId: "sub_acme" });
const client = sdk.wrap(new OpenAI({ apiKey: process.env.OPENAI_API_KEY! }));

await client.chat.completions.create({
  model: "gpt-4o-mini",
  messages: [{ role: "user", content: "Hello" }],
  max_completion_tokens: 200,
});
await sdk.flush();
```

Covers both **Chat Completions** (`client.chat.completions.create`) and the newer **Responses API** (`client.responses.create`), sync + streaming. For Chat Completions streaming, the wrapper auto-injects `stream_options: { include_usage: true }` so the final chunk carries usage data — without it OpenAI emits no usage on streamed responses.

**Reasoning tokens** (`llm_reasoning_tokens`) populate automatically when you call an o-series model (`o4-mini`, `o1`, etc.) — OpenAI is the first provider to expose this metric separately.

## Multi-tenant — pick a subscription per call

Three ways to set the `external_subscription_id`, in priority order:

```typescript
// 1. Per-call override — attach __lago to a Bedrock command, or pass `lago: {...}` on a Mistral call.
const cmd = new ConverseCommand({...});
(cmd as any).__lago = { subscription: "sub_acme", dimensions: { feature: "summarize" } };
await client.send(cmd);

// 2. Context-bound — uses AsyncLocalStorage; safe across `await` boundaries.
sdk.withSubscription("sub_acme", async () => {
  await client.send(...);  // bills sub_acme
});
// or at the top of a request handler:
sdk.setSubscription("sub_acme");

// 3. Default at init (fallback)
new LagoSDK({ apiKey: "...", defaultSubscriptionId: "sub_default" });
```

Backed by Node's `AsyncLocalStorage` for safe propagation across promises.

## Supported providers

| Provider | Access | Status |
|---|---|---|
| AWS Bedrock | `ConverseCommand` (sync + stream) | ✓ |
| AWS Bedrock | `InvokeModelCommand` (sync + stream), 7 model families | ✓ |
| Anthropic | `@anthropic-ai/sdk` (`messages.create` sync + stream, `messages.stream`) | ✓ |
| Mistral | `@mistralai/mistralai` (`chat.complete` + `chat.stream`) | ✓ |
| OpenAI | `openai` (`chat.completions.create` + `responses.create`, sync + async + stream) | ✓ |
| Google Gemini | native SDK | Phase 3 |
| Vercel AI SDK | `wrapLanguageModel` middleware | Phase 4 |

## Token dimensions captured

`CanonicalUsage` carries 11 numeric fields. Which ones populate depends on the provider:

| Field | Lago metric code | Bedrock | Anthropic | Mistral | OpenAI |
|---|---|---|---|---|---|
| input | `llm_input_tokens` | ✓ | ✓ | ✓ | ✓ |
| output | `llm_output_tokens` | ✓ | ✓ | ✓ | ✓ |
| cache_read | `llm_cached_input_tokens` | ✓ (Anthropic) | ✓ | ✓ (when cache hits) | ✓ (auto-cache) |
| cache_write | `llm_cache_creation_tokens` | ✓ (Anthropic) | ✓ | ✗ | ✗ (OpenAI auto-caches; no creation counts) |
| cache_write_5m / 1h | `llm_cache_write_5m/1h_tokens` | ✓ (Anthropic InvokeModel) | ✓ | ✗ | ✗ |
| reasoning | `llm_reasoning_tokens` | ✗ (folded into output) | ✗ (folded into output) | ✗ (folded into output) | **✓ (o-series models)** |
| tool_calls | `llm_tool_calls` | ✓ | ✓ | ✓ | ✓ |
| audio_input | `llm_audio_input_tokens` | ✗ | ✗ | ✗ | ✓ (GPT-4o-audio input) |
| audio_output | `llm_audio_output_tokens` | ✗ | ✗ | ✗ | ✓ (GPT-4o-audio output) |
| image_input | `llm_image_input_tokens` | ✗ | ✗ | ✗ | ✗ (Phase 3 — multimodal adapter) |

## Error policy

The SDK never breaks your LLM call. If anything in instrumentation fails (adapter bug, Lago down, network error), the SDK swallows it, logs a warning, and your call returns normally.

Wire your own observability via `onError`:

```typescript
new LagoSDK({
  apiKey: "...",
  config: {
    onError: (err, where) => Sentry.captureException(err, { tags: { sdk_phase: where } }),
  },
});
```

## Setting up Lago

The SDK ships with default metric codes (`llm_input_tokens`, `llm_output_tokens`, etc.). You need to register matching billable metrics in your Lago tenant before events count toward charges. See [Lago docs — Billable Metrics](https://docs.getlago.com/api-reference/billable-metrics/create).

## Development

```bash
git clone https://github.com/getlago/lago-agent-sdk-js
cd lago-agent-sdk-js
npm install
npm test
npm run build
```

Run live integration tests (requires real credentials):

```bash
AWS_BEARER_TOKEN_BEDROCK="..." \
MISTRAL_API_KEY="..." \
LAGO_API_URL="https://api.getlago.com/api/v1/" \
LAGO_API_KEY="..." \
LAGO_EXTERNAL_SUBSCRIPTION_ID="sub_..." \
npm test -- tests/integration
```

## Security

Found a vulnerability? See [SECURITY.md](SECURITY.md).
