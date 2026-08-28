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

await client.send(
  new ConverseCommand({
    modelId: "eu.amazon.nova-lite-v1:0",
    messages: [{ role: "user", content: [{ text: "Hello" }] }],
  }),
);
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

Every provider is covered sync + streaming (async where the provider SDK offers it). The full coverage matrix, the token fields each provider populates, and the per-provider quirks that affect billing (cache/reasoning overlap semantics, OpenAI's `stream_options` auto-inject, Gemini's additive `thoughtsTokenCount`) live in [docs/providers.md](docs/providers.md).

## Gateways

`wrap()` also detects a client pointed at a gateway and bills what the gateway actually did — each guide covers backfill, attribution and the measured billing caveats for that gateway.

### Cloudflare AI Gateway

Point any supported client at your gateway URL; cache hits (`cf-aig-cache-status: HIT`) are not billed, and Workers AI models get priced automatically from Cloudflare's published rates.

```typescript
const client = sdk.wrap(
  new Anthropic({
    apiKey: "...",
    baseURL: `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/anthropic`,
    defaultHeaders: { "cf-aig-authorization": `Bearer ${gatewayAuth}` },
  }),
);
```

Full guide, including backfill from the gateway's Logs API: [docs/cloudflare.md](docs/cloudflare.md).

### Databricks AI Gateway

BYOK calls bill dollar cost at the vendor's rates; Databricks-hosted models (`system.ai.*`) bill token counts, and `sdk.backfillDatabricks(source, "7 days")` fills in what `wrap()` didn't see.

```typescript
const client = sdk.wrap(
  new OpenAI({
    apiKey: process.env.DATABRICKS_TOKEN,
    baseURL: `${process.env.DATABRICKS_HOST}/ai-gateway/mlflow/v1`,
    defaultHeaders: {
      "Databricks-Ai-Gateway-Request-Tags": JSON.stringify({ lago_subscription: "sub_acme" }),
    },
  }),
);
```

Full guide, including BYOK setup, backfill and gotchas: [docs/databricks.md](docs/databricks.md).

### Snowflake Cortex

The Cortex REST surface wraps like any OpenAI-compatible client; the AI SQL functions (`AI_COMPLETE`, …) have no client to wrap and are backfilled from Snowflake's usage views. Everything bills as token counts.

```typescript
const client = sdk.wrap(
  new OpenAI({
    baseURL: `https://${process.env.SNOWFLAKE_ACCOUNT}.snowflakecomputing.com/api/v2/cortex/v1`,
    apiKey: process.env.SNOWFLAKE_PAT,
  }),
);

await sdk.backfillSnowflake(SnowflakeSource.fromEnv(), "7 days", { defaultSubscription: "sub_default" });
```

Full guide, including cache semantics, dedup, attribution via `QUERY_TAG` and account setup: [docs/snowflake.md](docs/snowflake.md).

### Ramp Router

An OpenAI-Responses-compatible gateway in front of OpenAI, Anthropic, Google Vertex, Fireworks and xAI. The model that answered is the one billed — Router can serve a different model than the one requested.

```typescript
const client = sdk.wrap(
  new OpenAI({ apiKey: process.env.RAMP_ROUTER_API_KEY!, baseURL: "https://api.router.com/v1" }),
  { subscription: "sub_acme" },
);
await client.responses.create({ model: process.env.RAMP_ROUTER_MODEL!, input: "Summarize this invoice." });
```

Full guide, including why price mode falls back to token events for Router traffic: [docs/ramp-router.md](docs/ramp-router.md).

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
// The subscription is captured when the CALL is made, so the result can leave the
// scope — a stream returned from a helper and iterated by the caller still bills
// sub_acme.
const stream = await sdk.withSubscription("sub_acme", () => client.chat.completions.create({ ..., stream: true }));
for await (const chunk of stream) { /* still bills sub_acme */ }
// or at the top of a request handler:
sdk.setSubscription("sub_acme");

// 3. Default at init (fallback)
new LagoSDK({ apiKey: "...", defaultSubscriptionId: "sub_default" });
```

Backed by Node's `AsyncLocalStorage` for safe propagation across promises.

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
```

Price mode emits one `llm_cost` event per priced field (input, output, cache, ...), each carrying `precise_total_amount_cents` for Lago's **dynamic charge model** plus a `token_type` property so a single billable metric can be grouped by both `model` and `token_type`. Prices come from public sources (OpenRouter for native providers, the AWS Bedrock price list for Bedrock), fetched and cached in the background — your LLM call is never blocked on pricing. If a price isn't available yet, the SDK falls back to token-count events and reports via `onError` rather than under-billing. Per-call override: `lago: { mode: "price", markup: 1.5 }` (Bedrock: the command's `__lago`).

## Error policy

The SDK never breaks your LLM call. If anything in instrumentation fails (adapter bug, Lago down, network error), your call returns normally — and the failure is reported through `onError` and logged, so it never passes in silence. Wire your own observability there:

```typescript
new LagoSDK({
  apiKey: "...",
  config: {
    onError: (err, where) => Sentry.captureException(err, { tags: { sdk_phase: where } }),
  },
});
```

`where` names the stage, so you can tell the failures apart:

| `where`                                      | What happened                                                                                                    |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `adapter.<provider>`                         | The provider's response could not be parsed — its usage shape changed. Nothing was billed for that call.         |
| `wrapper.<provider>`                         | Interception itself failed, so the call went uninstrumented.                                                     |
| `emit` / `pricing` / `timestamp`             | The usage was read, but the event could not be built or priced.                                                  |
| `send_batch` / `overflow` / `shutdown_drain` | Delivery: a batch failed, the buffer is full, or events were still owed at exit.                                 |
| `queue_loop`                                 | The background delivery loop died. Events stop being delivered; the buffer will start reporting overflow on top. |

A drifted provider is the one to alert on: it bills nothing for that provider until it is fixed, and it looks like silence rather than an error anywhere else.

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

## Security

Found a vulnerability? See [SECURITY.md](SECURITY.md).
