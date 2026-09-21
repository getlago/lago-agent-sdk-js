# Cloudflare AI Gateway

Point any of the supported clients at your gateway instead of the provider directly — `wrap()` detects it and bills correctly, with two behaviors on top of the plain provider case:

```typescript
import Anthropic from "@anthropic-ai/sdk";
import { LagoSDK } from "lago-agent-sdk";

const sdk = new LagoSDK({ apiKey: "...", defaultSubscriptionId: "sub_acme" });
const client = sdk.wrap(
  new Anthropic({
    apiKey: "...",
    baseURL: `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/anthropic`,
    defaultHeaders: { "cf-aig-authorization": `Bearer ${gatewayAuth}` },
  }),
);
await client.messages.create({
  model: "claude-sonnet-4-6",
  max_tokens: 200,
  messages: [{ role: "user", content: "Hello" }],
});
await sdk.flush();
```

- **Gateway cache hits aren't billed.** If the gateway serves a response from its own cache (`cf-aig-cache-status: HIT`), the provider was never called, so the SDK skips emitting for that response.
- **Workers AI gets priced automatically.** Wrap an OpenAI-shaped client against the gateway's `/compat` endpoint (`model: "workers-ai/@cf/..."`) with `pricingMode: "price"`, and the SDK fetches Cloudflare's own published Workers AI rates in the background — no separate price table to maintain.

## Backfill from the Logs API

For usage that already happened, backfill straight from the gateway's own Logs API instead of replaying calls — `lago-agent-sdk/gateway/adapters` extracts a log entry into `CanonicalUsage` and bills Cloudflare's own metered `cost` for it, so there's no separate price lookup and re-running over the same window never double-bills:

```typescript
import { extractCloudflareLog, resolveSubscription } from "lago-agent-sdk/gateway/adapters";

for (const entry of await fetchGatewayLogs()) {
  // GET .../ai-gateway/gateways/{id}/logs
  const usage = extractCloudflareLog(entry);
  if (usage.extras.cached) continue; // gateway served it from cache — the provider was never called
  const sub = resolveSubscription(entry) ?? "sub_default"; // from the call's cf-aig-metadata, if set
  if (usage.extras.byok) {
    // Served with the customer's own provider key (BYOK): Cloudflare charged nothing and the
    // partner bills them directly, yet `cost` still carries Cloudflare's list price. Bill the
    // tokens, never that number.
    sdk.emit(usage, { subscription: sub, mode: "tokens", eventId: `cf_${entry.id}` });
    continue;
  }
  // Pass `cost` through as-is. Coercing an absent cost to 0 bills a $0.00 event instead
  // of falling back to token counts, which is the one outcome that loses revenue silently.
  sdk.emit(usage, { subscription: sub, mode: "price", usdCost: entry.cost, eventId: `cf_${entry.id}` });
}
await sdk.flush();
```

**Gateway-routed calls are billed at the gateway's metered cost.** Cloudflare reports its own `cost` per log entry and the backfill passes that straight through, so Lago reconciles against the dashboard you actually look at. One measured consequence to be aware of: that field excludes additive _reasoning_ tokens, so a thinking-heavy Gemini call bills about 4% of what Google charges (verified live at 22.8x on one call, 39.6x on another — the ratio tracks each prompt's thinking-to-output ratio). Cloudflare is exact on input, output, cache-read and cache-write.

## Workers AI models with no client to wrap

Cloudflare-hosted models can be reached through the OpenAI-compatible `/compat` endpoint above, but only when they are chat-shaped. Partner models are not: `typesafe/jev` takes `{state, questions}` and refuses a `messages` array, and the official `cloudflare` package cannot address any Workers AI model at all (it percent-encodes the slash in the model name). For these the SDK ships its own one-method client:

```typescript
const ai = sdk.workersAI(accountId, cfApiToken, {
  gatewayId, // optional — see what it buys below
  gatewayAuth, // the gateway's cf-aig-authorization token, if authentication is on
  subscription: "sub_acme", // default for every call; { lago: { subscription } } per call
});

// a partner model: the partner's key must be stored under the gateway's Provider Keys (BYOK)
const out = await ai.run(
  "typesafe/jev",
  {
    state: "I was charged twice and need the duplicate refunded before Friday.",
    questions: {
      department: {
        type: "choice",
        instructions: "Which team should handle this?",
        criteria: { billing: "Payments, refunds", technical: "Bugs, outages" },
      },
    },
  },
  { lago: { dimensions: { ticket: "T-4821" } } },
);
(out.result as any).result.answers.department.choice; // "billing"

// a catalog model: same client, same billing
await ai.run("@cf/meta/llama-3.2-3b-instruct", {
  messages: [{ role: "user", content: "Hello" }],
  max_tokens: 50,
});
await sdk.flush();
```

`run()` returns Cloudflare's full response envelope unchanged and rejects with `WorkersAIError` on an error status (a 402 for a partner model whose key is not stored, a 403 for a model not on your Workers plan), before anything is billed.

**What the gateway buys.** With `gateway_id` set, `@cf/...` calls go through the gateway host: a cache hit (`cf-aig-cache-status: HIT`) is not billed, and every event carries a `cf_log_id` dimension that matches the entry's `id` in the Logs API. Partner models go through the unified `api.cloudflare.com/.../ai/run` path with the gateway named in a header, which is the only route where the gateway's stored partner key is consulted; that path returns no cache header, so the client asks the gateway to skip its cache for those calls rather than risk billing a cached replay. Pass `{ extraHeaders: { "cf-aig-skip-cache": "false" } }` to opt back in.

**Billing.** Token events from the response's own `usage`: `prompt_tokens`/`completion_tokens` for catalog models, `input_tokens`/`output_tokens` for partner models. Catalog models price from Cloudflare's published Workers AI rates in price mode as usual. Partner models are not in that catalog; their rates come from AI Gateway's own cost table (`GET .../ai-gateway/costs`), fetched per model in the background the first time one is seen. Left alone, the very first call to a partner model in a process bills tokens and reports the miss via `onError`, and every call after it bills dollars; name the ids up front with `await sdk.warmPricing(["workers-ai"], { workersAiModels: ["typesafe/jev"] })` and even the first call prices. A fetched rate keeps serving past its TTL while it refreshes, so an expiry never bills a call as tokens. Jev lists input at $0.042 per million with free output, the same rate the gateway stamps as `cost` on its log entries. Under BYOK the gateway's Logs API still reports a `cost` for the partner call at Cloudflare's list price although Cloudflare charged nothing — the entry's `byok` field (surfaced in `extras.byok` by `extractCloudflareLog`) is what tells a backfill not to bill it. The id billed is the one you requested, because that is what Cloudflare's price catalog is keyed by; the name the model reports (`jev-1.13.0`, `...-24b-v2`) is kept in `extras.served_model`.

Streaming is not supported by this client; use the `/compat` endpoint through a wrapped OpenAI client for streamed chat.
