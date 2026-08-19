/**
 * Ramp Router model-id vocabulary — the one piece shared by both halves of this
 * connector.
 *
 * Deliberately a TOP-LEVEL module rather than living under `gateway/`, for the
 * boundary `gateway/index.ts` states: `adapters/` and `gateway/` never import from
 * each other. Both halves need this parser — the live wrapper to resolve what
 * actually served a `models` fallback, the backfill adapter to read the same id out
 * of a usage record — so it sits beside `canonical.ts` as a neutral peer both may
 * import, instead of being duplicated on each side or smuggled across that line.
 *
 * Router accepts exactly one of two route selectors (docs.router.com/api/request-fields):
 *
 *   model:  a single id from `GET /v1/models` — a BARE label with no vendor part
 *           ("opus-5", "gpt-5.4", "deepseek-v4-flash").
 *   models: 1-15 candidates of the form `provider:provider-model[:service-tier]`,
 *           tried in order, first success wins.
 *
 * Both the live wrapper and the backfill adapter have to turn those strings into
 * this SDK's `(provider, model)` vocabulary, and getting the split wrong mis-prices
 * rather than merely missing — hence one module, one parser, one alias table.
 *
 * THE PARSING TRAP. A candidate is not `provider:model` split on ":". Two real
 * documented forms break the naive reading:
 *
 *   fireworks:accounts/fireworks/models/deepseek-v4-flash   model part has SLASHES
 *   openai:gpt-5-mini:flex                                  a THIRD segment
 *
 * So splitting on the LAST colon makes the fireworks form's provider
 * "fireworks:accounts/fireworks/models" (a guaranteed miss), and splitting on ALL
 * colons loses the tier. The rule that holds for both: provider is everything
 * before the FIRST colon, and a trailing `:suffix` is a service tier only when the
 * suffix is in Router's own closed tier vocabulary. Anything else stays part of the
 * model id, because a model whose name happens to end in a colon-segment is a miss
 * we can recover from and a mis-split provider is not.
 */

/**
 * The `provider` AND `api` string stamped on every Ramp Router call, live or
 * backfilled.
 *
 * One constant for both fields, deliberately. `api` normally records the request
 * surface ("responses" / "chat_completions"), and overwriting it usually loses
 * information — but Router publishes no chat-completions surface at all
 * (docs.router.com/api/endpoint documents `GET /v1/models` and `POST /v1/responses`
 * and nothing else), so the surface dimension is constant for every Router call and
 * the gateway name is the only informative value it could carry.
 *
 * Exported and shared rather than written as a literal at each site: pricing keys its
 * Router catalog lookup off this exact string, so two spellings of it would be a
 * silent price miss on every call.
 *
 * It matches no vendor in pricing's VENDOR_MAP, which is the same deliberate
 * construction as `provider="databricks"`: a Router call cannot accidentally reach
 * OpenRouter and be priced as whatever vendor its model name resembles.
 */
export const RAMP_ROUTER_PROVIDER = "ramp_router";

/**
 * Router's service tiers, as documented on /guides/control-spend: "Pin one as the
 * third segment of a candidate: `openai:gpt-5-mini:flex`", with supported values
 * auto/default/flex/priority varying by provider.
 *
 * A CLOSED vocabulary is what makes the third segment safe to detect. Treating any
 * trailing colon-segment as a tier would silently truncate a model id that contains
 * one, and Router's own model namespace already proves ids are not simple slugs.
 */
export const ROUTER_SERVICE_TIERS: ReadonlySet<string> = new Set(["auto", "default", "flex", "priority"]);

export interface RouterModelId {
  /** Lowercased provider segment, or "" for the bare `model` selector form. */
  provider: string;
  /** Model id with the provider prefix and any tier suffix removed. Case preserved. */
  model: string;
  /** Lowercased service tier, or "" when none was pinned. */
  tier: string;
}

/**
 * Split a Router route selector into provider, model and service tier.
 *
 * Accepts both selector forms. A bare id ("opus-5") yields provider "" — deliberately,
 * because Router's `/v1/models` ids carry no vendor and guessing one is how a call gets
 * priced against the wrong rate card. An empty provider is an honest "unknown", and the
 * caller decides what to do with it.
 *
 * Never throws: a non-string or empty input yields all-empty, matching the defensive
 * style of the gateway adapters.
 */
export function parseRouterModelId(id: unknown): RouterModelId {
  const raw = typeof id === "string" ? id.trim() : "";
  if (!raw) return { provider: "", model: "", tier: "" };

  const firstColon = raw.indexOf(":");

  // The bare `model` selector: no provider segment at all.
  if (firstColon < 0) return { provider: "", model: raw, tier: "" };

  const provider = raw.slice(0, firstColon).toLowerCase();
  let model = raw.slice(firstColon + 1);
  let tier = "";

  // A tier is only ever the LAST segment, and only when it is one of Router's own.
  const lastColon = model.lastIndexOf(":");
  if (lastColon >= 0) {
    const suffix = model.slice(lastColon + 1).toLowerCase();
    if (suffix && ROUTER_SERVICE_TIERS.has(suffix)) {
      tier = suffix;
      model = model.slice(0, lastColon);
    }
  }

  // "openai:" with nothing after it is not a model. Report the provider and leave the
  // model empty rather than inventing one; nonzeroNumeric-style callers treat it as a miss.
  return { provider, model, tier };
}

/**
 * Router's provider vocabulary -> this SDK's.
 *
 * Same rule as the Cloudflare adapter's PROVIDER_ALIASES, and for the same reason:
 * only providers this SDK can actually price get an entry, everything else passes
 * through unchanged so the miss is honest. A miss falls back to token events, which
 * is strictly better than pricing against a vendor that never served the call.
 *
 * `google` -> `gemini` is NOT cosmetic, and is the specific bug the Cloudflare
 * connector shipped first. Pricing's VENDOR_MAP resolves both spellings to the
 * OpenRouter vendor "google", so a price would still be found — but
 * INPUT_INCLUDES_CACHE_READ is keyed on "gemini" alone, and Gemini's cache_read is a
 * SUBSET of its input count. Left as "google", the cached portion is never subtracted
 * out of `input`, so it bills once at the full prompt rate and again at the cache-read
 * rate. The alias exists to keep those two tables agreeing.
 *
 * Deliberately absent: fireworks, deepseek, xai, nvidia, kimi, glm, minimax, qwen.
 * Router serves all of them, and none is a vendor this SDK holds a rate for under that
 * name — `fireworks:accounts/fireworks/models/deepseek-v4-flash` is a Fireworks-hosted
 * DeepSeek model whose OpenRouter listing (if any) sits under "deepseek" at a different
 * rate than Fireworks charges. Mapping it would bill a real call at a rate nobody
 * quoted. Router's own catalog is the correct source for these, and where it has no
 * entry they fall back to token counts.
 */
export const ROUTER_PROVIDER_ALIASES: Record<string, string> = {
  openai: "openai",
  anthropic: "anthropic",
  mistral: "mistral",
  gemini: "gemini",
  google: "gemini",
  "google-vertex": "gemini",
  vertex: "gemini",
};

/** Map a Router provider segment onto the SDK's own provider vocabulary. */
export function normalizeRouterProvider(v: unknown): string {
  const p = typeof v === "string" ? v.toLowerCase() : "";
  return ROUTER_PROVIDER_ALIASES[p] ?? p;
}
