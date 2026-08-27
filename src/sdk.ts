/** LagoSDK — primary entrypoint. */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

import { CanonicalUsage, NUMERIC_FIELDS, nonzeroNumeric } from "./canonical.js";
import { LagoConfig, PricingMode, makeConfig } from "./config.js";
import { detectClientKind } from "./detector.js";
import { PricingUnavailableError, UnknownClientError } from "./exceptions.js";
import { LagoClient, LagoEvent } from "./lago_client.js";
import {
  CostBreakdown,
  PricingProvider,
  TOKEN_BILLED_PROVIDERS,
  applyMarkup,
  coerceMarkup,
  computeCost,
  computePrecomputedCost,
  deoverlappedTokenTotal,
  moneyStrToCents,
} from "./pricing.js";
import { EventQueue } from "./queue.js";
import { wrapAnthropicClient } from "./wrappers/anthropic.js";
import { wrapBedrockClient } from "./wrappers/bedrock.js";
import { wrapGeminiClient } from "./wrappers/gemini.js";
import { wrapMistralClient } from "./wrappers/mistral.js";
import { wrapOpenAIClient } from "./wrappers/openai.js";

const subscriptionStore = new AsyncLocalStorage<string>();

export interface LagoSDKOptions {
  apiKey: string;
  apiUrl?: string;
  defaultSubscriptionId?: string | null;
  /**
   * TLS certificate verification for requests to `apiUrl`. Accepted directly so a
   * local dev Lago behind a self-signed cert (Traefik's default) needs no `config`
   * object at all — `{ apiKey, apiUrl, verifySsl: false }` is enough. Mirrors the
   * Python port's `verify_ssl=` parameter.
   */
  verifySsl?: boolean;
  config?: Partial<LagoConfig>;
}

/**
 * `LagoConfig` fields that `LagoSDKOptions` has no equivalent for. Presence of any of
 * them means a config object was handed in where options were expected — see the
 * constructor. `apiKey` / `apiUrl` / `defaultSubscriptionId` / `verifySsl` are
 * deliberately absent: those exist on BOTH, so they are not evidence of the mistake.
 */
const CONFIG_ONLY_KEYS = [
  "metricCodes",
  "flushIntervalMs",
  "maxBatchSize",
  "maxBufferSize",
  "requestTimeoutMs",
  "maxRetryMs",
  "onError",
  "pricingMode",
  "markup",
  "costMetricCode",
  "pricingTtlMs",
  "bedrockDefaultRegion",
] as const;

export interface WrapOptions {
  dimensions?: Record<string, unknown>;
  subscription?: string;
  /** Per-call override of the pricing mode (`tokens` | `price`). */
  mode?: PricingMode;
  /** Per-call override of the cost markup multiplier. */
  markup?: number;
  /**
   * Skip this SDK's own OpenRouter/Bedrock/Cloudflare price lookup and bill
   * this exact amount instead. For a gateway that reports its own real,
   * metered cost per call (e.g. Cloudflare AI Gateway's `cost` field on a
   * log entry), that number is more accurate than anything we'd compute
   * ourselves — this is the connector's one-call entrypoint rather than
   * hand-building a `precise_total_amount_cents` event. Only consulted
   * when the effective mode is "price"; ignored in token mode.
   */
  usdCost?: number;
  /**
   * Use this as Lago's idempotency key (`transaction_id`) instead of a
   * random UUID — pass the source log entry's own id when replaying/
   * backfilling from a gateway's logs, so re-running against the same
   * window never double-bills. A live, one-shot call has no natural id to
   * reuse and should leave this unset.
   *
   * Both multi-event paths suffix per field so they don't collide with each
   * other, and they use DIFFERENT namespaces so they can't collide across
   * modes either:
   *
   *   - token events      `${eventId}_tok_${fieldName}`
   *   - split cost events `${eventId}_cost_${fieldName}`
   *   - single cost event `eventId` (one event, nothing to disambiguate)
   *
   * The namespaces are load-bearing, because both paths are reachable for the SAME
   * `eventId`: a price lookup that misses falls back to token events, and the same
   * window re-run once the table is warm takes the cost path. Sharing one namespace
   * makes the second run a duplicate `transaction_id`, and since `/events/batch` is
   * all-or-nothing that rejection takes the whole batch with it.
   */
  eventId?: string;
  /**
   * Bill the events at this instant instead of at now — pass the source row's own
   * time when replaying/backfilling from a gateway's logs, or a window reaching
   * back a week bills every one of its calls into the period the script happens
   * to run in. Accepts a `Date` or epoch seconds.
   *
   * Deliberately NOT an ISO-8601 string: `new Date()` accepts the trailing "Z"
   * that gateway APIs emit while the Python port's `fromisoformat` rejects it on
   * 3.10, which is still supported there — so a string would parse in one repo
   * and fail in the other. Connectors parse their own source column instead,
   * where the shapes that column really returns are known and tested (see
   * `DatabricksUsageRow.occurredAt`). A live call has no source time and should
   * leave this unset.
   */
  timestamp?: number | Date;
}

/** A caller-supplied event time as the unix seconds Lago's `timestamp` wants. */
function toEpochSeconds(value: number | Date): number {
  // A numeric STRING is refused, not coerced: `Number("1786112523")` would sail
  // through here while the Python port's `isinstance` check rejects it, so the same
  // input would bill in one repo and report an error in the other.
  const ms = value instanceof Date ? value.getTime() : typeof value === "number" ? value * 1000 : NaN;
  // An Invalid Date and a NaN both arrive here as NaN, as does anything that is
  // neither a Date nor a number — the three cases the Python port raises on.
  if (!Number.isFinite(ms)) {
    throw new TypeError(
      `timestamp=${JSON.stringify(value)} not understood — pass a Date or ` +
        `epoch seconds (an ISO-8601 string is deliberately not accepted; see emit())`,
    );
  }
  // `trunc`, not `floor`, so a pre-epoch stamp rounds the same way Python's `int()` does.
  return Math.trunc(ms / 1000);
}

export class LagoSDK {
  config: LagoConfig;
  private client: LagoClient;
  private queue: EventQueue;
  private pricing: PricingProvider;
  /** (provider, model) pairs already noted as token-billed — see `noteTokenBilled`. */
  private tokenBilledNoted = new Set<string>();

  constructor(opts: LagoSDKOptions) {
    // `new LagoSDK(config)` is the natural-looking call, it TYPECHECKS — a `LagoConfig`
    // is structurally assignable to `LagoSDKOptions`, both starting with a required
    // `apiKey` — and it silently drops every field that only `config` can carry.
    // Measured: a config with `pricingMode: "price"` and an `onError` hook built an SDK
    // billing in TOKENS mode with no error hook wired and no warning anywhere, i.e. the
    // wrong bill, delivered successfully. Python's twin of this mistake is positional
    // (`LagoSDK(cfg)`) and 401s every event instead; both are silent, so both throw.
    const misplaced = CONFIG_ONLY_KEYS.filter((k) => k in opts);
    if (misplaced.length) {
      throw new TypeError(
        `LagoSDK takes { apiKey, config }, not a LagoConfig. These belong under ` +
          `\`config\` and were being ignored: ${misplaced.join(", ")}. ` +
          `Use new LagoSDK({ apiKey: config.apiKey, config }).`,
      );
    }
    // Explicit options win over `config`. Spread order is load-bearing: with `config`
    // last, a `config.apiUrl` would beat an explicitly passed `apiUrl` and bill a
    // different Lago instance than the Python port does.
    //
    // `apiUrl` is guarded on TRUTHINESS, not on `!== undefined` like its neighbours —
    // an empty string must not win either. This used to be `!== undefined`, which meant
    // the ports diverged on the same input: `apiUrl: process.env.LAGO_API_URL ?? ""`
    // with the var unset wrote `""` here while Python kept its default. Downstream that
    // is unrecoverable — `fetch("" + "/events/batch")` throws a plain TypeError, not a
    // `LagoApiError`, so `isPermanentFailure` calls it transient, the batch is
    // re-prepended and retried at the 60s ceiling forever. All billing stops, nothing is
    // dropped or escalated, and the only symptom is a growing buffer. Falling back is
    // right, but it must not be SILENT — see the report below.
    this.config = makeConfig({
      ...(opts.config || {}),
      apiKey: opts.apiKey,
      ...(opts.apiUrl ? { apiUrl: opts.apiUrl } : {}),
      ...(opts.defaultSubscriptionId !== undefined
        ? { defaultSubscriptionId: opts.defaultSubscriptionId }
        : {}),
      ...(opts.verifySsl !== undefined ? { verifySsl: opts.verifySsl } : {}),
    });
    // A caller who passed `apiUrl` explicitly MEANT to point somewhere specific.
    // Discarding a falsy one is the safe choice for delivery, but doing it silently is
    // the one outcome that must not happen here: the default is PRODUCTION, so the
    // fallback above now points a CI job or a developer holding a real production key at
    // production Lago, which accepts every event — and ingested events cannot be
    // un-ingested. Reported through the same log-plus-callback floor as every other drop
    // path rather than trusting an opt-in callback to exist.
    if (opts.apiUrl !== undefined && !opts.apiUrl) {
      this.reportError(
        new Error(
          `apiUrl was explicitly set to an empty value; falling back to ${this.config.apiUrl}. ` +
            `Set LAGO_API_URL (or pass config.apiUrl) if you did not intend to send events there.`,
        ),
        "config.apiUrl",
      );
    }
    this.client = new LagoClient(
      this.config.apiKey,
      this.config.apiUrl,
      this.config.requestTimeoutMs,
      this.config.verifySsl,
    );
    // Pricing provider (price mode). Default does no network until a price-mode
    // lookup flags a source stale; refreshes run on the queue loop.
    this.pricing =
      (this.config.pricingProvider as PricingProvider | undefined) ??
      new PricingProvider({
        ttlMs: this.config.pricingTtlMs,
        defaultRegion: this.config.bedrockDefaultRegion,
        onError: this.config.onError,
        cloudflareAccountId: this.config.cloudflareAccountId,
        cloudflareApiToken: this.config.cloudflareApiToken,
        mistralApiKey: this.config.mistralApiKey,
      });
    if (this.config.pricingMode === "price") this.pricing.prime(); // eager warm when price mode is the global default
    this.queue = new EventQueue(
      (batch) => this.client.sendBatch(batch),
      this.config.flushIntervalMs,
      this.config.maxBatchSize,
      this.config.maxBufferSize,
      this.config.maxRetryMs,
      this.config.onError,
      this.pricing,
    );
  }

  /** Run a callback with the given subscription bound in async-local context. */
  withSubscription<T>(subscriptionId: string, fn: () => T): T {
    return subscriptionStore.run(subscriptionId, fn);
  }

  /** One-shot setter — useful for middleware patterns where you set once per request. */
  setSubscription(subscriptionId: string): void {
    subscriptionStore.enterWith(subscriptionId);
  }

  private resolveSubscription(override?: string): string | null {
    return override || subscriptionStore.getStore() || this.config.defaultSubscriptionId || null;
  }

  /**
   * Non-blocking warm-up of the credential-gated pricing sources, triggered by `wrap()`
   * because it usually runs well before the first completion call. Price mode only.
   * `prime()`/`wake()` are pure in-memory; the HTTP fetch stays on the queue's loop.
   */
  private autoPrimePricingFor(kind: string, client: unknown): void {
    if (this.config.pricingMode !== "price") return;
    let provider: string | null = null;
    if (kind === "mistral") {
      // The client being wrapped already carries the exact Mistral API key
      // needed to call Mistral's own /v1/models for alias resolution — no
      // separate LagoConfig.mistralApiKey required.
      const key = LagoSDK.extractMistralApiKey(client);
      if (key) this.pricing.learnMistralApiKey(key);
      provider = "mistral";
    } else if (kind === "openai") {
      // An OpenAI-shaped client can point at real OpenAI or, via Cloudflare's
      // `.../compat` endpoint, at Workers AI; `baseURL` is the only signal available
      // before a response arrives. Defensive: some client variants omit it.
      let baseUrl = "";
      try {
        baseUrl = String((client as { baseURL?: unknown })?.baseURL ?? "");
      } catch {
        /* ignore */
      }
      if (baseUrl.includes("gateway.ai.cloudflare.com")) provider = "workers-ai";
    }
    if (provider) {
      this.pricing.prime([provider]);
      this.queue.wake();
    }
  }

  /**
   * `@mistralai/mistralai` keeps the constructor's key at `client._options.apiKey`. This
   * is an INTERNAL path: if a version moves it, this must degrade to "no key learned"
   * (then `LagoConfig.mistralApiKey`, then a lazy miss) rather than throw.
   */
  private static extractMistralApiKey(client: unknown): string | null {
    try {
      const key = (client as { _options?: { apiKey?: unknown } })?._options?.apiKey;
      return typeof key === "string" && key ? key : null;
    } catch {
      return null;
    }
  }

  /**
   * Block until the given price table(s) are fetched, instead of waiting
   * for the queue's background loop to pick them up on its next tick (up
   * to `flushIntervalMs` later, by default ~1s).
   *
   * Matters for a script or one-shot job, where the first call can beat that tick. A
   * miss falls back to token events — but in an `llm_cost`-only setup there is nowhere
   * to fall back to and the event is lost. OpenRouter is always warmed here.
   *
   * Workers AI and Mistral are credential-gated, so they are NOT warmed by default and
   * `wrap()` already primes them on a matching client. Name one — `["mistral"]`,
   * `["workers-ai"]` — only if you will call it WITHOUT `wrap()`.
   *
   * Resolves once the fetch was ATTEMPTED, not once it succeeded: a failure reports
   * through `onError` and leaves the table cold, same as a lazy miss.
   */
  async warmPricing(providers: string[] = []): Promise<void> {
    this.pricing.prime(providers);
    await this.pricing.maybeRefresh();
  }

  wrap<T extends object>(client: T, opts: WrapOptions = {}): T {
    const kind = detectClientKind(client);
    this.autoPrimePricingFor(kind, client);
    if (kind === "bedrock") {
      return wrapBedrockClient(this as never, client as never, opts) as T;
    }
    if (kind === "mistral") {
      return wrapMistralClient(this as never, client as never, opts) as T;
    }
    if (kind === "anthropic") {
      return wrapAnthropicClient(this as never, client as never, opts) as T;
    }
    if (kind === "openai") {
      return wrapOpenAIClient(this as never, client as never, opts) as T;
    }
    if (kind === "gemini") {
      return wrapGeminiClient(this as never, client as never, opts) as T;
    }
    if (kind === "gemini_legacy") {
      throw new UnknownClientError(
        "The legacy @google/generative-ai SDK (GoogleGenerativeAI) is not supported — " +
          "its surface differs from the unified SDK and cannot be instrumented. " +
          "Migrate to @google/genai: `npm install @google/genai`, then " +
          "`new GoogleGenAI({ apiKey })` and wrap that client. " +
          "See https://ai.google.dev/gemini-api/docs/migrate.",
      );
    }
    if (kind === "unknown") {
      throw new UnknownClientError(
        `Unknown client passed to wrap(): ${client.constructor?.name}. Supported: AWS SDK v3 BedrockRuntimeClient, @mistralai/mistralai Mistral, @anthropic-ai/sdk Anthropic, openai OpenAI, @google/genai GoogleGenAI.`,
      );
    }
    throw new UnknownClientError(
      `Client kind '${kind}' is not yet supported. Implemented: 'bedrock', 'mistral', 'anthropic', 'openai', 'gemini'.`,
    );
  }

  /**
   * Emit usage to Lago.
   *
   * In "tokens" mode (default), pushes one event per nonzero token field.
   * In "price" mode, pushes a single dollar-cost event (or one per
   * `token_type` — see `pushCostEvent`); if no price is available it falls
   * back to token events and reports via onError. Precedence for
   * mode/markup: per-call opt > config default.
   *
   * See `WrapOptions.usdCost`/`WrapOptions.eventId` for the connector-facing
   * (backfill/log-replay) use of this method.
   */
  emit(usage: CanonicalUsage, opts: WrapOptions = {}): void {
    try {
      // Resolved ONCE, ahead of every branch: a price-lookup miss falls through to
      // the token path, so one usage row can reach two of the push paths below. Two
      // separate `Date.now()` reads there let a call that straddles a billing-period
      // boundary land half in each period.
      const at = this.eventTime(opts.timestamp);
      const sub = this.resolveSubscription(opts.subscription);
      if (!sub) {
        this.reportError(new Error(`no subscription resolved for model=${usage.model}`), "emit");
        return;
      }
      const mode = opts.mode ?? this.config.pricingMode;
      if (mode !== "price") {
        if (opts.usdCost !== undefined && opts.usdCost !== null) {
          // A supplied cost that gets dropped must be reported, or a whole backfill
          // silently bills token counts only. Per occurrence, NOT deduped: the count of
          // discarded costs is what a caller reconciling on `onError` needs.
          this.reportError(
            new Error(
              `usdCost=${opts.usdCost} ignored: effective pricing mode is "${mode}", not ` +
                `"price" — emitting token counts instead. Pass mode: "price" per call, ` +
                `or set pricingMode: "price".`,
            ),
            "pricing",
          );
        }
        this.emitTokenEvents(usage, sub, opts.dimensions, opts.eventId, at);
        return;
      }
      const [markupScaled, ok] = coerceMarkup(opts.markup ?? this.config.markup);
      if (!ok) {
        this.reportError(
          new Error(`invalid markup ${opts.markup ?? this.config.markup}; using 1.0`),
          "pricing",
        );
      }

      let breakdown: CostBreakdown;
      // `!= null` deliberately covers BOTH undefined and null: an explicit null means
      // "no cost supplied" and must take the normal lookup path, not bill $0.00. Matches
      // Python's `usd_cost is not None`.
      if (opts.usdCost != null) {
        breakdown = computePrecomputedCost(opts.usdCost, markupScaled);
      } else if (TOKEN_BILLED_PROVIDERS.has(usage.provider)) {
        // NOT a failure, so deliberately not routed through onError: this provider
        // publishes no per-token rate at all, so token counts are the complete answer
        // rather than a fallback. Said once per model instead of once per call. See
        // TOKEN_BILLED_PROVIDERS for the reasoning.
        this.noteTokenBilled(usage);
        this.emitTokenEvents(usage, sub, opts.dimensions, opts.eventId, at);
        return;
      } else {
        const price = this.pricing.lookup(usage.provider, usage.model, usage.api);
        if (price === null) {
          // Don't silently under-bill: fall back to token events + report.
          this.reportError(new PricingUnavailableError(usage.provider, usage.model, usage.api), "pricing");
          this.emitTokenEvents(usage, sub, opts.dimensions, opts.eventId, at);
          return;
        }
        breakdown = computeCost(usage, price, markupScaled);
      }
      this.pushCostEvent(usage, breakdown, sub, opts.dimensions, opts.eventId, at);
    } catch (err) {
      this.reportError(err, "emit");
    }
  }

  /**
   * The instant to stamp this call's events with — the caller's, or now.
   *
   * A value we cannot read is reported and falls back to `now` rather than dropping
   * the call. Stamping the wrong period is a reconciliation problem the operator can
   * see and fix; losing the event is revenue that never appears at all. Same
   * trade-off as a missed price lookup.
   */
  private eventTime(timestamp?: number | Date): number {
    if (timestamp !== undefined && timestamp !== null) {
      try {
        return toEpochSeconds(timestamp);
      } catch (err) {
        this.reportError(err, "timestamp");
      }
    }
    return Math.floor(Date.now() / 1000);
  }

  private emitTokenEvents(
    usage: CanonicalUsage,
    sub: string,
    dimensions?: Record<string, unknown>,
    eventId?: string,
    at?: number,
  ): void {
    const counts = nonzeroNumeric(usage);
    // `emit` already resolved the instant; the fallback covers nothing today and is
    // kept only so this stays callable on its own without stamping the epoch.
    const now = at ?? Math.floor(Date.now() / 1000);
    for (const field of NUMERIC_FIELDS) {
      const value = counts[field];
      if (!value) continue;
      const code = this.config.metricCodes[field];
      if (!code) continue;
      this.queue.push({
        // `_tok_` namespace — see `WrapOptions.eventId` for why it must differ from
        // the cost path's.
        transaction_id: eventId ? `${eventId}_tok_${field}` : randomUUID(),
        external_subscription_id: sub,
        code,
        timestamp: now,
        properties: {
          value: String(value),
          model: usage.model,
          provider: usage.provider,
          api: usage.api,
          ...(dimensions || {}),
        },
      });
    }
  }

  /**
   * Push one llm_cost event — or several, one per token_type, when a real
   * per-field breakdown exists.
   *
   * `breakdown.fields` exists only when WE priced per token (`computeCost`), where a
   * unit price is known per field. Then it is one event per field tagged `token_type`,
   * so Lago's `grouped_by: ["model", "token_type"]` charge can split both ways.
   *
   * A precomputed `usdCost` (e.g. the gateway's own metered cost) is one lump sum, so it
   * bills ONE event with no `token_type` — splitting it proportionally would substitute
   * a guess for the real number we took `usdCost` to avoid guessing at.
   */
  private pushCostEvent(
    usage: CanonicalUsage,
    breakdown: CostBreakdown,
    sub: string,
    dimensions: Record<string, unknown> | undefined,
    eventId: string | undefined,
    at?: number,
  ): void {
    // See the note in `emitTokenEvents` — `emit` is the one authority on this.
    const now = at ?? Math.floor(Date.now() / 1000);
    // Caller dimensions are spread LAST in each `properties` below, not here — they
    // must win over every SDK-computed key, exactly as they already do in
    // `emitTokenEvents`. Spreading them into `baseProperties` put them *before*
    // `unit`/`value`/`base_cost`/`unit_price`, so those four silently overwrote a
    // caller's same-named dimension on this path while honouring it on the token
    // path — one customer config, two different outcomes.
    const baseProperties: Record<string, unknown> = {
      model: usage.model,
      provider: usage.provider,
      api: usage.api,
      price_source: breakdown.source,
      markup: breakdown.markup,
    };

    if (Object.keys(breakdown.fields).length === 0) {
      this.queue.push({
        // Unsuffixed: this branch pushes exactly ONE event, so there is nothing
        // to disambiguate. It cannot collide with the namespaced multi-event ids.
        transaction_id: eventId || randomUUID(),
        external_subscription_id: sub,
        code: this.config.costMetricCode,
        timestamp: now,
        precise_total_amount_cents: breakdown.totalCents,
        properties: {
          ...baseProperties,
          // Same basis as the split path below (which reports the de-overlapped
          // per-field `parts.tokens`), so the two branches can't report different
          // quantities for one call. `input + output` dropped `reasoning` and
          // `cache_write` entirely — on a real captured Gemini row with 9 in /
          // 21 out / 852 reasoning it published unit="30" for a call that
          // consumed 882 — and counted a cache-inclusive provider's cached
          // tokens at full weight.
          unit: String(deoverlappedTokenTotal(usage)),
          value: breakdown.total,
          base_cost: breakdown.base,
          ...(dimensions || {}),
        },
      });
      return;
    }

    for (const [fieldName, parts] of Object.entries(breakdown.fields)) {
      // parts.cost is PRE-markup (computeCost only applies markup to the
      // summed total) — apply it here or a markup != 1.0 silently vanishes
      // from every split event.
      const billedCost = applyMarkup(parts.cost, breakdown.markup);
      this.queue.push({
        // `_cost_` namespace — see the `_tok_` note in emitTokenEvents.
        transaction_id: eventId ? `${eventId}_cost_${fieldName}` : randomUUID(),
        external_subscription_id: sub,
        code: this.config.costMetricCode,
        timestamp: now,
        precise_total_amount_cents: moneyStrToCents(billedCost),
        properties: {
          ...baseProperties,
          token_type: fieldName,
          unit: parts.tokens,
          value: billedCost,
          base_cost: parts.cost,
          unit_price: parts.unit_price,
          ...(dimensions || {}),
        },
      });
    }
  }

  /**
   * Say it once per model, at info level.
   *
   * It is a standing fact about the provider, not an event about this call, so repeating
   * it per request would bury the log in something the reader can neither fix nor act on.
   */
  private noteTokenBilled(usage: CanonicalUsage): void {
    const key = `${usage.provider}\u0000${usage.model}`;
    if (this.tokenBilledNoted.has(key)) return;
    this.tokenBilledNoted.add(key);
    console.info(
      `[lago] ${usage.provider} bills ${JSON.stringify(usage.model)} in its own units, not ` +
        `per token — emitting token counts for it instead of a dollar cost`,
    );
  }

  /**
   * The SDK's single error channel: `config.onError` if set, and a `console.warn` floor
   * either way.
   *
   * Reachable from the wrappers on purpose, not private. A wrapper runs the ADAPTER that
   * parses a provider response, and that ran outside this boundary — so when a provider
   * drifted, the wrapper logged a line and stopped. Public in the sense that the package
   * calls it across module boundaries; not part of the supported API.
   *
   * @internal
   */
  reportError(err: unknown, where: string): void {
    if (this.config.onError) {
      try {
        this.config.onError(err, where);
      } catch {
        /* ignore */
      }
    }
    // The LOG is the floor, not the callback: `onError` is opt-in, so a customer who
    // never set one used to get literally nothing for a dropped event here while the
    // Python port logged a warning for the same one — the two repos reported 0 lines
    // vs 1 for an identical billing gap. Mirrors `_report_error`'s `logger.warning`.
    console.warn(`[lago] ${where} failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  /**
   * Read a window of Databricks AI Gateway usage and bill all of it.
   *
   * The one-call entrypoint: give it a window, it does the rest. Returns counts of what
   * it handed to `emit()`, e.g. `{cost: 56, tokens: 45, skipped: 0, deferred: 0}`.
   *
   * The last two are billing GAPS, and both are also reported through `config.onError`
   * (`where: "backfill"`) — the hook every other gap in this SDK uses — so a caller does
   * not have to inspect the return value to notice one. They fail differently: `skipped`
   * rows had no resolvable subscription and stay lost until they are tagged or a default
   * is set, while `deferred` buckets are billable revenue that the NEXT run of the same
   * window collects once Databricks has aggregated their spend row. A run with both at 0
   * is the only one that billed the whole window.
   *
   * Billing follows the rule the connector establishes rather than re-deriving it: a
   * BYOK row carries Databricks' own metered USD and bills as a dollar cost; a
   * Databricks-hosted row has no per-request dollar figure anywhere in Databricks'
   * system tables and bills as token counts.
   *
   * `unified: true` bills everything to `defaultSubscription`, ignoring per-call
   * `request_tags` — right when one gateway serves one customer. Left false, each row
   * goes to the subscription its own tags name, falling back to `defaultSubscription`
   * only when a row is untagged.
   *
   * Every event also carries the Databricks-side grouping key for its row —
   * `endpoint_name` for hosted, `bucket` for BYOK — so grouping Lago the same way the
   * Databricks page groups puts the two side by side. See
   * `DatabricksUsageRow.reconcileDimensions`. Anything in `dimensions` is added on top
   * and wins on a key collision.
   *
   * Idempotent: every event id is derived from the source row's own id and scoped by
   * subscription, so re-running the same window has Lago reject the duplicates rather
   * than double-bill. Does not flush — call `flush()` when you want to await delivery.
   *
   * `source` is normally a `DatabricksSource`, and `since` the window. It also accepts an
   * already-read array of `DatabricksUsageRow` — pass one when you have inspected the rows
   * first, so the window is read ONCE. Reading twice is not just slow: a SQL warehouse
   * costs roughly 1,500x the model-serving usage it reports on, and rows landing between
   * the two reads make the summary you printed disagree with what was billed.
   */
  async backfillDatabricks(
    source: { readUsage(since: any, opts?: { eventIdPrefix?: string }): Promise<any[]> } | any[],
    since: any = "1 day",
    opts: {
      defaultSubscription?: string;
      unified?: boolean;
      dimensions?: Record<string, unknown>;
      eventIdPrefix?: string;
    } = {},
  ): Promise<{ cost: number; tokens: number; skipped: number; deferred: number }> {
    const counts = { cost: 0, tokens: 0, skipped: 0, deferred: 0 };
    const reader = Array.isArray(source) ? undefined : source;
    const rows = reader
      ? await reader.readUsage(since, { eventIdPrefix: opts.eventIdPrefix ?? "dbx" })
      : (source as any[]);
    for (const row of rows) {
      const sub = opts.unified ? opts.defaultSubscription : row.subscription || opts.defaultSubscription;
      if (!sub) {
        // No attribution and no fallback — emit() would drop it anyway, but counting
        // it here makes the gap visible instead of silent.
        counts.skipped += 1;
        continue;
      }
      // Row's own reconciliation key first, so an explicit caller dimension of the same
      // name wins rather than being silently overwritten.
      const dims = { ...row.reconcileDimensions, ...(opts.dimensions || {}) };
      if (row.usdCost !== undefined) {
        this.emit(row.usage, {
          subscription: sub,
          dimensions: dims,
          mode: "price",
          usdCost: row.usdCost,
          // Keyed off the subscription actually billed, not the row's own tag — an
          // untagged row billed to the default must not carry an id that blocks it
          // from a different default on a later run.
          eventId: row.eventIdFor(sub),
          // The row's own time, not the run's — see `occurredAt`. A backfill that
          // stamps `now` bills last week's usage into this week's period, and
          // nothing in Lago can tell afterwards.
          timestamp: row.occurredAt,
        });
        counts.cost += 1;
      } else {
        this.emit(row.usage, {
          subscription: sub,
          dimensions: dims,
          mode: "tokens",
          eventId: row.eventIdFor(sub),
          timestamp: row.occurredAt,
        });
        counts.tokens += 1;
      }
    }

    // Both gaps below were counted but never reported: measured live over a window with
    // one hour's spend rows withheld — the shape of real spend-table lag — this returned
    // `{cost: 12, tokens: 54, skipped: 0}` while 54 BYOK buckets went unbilled and
    // `onError` fired zero times. `cost` alone dropping from 66 to 12 is not something an
    // automated caller can read as a gap, so route both through the hook that already
    // means "billing gap".
    if (counts.skipped) {
      this.reportError(
        new Error(
          `${counts.skipped} Databricks row(s) had no resolvable subscription and were NOT ` +
            `billed. Pass defaultSubscription, set LagoConfig.defaultSubscriptionId, or tag ` +
            `the calls.`,
        ),
        "backfill",
      );
    }
    // Only the reader knows about a bucket it never yielded, so a caller who passed an
    // already-read array gets 0 here — they hold the source and can read
    // `deferredBuckets` off it directly. Optional because `source` is duck-typed: a
    // caller's own reader need not carry the property.
    const deferred = reader ? ((reader as any).deferredBuckets ?? []) : [];
    counts.deferred = deferred.length;
    if (deferred.length) {
      const first = deferred[0];
      // `readUsage` logs this too. That is deliberate, not a stutter: a caller who reads
      // the window itself never reaches this line, and one who ran the backfill needs it on
      // the channel they reconcile against. Worded from the RUN's side so the two read as
      // one gap seen from two layers rather than as two gaps.
      this.reportError(
        new Error(
          `this run left ${deferred.length} Databricks BYOK bucket(s) unbilled: no ` +
            `external_model_spend row yet (e.g. hour=${first.hour} ` +
            `provider=${first.provider} model=${first.model}). The spend table lags; ` +
            `re-run this window later to bill them.`,
        ),
        "backfill",
      );
    }
    return counts;
  }

  flush(timeoutMs: number = 5000): Promise<boolean> {
    return this.queue.flush(timeoutMs);
  }

  shutdown(timeoutMs: number = 5000): Promise<void> {
    return this.queue.shutdown(timeoutMs);
  }

  /** Tests-only: replace the queue's sender. */
  _setSender(fn: (batch: LagoEvent[]) => Promise<void>): void {
    // @ts-expect-error — touching private field for test injection
    this.queue.sender = fn;
  }

  /** Tests-only: replace the pricing provider. */
  _setPricingProvider(provider: PricingProvider): void {
    this.pricing = provider;
    // @ts-expect-error — touching private field for test injection
    this.queue.pricing = provider;
  }

  /** Tests-only: read HTTP call counter. */
  _httpCalls(): number {
    return this.queue.httpCalls;
  }
}
