/**
 * Pricing — optional dollar-cost computation for price mode.
 *
 * Fetches live, public, no-auth per-token unit prices and computes the cost of a
 * call as `Σ(unit_price × token_count) × markup`.
 *
 * Sources:
 *   - OpenRouter, for native providers (anthropic / openai / mistral / gemini).
 *   - AWS Bedrock Price List Bulk API, for Bedrock.
 *   - Cloudflare's model catalog, for "workers-ai" — the rate the gateway actually bills
 *     at, which is NOT a third party's price for the same open-weight model. Needs an
 *     account id + token; without both, the source is empty.
 *   - Mistral's /v1/models, for ALIAS RESOLUTION, not pricing: Mistral publishes no
 *     per-token table and never resolves a moving alias ("mistral-small-latest") in its
 *     response, so the OpenRouter lookup misses even though OpenRouter lists the
 *     resolved id. Needs the customer's own Mistral key.
 *   - Ramp Router's own `GET /v1/models`, for "ramp_router" — like Cloudflare's catalog,
 *     the rate the gateway actually bills at (measured exact against a live account's
 *     dashboard export across five served vendors), and like Cloudflare's it is
 *     account-scoped and needs the customer's Router key. The key is learned from the
 *     wrapped client at `wrap()` time, or set via `LagoConfig.rampRouterApiKey`; without
 *     either the source is simply empty.
 *
 * `lookup()` is pure in-memory and O(1) — the customer's call is never blocked on
 * pricing. ALL HTTP happens in `maybeRefresh()`, on the queue's background loop. A cold
 * or missing table returns null and the caller falls back to token events; it must never
 * bill zero.
 *
 * Money is fixed-point BigInt scaled by 1e12, floored to 12dp — byte-identical to the
 * Python port's Decimal path, which `money_golden.json` pins in both repos.
 */

import { tokenSemantics } from "./token_semantics.js";

export const OPENROUTER_URL = "https://openrouter.ai/api/v1/models";
export const AWS_PRICING_HOST = "https://pricing.us-east-1.amazonaws.com";
export const AWS_BEDROCK_REGION_INDEX = `${AWS_PRICING_HOST}/offers/v1.0/aws/AmazonBedrock/current/region_index.json`;
export const cloudflareModelsUrl = (accountId: string): string =>
  `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/models/search`;
// AI Gateway's own price list — every provider the gateway fronts, including the partner
// models Workers AI serves under a bare `vendor/model` id (`typesafe/jev`), which the
// `/ai/models/search` catalog above does not list at all. Measured 2026-09-21: 2,839 rows,
// `per_page` capped at 100, `search=` filters by model id; the `typesafe/jev` row is
// `token_pricing: {input_tokens: 0.042, input_cached_tokens: 0, output_tokens: 0}` (USD per
// 1M) and 446 x 0.042e-6 is exactly the `cost` the gateway stamped on that call's log entry.
const cloudflareGatewayCostsUrl = (accountId: string) =>
  `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai-gateway/costs`;
// `token_pricing` keys on an `ai-gateway/costs` row → ModelPrice fields (USD per 1M tokens).
// The sibling `cost_in` / `cost_out` per-token fields are NOT used: on the same row they are
// frequently 0 where `token_pricing` is not (typesafe/jev, every Fireworks entry), and the
// gateway's own `cost` on a log entry reconciles against `token_pricing`, not against them.
const CF_COSTS_FIELD_MAP: Record<string, PricedField> = {
  input_tokens: "input",
  output_tokens: "output",
  input_cached_tokens: "cache_read",
  input_cache_creation_tokens: "cache_write",
};
export const MISTRAL_MODELS_URL = "https://api.mistral.ai/v1/models";
export const RAMP_ROUTER_MODELS_URL = "https://api.router.com/v1/models";

// A failed pricing fetch must not be retried on every tick. `maybeRefresh()` runs once
// per queue flush (1s by default) and each attempt can burn the full 10s HTTP timeout,
// so an unreachable endpoint or a rotated credential would otherwise retry forever at
// the speed of its own timeout, with nothing to show for it. Per source: 1s, 2s, 4s …
// to a 60s ceiling — the same shape and ceiling as the event queue's send backoff —
// cleared on that source's next success.
const FETCH_RETRY_BASE_MS = 1_000;
const FETCH_RETRY_MAX_MS = 60_000;

export const PRICED_FIELDS = ["input", "output", "cache_read", "cache_write", "reasoning"] as const;
export type PricedField = (typeof PRICED_FIELDS)[number];

// The subset-vs-additive convention sets (INPUT_INCLUDES_CACHE_READ and friends) used
// to live here. They moved to token_semantics.ts the day the total_tokens guard in
// adapters/openai_native.ts needed the same answers: the guard, the cost split and the
// token total are three readings of one convention, and keeping the sets in this module
// would have forced the adapter layer to import pricing's HTTP machinery to reach them.

// Providers this SDK bills as TOKEN COUNTS by design, even in price mode — because no
// per-token rate for them exists anywhere the SDK could read it.
//
// "databricks" means a Databricks-HOSTED foundation model (`system.ai.*`). Databricks
// bills those in DBUs at a per-model rate published only as an HTML page — verified
// absent from every column of all 88 system tables — so there is nothing to look up now
// and nothing a later refresh could supply. Token counts are the honest, complete answer
// for them, not a degraded one.
//
// This is a deliberate, NARROW exception to "a price miss is reported via onError". It
// applies only where the miss is *structural and permanent*. A cold table, an unmatched
// model name, a mistyped provider — all still report, because those are genuine misses a
// customer can act on. Reporting this one on every call would be a permanent false
// alarm, and an alarm that always fires is one nobody reads.
//
// Note this keys on the PROVIDER, so it only ever covers Databricks-hosted models: BYOK
// traffic through the same gateway is stamped "openai"/"anthropic" and prices normally
// (verified exact against Databricks' own metered spend, 38 of 38 buckets).
// "snowflake" means Snowflake Cortex, on either surface. Snowflake bills Cortex in
// CREDITS, at a per-credit rate that depends on edition, region and contract and is
// published in no API, no view and no account-level table the SDK could read — and the
// credit consumption tables that do exist are warehouse-level, not per-request. So there
// is no per-token rate to find now and no later refresh that could supply one. Token
// counts are what we bill; customers price them with their own Lago charges.
//
// Deliberately NOT in VENDOR_MAP, and this is the load-bearing half: Cortex serves
// `claude-sonnet-4-5` and `openai-gpt-5` under those very names, so giving "snowflake" a
// real vendor prefix would let a near-miss model string match Anthropic's or OpenAI's own
// OpenRouter rate — a silent mispricing of a call Snowflake charged in credits. The
// absence is the guard; do not "fix" it.
//
// "ramp_router" was here until its catalog became a price source (see the Ramp Router
// section below). Its miss is no longer structural: a Router call that cannot be priced
// now reports through onError like any other provider's, because the customer CAN act
// on it — a missing Router key, a cold table, or a non-default service tier.
export const TOKEN_BILLED_PROVIDERS: ReadonlySet<string> = new Set(["databricks", "snowflake"]);

const OPENROUTER_FIELD_MAP: Record<PricedField, string> = {
  input: "prompt",
  output: "completion",
  cache_read: "input_cache_read",
  cache_write: "input_cache_write",
  reasoning: "internal_reasoning",
};

const VENDOR_MAP: Record<string, string> = {
  anthropic: "anthropic",
  openai: "openai",
  mistral: "mistralai",
  gemini: "google",
  google: "google",
};

// Cloudflare's catalog price unit -> canonical field. Real, surveyed units
// also include "per 1k characters", "per step", "per 512 by 512 tile", "per
// audio minute (websocket)", "per audio minute", "per inference request" —
// none of those are token-based, so they're deliberately absent: a model
// priced only in those units yields a ModelPrice with no input/output/
// cache_read at all, which computeCost already treats as "unpriced field,
// skip it" — the same safe behavior as any other model with no usable price.
const CLOUDFLARE_UNIT_FIELD_MAP: Record<string, PricedField> = {
  "per M input tokens": "input",
  "per M output tokens": "output",
  "per M cached input tokens": "cache_read",
};

// The routing prefix the gateway's OpenAI-compatible `/compat` endpoint requires.
// Cloudflare's catalog keys models as bare "@cf/...", so this comes off before a
// lookup. Kept in sync with `adapters/openai_native.WORKERS_AI_COMPAT_PREFIX`, which
// decides the provider from the same two spellings.
const WORKERS_AI_COMPAT_PREFIX = "workers-ai/";

// Cloudflare's catalog page size, and a hard bound on the paging loop. The loop runs
// on the queue's flush tick ahead of the drain, so it must terminate even if the
// endpoint keeps returning full pages. 40 pages covers ~2000 models against a real
// catalog of 64.
const CF_PER_PAGE = 50;
const CF_MAX_PAGES = 40;

// A real dated Mistral snapshot ends in a short numeric tag (e.g. "-2603",
// "-2411", "-2508") — never a "-latest"-style moniker. Used to pick the one
// genuine canonical name out of a family that mutually lists each other
// (see parseMistralAliases).
const MISTRAL_DATED_ID = /-\d{4,8}$/;

const BEDROCK_REGION_PREFIX: Record<string, string> = {
  us: "us-east-1",
  eu: "eu-west-1",
  apac: "ap-southeast-1",
};

const BEDROCK_VENDOR_WORDS = new Set([
  "anthropic",
  "mistral",
  "mistralai",
  "ai21",
  "cohere",
  "meta",
  "amazon",
  "stability",
  "stabilityai",
  "google",
]);

// ----------------------------------------------------------------------
// Money (fixed-point BigInt, scale 1e12, floored — matches Python Decimal)
// ----------------------------------------------------------------------
const SCALE = 1_000_000_000_000n; // 1e12

// Mantissa + OPTIONAL exponent. The exponent half is not cosmetic: `String(n)`
// on a JS number switches to exponential notation below 1e-6, so a real
// gateway-reported cost of 9.807224944233895e-7 reaches us as
// "9.807224944233895e-7", never "0.0000009807...". A decimal-only pattern
// rejected those, and the callers' `?? 0n` then billed a real metered call at
// ZERO with no error — while Python's Decimal accepted the same input and
// billed it correctly, so the two repos disagreed on live money.
const DEC_RE = /^(\d+(?:\.\d+)?)(?:[eE]([+-]?\d+))?$/;

// Python's Decimal.quantize(1e-12) raises InvalidOperation once the result
// exceeds the default 28-digit context precision — i.e. at 1e16 and up (16
// integer + 12 fractional digits) — and `_parse_price` returns None there. We
// return null for exactly the same inputs so the repos stay byte-identical.
const MAX_SCALED = 10n ** 28n; // 1e16 USD, expressed at 1e12 scale

/** Parse a non-negative decimal string/number to a BigInt scaled by 1e12 (truncated). null on invalid/negative. */
export function parseScaled(value: unknown): bigint | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const m = DEC_RE.exec(String(value).trim());
  if (m === null) return null; // rejects negatives, NaN, Infinity, junk
  const [intPart, fracPart = ""] = m[1].split(".");
  const exp = m[2] ? Number(m[2]) : 0;
  const digits = intPart + fracPart;
  const significant = digits.replace(/^0+/, "");
  if (significant === "") return 0n; // any number of zeros, at any exponent
  // Decimal magnitude: the value sits in [10^(mag-1), 10^mag).
  const mag = significant.length + exp - fracPart.length;
  // Anything under 1e-12 floors to zero anyway. Short-circuiting here also
  // stops an absurd exponent ("1e-999999999") from turning the 10n ** shift
  // below into a memory bomb.
  if (mag <= -12) return 0n;
  // Same guard at the top end, before any exponentiation; the exact ceiling is
  // enforced against MAX_SCALED once the value is known.
  if (mag > 17) return null;
  const shift = 12 - fracPart.length + exp;
  let scaled: bigint;
  try {
    const n = BigInt(digits);
    // A negative shift divides, which truncates toward zero — and every value
    // reaching here is non-negative, so that is floor, matching ROUND_DOWN.
    scaled = shift >= 0 ? n * 10n ** BigInt(shift) : n / 10n ** BigInt(-shift);
  } catch {
    return null;
  }
  return scaled >= MAX_SCALED ? null : scaled;
}

/** Format a scaled-1e12 BigInt to a plain decimal string, trailing zeros trimmed. */
export function fmtMoney(scaled: bigint): string {
  if (scaled < 0n) scaled = 0n;
  const intPart = scaled / SCALE;
  const frac = (scaled % SCALE).toString().padStart(12, "0").replace(/0+$/, "");
  return frac ? `${intPart}.${frac}` : `${intPart}`;
}

/** Return [scaledMarkup, ok]. Falls back to 1.0 when invalid/non-positive. */
export function coerceMarkup(markup: unknown): [bigint, boolean] {
  const s = parseScaled(markup);
  if (s === null || s <= 0n) return [SCALE, false];
  return [s, true];
}

function norm(s: string): string {
  return s.toLowerCase().replace(/\./g, "-");
}

function alnum(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Drop a trailing -YYYYMMDD / -YYYY-MM-DD date or -vN version tag.
 *
 * Vendors stamp resolved model names with a date in one of two shapes, and both
 * must be strippable or the price lookup misses. Anthropic uses a COMPACT date
 * ("claude-sonnet-4-5-20250929"); OpenAI uses a HYPHENATED one
 * ("gpt-5-2025-08-07", "o3-2025-04-16"). OpenRouter lists the BARE id
 * ("openai/gpt-5"), so a name we can't strip back to bare never matches.
 *
 * Handling only the compact form silently broke price mode for every current
 * OpenAI model: `create({model: "gpt-5"})` returns model="gpt-5-2025-08-07", and
 * `resolveModel` prefers the response's own name over the requested one, so
 * gpt-4.1 / gpt-4.1-mini / gpt-5 / gpt-5-mini / o3 / o4-mini all fell through to
 * token events. gpt-4o looked fine only by luck — OpenRouter happens to list
 * "openai/gpt-4o-2024-08-06" verbatim.
 */
function stripVersion(model: string): string {
  return model.replace(/-(?:\d{8}|\d{4}-\d{2}-\d{2}|v\d+)$/, "");
}

/**
 * `stripVersion`, plus Gemini's 3-digit revision ("-002", which `model_version`
 * can report where OpenRouter lists only the bare name). OPENROUTER MATCHING ONLY.
 *
 * Deliberately not folded into `stripVersion`: that helper also builds the
 * AWS/Bedrock price keys, where a shortened key does not merely miss but silently
 * MIS-prices — `bedrockModelKey` feeds a map keyed by model, so two distinct models
 * collapsing to one key overwrite each other's rate. All four live catalogs are
 * currently clean (OpenRouter 415 ids, Cloudflare 64, AWS offer 77, captured Bedrock
 * 39: zero model parts end in exactly three digits), but the arm was only ever
 * motivated by OpenRouter, and scoping it makes that risk structurally zero instead
 * of empirically zero. Mirrors `_strip_version_openrouter` in the Python port.
 */
function stripVersionOpenrouter(model: string): string {
  return model.replace(/-(?:\d{8}|\d{4}-\d{2}-\d{2}|\d{3}|v\d+)$/, "");
}

// ----------------------------------------------------------------------
// Price tables
// ----------------------------------------------------------------------
export interface ModelPrice {
  source: string; // "openrouter" | "aws_bedrock" | "cloudflare_workers_ai" | "ramp_router"
  input: bigint | null;
  output: bigint | null;
  cache_read: bigint | null;
  cache_write: bigint | null;
  reasoning: bigint | null;
  // Anthropic prices a cache write by its TTL: 1.25x input for the 5-minute cache, 2x for
  // the 1-hour one. Only a source that publishes both can fill these (Ramp Router's
  // catalog does; OpenRouter publishes one `input_cache_write`, the 5m rate, so native
  // Anthropic bills every write at it). When they are set AND the usage carries the
  // matching `cache_write_5m`/`cache_write_1h` split, `computeCost` bills each part at its
  // own rate instead of the lump `cache_write` rate — see `splitCacheWrite`. Optional so
  // a hand-built five-field price stays a valid ModelPrice.
  cache_write_5m?: bigint | null;
  cache_write_1h?: bigint | null;
}

function emptyPrice(source: string): ModelPrice {
  return {
    source,
    input: null,
    output: null,
    cache_read: null,
    cache_write: null,
    reasoning: null,
    cache_write_5m: null,
    cache_write_1h: null,
  };
}

export interface CostBreakdown {
  total: string; // after-markup total in USD (billable value)
  totalCents: string; // same total in CENTS — Lago dynamic charge `precise_total_amount_cents`
  base: string; // pre-markup
  markup: string;
  source: string;
  fields: Record<string, { tokens: string; unit_price: string; cost: string }>;
}

/** The priced numeric fields computeCost reads — CanonicalUsage satisfies this. */
export type CanonicalUsageLike = { [K in PricedField]: number } & {
  provider?: string;
  api?: string;
  cache_write_5m?: number;
  cache_write_1h?: number;
};

/**
 * `tokenSemantics` read off a CanonicalUsage — see token_semantics.ts.
 *
 * Kept as the module-internal spelling so the billing paths keep reading the convention
 * from the record they are billing, not from loose strings.
 */
function usageTokenSemantics(usage: CanonicalUsageLike): [boolean, boolean, boolean] {
  return tokenSemantics(usage.provider || "", usage.api || "");
}

export function computeCost(
  usage: CanonicalUsageLike,
  price: ModelPrice,
  markupScaled: bigint,
): CostBreakdown {
  const counts = {} as Record<PricedField, number>;
  for (const f of PRICED_FIELDS) counts[f] = Number(usage[f]) || 0;
  // De-overlap subsets so a token is never billed twice (see `tokenSemantics`):
  //   • reasoning ⊆ output → bill it as output only (drop the separate line).
  //   • cache_read ⊆ input → bill the cached portion at the cache-read rate, so
  //     subtract it from input (only when a cache_read price exists).
  //   • cache_write ⊆ input → same treatment, on the surfaces that report it that
  //     way. Only one of cache_read/cache_write is non-zero on a given Databricks
  //     row, but both are subtracted unconditionally so a surface that does report
  //     both at once still reconciles.
  const [incCacheRead, incCacheWrite, incReasoning] = usageTokenSemantics(usage);
  if (incReasoning) counts.reasoning = 0;
  if (incCacheRead && price.cache_read !== null && price.cache_read !== undefined) {
    counts.input = Math.max(0, counts.input - counts.cache_read);
  }
  if (incCacheWrite && price.cache_write !== null && price.cache_write !== undefined) {
    counts.input = Math.max(0, counts.input - counts.cache_write);
  }
  const split = splitCacheWrite(usage, price, counts);

  let baseScaled = 0n;
  const fields: CostBreakdown["fields"] = {};
  const lines: Array<[string, number, bigint | null | undefined]> = [
    ...PRICED_FIELDS.map((f): [string, number, bigint | null | undefined] => [f, counts[f], price[f]]),
    ...split,
  ];
  for (const [f, count, unit] of lines) {
    if (!count) continue;
    if (unit === null || unit === undefined) continue;
    const costScaled = unit * BigInt(count); // scale 1e12
    baseScaled += costScaled;
    fields[f] = { tokens: String(count), unit_price: fmtMoney(unit), cost: fmtMoney(costScaled) };
  }
  return finalizeBreakdown(baseScaled, markupScaled, price.source, fields);
}

/**
 * Shared tail for `computeCost`/`computePrecomputedCost`: base (1e12) *
 * markup (1e12) / 1e12 -> 1e12, truncated (floor) — matches Python's
 * ROUND_DOWN, so cents == billed-USD × 100 exactly.
 */
const CACHE_WRITE_TTL_FIELDS = ["cache_write_5m", "cache_write_1h"] as const;

/**
 * Move the TTL-split part of `cache_write` onto its own rates, when both sides carry the
 * split.
 *
 * `cache_write_5m` / `cache_write_1h` are a breakdown OF `cache_write`, not additions to
 * it (Anthropic: `cache_creation_input_tokens == ephemeral_5m + ephemeral_1h`, measured on
 * every capture). So each part priced here is REMOVED from the lump count, and only a
 * remainder — a surface reporting a lump with no split — still bills at the lump rate.
 * Engages only when the price publishes a rate for that TTL: on OpenRouter's single-rate
 * Anthropic listing nothing moves and the lump path is unchanged.
 *
 * The 1h rate is 2x input where the 5m rate is 1.25x; billing a 1h write at the 5m rate
 * under-bills it by 37.5%, which is what this exists to prevent on the one source (Ramp
 * Router) that publishes both and the one surface (`/v1/messages`) that reports the split.
 * Reconciled exactly against Router's dashboard on 2026-09-04: 20,113 tokens at the 5m
 * rate + 16 input + 5 output = $0.02518225.
 *
 * Mutates `counts.cache_write`; returns [field, count, unit] triples to price.
 */
function splitCacheWrite(
  usage: CanonicalUsageLike,
  price: ModelPrice,
  counts: Record<PricedField, number>,
): Array<[string, number, bigint | null | undefined]> {
  const split: Array<[string, number, bigint | null | undefined]> = [];
  for (const f of CACHE_WRITE_TTL_FIELDS) {
    const unit = price[f];
    let n = Number(usage[f]) || 0;
    if (unit === null || unit === undefined || n <= 0) continue;
    // Never bill more split tokens than the lump reports: a surface whose split exceeds
    // its total is misreporting, and the lump is the authoritative count.
    n = Math.min(n, counts.cache_write);
    if (n <= 0) continue;
    counts.cache_write -= n;
    split.push([f, n, unit]);
  }
  return split;
}

function finalizeBreakdown(
  baseScaled: bigint,
  markupScaled: bigint,
  source: string,
  fields: CostBreakdown["fields"],
): CostBreakdown {
  const totalScaled = (baseScaled * markupScaled) / SCALE;
  return {
    total: fmtMoney(totalScaled),
    totalCents: fmtMoney(totalScaled * 100n),
    base: fmtMoney(baseScaled),
    markup: fmtMoney(markupScaled),
    source,
    fields,
  };
}

/**
 * Total tokens a call actually consumed, with the reported overlaps removed.
 *
 * Sums the same PRICED_FIELDS the split cost path emits one event each for, so the
 * single-event `unit` equals the sum of the split path's `unit`s instead of
 * reporting a different basis. Every overlap `tokenSemantics` reports is applied,
 * because a subset counted twice inflates the reported quantity exactly as it would
 * inflate a price:
 *
 *   - reasoning   ⊆ output — providers in OUTPUT_INCLUDES_REASONING, or any row
 *     from a surface in OPENAI_SHAPED_APIS
 *   - cache_read  ⊆ input  — providers in INPUT_INCLUDES_CACHE_READ, likewise
 *   - cache_write ⊆ input  — providers in INPUT_INCLUDES_CACHE_WRITE, likewise
 *     (all in token_semantics.ts)
 *
 * NOT gated on a unit price existing (unlike `computeCost`'s subtraction): a published
 * rate cannot change how many tokens were consumed. The two still agree in the case
 * that matters — a cache-inclusive provider with no cache_read price leaves the cached
 * tokens inside `input` on both paths.
 *
 * Limited to PRICED_FIELDS, the five text fields: `tool_calls` counts calls not tokens,
 * and `cache_write_5m`/`_1h` are a breakdown OF `cache_write`.
 */
export function deoverlappedTokenTotal(usage: CanonicalUsageLike): number {
  const counts: Record<string, number> = {};
  for (const f of PRICED_FIELDS) counts[f] = Number((usage as any)[f] ?? 0) || 0;
  const [incCacheRead, incCacheWrite, incReasoning] = usageTokenSemantics(usage);
  if (incReasoning) counts.reasoning = 0;
  if (incCacheRead) counts.cache_read = 0;
  if (incCacheWrite) counts.cache_write = 0;
  return Object.values(counts).reduce((a, b) => a + b, 0);
}

/**
 * Build a CostBreakdown from a cost the CALLER already knows.
 *
 * For a gateway that reports its own real, metered price per call (e.g. Cloudflare AI
 * Gateway's `cost`), our per-token estimate would be both redundant and less accurate
 * than the number the gateway already has. Skips `computeCost` entirely: one lump sum,
 * so `fields` is empty, and an invalid or negative input floors to 0 the way
 * `parseScaled` always has rather than throwing or mis-billing.
 */
export function computePrecomputedCost(usdCost: unknown, markupScaled: bigint): CostBreakdown {
  const baseScaled = parseScaled(usdCost) ?? 0n;
  return finalizeBreakdown(baseScaled, markupScaled, "precomputed", {});
}

/** A money string (already floored to 12dp) -> the same amount in cents,
 * same floor-and-format conventions as everywhere else. */
export function moneyStrToCents(usd: string): string {
  const scaled = parseScaled(usd) ?? 0n;
  return fmtMoney(scaled * 100n);
}

/**
 * `computeCost`'s per-field `cost` values are PRE-markup — only the summed
 * `total` has markup applied. Splitting a breakdown into one event per
 * field (per token_type) needs markup applied to each field individually,
 * with the same floor-to-12dp convention as everywhere else, or a markup
 * != 1.0 would silently vanish from every per-field/token_type event.
 */
export function applyMarkup(usd: string, markup: string): string {
  const usdScaled = parseScaled(usd) ?? 0n;
  const markupScaled = parseScaled(markup) ?? SCALE;
  return fmtMoney((usdScaled * markupScaled) / SCALE);
}

// ----------------------------------------------------------------------
// OpenRouter parsing + matching
// ----------------------------------------------------------------------
export interface OpenRouterTable {
  exact: Map<string, ModelPrice>;
  norm: Map<string, ModelPrice>; // key: `${vendor}\n${normModel}`
}

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object";
}

export function parseOpenRouter(data: unknown): OpenRouterTable {
  const exact = new Map<string, ModelPrice>();
  const normMap = new Map<string, ModelPrice>();
  const models = isObj(data) && Array.isArray(data.data) ? data.data : [];
  for (const m of models) {
    if (!isObj(m)) continue;
    const id = m.id;
    const pricing = m.pricing;
    if (typeof id !== "string" || !isObj(pricing)) continue;
    const mp = emptyPrice("openrouter");
    for (const f of PRICED_FIELDS) mp[f] = parseScaled(pricing[OPENROUTER_FIELD_MAP[f]]);
    // OpenRouter marks a MOVING alias with a leading "~" on the vendor
    // ("~anthropic/claude-sonnet-latest"). The marker must be stripped or the vendor
    // parses as "~anthropic", which is not in VENDOR_MAP, and every "-latest" alias
    // becomes unpriceable despite carrying real pricing. Collision-free: no
    // un-prefixed id duplicates a "~"-prefixed one.
    const bare = id.startsWith("~") ? id.slice(1) : id;
    exact.set(id, mp);
    if (bare !== id) exact.set(bare, mp);
    const slash = bare.indexOf("/");
    if (slash > 0) {
      const vendor = bare.slice(0, slash).toLowerCase();
      const suffix = bare.slice(slash + 1);
      normMap.set(`${vendor}\n${norm(suffix)}`, mp);
    }
  }
  return { exact, norm: normMap };
}

export function lookupOpenRouter(table: OpenRouterTable, provider: string, model: string): ModelPrice | null {
  const vendor = VENDOR_MAP[(provider || "").toLowerCase()] ?? (provider || "").toLowerCase();
  // Some sources report the model ALREADY carrying its vendor prefix — a real
  // Cloudflare AI Gateway log for a REST-path call says
  // model="anthropic/claude-opus-4.8" with provider="anthropic" — which would
  // otherwise build "anthropic/anthropic/claude-opus-4.8" and never match.
  // Strip it only when the prefix agrees with the vendor we just resolved, so
  // this stays vendor-gated as documented: a model naming a DIFFERENT vendor
  // than the call claims is still a miss, not a cross-vendor mispricing.
  const slash = model.indexOf("/");
  if (slash > 0) {
    const head = model.slice(0, slash).toLowerCase();
    if (head === vendor || head === (provider || "").toLowerCase()) model = model.slice(slash + 1);
  }
  return (
    table.exact.get(`${vendor}/${model}`) ??
    table.norm.get(`${vendor}\n${norm(model)}`) ??
    table.norm.get(`${vendor}\n${norm(stripVersionOpenrouter(model))}`) ??
    null
  );
}

// ----------------------------------------------------------------------
// Cloudflare Workers AI parsing + matching
//
// Unlike OpenRouter/Bedrock, this is the ACTUAL rate the gateway bills at —
// not a third party's price for hosting the same open-weight model
// elsewhere, which can (and does) differ meaningfully. Model strings (e.g.
// "@cf/meta/llama-3.3-70b-instruct-fp8-fast") are already exact and
// self-contained; no vendor-prefix mapping is needed the way OpenRouter
// needs one to disambiguate "anthropic" -> "anthropic" vs "mistral" ->
// "mistralai".
// ----------------------------------------------------------------------

/**
 * Parse `/ai/models/search` results into a `{modelName: ModelPrice}` map.
 *
 * A model with no `price` property at all, or whose price entries are all
 * non-token units (per-image, per-audio-minute, ...), is simply absent from
 * the table — `lookup` then returns null, same as any other priced-nowhere
 * model, and the caller safely falls back to token events.
 */
export function parseCloudflareWorkersAi(models: unknown): Map<string, ModelPrice> {
  const table = new Map<string, ModelPrice>();
  if (!Array.isArray(models)) return table;
  for (const m of models) {
    if (!isObj(m)) continue;
    const name = m.name;
    if (typeof name !== "string" || !name) continue;
    const properties = Array.isArray(m.properties) ? m.properties : [];
    const priceProp = properties.find((p) => isObj(p) && p.property_id === "price");
    if (!isObj(priceProp)) continue;
    const entries = priceProp.value;
    if (!Array.isArray(entries)) continue;
    const fields: Partial<Record<PricedField, bigint>> = {};
    for (const entry of entries) {
      if (!isObj(entry) || entry.currency !== "USD") continue;
      const field = CLOUDFLARE_UNIT_FIELD_MAP[String(entry.unit ?? "")];
      if (!field) continue;
      const perMillion = parseScaled(entry.price);
      if (perMillion === null) continue;
      fields[field] = perMillion / 1_000_000n; // per-million -> per-token, truncated
    }
    if (Object.keys(fields).length > 0) {
      const mp = emptyPrice("cloudflare_workers_ai");
      for (const f of PRICED_FIELDS) if (fields[f] !== undefined) mp[f] = fields[f]!;
      table.set(name, mp);
    }
  }
  return table;
}

/**
 * Exact match first; a version-suffix fallback covers the same drift we've
 * seen in practice — e.g. a live response naming a model "...instruct-v2"
 * when the catalog itself only lists "...instruct".
 *
 * The "workers-ai/" routing prefix comes off first. Cloudflare's catalog keys
 * models as bare "@cf/...", but calling one through the gateway's `/compat`
 * endpoint requires "workers-ai/@cf/..." — the form the README prescribes and the
 * only form a streaming call can report. Without the strip, recognising the
 * prefixed spelling as Workers AI upstream just moves the miss here.
 */
export function lookupCloudflareWorkersAi(table: Map<string, ModelPrice>, model: string): ModelPrice | null {
  const bare = model.startsWith(WORKERS_AI_COMPAT_PREFIX)
    ? model.slice(WORKERS_AI_COMPAT_PREFIX.length)
    : model;
  for (const candidate of bare === model ? [model] : [model, bare]) {
    const hit = table.get(candidate) ?? table.get(stripVersion(candidate));
    if (hit !== undefined) return hit;
  }
  return null;
}

/**
 * One `ai-gateway/costs?search=<model>` response → the price of exactly `model`, or null.
 *
 * Only rows whose `model` equals the requested id and whose `cost_type` is `tokens` count.
 * The same id can appear under several providers at DIFFERENT rates (`stealth/union-alpha`
 * is listed by openrouter, unbiased and stealth), so when more than one row matches, the
 * row whose `provider` is the id's own namespace (`typesafe/jev` → `typesafe`) wins; failing
 * that, rows that all agree are one price and rows that disagree are a refused lookup — the
 * honest miss, same rule as Ramp Router's foreign-backend aliases. A published 0 is kept as
 * a real $0 rate (Jev's output and cached input are free), not turned into "no rate": the
 * gateway bills the row literally, and so must we.
 */
export function parseCloudflareGatewayCost(rows: unknown, model: string): ModelPrice | null {
  if (!Array.isArray(rows)) return null;
  const matches = rows.filter(
    (r): r is Record<string, unknown> =>
      isObj(r) && r.model === model && r.cost_type === "tokens" && isObj(r.token_pricing),
  );
  if (matches.length === 0) return null;
  const namespace = model.includes("/") ? model.split("/", 1)[0] : null;
  const own = namespace ? matches.filter((r) => r.provider === namespace) : [];
  const candidates = own.length ? own : matches;
  const fields = (row: Record<string, unknown>): Partial<Record<PricedField, bigint>> => {
    const out: Partial<Record<PricedField, bigint>> = {};
    const tp = row.token_pricing as Record<string, unknown>;
    for (const [key, field] of Object.entries(CF_COSTS_FIELD_MAP)) {
      if (!(key in tp)) continue;
      const perMillion = parseScaled(tp[key]);
      if (perMillion === null) continue;
      out[field] = perMillion / 1_000_000n; // per-million -> per-token, truncated
    }
    return out;
  };
  const same = (a: Partial<Record<PricedField, bigint>>, b: Partial<Record<PricedField, bigint>>) =>
    PRICED_FIELDS.every((f) => a[f] === b[f]);
  const first = fields(candidates[0]);
  if (candidates.slice(1).some((r) => !same(fields(r), first))) return null;
  if (Object.keys(first).length === 0) return null;
  const mp = emptyPrice("cloudflare_gateway_costs");
  for (const f of PRICED_FIELDS) if (first[f] !== undefined) mp[f] = first[f]!;
  return mp;
}

// ----------------------------------------------------------------------
// Ramp Router parsing + matching
//
// Router's own `GET /v1/models` is the price source for the same reason Cloudflare's
// catalog is Workers AI's: it is the rate the gateway actually bills, not a third
// party's listing for the same model hosted elsewhere. Measured against a live
// account's dashboard export: every default-tier row whose counts the response fully
// reports reconciled at exactly 1.000000x the catalog rate — 28 rows across five
// served vendors on 2026-09-04, including the cache split (grok, 194 in / 192 cached:
// 2 x input + 192 x cache_read + out, to the last digit), and an OpenAI cache WRITE
// billed at `cache_write_input` on 2026-09-07 (gpt-5.6-luna, 4493 in / 4490 written).
// The five default-tier rows that did NOT reconcile were Anthropic cold cache writes,
// whose write count this surface never reports — see the adapter.
//
// Where Router bills OFF its own catalog (measured 2026-09-07: eight OpenAI models at a
// constant 1.1x or 0.55x of their published rate), the SDK still bills the PUBLISHED rate
// and documents the mismatch with its date, recommending `markup` on those models. A
// factor baked into the SDK would be the thing out of sync the day Router corrects its
// catalog — a customer's markup can be dropped the same day, an SDK release cannot.
// Where Router serves an entry through a backend other than the one the rate belongs to,
// the served name is refused rather than mispriced — see `isForeignBackendAlias`.
// ----------------------------------------------------------------------

// Ramp Router's `router.pricing` key -> canonical field. Every one of the live catalog's
// entries carries all six keys as STRINGS in USD per 1M tokens (measured 2026-09-07, 68
// of 68). `cache_write_input_5m` / `_1h` are Anthropic's TTL-split write rates; the count
// they price is reported only on Router's `/v1/messages` surface (the Anthropic wrapper),
// never on `/v1/responses` — see adapters/anthropic_native.ts.
type RampRouterPriceField = PricedField | "cache_write_5m" | "cache_write_1h";
const RAMP_ROUTER_FIELD_MAP: ReadonlyArray<[RampRouterPriceField, string]> = [
  ["input", "input"],
  ["output", "output"],
  ["cache_read", "cache_read_input"],
  ["cache_write", "cache_write_input"],
  ["cache_write_5m", "cache_write_input_5m"],
  ["cache_write_1h", "cache_write_input_1h"],
];

// Served service tiers that bill at the catalog's published rate. Any OTHER reported
// tier — `flex` (measured 0.5x), `priority` (measured 2.0x on two vendors), or a tier
// Router adds later — is a price MISS: token events plus an onError report, never a
// multiplied rate. The tier multipliers are Router's policy, published nowhere
// machine-readable. `standard` is the dashboard's spelling of the tier the API reports
// as `default`; accepted so a vocabulary change on the wire stays a base-rate call.
//
// A response with NO tier at all is priced at the base rate (decided 2026-09-07 on
// data): in a 237-call sweep Router omitted `service_tier` on exactly the responses
// that stopped with zero output (`incomplete`, both surfaces, six calls) and billed
// every one of them at the standard rate; flex and priority were reported explicitly
// whenever they applied. So absence has only ever meant standard, and treating it as a
// miss turned $0.50 of real usage into token events for no gain.
export const RAMP_ROUTER_BASE_RATE_TIERS: ReadonlySet<string> = new Set(["default", "standard"]);

/**
 * True when an alias names the SAME model on a DIFFERENT backend than the entry's own.
 *
 * Router serves some catalog entries through more than one hosting provider and bills
 * the rate of whichever served — but publishes ONE rate per entry, the entry's own
 * provider's. Measured 2026-09-07: ten Fireworks-owned entries carry a Baseten alias
 * (`deepseek-ai/DeepSeek-V4-Flash-0731`, `zai-org/GLM-5.2`, `moonshotai/Kimi-K2.7-Code`,
 * …); when Baseten served, Router billed Baseten's rate, 1.11x to 2.4x away from the
 * catalog's. The served model name is that alias, so it is the one signal that the
 * published rate does not apply — and a name the SDK refuses to index is an honest miss
 * (token events + onError) instead of a wrong price. Decided by the user, 2026-09-07,
 * knowing it also turns the Baseten-served rows that happened to match (kimi-k3,
 * glm-5p3-flash, deepseek-v4-pro) into misses.
 *
 * "Different backend" is read off the path prefix: `provider_model` says where the
 * entry's rate comes from (`accounts/fireworks/models/…`), and an alias whose leading
 * path segment differs (`deepseek-ai/…`) is another host's spelling. A bare alias with
 * no path is a plain synonym and stays indexed.
 */
function isForeignBackendAlias(alias: string, providerModel: unknown): boolean {
  if (!alias.includes("/") || typeof providerModel !== "string" || !providerModel.includes("/")) return false;
  return alias.split("/", 1)[0] !== providerModel.split("/", 1)[0];
}

function samePrice(a: ModelPrice, b: ModelPrice): boolean {
  return PRICED_FIELDS.every((f) => a[f] === b[f]);
}

/**
 * Parse Router's `/v1/models` into {name: ModelPrice}, keyed on every name a served
 * response can report for the entry.
 *
 * Router answers with a RESOLVED vendor snapshot, not the catalog id: `gpt-5.4-nano` in
 * the catalog, `gpt-5.4-nano-2026-03-17` in the response — `lookupRampRouter` strips
 * that. But Fireworks- and Baseten-served responses report the vendor's own path
 * (`accounts/fireworks/models/…`, `thinkingmachines/inkling-small`), which is the entry's
 * `router.provider_model` or one of its `router.aliases`, never its `id`. So every one of
 * `id`, `router.request_name`, `router.provider_model` and `router.aliases[]` is indexed
 * (measured: all 9 distinct served names across every capture resolve, 5 by
 * version-strip and 4 by exact name).
 *
 * Two rules keep that widening honest:
 *
 *   - A name claimed by two entries with DIFFERENT rates is unpriced — removed and pinned
 *     so no later entry can re-add it. Guessing between two rates is a mispricing, not a
 *     miss. The live catalog has exactly one shared name today
 *     (`…/nemotron-3-ultra-nvfp4`, the provider_model of two entries) and both carry
 *     identical rates, so it prices; the rule is for the day they diverge.
 *   - A ZERO cache rate means "no separate rate", not "free": `cache_write_input` is "0"
 *     on every Anthropic entry because their write price lives in the `_5m`/`_1h` keys,
 *     and `cache_read_input` is "0" on the pro and legacy OpenAI models that do not cache
 *     at all. Stored as null so `computeCost` leaves those tokens inside `input` at the
 *     input rate — the floor — rather than billing a cached block at $0. Zero
 *     `input`/`output` is kept as a genuine published zero.
 *
 * One more rule, measured against the dashboard on 2026-09-07: an alias that names the
 * entry on a DIFFERENT backend is NOT indexed — see `isForeignBackendAlias`. A call served
 * there misses rather than misprices. The published rate is otherwise stored as-is, even
 * for the models measured to bill off it (see the section comment).
 *
 * An entry with no token rate at all is simply absent, the same safe miss as everywhere
 * else.
 */
export function parseRampRouter(data: unknown): Map<string, ModelPrice> {
  const table = new Map<string, ModelPrice>();
  const conflicts = new Set<string>();
  const models = isObj(data) ? data.data : null;
  if (!Array.isArray(models)) return table;
  for (const m of models) {
    if (!isObj(m)) continue;
    const mid = m.id;
    const router = m.router;
    if (typeof mid !== "string" || !mid || !isObj(router) || !isObj(router.pricing)) continue;
    const pricing = router.pricing;
    const fields: Partial<Record<RampRouterPriceField, bigint>> = {};
    for (const [field, key] of RAMP_ROUTER_FIELD_MAP) {
      const perMillion = parseScaled(pricing[key]);
      if (perMillion === null) continue;
      if (perMillion === 0n && field.startsWith("cache_")) continue;
      fields[field] = perMillion / 1_000_000n; // per-million -> per-token, truncated
    }
    if (Object.keys(fields).length === 0) continue;
    const mp = emptyPrice("ramp_router");
    for (const [f] of RAMP_ROUTER_FIELD_MAP) if (fields[f] !== undefined) mp[f] = fields[f]!;
    const names = new Set<string>([mid]);
    for (const key of ["request_name", "provider_model"]) {
      const v = router[key];
      if (typeof v === "string" && v) names.add(v);
    }
    if (Array.isArray(router.aliases)) {
      for (const a of router.aliases) {
        if (typeof a === "string" && a && !isForeignBackendAlias(a, router.provider_model)) names.add(a);
      }
    }
    for (const name of names) {
      if (conflicts.has(name)) continue;
      const prior = table.get(name);
      if (prior === undefined) table.set(name, mp);
      else if (!samePrice(prior, mp)) {
        table.delete(name);
        conflicts.add(name);
      }
    }
  }
  if (conflicts.size > 0) {
    // Once per fetch, not per call: a customer can act on it (the name is unpriced until
    // Router's catalog stops disagreeing with itself), so it must be visible.
    console.warn(
      `[lago] ramp router catalog lists ${conflicts.size} name(s) under more than one rate; ` +
        `left unpriced: ${[...conflicts].sort().join(", ")}`,
    );
  }
  return table;
}

/**
 * Exact served name first, then the version-stripped form.
 *
 * The strip is the same `stripVersion` the OpenRouter path uses, because Router reports
 * the vendor's own dated snapshot for OpenAI- and Anthropic-served calls
 * (`o3-2025-04-16`, `claude-haiku-4-5-20251001`) while its catalog lists the bare id.
 * Verified collision-free against the live catalog: no stripped served name lands on a
 * different entry than the exact one would.
 */
export function lookupRampRouter(table: Map<string, ModelPrice>, model: string): ModelPrice | null {
  return table.get(model) ?? table.get(stripVersion(model)) ?? null;
}

/**
 * The served tier that keeps a Router call OUT of price mode, or null.
 *
 * null means "bill the catalog rate": either this is not a Router call at all, or Router
 * served it at a base-rate tier (see RAMP_ROUTER_BASE_RATE_TIERS). Otherwise the
 * offending tier is returned so the miss report can say WHY — a customer seeing "no
 * price" for a model that priced a second ago needs to know it was the tier. The tier is
 * read from `extras.service_tier`, where the adapter records the response's own field
 * (top level on `/v1/responses`, inside `usage` on `/v1/messages`). A Router call with NO
 * tier bills at the base rate — see RAMP_ROUTER_BASE_RATE_TIERS for the measurement
 * behind that. Only an explicitly reported non-base tier is a miss.
 */
export function rampRouterUnpricedTier(usage: {
  provider?: string;
  extras?: Record<string, unknown>;
}): string | null {
  if ((usage.provider || "").toLowerCase() !== "ramp_router") return null;
  const tier = usage.extras?.service_tier;
  if (tier === null || tier === undefined || tier === "") return null;
  if (typeof tier === "string" && RAMP_ROUTER_BASE_RATE_TIERS.has(tier.toLowerCase())) return null;
  return typeof tier === "string" ? tier : String(tier);
}

// ----------------------------------------------------------------------
// Mistral alias resolution
// ----------------------------------------------------------------------

/**
 * Normalize a dated Mistral suffix to a comparable number; newest = largest.
 *
 * Mistral's own convention is a 4-digit YYMM ("-2411", "-2603"), but the regex
 * admits 4-8 digits and mixed widths do NOT compare correctly as raw strings:
 * "20241101" sorts *below* "2411" lexicographically. Widening YYMM to YYYYMM00
 * puts both shapes on one scale.
 */
function mistralDateKey(name: string): number {
  const m = MISTRAL_DATED_ID.exec(name);
  if (m === null) return -1;
  const digits = m[0].slice(1); // drop the leading "-"
  if (digits.length === 4) return Number(`20${digits}00`); // YYMM -> 20YY-MM, day unknown
  return Number(digits); // YYYYMMDD, or an unexpected width taken at face value
}

/**
 * Prefer the NEWEST dated snapshot id (what OpenRouter actually lists models
 * under) over a "-latest"-style moniker.
 *
 * Newest, not shortest: every dated id in a family is the same length, so a
 * shortest-then-alphabetical tie-break resolves on the DATE, ascending — which picks
 * the OLDEST snapshot and prices the whole family at a years-old rate.
 *
 * Falls back to shortest-then-code-point when no dated candidate exists, so the choice
 * is deterministic either way. NOT `localeCompare`: it is ICU/locale-dependent, so it
 * is not reproducible across environments and made the two ports disagree on which
 * canonical name to pick for the same input.
 */
function pickMistralCanonical(names: string[]): string {
  const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  const dated = names.filter((n) => MISTRAL_DATED_ID.test(n));
  if (dated.length > 0) {
    return [...dated].sort((a, b) => mistralDateKey(b) - mistralDateKey(a) || byCodePoint(a, b))[0];
  }
  return [...names].sort((a, b) => a.length - b.length || byCodePoint(a, b))[0];
}

/**
 * Parse Mistral's `/v1/models` response into a `{alias: canonicalId}` map.
 *
 * Mistral lists EVERY name in a family as its own top-level entry, each one's
 * `aliases` pointing at the others, so a directional last-write-wins map is
 * order-dependent and can resolve an alias to ANOTHER alias rather than the dated
 * snapshot OpenRouter actually lists. Union-find instead: id + aliases form one
 * connected group whichever entry mentions which, then one canonical per group (see
 * `pickMistralCanonical`) that every member maps to.
 */
export function parseMistralAliases(data: unknown): Map<string, string> {
  const models = isObj(data) && Array.isArray(data.data) ? data.data : [];

  const parent = new Map<string, string>();
  function find(x: string): string {
    let root = x;
    while (parent.has(root) && parent.get(root) !== root) root = parent.get(root)!;
    return root;
  }
  function union(a: string, b: string): void {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }

  const names = new Set<string>();
  for (const m of models) {
    if (!isObj(m)) continue;
    const mid = m.id;
    if (typeof mid !== "string" || !mid) continue;
    if (!parent.has(mid)) parent.set(mid, mid);
    names.add(mid);
    const aliases = Array.isArray(m.aliases) ? m.aliases : [];
    for (const alias of aliases) {
      if (typeof alias !== "string" || !alias) continue;
      if (!parent.has(alias)) parent.set(alias, alias);
      names.add(alias);
      union(mid, alias);
    }
  }

  const groups = new Map<string, string[]>();
  for (const name of names) {
    const root = find(name);
    const arr = groups.get(root) ?? [];
    arr.push(name);
    groups.set(root, arr);
  }

  const result = new Map<string, string>();
  for (const members of groups.values()) {
    if (members.length < 2) continue; // no aliasing at all — nothing to resolve
    const canonical = pickMistralCanonical(members);
    for (const name of members) {
      if (name === canonical) continue;
      // An explicit dated snapshot is already the real id OpenRouter lists, so it
      // must pass through untouched — never rewritten onto a sibling. Without this,
      // requesting `mistral-large-2411` was remapped to the group's canonical and
      // priced at THAT snapshot's rate instead of its own, a mispricing not a miss.
      if (MISTRAL_DATED_ID.test(name)) continue;
      result.set(name, canonical);
    }
  }
  return result;
}

// ----------------------------------------------------------------------
// Bedrock parsing + matching (validated by the env-gated live test)
// ----------------------------------------------------------------------
export function parseBedrockRegion(model: string, defaultRegion: string): string {
  const head = model.includes(".") ? model.split(".", 1)[0].toLowerCase() : "";
  return BEDROCK_REGION_PREFIX[head] ?? defaultRegion;
}

export function bedrockModelKey(model: string): string {
  let parts = model.split(".");
  if (parts.length && BEDROCK_REGION_PREFIX[parts[0].toLowerCase()]) parts = parts.slice(1);
  let modelPart = parts.length > 1 ? parts.slice(1).join(".") : (parts[0] ?? "");
  modelPart = modelPart.replace(/:\d+$/, "").replace(/-v\d+$/, "");
  modelPart = stripVersion(modelPart);
  return alnum(modelPart);
}

function awsModelKeys(name: string): string[] {
  const base = stripVersion(norm(name));
  const keys = new Set<string>([alnum(base)]);
  const words = name.split(/\s+/);
  if (words.length && BEDROCK_VENDOR_WORDS.has(words[0].toLowerCase())) {
    keys.add(alnum(stripVersion(norm(words.slice(1).join(" ")))));
  }
  return [...keys].filter(Boolean);
}

/** Classify a Bedrock product as standard on-demand input/output, rejecting tier variants. */
function bedrockDirection(attrs: Record<string, unknown>): "input" | "output" | null {
  const it = String(attrs.inferenceType ?? "")
    .trim()
    .toLowerCase();
  if (it === "input tokens") return "input";
  if (it === "output tokens") return "output";
  if (it) return null; // priority/flex/batch or non-token
  const blob = ["usagetype", "operation", "feature"]
    .map((k) => String(attrs[k] ?? ""))
    .join(" ")
    .toLowerCase();
  if (blob.includes("batch") || !blob.includes("token")) return null;
  if (blob.includes("input")) return "input";
  if (blob.includes("output")) return "output";
  return null;
}

function usdPerToken(term: unknown): bigint | null {
  if (!isObj(term)) return null;
  for (const offer of Object.values(term)) {
    const dims = isObj(offer) ? offer.priceDimensions : undefined;
    if (!isObj(dims)) continue;
    for (const dim of Object.values(dims)) {
      if (!isObj(dim)) continue;
      const ppu = dim.pricePerUnit;
      const usd = isObj(ppu) ? ppu.USD : undefined;
      let price = parseScaled(usd);
      if (price === null) continue;
      const unit = String(dim.unit ?? "").toLowerCase();
      if (unit.includes("1k") || unit.includes("1000") || unit.includes("thousand")) {
        price = price / 1000n; // per 1K tokens -> per token (truncated)
      }
      return price;
    }
  }
  return null;
}

export function parseBedrockOffer(offer: unknown, _region: string): Map<string, ModelPrice> {
  const result = new Map<string, ModelPrice>();
  if (!isObj(offer)) return result;
  const products = offer.products;
  const terms = offer.terms;
  const onDemand = isObj(terms) ? terms.OnDemand : undefined;
  if (!isObj(products) || !isObj(onDemand)) return result;

  const acc = new Map<string, { input?: bigint; output?: bigint }>();
  for (const [sku, product] of Object.entries(products)) {
    if (!isObj(product)) continue;
    const attrs = product.attributes;
    if (!isObj(attrs)) continue;
    const name = attrs.model ?? attrs.titleModelId ?? attrs.modelName;
    if (typeof name !== "string" || !name) continue;
    const direction = bedrockDirection(attrs);
    if (direction === null) continue;
    const price = usdPerToken((onDemand as Record<string, unknown>)[sku]);
    if (price === null) continue;
    for (const key of awsModelKeys(name)) {
      const entry = acc.get(key) ?? {};
      entry[direction] = price;
      acc.set(key, entry);
    }
  }
  for (const [key, v] of acc) {
    const mp = emptyPrice("aws_bedrock");
    mp.input = v.input ?? null;
    mp.output = v.output ?? null;
    result.set(key, mp);
  }
  return result;
}

export function lookupBedrock(regionTable: Map<string, ModelPrice>, model: string): ModelPrice | null {
  return regionTable.get(bedrockModelKey(model)) ?? null;
}

// ----------------------------------------------------------------------
// Fetcher (real HTTP via native fetch; injectable for tests)
// ----------------------------------------------------------------------
export interface PricingFetcher {
  fetchOpenRouter(): Promise<OpenRouterTable>;
  fetchBedrock(region: string): Promise<Map<string, ModelPrice>>;
  fetchCloudflareWorkersAi(): Promise<Map<string, ModelPrice>>;
  fetchCloudflareGatewayCost(model: string): Promise<ModelPrice | null>;
  fetchMistralAliases(apiKey?: string | null): Promise<Map<string, string>>;
  fetchRampRouter(apiKey?: string | null): Promise<Map<string, ModelPrice>>;
}

/**
 * `cloudflareAccountId`/`cloudflareApiToken`: unlike OpenRouter/AWS,
 * Cloudflare's model catalog is account-scoped and needs auth — there's no
 * public, no-credentials equivalent. Without both set,
 * `fetchCloudflareWorkersAi` returns an empty table rather than throwing, so
 * Workers AI pricing is simply unavailable (safe token-event fallback)
 * instead of breaking price mode for every other provider.
 *
 * `mistralApiKey`: same story — Mistral's `/v1/models` needs the customer's
 * own key. Without it (and without one passed at call time either),
 * `fetchMistralAliases` returns an empty map, so alias resolution is simply
 * skipped and lookups fall back to whatever the request already spelled
 * out (safe miss, not a break).
 *
 * `rampRouterApiKey`: Router's catalog is account-scoped too. Without it (and without
 * one learned from a wrapped client), `fetchRampRouter` returns an empty table, so
 * Router pricing is unavailable and every Router call in price mode reports a miss and
 * bills token events — loudly, because unlike the two above this is a source the
 * customer almost always has the key for.
 */
export class HttpPricingFetcher implements PricingFetcher {
  constructor(
    private timeoutMs: number = 10_000,
    private cloudflareAccountId?: string,
    private cloudflareApiToken?: string,
    private mistralApiKey?: string,
    private rampRouterApiKey?: string,
  ) {}

  private async getJson(url: string, headers?: Record<string, string>): Promise<unknown> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const resp = await fetch(url, { signal: ctrl.signal, headers });
      if (!resp.ok) throw new Error(`GET ${url} -> ${resp.status}`);
      return await resp.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async fetchOpenRouter(): Promise<OpenRouterTable> {
    return parseOpenRouter(await this.getJson(OPENROUTER_URL));
  }

  async fetchBedrock(region: string): Promise<Map<string, ModelPrice>> {
    const idx = (await this.getJson(AWS_BEDROCK_REGION_INDEX)) as Record<string, unknown>;
    const regions = isObj(idx.regions) ? idx.regions : {};
    const entry = (regions as Record<string, unknown>)[region];
    const url = isObj(entry) ? entry.currentVersionUrl : undefined;
    if (typeof url !== "string" || !url) return new Map();
    return parseBedrockOffer(await this.getJson(AWS_PRICING_HOST + url), region);
  }

  async fetchCloudflareWorkersAi(): Promise<Map<string, ModelPrice>> {
    if (!this.cloudflareAccountId || !this.cloudflareApiToken) return new Map();
    const headers = { Authorization: `Bearer ${this.cloudflareApiToken}` };
    const models: unknown[] = [];
    let page = 1;
    for (;;) {
      const url = `${cloudflareModelsUrl(this.cloudflareAccountId)}?per_page=${CF_PER_PAGE}&page=${page}`;
      const body = (await this.getJson(url, headers)) as Record<string, unknown>;
      const batch = Array.isArray(body.result) ? body.result : [];
      // `push(...batch)` spreads every element as an argument, which throws
      // RangeError once a batch is large enough — on exactly the one-wide-read
      // pattern this is used for. A loop has no argument ceiling.
      for (const m of batch) models.push(m);
      // A SHORT page is the only reliable end-of-catalog signal. `result_info.total_count`
      // is not — it can report several times the number the endpoint actually serves, so
      // a `models.length >= total` test never fires — and it must never fall back to
      // `models.length`, which breaks after page one and silently keeps a partial
      // catalog.
      if (batch.length < CF_PER_PAGE) break;
      if (page >= CF_MAX_PAGES) {
        // Bounded because this runs on the queue's flush tick, ahead of the drain —
        // an endpoint that always returns a full page must not stall event delivery
        // indefinitely. Truncation is reported rather than silent, since a short
        // catalog reads as "these models are unpriced".
        console.warn(
          `[lago] cloudflare model catalog truncated at ${CF_MAX_PAGES} pages ` +
            `(${models.length} models); prices for later models are unavailable`,
        );
        break;
      }
      page++;
    }
    return parseCloudflareWorkersAi(models);
  }

  /**
   * The gateway's own rate for one model id, or null when it lists none.
   *
   * One request per model, on demand — the full table is 2,839 rows across every provider,
   * and the only ids that reach this path are partner models the Workers AI catalog omits, a
   * handful per account. Same credentials as the catalog fetch.
   */
  async fetchCloudflareGatewayCost(model: string): Promise<ModelPrice | null> {
    if (!this.cloudflareAccountId || !this.cloudflareApiToken) return null;
    const url = `${cloudflareGatewayCostsUrl(this.cloudflareAccountId)}?search=${encodeURIComponent(model)}&per_page=100`;
    const body = (await this.getJson(url, { Authorization: `Bearer ${this.cloudflareApiToken}` })) as Record<
      string,
      unknown
    >;
    return parseCloudflareGatewayCost(body.result, model);
  }

  async fetchMistralAliases(apiKey?: string | null): Promise<Map<string, string>> {
    // An explicitly configured key always wins over one learned from a
    // wrapped client — a deliberate config value shouldn't be silently
    // shadowed by an auto-detected one.
    const key = this.mistralApiKey || apiKey;
    if (!key) return new Map();
    const headers = { Authorization: `Bearer ${key}` };
    return parseMistralAliases(await this.getJson(MISTRAL_MODELS_URL, headers));
  }

  async fetchRampRouter(apiKey?: string | null): Promise<Map<string, ModelPrice>> {
    // Same precedence as Mistral: an explicitly configured key always wins over one
    // learned from a wrapped client.
    const key = this.rampRouterApiKey || apiKey;
    if (!key) return new Map();
    // `api.router.com` sits behind Cloudflare bot management, which rejects urllib's
    // default User-Agent outright (403). Node's `fetch` passes as-is (measured
    // 2026-09-07), so nothing is overridden here.
    const headers = { Authorization: `Bearer ${key}` };
    return parseRampRouter(await this.getJson(RAMP_ROUTER_MODELS_URL, headers));
  }
}

// ----------------------------------------------------------------------
// PricingProvider — cache + background refresh + non-blocking lookup
// ----------------------------------------------------------------------
export class PricingProvider {
  private fetcher: PricingFetcher;
  private ttlMs: number;
  private defaultRegion: string;
  private onError?: (err: unknown, where: string) => void;

  private openrouter: OpenRouterTable | null = null;
  private openrouterFetched = 0;
  // Not stale by default: token-mode SDKs never trigger a pricing fetch.
  private openrouterStale = false;
  private bedrock = new Map<string, Map<string, ModelPrice>>();
  private bedrockFetched = new Map<string, number>();
  private bedrockStale = new Set<string>();
  private cloudflareWorkersAi: Map<string, ModelPrice> | null = null;
  private cloudflareFetched = 0;
  private cloudflareStale = false;
  // Partner models on Workers AI (`typesafe/jev`), priced from AI Gateway's own cost table
  // one model at a time. Reactive like Bedrock: a miss in `lookup()` queues the id here,
  // `maybeRefresh()` fetches it on the next tick, and every later call hits. A null value is
  // a remembered "the gateway lists no rate" — kept for the TTL so an unpriced id does not
  // cost one HTTP request per flush tick.
  private cfGatewayCosts = new Map<string, ModelPrice | null>();
  private cfGatewayCostsFetched = new Map<string, number>();
  private cfGatewayPending = new Set<string>();
  private mistralAliases: Map<string, string> | null = null;
  private mistralFetched = 0;
  private mistralStale = false;
  // Learned from a wrapped Mistral client (see LagoSDK's auto-prime-on-wrap),
  // not configured — the customer's own client already carries this key for
  // making real calls, so alias resolution can reuse it without ever
  // requiring a separate LagoConfig.mistralApiKey.
  private mistralApiKeyOverride: string | null = null;
  private rampRouter: Map<string, ModelPrice> | null = null;
  private rampRouterFetched = 0;
  private rampRouterStale = false;
  // Learned from a wrapped OpenAI client pointed at Router, same mechanism and same
  // precedence as the Mistral key above.
  private rampRouterApiKeyOverride: string | null = null;
  private refreshing = new Set<string>();
  // Post-failure backoff, per source: current delay, and the earliest next attempt.
  // Absent from both maps == healthy.
  private retryDelayMs = new Map<string, number>();
  private retryAfterMs = new Map<string, number>();

  constructor(
    opts: {
      fetcher?: PricingFetcher;
      ttlMs?: number;
      defaultRegion?: string;
      onError?: (err: unknown, where: string) => void;
      cloudflareAccountId?: string;
      cloudflareApiToken?: string;
      mistralApiKey?: string;
      rampRouterApiKey?: string;
    } = {},
  ) {
    this.fetcher =
      opts.fetcher ??
      new HttpPricingFetcher(
        10_000,
        opts.cloudflareAccountId,
        opts.cloudflareApiToken,
        opts.mistralApiKey,
        opts.rampRouterApiKey,
      );
    this.ttlMs = opts.ttlMs ?? 3_600_000;
    this.defaultRegion = opts.defaultRegion ?? "us-east-1";
    this.onError = opts.onError;
  }

  /**
   * Flag OpenRouter for an eager warm (price mode as the global default).
   *
   * Deliberately does NOT also eagerly warm Cloudflare Workers AI or
   * Mistral alias resolution by default — both are credential-gated and
   * provider-specific; most price-mode customers never touch Workers AI
   * or Mistral at all, and eagerly hitting either's API at construction
   * time regardless of actual usage is real, unnecessary work. Instead
   * they stay purely reactive: the first real `lookup()` for that provider
   * flags it stale, `maybeRefresh()` fetches it on the next tick, and
   * every call after that hits the cache with zero further network calls
   * until the TTL expires.
   *
   * Pass `providers: ["mistral"]`, `["workers-ai"]` and/or `["ramp_router"]` when you already
   * know, in advance, which of these two you're about to call this
   * session — this eagerly warms exactly that source too, so even ITS
   * first call prices correctly instead of paying the one-time lazy
   * cold-start cost. Unknown provider names are silently ignored rather
   * than throwing, since this is a hint, not a contract.
   */
  prime(providers: string[] = [], opts: { workersAiModels?: string[] } = {}): void {
    // Gated on "is this table actually cold?", NOT unconditional. `wrap()` and
    // `warmPricing()` both reach here and a server can run either per request, so
    // flagging an in-TTL table stale means re-downloading the ~400-model OpenRouter
    // catalogue on the next tick — `pricingTtlMs` would never apply on this path.
    //
    // "Cold" is the same test `lookup()` uses, so priming and looking up cannot
    // disagree about what needs fetching.
    if (this.isCold(this.openrouter, this.openrouterFetched)) this.openrouterStale = true;
    // Partner models on Workers AI are priced one row at a time from the gateway's cost
    // table, and the SDK only learns an id when a call for it arrives — so the first call to
    // each such model in a process is a cold miss. Naming the ids here (via
    // `warmPricing(providers, { workersAiModels })`) fetches their rows up front, the way
    // `providers: ["workers-ai"]` fetches the catalog, so even the first call prices. Same
    // "only if cold" gate as everything else in this method.
    for (const m of opts.workersAiModels ?? []) {
      if (!m || m.startsWith("@") || m.startsWith(WORKERS_AI_COMPAT_PREFIX)) continue;
      const fetchedAt = this.cfGatewayCostsFetched.get(m);
      if (fetchedAt === undefined || Date.now() - fetchedAt >= this.ttlMs) this.cfGatewayPending.add(m);
    }
    for (const p of providers) {
      const key = (p || "").toLowerCase();
      if (key === "workers-ai") {
        if (this.isCold(this.cloudflareWorkersAi, this.cloudflareFetched)) this.cloudflareStale = true;
      } else if (key === "mistral") {
        if (this.isCold(this.mistralAliases, this.mistralFetched)) this.mistralStale = true;
      } else if (key === "ramp_router") {
        if (this.isCold(this.rampRouter, this.rampRouterFetched)) this.rampRouterStale = true;
      }
    }
  }

  /** True when a table needs fetching: absent, or older than the TTL. */
  private isCold(table: unknown | null, fetchedAt: number): boolean {
    return table === null || Date.now() - fetchedAt >= this.ttlMs;
  }

  /**
   * Adopt a Mistral API key discovered from a wrapped client, so alias
   * resolution can run without ever requiring the customer to also
   * declare it in LagoConfig — their Mistral client already carries the
   * exact credential needed. Pure in-memory, no I/O. A key explicitly set
   * via LagoConfig.mistralApiKey always wins over one learned this way
   * (see HttpPricingFetcher.fetchMistralAliases); this only fills the gap
   * when no explicit key was configured.
   */
  learnMistralApiKey(apiKey: string): void {
    if (!apiKey) return;
    if (!this.mistralApiKeyOverride) this.mistralApiKeyOverride = apiKey;
  }

  /**
   * Adopt the Router key a wrapped OpenAI client already carries, so the catalog can be
   * fetched without a separate `LagoConfig.rampRouterApiKey`. Pure in-memory, no I/O.
   * Same precedence as the Mistral key: an explicit config value wins, and the first
   * learned key is kept.
   */
  learnRampRouterApiKey(apiKey: string): void {
    if (!apiKey) return;
    if (!this.rampRouterApiKeyOverride) this.rampRouterApiKeyOverride = apiKey;
  }

  /** Non-blocking, pure in-memory lookup (runs on the customer's call). */
  lookup(provider: string, model: string, api: string): ModelPrice | null {
    try {
      if ((api || "").startsWith("bedrock")) {
        const region = parseBedrockRegion(model, this.defaultRegion);
        const table = this.bedrock.get(region);
        const fresh = table !== undefined && Date.now() - (this.bedrockFetched.get(region) ?? 0) < this.ttlMs;
        if (!fresh) this.bedrockStale.add(region);
        return table !== undefined ? lookupBedrock(table, model) : null;
      }
      if ((provider || "").toLowerCase() === "ramp_router") {
        const table = this.rampRouter;
        const fresh = table !== null && Date.now() - this.rampRouterFetched < this.ttlMs;
        if (!fresh) this.rampRouterStale = true;
        return table !== null ? lookupRampRouter(table, model) : null;
      }
      if ((provider || "").toLowerCase() === "workers-ai") {
        const table = this.cloudflareWorkersAi;
        const fresh = table !== null && Date.now() - this.cloudflareFetched < this.ttlMs;
        if (!fresh) this.cloudflareStale = true;
        const hit = table !== null ? lookupCloudflareWorkersAi(table, model) : null;
        if (hit !== null || model.startsWith("@") || model.startsWith(WORKERS_AI_COMPAT_PREFIX)) return hit;
        // A bare `vendor/model` id the catalog does not list: a partner model. Its rate lives
        // in the gateway's cost table — fetched per id, in the background.
        const fetchedAt = this.cfGatewayCostsFetched.get(model);
        if (fetchedAt === undefined || Date.now() - fetchedAt >= this.ttlMs) {
          // Cold or past the TTL: queue a (re)fetch for the next tick. A row we already hold
          // keeps serving meanwhile — stale-while-revalidate, the same as the catalog table —
          // so a TTL expiry never bills a call as tokens. Only a never-fetched id misses.
          this.cfGatewayPending.add(model);
        }
        return this.cfGatewayCosts.get(model) ?? null;
      }
      let resolvedModel = model;
      const isMistral = (provider || "").toLowerCase() === "mistral";
      if (isMistral) {
        const aliases = this.mistralAliases;
        const freshM = aliases !== null && Date.now() - this.mistralFetched < this.ttlMs;
        if (!freshM) this.mistralStale = true;
        // Cold/miss: resolvedModel stays the alias as-requested, and the
        // OpenRouter lookup below misses safely, same as before this
        // resolution step existed — never worse than the old behavior,
        // only better once the table is warm.
        if (aliases) resolvedModel = aliases.get(model) ?? model;
      }
      const fresh = this.openrouter !== null && Date.now() - this.openrouterFetched < this.ttlMs;
      if (!fresh) this.openrouterStale = true;
      return this.openrouter !== null ? lookupOpenRouter(this.openrouter, provider, resolvedModel) : null;
    } catch {
      return null;
    }
  }

  /** Background refresh — awaited by the queue's loop. Fast-path no-op when nothing is stale.
   *
   * The four sources are independent: no ordering dependency, no shared state beyond
   * their own table. They run CONCURRENTLY, so one slow or hanging endpoint delays only
   * itself rather than everything queued behind it — a sequential walk of four 10s
   * timeouts is a 40s tick. `allSettled` because `refreshSource` already contains every
   * failure; it is here so one unexpected rejection can never leave the rest unawaited.
   */
  async maybeRefresh(): Promise<void> {
    if (
      !this.openrouterStale &&
      this.bedrockStale.size === 0 &&
      !this.cloudflareStale &&
      !this.mistralStale &&
      !this.rampRouterStale &&
      this.cfGatewayPending.size === 0
    ) {
      return;
    }

    const jobs: Array<Promise<void>> = [];

    if (this.openrouterStale) {
      jobs.push(
        this.refreshSource("openrouter", "pricing.fetchOpenRouter", async () => {
          const table = await this.fetcher.fetchOpenRouter();
          this.openrouter = table;
          this.openrouterFetched = Date.now();
          this.openrouterStale = false;
        }),
      );
    }

    if (this.cloudflareStale) {
      jobs.push(
        this.refreshSource("cloudflare_workers_ai", "pricing.fetchCloudflareWorkersAi", async () => {
          const table = await this.fetcher.fetchCloudflareWorkersAi();
          this.cloudflareWorkersAi = table;
          this.cloudflareFetched = Date.now();
          this.cloudflareStale = false;
        }),
      );
    }

    if (this.mistralStale) {
      jobs.push(
        this.refreshSource("mistral_aliases", "pricing.fetchMistralAliases", async () => {
          const aliases = await this.fetcher.fetchMistralAliases(this.mistralApiKeyOverride);
          this.mistralAliases = aliases;
          this.mistralFetched = Date.now();
          this.mistralStale = false;
        }),
      );
    }

    if (this.rampRouterStale) {
      jobs.push(
        this.refreshSource("ramp_router", "pricing.fetchRampRouter", async () => {
          const table = await this.fetcher.fetchRampRouter(this.rampRouterApiKeyOverride);
          this.rampRouter = table;
          this.rampRouterFetched = Date.now();
          this.rampRouterStale = false;
        }),
      );
    }

    for (const region of [...this.bedrockStale]) {
      jobs.push(
        this.refreshSource(`bedrock:${region}`, "pricing.fetchBedrock", async () => {
          const table = await this.fetcher.fetchBedrock(region);
          this.bedrock.set(region, table);
          this.bedrockFetched.set(region, Date.now());
          this.bedrockStale.delete(region);
        }),
      );
    }

    for (const model of [...this.cfGatewayPending]) {
      jobs.push(
        this.refreshSource(`cf_costs:${model}`, "pricing.fetchCloudflareGatewayCost", async () => {
          const price = await this.fetcher.fetchCloudflareGatewayCost(model);
          this.cfGatewayCosts.set(model, price);
          this.cfGatewayCostsFetched.set(model, Date.now());
          this.cfGatewayPending.delete(model);
        }),
      );
    }

    await Promise.allSettled(jobs);
  }

  /** Run one source's fetch, guarded by the in-flight set AND its retry backoff.
   *
   * A source stays flagged stale on failure — the event is still unpriced, so the
   * retry must happen; `retryAfterMs` is what decides WHEN, instead of "every tick".
   */
  private async refreshSource(source: string, where: string, run: () => Promise<void>): Promise<void> {
    if (this.refreshing.has(source)) return;
    const notBefore = this.retryAfterMs.get(source);
    if (notBefore !== undefined && Date.now() < notBefore) return;
    this.refreshing.add(source);
    try {
      await run();
      // Healthy again: the next failure starts the backoff over at 1s rather than
      // inheriting a ceiling reached hours ago.
      this.retryDelayMs.delete(source);
      this.retryAfterMs.delete(source);
    } catch (err) {
      const prev = this.retryDelayMs.get(source) ?? 0;
      const delay = prev === 0 ? FETCH_RETRY_BASE_MS : Math.min(prev * 2, FETCH_RETRY_MAX_MS);
      this.retryDelayMs.set(source, delay);
      this.retryAfterMs.set(source, Date.now() + delay);
      this.report(err, where);
    } finally {
      this.refreshing.delete(source);
    }
  }

  private report(err: unknown, where: string): void {
    if (this.onError) {
      try {
        this.onError(err, where);
      } catch {
        /* ignore */
      }
    }
  }
}
