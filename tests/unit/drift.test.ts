/** Drift detection — unknown fields land in extras, not in numeric counts. */
import { describe, expect, it } from "vitest";

import { extractBedrockConverse, extractBedrockInvoke } from "../../src/adapters/index.js";

describe("Drift detection — Converse", () => {
  it("unknown top-level usage field goes to extras", () => {
    const resp = { usage: { inputTokens: 10, outputTokens: 20, futureCacheReadAtL1Tokens: 99 } };
    const u = extractBedrockConverse(resp, "eu.something.future");
    expect(u.input).toBe(10);
    expect(u.output).toBe(20);
    expect(u.extras.futureCacheReadAtL1Tokens).toBe(99);
  });

  it("known aliases do not pollute extras", () => {
    const resp = {
      usage: {
        inputTokens: 10,
        outputTokens: 20,
        cacheReadInputTokens: 5,
        cacheReadInputTokenCount: 5,
        cacheWriteInputTokenCount: 0,
        totalTokens: 30,
        serverToolUsage: {},
      },
    };
    const u = extractBedrockConverse(resp, "eu.anthropic.claude-sonnet-4-6");
    expect(u.cache_read).toBe(5);
    expect("cacheReadInputTokenCount" in u.extras).toBe(false);
    expect("cacheWriteInputTokenCount" in u.extras).toBe(false);
    expect("totalTokens" in u.extras).toBe(false);
  });
});

describe("Drift detection — Invoke", () => {
  it("anthropic — unknown top usage field lands in extras", () => {
    const resp = {
      usage: { input_tokens: 13, output_tokens: 39, newSpecialField: "spectacular" },
      content: [],
    };
    const u = extractBedrockInvoke(resp, "eu.anthropic.claude-sonnet-4-6");
    expect(u.extras.newSpecialField).toBe("spectacular");
  });

  it("opus_4_7 — service_tier in extras", () => {
    const resp = {
      usage: { input_tokens: 5, output_tokens: 7, service_tier: "priority" },
      content: [],
    };
    const u = extractBedrockInvoke(resp, "eu.anthropic.claude-opus-4-7");
    expect(u.extras.service_tier).toBe("priority");
  });

  it("openai_compat — prompt_tokens_details lands in extras (drift signal)", () => {
    const resp = {
      usage: {
        prompt_tokens: 73,
        completion_tokens: 80,
        prompt_tokens_details: { cached_tokens: 48 },
      },
    };
    const u = extractBedrockInvoke(resp, "openai.gpt-oss-safeguard-20b-1:0");
    expect(u.extras.prompt_tokens_details).toEqual({ cached_tokens: 48 });
  });
});
