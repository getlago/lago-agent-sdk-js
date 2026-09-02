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
  // Pass `cost` through as-is. Coercing an absent cost to 0 bills a $0.00 event instead
  // of falling back to token counts, which is the one outcome that loses revenue silently.
  sdk.emit(usage, { subscription: sub, mode: "price", usdCost: entry.cost, eventId: `cf_${entry.id}` });
}
await sdk.flush();
```

**Gateway-routed calls are billed at the gateway's metered cost.** Cloudflare reports its own `cost` per log entry and the backfill passes that straight through, so Lago reconciles against the dashboard you actually look at. One measured consequence to be aware of: that field excludes additive _reasoning_ tokens, so a thinking-heavy Gemini call bills about 4% of what Google charges (verified live at 22.8x on one call, 39.6x on another — the ratio tracks each prompt's thinking-to-output ratio). Cloudflare is exact on input, output, cache-read and cache-write.
