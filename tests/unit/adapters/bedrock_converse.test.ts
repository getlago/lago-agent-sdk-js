/** Bedrock Converse adapter — verified against shared fixtures. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { extractBedrockConverse } from "../../../src/adapters/index.js";

const FIX = join(__dirname, "fixtures", "bedrock", "converse");

const FAMILY_FIXTURES: Record<string, string> = {
  standard: "eu.amazon.nova-lite-v1_0.json",
  cache_read_only: "eu.anthropic.claude-opus-4-7.json",
  full_cache: "eu.anthropic.claude-sonnet-4-6.json",
};

function load(family: string): { modelId: string; response: any } {
  const data = JSON.parse(readFileSync(join(FIX, FAMILY_FIXTURES[family]), "utf8"));
  return { modelId: data._model_id, response: data._response };
}

describe("Bedrock Converse adapter", () => {
  it("standard family — Nova Lite", () => {
    const { modelId, response } = load("standard");
    const u = extractBedrockConverse(response, modelId);
    expect(u.input).toBe(5);
    expect(u.output).toBe(17);
    expect(u.cache_read).toBe(0);
    expect(u.cache_write).toBe(0);
    expect(u.api).toBe("bedrock_converse");
    expect(u.provider).toBe("amazon");
    expect(u.tool_calls).toBe(0);
    expect(u.extras.serverToolUsage).toBeUndefined();
  });

  it("cache-read-only family — Opus 4.7", () => {
    const { modelId, response } = load("cache_read_only");
    const u = extractBedrockConverse(response, modelId);
    expect(u.input).toBe(21);
    expect(u.output).toBe(37);
    expect(u.cache_read).toBe(0);
    expect(u.cache_write).toBe(0);
    expect(u.provider).toBe("anthropic");
  });

  it("full-cache family — Sonnet 4.6", () => {
    const { modelId, response } = load("full_cache");
    const u = extractBedrockConverse(response, modelId);
    expect(u.input).toBe(12);
    expect(u.output).toBe(36);
    expect(u.provider).toBe("anthropic");
  });

  it("ignores cacheReadInputTokenCount alias (alias of *Tokens)", () => {
    const resp = {
      usage: {
        inputTokens: 10,
        outputTokens: 20,
        cacheReadInputTokens: 100,
        cacheReadInputTokenCount: 999,
      },
    };
    const u = extractBedrockConverse(resp, "eu.anthropic.claude-opus-4-7");
    expect(u.cache_read).toBe(100);
    expect(u.extras.cacheReadInputTokenCount).toBeUndefined();
  });

  it("flattens non-empty serverToolUsage into tool_calls", () => {
    const resp = { usage: { inputTokens: 1, outputTokens: 2, serverToolUsage: { webSearchRequests: 3 } } };
    const u = extractBedrockConverse(resp, "eu.amazon.nova-pro-v1:0");
    expect(u.tool_calls).toBe(3);
    expect(u.extras.serverToolUsage).toEqual({ webSearchRequests: 3 });
  });

  it("unknown field lands in extras", () => {
    const resp = { usage: { inputTokens: 1, outputTokens: 2, noveltyField: "drift" } };
    const u = extractBedrockConverse(resp, "eu.something.new");
    expect(u.extras.noveltyField).toBe("drift");
  });

  it("survives bad input — returns zeros", () => {
    expect(extractBedrockConverse(null as any).input).toBe(0);
    expect(extractBedrockConverse({}).output).toBe(0);
    expect(extractBedrockConverse({ usage: 42 } as any).input).toBe(0);
    expect(extractBedrockConverse({ usage: { inputTokens: "garbage" } } as any).input).toBe(0);
  });
});
