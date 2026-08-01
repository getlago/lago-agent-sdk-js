/** The billing hook: raw provider payload → CanonicalUsage → priced Lago
 * events → durable outbox.
 *
 * Bifrost's usage/cost fields are never trusted for billing. We extract from
 * `extra_fields.raw_response` (byte-faithful provider payload) via the SDK's
 * native adapters, and fall back to Bifrost's normalized usage only when no
 * raw frame is available (ADR-001 spike: the final stream chunk is
 * synthesized and carries normalized usage only).
 */
import {
  buildCostEvent,
  buildTokenEvents,
  coerceMarkup,
  extractAnthropicNative,
  extractBedrockConverse,
  extractGeminiNative,
  extractMistralNative,
  extractOpenAINative,
  makeCanonicalUsage,
  PricingUnavailableError,
  type CanonicalUsage,
  type EventTransport,
  type PricingProvider,
} from "@getlago/agent-sdk/core";

export interface BillingContext {
  outbox: EventTransport;
  pricing: PricingProvider;
  pricingMode: "price" | "tokens";
  markup: number;
  metricCodes: Record<string, string>;
  costMetricCode: string;
  onError: (err: unknown, where: string) => void;
}

/** Bifrost-normalized usage (OpenAI-flavored, plus cache write details). */
interface NormalizedUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
    cached_read_tokens?: number;
    cached_write_tokens?: number;
    cached_write_token_details?: {
      cached_write_tokens_5m?: number;
      cached_write_tokens_1h?: number;
    };
  };
  completion_tokens_details?: {
    reasoning_tokens?: number;
  };
}

function extractRaw(provider: string, raw: unknown, model: string): CanonicalUsage | null {
  try {
    switch (provider) {
      case "anthropic":
        return extractAnthropicNative(raw, model);
      case "openai":
        return extractOpenAINative(raw, model);
      case "mistral":
        return extractMistralNative(raw, model);
      case "gemini":
      case "vertex":
        return extractGeminiNative(raw, model);
      case "bedrock":
        return extractBedrockConverse(raw, model);
      default:
        return null;
    }
  } catch {
    return null;
  }
}

function hasUsage(u: CanonicalUsage | null): u is CanonicalUsage {
  return !!u && (u.input > 0 || u.output > 0);
}

/** Map Bifrost's normalized usage into CanonicalUsage (fallback path). */
export function fromNormalizedUsage(
  usage: NormalizedUsage | null | undefined,
  model: string,
  provider: string,
): CanonicalUsage | null {
  if (!usage) return null;
  const ptd = usage.prompt_tokens_details ?? {};
  const ctd = usage.completion_tokens_details ?? {};
  const cacheRead = ptd.cached_read_tokens ?? ptd.cached_tokens ?? 0;
  const cacheWrite = ptd.cached_write_tokens ?? 0;
  const details = ptd.cached_write_token_details ?? {};
  const input = usage.prompt_tokens ?? 0;
  const output = usage.completion_tokens ?? 0;
  if (input === 0 && output === 0) return null;
  return makeCanonicalUsage({
    // Bifrost folds cache reads and writes into prompt_tokens; CanonicalUsage
    // treats input as the non-cache portion (the pricing de-overlap carves
    // cache_read out of input for openai/gemini, and Anthropic reports them
    // separately at the source).
    input: Math.max(0, input - cacheRead - cacheWrite),
    output,
    cache_read: cacheRead,
    cache_write: cacheWrite,
    cache_write_5m: details.cached_write_tokens_5m ?? 0,
    cache_write_1h: details.cached_write_tokens_1h ?? 0,
    reasoning: ctd.reasoning_tokens ?? 0,
    model,
    provider,
    api: "gateway_normalized",
    extras: {},
  });
}

/** Non-streaming Bifrost response body → CanonicalUsage. */
export function usageFromResponse(body: Record<string, unknown>): CanonicalUsage | null {
  const extra = (body.extra_fields ?? {}) as Record<string, unknown>;
  const provider = String(extra.provider ?? "");
  const model = String(body.model ?? extra.resolved_model_used ?? "");
  const fromRaw = extractRaw(provider, extra.raw_response, model);
  if (hasUsage(fromRaw)) return withProvider(fromRaw, provider);
  const fallback = fromNormalizedUsage(body.usage as NormalizedUsage | undefined, model, provider);
  return fallback;
}

/** Streamed response: raw provider SSE events + the final normalized usage. */
export function usageFromStream(
  provider: string,
  model: string,
  rawEvents: string[],
  finalNormalizedUsage: NormalizedUsage | null,
): CanonicalUsage | null {
  const parsed: Array<Record<string, unknown>> = [];
  for (const raw of rawEvents) {
    try {
      parsed.push(JSON.parse(raw) as Record<string, unknown>);
    } catch {
      /* skip unparseable frames; fallback covers us */
    }
  }
  const fromRaw = mergeStreamUsage(provider, model, parsed);
  if (hasUsage(fromRaw)) return withProvider(fromRaw, provider);
  return fromNormalizedUsage(finalNormalizedUsage, model, provider);
}

function mergeStreamUsage(
  provider: string,
  model: string,
  events: Array<Record<string, unknown>>,
): CanonicalUsage | null {
  if (events.length === 0) return null;
  if (provider === "anthropic") {
    // input/cache counts arrive on message_start.message.usage; the
    // authoritative output count arrives on message_delta.usage.
    let startUsage: Record<string, unknown> | null = null;
    let deltaUsage: Record<string, unknown> | null = null;
    let msgModel = model;
    for (const ev of events) {
      if (ev.type === "message_start" && isObj(ev.message)) {
        const msg = ev.message as Record<string, unknown>;
        if (isObj(msg.usage)) startUsage = msg.usage as Record<string, unknown>;
        if (typeof msg.model === "string") msgModel = msg.model;
      }
      if (ev.type === "message_delta" && isObj(ev.usage)) {
        deltaUsage = ev.usage as Record<string, unknown>;
      }
    }
    if (!startUsage && !deltaUsage) return null;
    return extractAnthropicNative({ model: msgModel, usage: { ...startUsage, ...deltaUsage } }, msgModel);
  }
  // OpenAI-compatible chunk streams (openai, mistral): the last chunk that
  // carries a usage object is authoritative and extractor-compatible.
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    // Mistral stream chunks nest the payload under `data`.
    const mistralUsage = isObj(ev.data) ? (ev.data as Record<string, unknown>).usage : undefined;
    if (provider === "mistral" && (isObj(ev.usage) || isObj(mistralUsage))) {
      return extractMistralNative({ model, usage: ev.usage ?? mistralUsage }, model);
    }
    if (isObj(ev.usage)) {
      return extractOpenAINative(ev, model);
    }
    if (isObj(ev.usageMetadata) || isObj(ev.usage_metadata)) {
      return extractGeminiNative(ev, model);
    }
  }
  return null;
}

function withProvider(usage: CanonicalUsage, provider: string): CanonicalUsage {
  if (!usage.provider) usage.provider = provider;
  return usage;
}

export interface BillOutcome {
  billed: boolean;
  mode: "price" | "tokens" | "tokens_fallback";
  events: number;
  /** Billing events the outbox refused. Must be 0; the pre-request
   * backpressure gate exists to make this impossible. */
  rejected: number;
}

/** Price and enqueue. Synchronous: the outbox write is the durability point
 * and must complete before the response is acked to the client. */
export function billUsage(
  ctx: BillingContext,
  usage: CanonicalUsage,
  subscriptionId: string,
  requestId: string,
  dimensions?: Record<string, unknown>,
): BillOutcome {
  const props = { request_id: requestId, ...(dimensions || {}) };
  let rejected = 0;
  const pushAll = (events: ReturnType<typeof buildTokenEvents>): number => {
    let n = 0;
    for (const event of events) {
      if (ctx.outbox.push(event) === "accepted") n++;
      else {
        rejected++;
        ctx.onError(new Error(`outbox rejected billing event ${event.transaction_id}`), "billing");
      }
    }
    return n;
  };

  if (ctx.pricingMode !== "price") {
    const n = pushAll(buildTokenEvents(usage, subscriptionId, ctx.metricCodes, { dimensions: props }));
    return { billed: n > 0, mode: "tokens", events: n, rejected };
  }
  const price = ctx.pricing.lookup(usage.provider, usage.model, usage.api);
  if (price === null) {
    // Never under-bill: no price → token events + onError, nothing dropped.
    ctx.onError(new PricingUnavailableError(usage.provider, usage.model, usage.api), "pricing");
    const n = pushAll(buildTokenEvents(usage, subscriptionId, ctx.metricCodes, { dimensions: props }));
    return { billed: n > 0, mode: "tokens_fallback", events: n, rejected };
  }
  const [markupScaled, ok] = coerceMarkup(ctx.markup);
  if (!ok) ctx.onError(new Error(`invalid markup ${ctx.markup}; using 1.0`), "pricing");
  const { event } = buildCostEvent(usage, subscriptionId, price, markupScaled, ctx.costMetricCode, {
    dimensions: props,
  });
  const n = pushAll([event]);
  return { billed: n > 0, mode: "price", events: n, rejected };
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
