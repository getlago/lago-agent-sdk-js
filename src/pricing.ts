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
 *
 * `lookup()` is pure in-memory and O(1) — the customer's call is never blocked on
 * pricing. ALL HTTP happens in `maybeRefresh()`, on the queue's background loop. A cold
 * or missing table returns null and the caller falls back to token events; it must never
 * bill zero.
 *
 * Money is fixed-point BigInt scaled by 1e12, floored to 12dp — byte-identical to the
 * Python port's Decimal path, which `money_golden.json` pins in both repos.
 */

export const OPENROUTER_URL = "https://openrouter.ai/api/v1/models";
export const AWS_PRICING_HOST = "https://pricing.us-east-1.amazonaws.com";
export const AWS_BEDROCK_REGION_INDEX = `${AWS_PRICING_HOST}/offers/v1.0/aws/AmazonBedrock/current/region_index.json`;
export const cloudflareModelsUrl = (accountId: string): string =>
  `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/models/search`;
export const MISTRAL_MODELS_URL = "https://api.mistral.ai/v1/models";

export const PRICED_FIELDS = ["input", "output", "cache_read", "cache_write", "reasoning"] as const;
export type PricedField = (typeof PRICED_FIELDS)[number];

// MEMBERSHIP IS BILLING-CRITICAL. These two sets say whether a subset metric is already
// counted inside its parent; pricing the parent at full count AND the subset separately
// double-bills the overlap. Getting a provider's side wrong over-bills real customers,
// and the error scales with cache hit rate.
//
//   openai, gemini    — cache_read is INSIDE input (`prompt_tokens_details.cached_tokens`)
//   anthropic         — cache_read/cache_write are ADDITIVE to input, hence absent
//   workers-ai        — only ever reached through Cloudflare's OpenAI-COMPATIBLE
//                       endpoint, so the payload is the OpenAI shape and the OpenAI
//                       semantics apply. It is a separate provider only because it
//                       prices against Cloudflare's catalog (see inferProvider in
//                       adapters/openai_native.ts).
const INPUT_INCLUDES_CACHE_READ = new Set(["openai", "gemini", "workers-ai"]);
const OUTPUT_INCLUDES_REASONING = new Set(["openai"]);

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
 * Strip a trailing version/revision marker OpenRouter usually omits from its ids.
 *
 * Shapes seen live: Anthropic's compact date ("-20250929"), an explicit "-v2", and
 * Gemini's 3-digit revision ("-002", which `model_version` can report where
 * OpenRouter lists only the bare name). Verified safe against the live 415-model
 * catalog: ZERO ids have a model part ending in exactly three digits, so the
 * "-\d{3}" arm cannot shorten a real listing.
 */
function stripVersion(model: string): string {
  return model.replace(/-(?:\d{8}|\d{3}|v\d+)$/, "");
}

// ----------------------------------------------------------------------
// Price tables
// ----------------------------------------------------------------------
export interface ModelPrice {
  source: string; // "openrouter" | "aws_bedrock"
  input: bigint | null;
  output: bigint | null;
  cache_read: bigint | null;
  cache_write: bigint | null;
  reasoning: bigint | null;
}

function emptyPrice(source: string): ModelPrice {
  return { source, input: null, output: null, cache_read: null, cache_write: null, reasoning: null };
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
export type CanonicalUsageLike = { [K in PricedField]: number } & { provider?: string };

export function computeCost(
  usage: CanonicalUsageLike,
  price: ModelPrice,
  markupScaled: bigint,
): CostBreakdown {
  const provider = (usage.provider || "").toLowerCase();
  const counts = {} as Record<PricedField, number>;
  for (const f of PRICED_FIELDS) counts[f] = Number(usage[f]) || 0;
  // De-overlap subsets so a token is never billed twice (see the _INCLUDES_ sets):
  //   • reasoning ⊆ output → bill it as output only (drop the separate line).
  //   • cache_read ⊆ input → bill the cached portion at the cache-read rate, so
  //     subtract it from input (only when a cache_read price exists).
  if (OUTPUT_INCLUDES_REASONING.has(provider)) counts.reasoning = 0;
  if (
    INPUT_INCLUDES_CACHE_READ.has(provider) &&
    price.cache_read !== null &&
    price.cache_read !== undefined
  ) {
    counts.input = Math.max(0, counts.input - counts.cache_read);
  }

  let baseScaled = 0n;
  const fields: CostBreakdown["fields"] = {};
  for (const f of PRICED_FIELDS) {
    const count = counts[f];
    if (!count) continue;
    const unit = price[f];
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
 * Total tokens a call actually consumed, with per-provider overlaps removed.
 *
 * Sums the same PRICED_FIELDS the split cost path emits one event each for, so the
 * single-event `unit` equals the sum of the split path's `unit`s instead of
 * reporting a different basis. Both `_INCLUDES_` sets are applied, because a subset
 * counted twice inflates the reported quantity exactly as it would inflate a price:
 *
 *   - reasoning ⊆ output for providers in OUTPUT_INCLUDES_REASONING
 *   - cache_read ⊆ input  for providers in INPUT_INCLUDES_CACHE_READ
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
  const provider = (usage.provider || "").toLowerCase();
  const counts: Record<string, number> = {};
  for (const f of PRICED_FIELDS) counts[f] = Number((usage as any)[f] ?? 0) || 0;
  if (OUTPUT_INCLUDES_REASONING.has(provider)) counts.reasoning = 0;
  if (INPUT_INCLUDES_CACHE_READ.has(provider)) counts.cache_read = 0;
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
    table.norm.get(`${vendor}\n${norm(stripVersion(model))}`) ??
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
  fetchMistralAliases(apiKey?: string | null): Promise<Map<string, string>>;
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
 */
export class HttpPricingFetcher implements PricingFetcher {
  constructor(
    private timeoutMs: number = 10_000,
    private cloudflareAccountId?: string,
    private cloudflareApiToken?: string,
    private mistralApiKey?: string,
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

  async fetchMistralAliases(apiKey?: string | null): Promise<Map<string, string>> {
    // An explicitly configured key always wins over one learned from a
    // wrapped client — a deliberate config value shouldn't be silently
    // shadowed by an auto-detected one.
    const key = this.mistralApiKey || apiKey;
    if (!key) return new Map();
    const headers = { Authorization: `Bearer ${key}` };
    return parseMistralAliases(await this.getJson(MISTRAL_MODELS_URL, headers));
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
  private mistralAliases: Map<string, string> | null = null;
  private mistralFetched = 0;
  private mistralStale = false;
  // Learned from a wrapped Mistral client (see LagoSDK's auto-prime-on-wrap),
  // not configured — the customer's own client already carries this key for
  // making real calls, so alias resolution can reuse it without ever
  // requiring a separate LagoConfig.mistralApiKey.
  private mistralApiKeyOverride: string | null = null;
  private refreshing = new Set<string>();

  constructor(
    opts: {
      fetcher?: PricingFetcher;
      ttlMs?: number;
      defaultRegion?: string;
      onError?: (err: unknown, where: string) => void;
      cloudflareAccountId?: string;
      cloudflareApiToken?: string;
      mistralApiKey?: string;
    } = {},
  ) {
    this.fetcher =
      opts.fetcher ??
      new HttpPricingFetcher(10_000, opts.cloudflareAccountId, opts.cloudflareApiToken, opts.mistralApiKey);
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
   * Pass `providers: ["mistral"]` and/or `["workers-ai"]` when you already
   * know, in advance, which of these two you're about to call this
   * session — this eagerly warms exactly that source too, so even ITS
   * first call prices correctly instead of paying the one-time lazy
   * cold-start cost. Unknown provider names are silently ignored rather
   * than throwing, since this is a hint, not a contract.
   */
  prime(providers: string[] = []): void {
    this.openrouterStale = true;
    for (const p of providers) {
      const key = (p || "").toLowerCase();
      if (key === "workers-ai") this.cloudflareStale = true;
      else if (key === "mistral") this.mistralStale = true;
    }
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
      if ((provider || "").toLowerCase() === "workers-ai") {
        const table = this.cloudflareWorkersAi;
        const fresh = table !== null && Date.now() - this.cloudflareFetched < this.ttlMs;
        if (!fresh) this.cloudflareStale = true;
        return table !== null ? lookupCloudflareWorkersAi(table, model) : null;
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

  /** Background refresh — awaited by the queue's loop. Fast-path no-op when nothing is stale. */
  async maybeRefresh(): Promise<void> {
    if (
      !this.openrouterStale &&
      this.bedrockStale.size === 0 &&
      !this.cloudflareStale &&
      !this.mistralStale
    ) {
      return;
    }

    if (this.openrouterStale && !this.refreshing.has("openrouter")) {
      this.refreshing.add("openrouter");
      try {
        const table = await this.fetcher.fetchOpenRouter();
        this.openrouter = table;
        this.openrouterFetched = Date.now();
        this.openrouterStale = false;
      } catch (err) {
        this.report(err, "pricing.fetchOpenRouter");
      } finally {
        this.refreshing.delete("openrouter");
      }
    }

    if (this.cloudflareStale && !this.refreshing.has("cloudflare_workers_ai")) {
      this.refreshing.add("cloudflare_workers_ai");
      try {
        const table = await this.fetcher.fetchCloudflareWorkersAi();
        this.cloudflareWorkersAi = table;
        this.cloudflareFetched = Date.now();
        this.cloudflareStale = false;
      } catch (err) {
        this.report(err, "pricing.fetchCloudflareWorkersAi");
      } finally {
        this.refreshing.delete("cloudflare_workers_ai");
      }
    }

    if (this.mistralStale && !this.refreshing.has("mistral_aliases")) {
      this.refreshing.add("mistral_aliases");
      try {
        const aliases = await this.fetcher.fetchMistralAliases(this.mistralApiKeyOverride);
        this.mistralAliases = aliases;
        this.mistralFetched = Date.now();
        this.mistralStale = false;
      } catch (err) {
        this.report(err, "pricing.fetchMistralAliases");
      } finally {
        this.refreshing.delete("mistral_aliases");
      }
    }

    for (const region of [...this.bedrockStale]) {
      const key = `bedrock:${region}`;
      if (this.refreshing.has(key)) continue;
      this.refreshing.add(key);
      try {
        const table = await this.fetcher.fetchBedrock(region);
        this.bedrock.set(region, table);
        this.bedrockFetched.set(region, Date.now());
        this.bedrockStale.delete(region);
      } catch (err) {
        this.report(err, "pricing.fetchBedrock");
      } finally {
        this.refreshing.delete(key);
      }
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
