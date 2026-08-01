/** Billing hook tests, using the exact wire shapes the ADR-001 spike captured
 * from Bifrost (raw_response object on non-stream, raw_response strings per
 * stream chunk, synthesized final chunk with normalized usage only). */
import { describe, expect, it } from "vitest";

import { parseOpenRouter, PricingProvider, type LagoEvent, type PushResult } from "@getlago/agent-sdk/core";
import { billUsage, usageFromResponse, usageFromStream, type BillingContext } from "../../src/billing.js";

const OPENAI_RAW_USAGE = {
  prompt_tokens: 120,
  completion_tokens: 45,
  total_tokens: 165,
  prompt_tokens_details: { cached_tokens: 80, audio_tokens: 0 },
  completion_tokens_details: { reasoning_tokens: 17 },
};

function bifrostNonStreamBody(provider: string, raw: unknown, model: string): Record<string, unknown> {
  return {
    id: "chatcmpl-x",
    model,
    choices: [],
    usage: { prompt_tokens: 254, completion_tokens: 45 },
    extra_fields: { provider, raw_response: raw, request_type: "chat_completion" },
  };
}

describe("usageFromResponse", () => {
  it("prefers the raw provider payload over Bifrost's normalized usage", () => {
    const body = bifrostNonStreamBody(
      "openai",
      { id: "x", model: "gpt-4o", choices: [], usage: OPENAI_RAW_USAGE },
      "gpt-4o",
    );
    const usage = usageFromResponse(body);
    expect(usage).not.toBeNull();
    expect(usage!.input).toBe(120);
    expect(usage!.output).toBe(45);
    expect(usage!.cache_read).toBe(80);
    expect(usage!.reasoning).toBe(17);
    expect(usage!.provider).toBe("openai");
  });

  it("preserves the Anthropic cache TTL split from the raw payload", () => {
    const raw = {
      id: "msg_x",
      type: "message",
      model: "claude-sonnet-4-20250514",
      usage: {
        input_tokens: 10,
        output_tokens: 45,
        cache_creation_input_tokens: 44,
        cache_read_input_tokens: 200,
        cache_creation: { ephemeral_5m_input_tokens: 33, ephemeral_1h_input_tokens: 11 },
      },
    };
    const usage = usageFromResponse(bifrostNonStreamBody("anthropic", raw, "claude-sonnet-4-20250514"));
    expect(usage!.input).toBe(10);
    expect(usage!.cache_read).toBe(200);
    expect(usage!.cache_write).toBe(44);
    expect(usage!.cache_write_5m).toBe(33);
    expect(usage!.cache_write_1h).toBe(11);
  });

  it("falls back to normalized usage when no raw payload exists", () => {
    const body = {
      model: "gpt-4o",
      usage: {
        prompt_tokens: 254,
        completion_tokens: 45,
        prompt_tokens_details: {
          cached_read_tokens: 200,
          cached_write_tokens: 44,
          cached_write_token_details: { cached_write_tokens_5m: 33, cached_write_tokens_1h: 11 },
        },
      },
      extra_fields: { provider: "anthropic" },
    };
    const usage = usageFromResponse(body);
    expect(usage!.input).toBe(10); // 254 - 200 - 44
    expect(usage!.cache_read).toBe(200);
    expect(usage!.cache_write_5m).toBe(33);
    expect(usage!.cache_write_1h).toBe(11);
  });

  it("returns null when there is nothing billable", () => {
    expect(usageFromResponse({ model: "gpt-4o", extra_fields: { provider: "openai" } })).toBeNull();
  });
});

describe("usageFromStream", () => {
  it("merges Anthropic message_start and message_delta raw frames", () => {
    const rawEvents = [
      JSON.stringify({
        type: "message_start",
        message: {
          id: "msg_1",
          model: "claude-sonnet-4-20250514",
          usage: {
            input_tokens: 10,
            output_tokens: 1,
            cache_read_input_tokens: 200,
            cache_creation_input_tokens: 44,
            cache_creation: { ephemeral_5m_input_tokens: 33, ephemeral_1h_input_tokens: 11 },
          },
        },
      }),
      JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } }),
      JSON.stringify({
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 45 },
      }),
    ];
    const usage = usageFromStream("anthropic", "claude-sonnet-4-20250514", rawEvents, null);
    expect(usage!.input).toBe(10);
    expect(usage!.output).toBe(45);
    expect(usage!.cache_read).toBe(200);
    expect(usage!.cache_write_5m).toBe(33);
    expect(usage!.cache_write_1h).toBe(11);
  });

  it("uses the last OpenAI chunk that carries usage", () => {
    const rawEvents = [
      JSON.stringify({
        id: "c",
        object: "chat.completion.chunk",
        model: "gpt-4o",
        choices: [{ delta: { content: "x" } }],
      }),
      JSON.stringify({
        id: "c",
        object: "chat.completion.chunk",
        model: "gpt-4o",
        choices: [],
        usage: OPENAI_RAW_USAGE,
      }),
    ];
    const usage = usageFromStream("openai", "gpt-4o", rawEvents, null);
    expect(usage!.input).toBe(120);
    expect(usage!.output).toBe(45);
    expect(usage!.reasoning).toBe(17);
  });

  it("falls back to the synthesized final chunk's normalized usage", () => {
    const usage = usageFromStream("anthropic", "claude-sonnet-4-20250514", [], {
      prompt_tokens: 254,
      completion_tokens: 45,
      prompt_tokens_details: {
        cached_read_tokens: 200,
        cached_write_tokens: 44,
        cached_write_token_details: { cached_write_tokens_5m: 33, cached_write_tokens_1h: 11 },
      },
    });
    expect(usage!.output).toBe(45);
    expect(usage!.cache_write_1h).toBe(11);
  });

  it("returns null for malformed frames with no usable usage (no phantom billing)", () => {
    expect(usageFromStream("openai", "gpt-4o", ["{not json", "also not json"], null)).toBeNull();
  });
});

describe("billUsage", () => {
  function makeCtx(overrides: Partial<BillingContext> = {}): {
    ctx: BillingContext;
    pushed: LagoEvent[];
    errors: Array<{ where: string }>;
  } {
    const pushed: LagoEvent[] = [];
    const errors: Array<{ where: string }> = [];
    const pricing = new PricingProvider({
      fetcher: {
        fetchOpenRouter: async () =>
          parseOpenRouter({
            data: [
              {
                id: "openai/gpt-4o",
                pricing: { prompt: "0.0000025", completion: "0.00001", input_cache_read: "0.00000125" },
              },
            ],
          }),
        fetchBedrock: async () => new Map(),
      },
    });
    pricing.prime();
    const ctx: BillingContext = {
      outbox: {
        push: (e: LagoEvent): PushResult => {
          pushed.push(e);
          return "accepted";
        },
        flush: async () => true,
        shutdown: async () => {},
        depth: () => 0,
        lagMs: () => 0,
      },
      pricing,
      pricingMode: "price",
      markup: 1.0,
      metricCodes: {
        input: "llm_input_tokens",
        output: "llm_output_tokens",
        cache_read: "llm_cached_input_tokens",
        reasoning: "llm_reasoning_tokens",
      },
      costMetricCode: "llm_cost",
      onError: (_err, where) => errors.push({ where }),
      ...overrides,
    };
    return { ctx, pushed, errors };
  }

  const usage = {
    input: 120,
    output: 45,
    cache_read: 80,
    cache_write: 0,
    cache_write_5m: 0,
    cache_write_1h: 0,
    reasoning: 17,
    tool_calls: 0,
    image_input: 0,
    audio_input: 0,
    audio_output: 0,
    model: "gpt-4o",
    provider: "openai",
    api: "chat_completions",
    extras: {},
  };

  it("price mode: one llm_cost event with request_id, priced from the table", async () => {
    const { ctx, pushed } = makeCtx();
    await ctx.pricing.maybeRefresh();
    const outcome = billUsage(ctx, usage, "sub_acme", "req-123");
    expect(outcome).toMatchObject({ billed: true, mode: "price", events: 1, rejected: 0 });
    expect(pushed).toHaveLength(1);
    const event = pushed[0];
    expect(event.code).toBe("llm_cost");
    expect(event.external_subscription_id).toBe("sub_acme");
    expect(event.properties.request_id).toBe("req-123");
    // Hand-recomputed (de-overlap carves cache_read out of input for openai;
    // reasoning is a subset of output for openai so it prices at 0 count):
    //   input:  (120 - 80) * 0.0000025  = 0.0001
    //   output: 45 * 0.00001            = 0.00045
    //   cache:  80 * 0.00000125         = 0.0001
    //   total                           = 0.00065
    expect(event.properties.value).toBe("0.00065");
    expect(event.precise_total_amount_cents).toBe("0.065");
  });

  it("never-under-bill: unknown model falls back to token events and fires onError", async () => {
    const { ctx, pushed, errors } = makeCtx();
    await ctx.pricing.maybeRefresh();
    const outcome = billUsage(ctx, { ...usage, model: "not-in-price-list" }, "sub_acme", "req-124");
    expect(outcome.mode).toBe("tokens_fallback");
    expect(outcome.events).toBeGreaterThan(0);
    expect(errors.some((e) => e.where === "pricing")).toBe(true);
    const codes = pushed.map((e) => e.code).sort();
    expect(codes).toContain("llm_input_tokens");
    expect(codes).toContain("llm_output_tokens");
    expect(codes).not.toContain("llm_cost");
  });

  it("applies markup to the cost event", async () => {
    const { ctx, pushed } = makeCtx({ markup: 1.2 });
    await ctx.pricing.maybeRefresh();
    billUsage(ctx, usage, "sub_acme", "req-125");
    // 0.00065 * 1.2 = 0.00078
    expect(pushed[0].properties.value).toBe("0.00078");
    expect(pushed[0].precise_total_amount_cents).toBe("0.078");
  });

  it("counts outbox rejections instead of silently dropping", async () => {
    const { ctx, errors } = makeCtx();
    await ctx.pricing.maybeRefresh();
    ctx.outbox.push = () => "rejected";
    const outcome = billUsage(ctx, usage, "sub_acme", "req-126");
    expect(outcome.rejected).toBe(1);
    expect(outcome.billed).toBe(false);
    expect(errors.some((e) => e.where === "billing")).toBe(true);
  });
});
