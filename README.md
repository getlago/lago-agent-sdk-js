# lago-agent-sdk

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
npm install lago-agent-sdk
# plus the provider SDK(s) you use:
npm install @aws-sdk/client-bedrock-runtime
npm install @anthropic-ai/sdk
npm install @mistralai/mistralai
npm install openai
npm install @google/genai
```

## Quickstart — Bedrock

```typescript
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { LagoSDK } from "lago-agent-sdk";

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
import { LagoSDK } from "lago-agent-sdk";

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
import { LagoSDK } from "lago-agent-sdk";

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
import { LagoSDK } from "lago-agent-sdk";

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

## Quickstart — Gemini

```typescript
import { GoogleGenAI } from "@google/genai";
import { LagoSDK } from "lago-agent-sdk";

const sdk = new LagoSDK({ apiKey: process.env.LAGO_API_KEY!, defaultSubscriptionId: "sub_acme" });
const client = sdk.wrap(new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! }));

await client.models.generateContent({
  model: "gemini-2.5-flash",
  contents: "Hello",
});
await sdk.flush();
```

Wraps the modern `@google/genai` SDK. Covers `client.models.generateContent` + `generateContentStream`, sync + streaming. Reads usage from `response.usageMetadata` (both camelCase and snake_case forms supported).

**Reasoning tokens** populate automatically on Gemini 2.5 — the model reasons internally by default and surfaces `thoughtsTokenCount` (see the note on reasoning semantics below).

## Cloudflare AI Gateway

Point any of the clients above at your gateway instead of the provider directly — `wrap()` detects it and bills correctly, with two behaviors on top of the plain provider case:

```typescript
import Anthropic from "@anthropic-ai/sdk";
import { LagoSDK } from "lago-agent-sdk";

const sdk = new LagoSDK({ apiKey: "...", defaultSubscriptionId: "sub_acme" });
const client = sdk.wrap(new Anthropic({
  apiKey: "...",
  baseURL: `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/anthropic`,
  defaultHeaders: { "cf-aig-authorization": `Bearer ${gatewayAuth}` },
}));
await client.messages.create({ model: "claude-sonnet-4-6", max_tokens: 200, messages: [{ role: "user", content: "Hello" }] });
await sdk.flush();
```

- **Gateway cache hits aren't billed.** If the gateway serves a response from its own cache (`cf-aig-cache-status: HIT`), the provider was never called, so the SDK skips emitting for that response.
- **Workers AI gets priced automatically.** Wrap an OpenAI-shaped client against the gateway's `/compat` endpoint (`model: "workers-ai/@cf/..."`) with `pricingMode: "price"`, and the SDK fetches Cloudflare's own published Workers AI rates in the background — no separate price table to maintain.

For usage that already happened, backfill straight from the gateway's own Logs API instead of replaying calls — `lago-agent-sdk/gateway/adapters` extracts a log entry into `CanonicalUsage` and bills Cloudflare's own metered `cost` for it, so there's no separate price lookup and re-running over the same window never double-bills:

```typescript
import { extractCloudflareLog, resolveSubscription } from "lago-agent-sdk/gateway/adapters";

for (const entry of await fetchGatewayLogs()) {  // GET .../ai-gateway/gateways/{id}/logs
  const usage = extractCloudflareLog(entry);
  const sub = resolveSubscription(entry) ?? "sub_default"; // from the call's cf-aig-metadata, if set
  sdk.emit(usage, { subscription: sub, mode: "price", usdCost: entry.cost ?? 0, eventId: `cf_${entry.id}` });
}
await sdk.flush();
```

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
| Google Gemini | `@google/genai` (`models.generateContent` + `generateContentStream`, sync + stream) | ✓ |

## Token dimensions captured

`CanonicalUsage` carries 11 numeric fields. Which ones populate depends on the provider:

| Field | Lago metric code | Bedrock | Anthropic | Mistral | OpenAI | Gemini |
|---|---|---|---|---|---|---|
| input | `llm_input_tokens` | ✓ | ✓ | ✓ | ✓ | ✓ |
| output | `llm_output_tokens` | ✓ | ✓ | ✓ | ✓ | ✓ |
| cache_read | `llm_cached_input_tokens` | ✓ (Anthropic) | ✓ | ✓ (when cache hits) | ✓ (auto-cache) | ✓ (CachedContent API) |
| cache_write | `llm_cache_creation_tokens` | ✓ (Anthropic) | ✓ | ✗ | ✗ | ✗ |
| cache_write_5m / 1h | `llm_cache_write_5m/1h_tokens` | ✓ (Anthropic InvokeModel) | ✓ | ✗ | ✗ | ✗ |
| reasoning | `llm_reasoning_tokens` | ✗ (folded into output) | ✗ (folded into output) | ✗ (folded into output) | **✓ (o-series, subset)** | **✓ (Gemini 2.5, additive)** |
| tool_calls | `llm_tool_calls` | ✓ | ✓ | ✓ | ✓ | ✓ |
| audio_input | `llm_audio_input_tokens` | ✗ | ✗ | ✗ | ✓ (GPT-4o-audio) | ✓ (multimodal AUDIO) |
| audio_output | `llm_audio_output_tokens` | ✗ | ✗ | ✗ | ✓ (GPT-4o-audio) | ✓ (multimodal AUDIO) |
| image_input | `llm_image_input_tokens` | ✗ | ✗ | ✗ | ✗ | ✓ (multimodal IMAGE) |

**Reasoning:** OpenAI's `reasoning_tokens` is a *subset* of `output` (already counted in `completion_tokens`). Gemini's `thoughtsTokenCount` is *additive* to `output` (`candidates + thoughts = total billable output`).

**Cache/audio/image on OpenAI and Gemini are subsets of `input`, not additive.** Both providers count cached/audio/image tokens *within* their input total, so summing `llm_input_tokens + llm_cached_input_tokens` (or `+ audio/image`) double-counts. Bill on `llm_input_tokens` alone; use the breakdown fields only for cost attribution (e.g. a discounted cache rate).

## Pricing mode — send dollar cost instead of tokens

By default the SDK emits **token counts** (`pricingMode: "tokens"`). Set `pricingMode: "price"` to instead emit the **dollar cost** of each call: `Σ(unit_price_per_token × tokens) × markup`.

```typescript
const sdk = new LagoSDK({
  apiKey: "...",
  defaultSubscriptionId: "sub_123",
  config: {
    pricingMode: "price", // "tokens" (default) | "price"
    markup: 1.2, // optional cost multiplier (1.2 = +20%)
  },
});
const client = sdk.wrap(anthropicClient);
```

Price mode emits one `llm_cost` event per priced field (input, output, cache, ...), each carrying `precise_total_amount_cents` for Lago's **dynamic charge model** plus a `token_type` property so a single billable metric can be grouped by both `model` and `token_type`. Prices come from public sources (OpenRouter for native providers, the AWS Bedrock price list for Bedrock), fetched and cached in the background — your LLM call is never blocked on pricing. If a price isn't available yet, the SDK falls back to token-count events and reports via `onError` rather than under-billing.

Per-call override via the inline `lago` option (Bedrock: the command's `__lago`):

```typescript
await client.messages.create({
  model: "claude-...",
  messages: [...],
  lago: { mode: "price", markup: 1.5 },
} as any);
```

## Error policy

The SDK never breaks your LLM call. If anything in instrumentation fails (adapter bug, Lago down, network error), it's swallowed, logged, and your call returns normally. Wire your own observability via `onError`:

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
