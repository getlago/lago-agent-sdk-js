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
  if (usage.extras.cached) continue;  // gateway served it from cache — the provider was never called
  const sub = resolveSubscription(entry) ?? "sub_default"; // from the call's cf-aig-metadata, if set
  // Pass `cost` through as-is. Coercing an absent cost to 0 bills a $0.00 event instead
  // of falling back to token counts, which is the one outcome that loses revenue silently.
  sdk.emit(usage, { subscription: sub, mode: "price", usdCost: entry.cost, eventId: `cf_${entry.id}` });
}
await sdk.flush();
```

**Gateway-routed calls are billed at the gateway's metered cost.** Cloudflare reports its own `cost` per log entry and the backfill passes that straight through, so Lago reconciles against the dashboard you actually look at. One measured consequence to be aware of: that field excludes additive *reasoning* tokens, so a thinking-heavy Gemini call bills about 4% of what Google charges (verified live at 22.8x on one call, 39.6x on another — the ratio tracks each prompt's thinking-to-output ratio). Cloudflare is exact on input, output, cache-read and cache-write.

## Databricks AI Gateway

Unlike Cloudflare, Databricks has **no unified endpoint** — each provider is reachable only through its own native surface, and two of them use the same `OpenAI` class. Which `baseURL` you point at decides how the call is priced.

**Databricks-hosted foundation models** (`system.ai.*`) — billed by Databricks in DBUs:

```typescript
import OpenAI from "openai";
import { LagoSDK } from "lago-agent-sdk";

const sdk = new LagoSDK({ apiKey: "...", defaultSubscriptionId: "sub_acme" });
const client = sdk.wrap(new OpenAI({
  apiKey: process.env.DATABRICKS_TOKEN,
  baseURL: `${process.env.DATABRICKS_HOST}/ai-gateway/mlflow/v1`,
  defaultHeaders: {
    "Databricks-Ai-Gateway-Request-Tags": JSON.stringify({ lago_subscription: "sub_acme" }),
  },
}));
await client.chat.completions.create({
  model: "system.ai.llama-4-maverick",
  messages: [{ role: "user", content: "Hi" }],
});
```

**Your own vendor key (BYOK)** — Anthropic via its native passthrough. Note `apiKey: "unused"`, because the real credential goes in `Authorization`, and the Unity Catalog connection holding your Anthropic key is named in `Databricks-Model-Provider-Service`:

```typescript
import Anthropic from "@anthropic-ai/sdk";
const client = sdk.wrap(new Anthropic({
  apiKey: "unused",
  baseURL: `${process.env.DATABRICKS_HOST}/ai-gateway/anthropic`,
  defaultHeaders: {
    Authorization: `Bearer ${process.env.DATABRICKS_TOKEN}`,
    "Databricks-Model-Provider-Service": "workspace.default.anthropickey",
  },
}));
```

OpenAI BYOK is the same `OpenAI` class as the hosted example, against `/ai-gateway/openai/v1` with its own `Databricks-Model-Provider-Service`.

### What gets billed

| Path | Live `wrap()` | Backfill |
|---|---|---|
| BYOK (OpenAI / Anthropic) | **dollar cost**, priced from the vendor's published rates | dollar cost from Databricks' own `external_model_spend` |
| Hosted (`system.ai.*`) | **token counts** | **token counts** |

BYOK prices live because you pay the vendor directly, so the vendor's rate *is* your cost — verified against Databricks' own metered spend on 38 of 38 real buckets, exactly. Hosted models bill in DBUs against a rate card published only as HTML and present in no system table, so there is no rate to look up: those calls emit token counts instead of a dollar cost. That is the complete answer for them, not a degraded one, so it is **not** reported as an error — `TOKEN_BILLED_PROVIDERS` lists the providers this applies to, and the SDK notes it once per model at info level rather than warning on every call. A genuine price miss — a cold table, an unmatched model name — still reports through `onError` as before.

**Hosted dollars exist, and are deliberately not billed from.** `system.billing.usage` × `list_prices` (or `account_prices` for your contract rate) does yield exact USD per hour and endpoint. It is not used because it comes from a *different Databricks screen* than the gateway view: it carries no `request_tags`, so per-subscription splits would be ours rather than Databricks', and it lags the gateway by roughly a day — measured at ~19h on a live workspace. Every number this connector sends is one you can find on a Databricks **gateway** page, which is the property that makes it checkable.

**Grouping matches the Databricks page.** Each backfilled event carries the grouping key of the surface it came from — `endpoint_name` for hosted, `bucket` (the hour) for BYOK. Group Lago by `endpoint_name` and you get the AI Gateway → Usage table row for row. Pass `dimensions={...}` to add your own keys; yours win on a name collision.

**Don't run the live path and the backfill over the same hosted traffic.** Both emit token events, with different `transaction_id`s, so Lago accepts both and the counts double. Pick one per traffic stream: `wrap()` for real time, the backfill for completeness.

`Databricks-Ai-Gateway-Request-Tags` is what makes attribution work. It lands in `request_tags` on `system.ai_gateway.usage` **and** is a first-class aggregation dimension on `external_model_spend`, so tagging `lago_subscription` means BYOK cost arrives already split per subscription — no apportioning needed.

### Backfill — give it a window, it does the rest

```typescript
import { DatabricksSource } from "lago-agent-sdk/gateway";

const source = DatabricksSource.fromEnv(); // DATABRICKS_HOST / _TOKEN / _WAREHOUSE_ID
console.log(await sdk.backfillDatabricks(source, "7 days", { defaultSubscription: "sub_default" }));
await sdk.flush();
// { cost: 60, tokens: 47, skipped: 0 }
```

Pass a `Date` instead of `"7 days"` for an exact lower bound, and `unified: true` to bill the whole window to `defaultSubscription` regardless of per-call tags.

The window reads **whole closed hours only**: it is floored to the hour at both ends and the current, still-aggregating hour is excluded, because `external_model_spend` is an hourly aggregate whose row for an hour does not exist until that hour closes. So the newest hour of traffic arrives on the next run — pass a window comfortably wider than your run interval, since this reader keeps no cursor.

Unlike Cloudflare's single paginated GET, this one is worth having in the SDK — hand-rolling it is ~100 lines with three money-losing traps in them. The Statement Execution API returns only **chunk 0** inline, so a wide window silently truncates and bills a fraction of it with no error. A BYOK call appears in **both** `ai_gateway.usage` and `external_model_spend`, so billing both charges twice. And `transaction_id` is unique account-wide, so an unscoped row id blocks that row from ever reaching a second subscription.

To inspect a window before billing it, or to route rows yourself, read them directly — each row is already shaped for `emit()`:

```typescript
for (const row of await source.readUsage("7 days")) {
  console.log(row.usage.model, row.subscription, row.usdCost); // usdCost is undefined for hosted
}
```

Reading the system tables needs a PAT with the **`sql`** scope plus a SQL warehouse — the live calls above need neither. The pure `extractDatabricksLog(row)` / `resolveDatabricksSubscription(row)` functions stay available from `lago-agent-sdk/gateway/adapters` if you already have rows from `@databricks/sql` or your own warehouse job.

**One cost note:** a SQL warehouse is a real cost centre. Measured on a test workspace, the warehouse queries cost roughly 1,500× the model-serving usage they were reporting on. Run the backfill as one query over a wide window, never as a tight polling loop.

### Gotchas worth knowing

- **`gpt-oss` models inflate input by ~100 tokens** from a server-injected preamble — a 2-character prompt bills 102. Not an SDK error.
- **`claude-opus-4-5` does not cache through this gateway**: reproducibly `cache_read`/`cache_write` of 0 with the full prompt billed as input, on a request shape where `claude-sonnet-4-5` caches fine. An opus customer silently gets no cache discount.
- **Hosted models report three different name strings.** `system.ai.llama-4-maverick` and `databricks-llama-4-maverick` both work as requests, and the response echoes a third (`meta-llama-4-maverick-040225`). Pricing keys off the resolved name, so reconciling by requested id will not line up.
- **Embeddings** work on `/ai-gateway/mlflow/v1/embeddings` and report input only — no `completion_tokens` at all.

## Snowflake Cortex

Snowflake serves Cortex two ways, and they need two different halves of this SDK. That split is the thing to understand before anything else here.

| Surface | How you call it | How Lago sees it |
|---|---|---|
| **Cortex REST** — `/api/v2/cortex/v1` | an OpenAI-compatible client you hand to `wrap()` | live, per call |
| **AI SQL functions** — `AI_COMPLETE`, `AI_EMBED`, … | SQL, inside the warehouse | **backfill only** — there is no client to wrap |

**Everything on this path bills as token counts.** Snowflake meters Cortex in credits against a rate card that lives in no view, so there is no per-request dollar figure to pass through and no price mode here. `provider` is `"snowflake"`, which is listed in `TOKEN_BILLED_PROVIDERS`, so a customer running `pricingMode: "price"` globally still gets token events for Snowflake rows — with no price-miss error, because a structural absence of a rate card is not a lookup failure.

### Live — the REST surface

```typescript
import OpenAI from "openai";

const client = sdk.wrap(
  new OpenAI({
    baseURL: `https://${process.env.SNOWFLAKE_ACCOUNT}.snowflakecomputing.com/api/v2/cortex/v1`,
    apiKey: process.env.SNOWFLAKE_PAT,
  }),
);
```

The `base_url` is what identifies these calls as Snowflake rather than OpenAI — an OpenAI-shaped endpoint says nothing about whose tokens they are. Use `max_completion_tokens`; Cortex rejects `max_tokens` outright.

**Cortex's `cached_tokens` is additive, the opposite of OpenAI's convention.** A cached call reports `prompt_tokens: 7`, `cached_tokens: 8745`, `completion_tokens: 6`, `total_tokens: 8758` — the cached block is *not* inside `prompt_tokens`. Caching also only happens when you send an explicit `cache_control: {type: "ephemeral"}` content part; the same prompt twice without one reports zero cached both times.

### Backfill — the SQL functions surface

```typescript
import { SnowflakeSource } from "lago-agent-sdk/gateway";

const source = SnowflakeSource.fromEnv(); // SNOWFLAKE_ACCOUNT / _PAT, plus a warehouse
console.log(await sdk.backfillSnowflake(source, "7 days", { defaultSubscription: "sub_default" }));
await sdk.flush();
// { tokens: 47, skipped: 0 }
```

Two counts, and there cannot be more: `tokens` is what got billed, `skipped` is what did not. Both causes of a skip are also reported through `onError` with `where: "backfill"`, so an automated caller notices a gap without inspecting the return value.

**It reads the functions view only.** The REST view reports the calls `wrap()` already billed above, and the two `transaction_id`s are unrelated — the live path's is a random UUID, the backfill's derives from `REQUEST_ID` — so Lago accepts both and every REST call bills twice. Pass `views: ["rest"]` only for REST traffic `wrap()` never saw:

```typescript
await sdk.backfillSnowflake(source, "7 days", {
  defaultSubscription: "sub_default",
  views: ["rest"], // ONLY if no wrapped client is billing this traffic
});
```

The window reads **whole closed hours only** — floored at both ends, with the current hour excluded, because a bucket is not complete until its hour closes and billing it early burns that row's idempotency key so the correction is rejected as a duplicate. The newest hour therefore arrives on the next run: pass a window comfortably wider than your run interval, since this reader keeps no cursor.

**Attribution comes from `QUERY_TAG`**, the only customer-injectable key on either view, and the same `lago_subscription` key Cloudflare and Databricks read from their own metadata:

```sql
ALTER SESSION SET QUERY_TAG = '{"lago_subscription": "sub_123"}';
SELECT AI_COMPLETE('claude-sonnet-4-5', 'summarize this');
```

Be deliberate about `subscriptionOrder`. The default tries `query_tag`, then `role_names`, then `user_id` — and `USER_ID` is a *numeric Snowflake identity*, which matches a Lago subscription only if you maintain that mapping yourself. Pass `subscriptionOrder: ["query_tag"]` to let an untagged row go unbilled instead: that is recoverable, and billing the wrong subscription is not.

**Grouping matches the view.** Each event carries the grouping key of the surface it came from — `function_name` + `model_name` for functions rows, `inference_region` for REST — so a `GROUP BY` on the view and the same grouping in Lago line up. `dimensions={...}` adds your own; yours win on a collision.

### A long-running query is deferred, not guessed at

`IS_COMPLETED` means "did the query finish *in this aggregation window*", and these views are hour-bucketed — Snowflake documents a query running 5:30→8:30 writing **four rows, one per hour, all sharing one `QUERY_ID`**. Two things follow. The key `{prefix}_{kind}_{sub}_{QUERY_ID}` collides across those rows, and whether each row's `METRICS` is incremental or cumulative is unmeasured. On a 3-hour query using 3,800 input tokens, summing four incremental rows bills 3,800 and summing four cumulative ones bills 9,500; billing only the last row gives 3,800 if cumulative and 900 if incremental.

So a `QUERY_ID` that yields more than one row in a window is **not billed**. It is counted in `skipped`, reported through `onError`, listed on `source.deferredRows`, and billable once the shape is settled. Guessing over-bills by 2.5× or under-bills by 76%, neither recoverable once invoiced. Every query ever observed on a real account finished inside one bucket, so this fires on a shape nobody has seen.

To inspect a window before billing it, read the rows directly — each is already shaped for `emit()`:

```typescript
for (const row of await source.readUsage("7 days")) {
  console.log(row.kind, row.usage.model, row.subscription, row.occurredAt);
}
```

### Setting up the account

Reading the views needs a PAT plus a **running warehouse**; the live calls above need neither. Four things block a first-time setup and none of them says so clearly:

- **Model access moved to RBAC.** `CORTEX_MODELS_ALLOWLIST` is deprecated and accepts only `'NONE'`; you need `GRANT APPLICATION ROLE SNOWFLAKE."CORTEX-MODEL-ROLE-ALL" TO ROLE …`, without which the role can call zero models.
- **A PAT's `ROLE_RESTRICTION` is a quoted string literal**, so it is case-sensitive — `'LAGO_CORTEX_ROLE'`, not the lowercase spelling that works everywhere else.
- **A warehouse with `AUTO_RESUME = FALSE`** fails every statement with "warehouse is suspended", which reads like a privilege error.
- **A PAT cannot authenticate without an active network policy.** Prefer reusing a broad one: recovering from an IP lockout needs Snowflake Support, with no self-service path back.

Error code `003001` has four distinct causes — account entitlement, unknown model, model not granted to the role, and a bare fine-tuned model name — so it is not diagnostic on its own.

**One cost note:** a SQL warehouse is a real cost centre. Measured on the equivalent Databricks setup, warehouse queries cost roughly 1,500× the model-serving usage they reported on. Run the backfill as one query over a wide window, never as a tight polling loop.

The pure `extractSnowflakeFunctionsLog(row)` / `extractSnowflakeRestLog(row)` / `resolveSnowflakeSubscription(row)` functions stay available from `lago-agent-sdk/gateway/adapters` if you already have rows from your own warehouse job.

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

| `where` | What happened |
| --- | --- |
| `adapter.<provider>` | The provider's response could not be parsed — its usage shape changed. Nothing was billed for that call. |
| `wrapper.<provider>` | Interception itself failed, so the call went uninstrumented. |
| `emit` / `pricing` / `timestamp` | The usage was read, but the event could not be built or priced. |
| `send_batch` / `overflow` / `shutdown_drain` | Delivery: a batch failed, the buffer is full, or events were still owed at exit. |
| `queue_loop` | The background delivery loop died. Events stop being delivered; the buffer will start reporting overflow on top. |

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
