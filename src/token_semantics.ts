/**
 * Token-count conventions per provider — the single source of truth.
 *
 * Providers disagree about whether a subset count (cached tokens, reasoning tokens) is
 * reported INSIDE its parent count or beside it. OpenAI reports `cached_tokens` inside
 * `prompt_tokens`; Anthropic reports `cache_read_input_tokens` outside `input_tokens`.
 * The wire shape says nothing about which convention is in play — Snowflake Cortex
 * answers on a byte-for-byte OpenAI wire with Anthropic's additive convention (measured
 * live 2026-08-25: prompt 7, cached 4805, completion 6, total 4818) — so the convention
 * can only be KEYED, never inferred from a payload. Two payload-only inference gates
 * were tried and both were shown unsound on real shapes (see PR #38 review); do not
 * reintroduce one.
 *
 * Three places have to answer the same question, and this module exists so they cannot
 * answer it differently:
 *
 *   - `adapters/openai_native.extractOpenAINative` — deciding which reported counts sit
 *     inside `total_tokens` when reconciling it,
 *   - `pricing.computeCost` — deciding which subsets to move out of their parent before
 *     pricing each field,
 *   - `pricing.deoverlappedTokenTotal` — deciding which subsets to drop from the
 *     single-event token total.
 *
 * The two failure directions are not symmetric and both have happened here: treat a
 * subtractive surface as additive and real tokens are silently never billed; treat an
 * additive surface as subtractive and the same tokens bill twice (measured at 1.570x,
 * 2.0x, and 6.15x on three different providers). Entries are added on MEASUREMENT of a
 * real payload, never on the wire shape or vendor documentation alone.
 */

// Providers whose reported `input` token count ALREADY includes the cached
// (`cache_read`) tokens — i.e. cache_read is a subset of input, not additive. For
// these, the cached portion must be billed at the cache-read rate, not the full prompt
// rate, so computeCost moves it out of `input`.
//
//   openai, gemini    — cache_read is INSIDE input (`prompt_tokens_details.cached_tokens`)
//   anthropic         — cache_read/cache_write are ADDITIVE to input, hence absent
//   workers-ai        — only ever reached through Cloudflare's OpenAI-COMPATIBLE
//                       endpoint, so the payload is the OpenAI shape and the OpenAI
//                       semantics apply on BOTH axes: `cached_tokens` inside
//                       `prompt_tokens`, and `reasoning_tokens` inside
//                       `completion_tokens`. It is a separate provider only because it
//                       prices against Cloudflare's catalog (see inferProvider in
//                       adapters/openai_native.ts).
//   mistral           — OpenAI-shaped API reporting `prompt_tokens_details.cached_tokens`
//                       as a SUBSET of `prompt_tokens`. Mistral's own documented example
//                       settles it: prompt=1013, cached=1008, total=1043 = prompt +
//                       completion, which only reconciles if the cached tokens sit inside
//                       the prompt count. Omitting it over-billed that payload by 6.15x,
//                       and 13 of 18 Mistral models on OpenRouter publish a cache-read
//                       rate, so the wrong path was reachable for most of them —
//                       including Mistral routed through a Cloudflare gateway, since the
//                       gateway adapter leaves provider="mistral" as-is.
//   snowflake         — deliberately ABSENT even though Cortex answers on an OpenAI-WIRE
//                       endpoint: measured live 2026-08-25, prompt_tokens 7 /
//                       cached_tokens 4805 / completion_tokens 6 / total_tokens 4818 —
//                       the cached block sits OUTSIDE prompt_tokens and INSIDE the
//                       total, Anthropic's additive convention on OpenAI's wire.
//                       Measured for the Claude family, the only family on that surface
//                       that caches at all today: llama accepts `cache_control` and
//                       ignores it (cached_tokens 0 on a matched pair, total = prompt +
//                       completion, measured 2026-08-27), and the OpenAI family needs
//                       cross-region inference the capture account cannot enable —
//                       re-verify the day an OpenAI-family model becomes reachable,
//                       since Cortex documents its caching behaviour per model family.
export const INPUT_INCLUDES_CACHE_READ = new Set(["openai", "gemini", "workers-ai", "mistral"]);

// Providers whose reported `input` token count ALREADY includes the cache-WRITE tokens.
// OpenAI is measured: a live gpt-5.6-sol response carries prompt_tokens=3025 with
// prompt_tokens_details.cache_write_tokens=3022, and Databricks' metered spend for that
// call matched billing all 3025 at the plain input rate — the write sits inside the
// prompt count (OpenAI's own docs now say the same: weighted input = ordinary + cached +
// cache-write portions). That is also why the field is deliberately NOT mapped to
// CanonicalUsage.cache_write — billing it separately over-charged 2.24x (see
// adapters/openai_native.ts).
//
// The other three subset-cache providers are carried here on the SHAPE argument that
// earned "workers-ai" its cache_read entry: their surfaces re-report usage in the
// OpenAI shape, where every prompt_tokens_details member is a subset of prompt_tokens.
// None of the three emits the key today (Gemini and Mistral have no cache_write concept
// on these wires), so for them membership decides only what the total_tokens guard does
// if the key ever appears — and for a subset-convention surface the guard must stay
// live (a genuine remainder still folds), which membership preserves. Snowflake is
// absent: cache_write_tokens exists on its wire (a key OpenAI never sends) and was 0 in
// every capture including cache-creation calls — creation reports under cached_tokens
// there.
export const INPUT_INCLUDES_CACHE_WRITE = new Set(["openai", "gemini", "workers-ai", "mistral"]);

// Providers whose reported `output` token count ALREADY includes the reasoning tokens
// (reasoning is a subset of output). For these, reasoning is billed as part of output
// and must NOT be billed again separately. (Gemini's `thoughts` are additive to output,
// so it's absent here.)
//
// Workers AI's membership is latent, not live: measured against the real gateway,
// `/compat` returns `completion_tokens_details: null` even for reasoning models
// (gpt-oss-120b, deepseek-r1-distill-qwen-32b, qwq-32b), and Cloudflare's catalog
// publishes no per-M-reasoning-tokens unit. It is here because the day either changes,
// the overlap has to already be known — and because the Python port
// (OUTPUT_INCLUDES_REASONING) has carried it since the same review, and the two repos
// reporting different token quantities for one call is its own bug.
//
// "snowflake" absence is a measured no-op rather than an open question:
// `reasoning_tokens` is always 0 on Cortex's OpenAI-compat wire (reasoning_effort is
// accepted and ignored; extended thinking exists only on Cortex's Anthropic wire, which
// this adapter never serves). Re-measure if that wire ever starts reporting it.
export const OUTPUT_INCLUDES_REASONING = new Set(["openai", "workers-ai"]);

// Gateway SURFACES that re-report every vendor's usage in the OpenAI shape: `input`
// already contains cache_read AND cache_write, and `output` already contains reasoning,
// no matter which vendor actually served the call.
//
// Keys on `CanonicalUsage.api` rather than the provider because on a gateway it is the
// SURFACE that decides the shape, and a surface row reuses the live vendor names. A
// provider="anthropic" row read from Databricks' system table needs the correction; a
// provider="anthropic" response from Anthropic's own API must NOT get it. The vendor
// name cannot tell those two apart, so it is the wrong key — unlike "workers-ai" above,
// which names a vendor reachable through exactly one surface and so works as a provider.
//
// Measured on `system.ai_gateway.usage`, 246 rows across 6 vendors: `total_tokens ==
// input + output` for EVERY vendor group, with cache_read and cache_write inside input
// and reasoning inside output. Anthropic's own API reports the exact opposite
// (cache_read=3962 against input=9, additive), which is why keying on the vendor
// over-billed a real backfill 1.570x — 48,798 tokens reported against 31,091 consumed,
// the excess being exactly cache_read + cache_write.
//
// Cloudflare AI Gateway is deliberately ABSENT: its logs preserve each vendor's native
// shape instead of normalising them. A real Anthropic entry there reads input=10,
// output=4, total=14 with input_cached_tokens=3429 sitting OUTSIDE that total —
// additive, exactly like the native API — so the provider-keyed sets are already right
// for it and adding it here would UNDER-bill the cached portion.
//
// Neither Snowflake Cortex surface qualifies, established from real rows in INT-224 and
// left out on purpose. The REST view is additive: `TOKENS` equals the sum of every
// `TOKENS_GRANULAR` value on 24 of 24 captured rows, so `input` EXCLUDES the cached
// block (`rest_cache_read.json`, and the wire agrees — see INPUT_INCLUDES_CACHE_READ
// above). It also spells its cache keys `cache_read_input` / `cache_write_input`, which
// no other surface in this tree uses. The functions view reports no cache keys at all.
// Adding either would drop a cached row from 4,698 tokens to 14; INT-221's
// reconciliation test asserts the sum against Snowflake's own TOKENS column and fails if
// someone does.
export const OPENAI_SHAPED_APIS = new Set(["databricks_gateway"]);

// Every provider name the SDK's own code can stamp on a CanonicalUsage, so that absence
// from the sets above is always a recorded DECISION and never a default nobody made.
// The convention for a name not in any set is "everything additive" — correct for
// Anthropic-style reporters and for gateway vendors whose logs preserve the native
// shape, and the conservative direction for an unknown (it can over-count a subset into
// the total but never silently drop generated tokens). token_semantics.test.ts pins
// this list against the stamps in the adapters and wrappers; when adding a provider,
// add it here IN THE SAME CHANGE as its (measured) set entries, per the recipe in
// CONTRIBUTING.md.
//
// The bedrock_* names are the vendor spellings providerFromModel can emit for Bedrock
// model ids. Bedrock reports cache counts ADDITIVELY for every vendor it hosts (its
// `inputTokens` excludes `cacheRead/WriteInputTokens`), and today only its Anthropic
// and Nova families cache at all — both stamped with names absent from the subset sets,
// so the additive default is the measured answer. If Bedrock ever enables caching for a
// vendor whose name IS in a subset set ("openai" via gpt-oss, "mistral"), the bedrock
// adapters must start stamping a surface-distinct api the way databricks_gateway does —
// the vendor name alone would answer wrongly there.
export const KNOWN_PROVIDERS = new Set([
  // adapters/, by inference or wrapper hint
  "openai",
  "workers-ai",
  "anthropic",
  "gemini",
  "mistral",
  "databricks",
  "snowflake",
  // adapters/bedrock_*, from providerFromModel
  "amazon",
  "meta",
  "cohere",
  "qwen",
  "google",
  "minimax",
  "nvidia",
  "zai",
  "bedrock",
]);

/**
 * Which of a record's subsets are ALREADY inside their parent count.
 *
 * Returns `[inputIncludesCacheRead, inputIncludesCacheWrite, outputIncludesReasoning]`,
 * the three overlaps the billing paths have to remove and the total_tokens guard has to
 * leave alone. The SURFACE wins over the vendor: a gateway that re-reports usage in its
 * own shape has already decided the convention, so `api` is checked first and the
 * provider-keyed sets only answer for a native call.
 */
export function tokenSemantics(provider: string, api: string): [boolean, boolean, boolean] {
  const p = (provider || "").toLowerCase();
  const shaped = OPENAI_SHAPED_APIS.has((api || "").toLowerCase());
  return [
    shaped || INPUT_INCLUDES_CACHE_READ.has(p),
    shaped || INPUT_INCLUDES_CACHE_WRITE.has(p),
    shaped || OUTPUT_INCLUDES_REASONING.has(p),
  ];
}
