/**
 * Pricing — optional dollar-cost computation for price mode.
 *
 * Fetches live, public, no-auth per-token unit prices and computes the cost of a
 * call as `Σ(unit_price × token_count) × markup`.
 *
 * Sources:
 *   - OpenRouter (https://openrouter.ai/api/v1/models) for native providers
 *     (anthropic / openai / mistral / gemini). Prices are USD per token.
 *   - AWS Bedrock Price List Bulk API (public, no credentials) for Bedrock.
 *
 * `lookup()` is pure in-memory and never does network I/O, so the customer's
 * call is never blocked on pricing. All HTTP happens in `maybeRefresh()`, which
 * the EventQueue's background loop awaits on its flush tick. A cold/missing
 * table returns null → the caller falls back to token events (never under-bill).
 *
 * Money uses fixed-point BigInt scaled by 1e12, floored (truncated) to 12
 * decimal places — deterministic and identical to the Python implementation.
 */

export const OPENROUTER_URL = "https://openrouter.ai/api/v1/models";
export const AWS_PRICING_HOST = "https://pricing.us-east-1.amazonaws.com";
export const AWS_BEDROCK_REGION_INDEX = `${AWS_PRICING_HOST}/offers/v1.0/aws/AmazonBedrock/current/region_index.json`;

export const PRICED_FIELDS = ["input", "output", "cache_read", "cache_write", "reasoning"] as const;
export type PricedField = (typeof PRICED_FIELDS)[number];

// Providers whose reported `input` ALREADY includes the cached (cache_read)
// tokens — cache_read is a subset of input, not additive — and whose `output`
// already includes reasoning. Pricing the parent at full count AND the subset
// separately would double-bill. Anthropic reports input exclusive of cache
// (cache_read/cache_write additive) and Gemini's `thoughts` are additive, so
// they're absent from the respective sets.
const INPUT_INCLUDES_CACHE_READ = new Set(["openai", "gemini"]);
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
const DEC_RE = /^\d+(\.\d+)?$/;

/** Parse a non-negative decimal string/number to a BigInt scaled by 1e12 (truncated). null on invalid/negative. */
export function parseScaled(value: unknown): bigint | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const s = String(value).trim();
  if (!DEC_RE.test(s)) return null; // rejects negatives, NaN, Infinity, junk
  const [intPart, fracPart = ""] = s.split(".");
  const frac12 = (fracPart + "000000000000").slice(0, 12);
  try {
    return BigInt(intPart) * SCALE + BigInt(frac12);
  } catch {
    return null;
  }
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

function stripVersion(model: string): string {
  return model.replace(/-(?:\d{8}|v\d+)$/, "");
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
  // base (1e12) * markup (1e12) / 1e12 -> 1e12, truncated (floor) — matches Python ROUND_DOWN.
  const totalScaled = (baseScaled * markupScaled) / SCALE;
  return {
    total: fmtMoney(totalScaled),
    totalCents: fmtMoney(totalScaled * 100n),
    base: fmtMoney(baseScaled),
    markup: fmtMoney(markupScaled),
    source: price.source,
    fields,
  };
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
    exact.set(id, mp);
    const slash = id.indexOf("/");
    if (slash > 0) {
      const vendor = id.slice(0, slash).toLowerCase();
      const suffix = id.slice(slash + 1);
      normMap.set(`${vendor}\n${norm(suffix)}`, mp);
    }
  }
  return { exact, norm: normMap };
}

export function lookupOpenRouter(table: OpenRouterTable, provider: string, model: string): ModelPrice | null {
  const vendor = VENDOR_MAP[(provider || "").toLowerCase()] ?? (provider || "").toLowerCase();
  return (
    table.exact.get(`${vendor}/${model}`) ??
    table.norm.get(`${vendor}\n${norm(model)}`) ??
    table.norm.get(`${vendor}\n${norm(stripVersion(model))}`) ??
    null
  );
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
}

export class HttpPricingFetcher implements PricingFetcher {
  constructor(private timeoutMs: number = 10_000) {}

  private async getJson(url: string): Promise<unknown> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const resp = await fetch(url, { signal: ctrl.signal });
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
  private refreshing = new Set<string>();

  constructor(
    opts: {
      fetcher?: PricingFetcher;
      ttlMs?: number;
      defaultRegion?: string;
      onError?: (err: unknown, where: string) => void;
    } = {},
  ) {
    this.fetcher = opts.fetcher ?? new HttpPricingFetcher();
    this.ttlMs = opts.ttlMs ?? 3_600_000;
    this.defaultRegion = opts.defaultRegion ?? "us-east-1";
    this.onError = opts.onError;
  }

  /** Flag the OpenRouter table for an eager warm (price mode as the global default). */
  prime(): void {
    this.openrouterStale = true;
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
      const fresh = this.openrouter !== null && Date.now() - this.openrouterFetched < this.ttlMs;
      if (!fresh) this.openrouterStale = true;
      return this.openrouter !== null ? lookupOpenRouter(this.openrouter, provider, model) : null;
    } catch {
      return null;
    }
  }

  /** Background refresh — awaited by the queue's loop. Fast-path no-op when nothing is stale. */
  async maybeRefresh(): Promise<void> {
    if (!this.openrouterStale && this.bedrockStale.size === 0) return;

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
