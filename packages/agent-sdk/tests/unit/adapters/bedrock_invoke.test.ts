/** Bedrock InvokeModel adapter — dispatch + per-family extraction. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { extractBedrockInvoke, pickInvokeAdapter } from "../../../src/adapters/index.js";

const FIX = join(__dirname, "fixtures", "bedrock", "invoke");

const FAMILY_FIXTURES: Record<string, string> = {
  openai_compat_basic: "openai.gpt-oss-20b-1_0.json",
  openai_compat_with_details: "openai.gpt-oss-safeguard-20b.json",
  anthropic: "eu.anthropic.claude-sonnet-4-6.json",
  opus_4_7: "eu.anthropic.claude-opus-4-7.json",
  nova: "eu.amazon.nova-lite-v1_0.json",
  pixtral: "eu.mistral.pixtral-large-2502-v1_0.json",
  mistral_legacy: "mistral.mistral-large-2402-v1_0.json",
};

function load(family: string): { modelId: string; response: any } {
  const data = JSON.parse(readFileSync(join(FIX, FAMILY_FIXTURES[family]), "utf8"));
  return { modelId: data._model_id, response: data._response };
}

describe("pickInvokeAdapter", () => {
  it.each([
    ["eu.anthropic.claude-sonnet-4-6", "anthropic"],
    ["eu.anthropic.claude-opus-4-7", "opus_4_7"],
    ["eu.amazon.nova-lite-v1:0", "nova"],
    ["eu.mistral.pixtral-large-2502-v1:0", "pixtral"],
    ["mistral.mistral-large-2402-v1:0", "mistral_legacy"],
    ["mistral.mistral-7b-instruct-v0:2", "mistral_legacy"],
    ["mistral.mixtral-8x7b-instruct-v0:1", "mistral_legacy"],
    ["eu.mistral.ministral-3b-2410-v1:0", "openai_compat_basic"],
    ["openai.gpt-oss-safeguard-20b-1:0", "openai_compat_with_details"],
    ["openai.gpt-oss-safeguard-120b-1:0", "openai_compat_with_details"],
    ["eu.minimax.minimax-m2-v1:0", "openai_compat_with_details"],
    ["openai.gpt-oss-20b-1:0", "openai_compat_basic"],
    ["eu.qwen.qwen3-235b-a22b-instruct-2507-v1:0", "openai_compat_basic"],
  ])("%s → %s", (mid, expected) => {
    expect(pickInvokeAdapter(mid)).toBe(expected);
  });
});

describe("Bedrock InvokeModel adapter", () => {
  it("openai_compat_basic — gpt-oss-20b", () => {
    const { modelId, response } = load("openai_compat_basic");
    const u = extractBedrockInvoke(response, modelId);
    expect(u.input).toBe(72);
    expect(u.output).toBe(40);
    expect(u.provider).toBe("openai");
    expect(u.api).toBe("bedrock_invoke");
  });

  it("openai_compat_with_details — gpt-oss-safeguard", () => {
    const { modelId, response } = load("openai_compat_with_details");
    const u = extractBedrockInvoke(response, modelId);
    expect(u.input).toBe(72);
    expect(u.output).toBe(40);
    expect(u.reasoning).toBe(0);
    expect(u.extras.prompt_tokens_details).toBeDefined();
  });

  it("openai_compat_with_details — extracts reasoning when present", () => {
    const resp = {
      usage: {
        prompt_tokens: 10,
        completion_tokens: 50,
        completion_tokens_details: { reasoning_tokens: 12 },
      },
    };
    const u = extractBedrockInvoke(resp, "openai.gpt-oss-safeguard-20b-1:0");
    expect(u.reasoning).toBe(12);
  });

  it("anthropic — Sonnet 4.6", () => {
    const { modelId, response } = load("anthropic");
    const u = extractBedrockInvoke(response, modelId);
    expect(u.input).toBe(12);
    expect(u.output).toBe(36);
    expect(u.cache_read).toBe(0);
    expect(u.cache_write).toBe(0);
    expect(u.provider).toBe("anthropic");
  });

  it("anthropic — extracts ephemeral cache buckets", () => {
    const resp = {
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        cache_creation_input_tokens: 50,
        cache_creation: { ephemeral_5m_input_tokens: 30, ephemeral_1h_input_tokens: 20 },
      },
    };
    const u = extractBedrockInvoke(resp, "eu.anthropic.claude-sonnet-4-6");
    expect(u.cache_write).toBe(50);
    expect(u.cache_write_5m).toBe(30);
    expect(u.cache_write_1h).toBe(20);
  });

  it("anthropic — counts tool_use content blocks", () => {
    const resp = {
      usage: { input_tokens: 1, output_tokens: 2 },
      content: [{ type: "text" }, { type: "tool_use" }, { type: "tool_use" }],
    };
    const u = extractBedrockInvoke(resp, "eu.anthropic.claude-sonnet-4-6");
    expect(u.tool_calls).toBe(2);
  });

  it("opus_4_7 — service_tier lands in extras", () => {
    const { modelId, response } = load("opus_4_7");
    const u = extractBedrockInvoke(response, modelId);
    expect(u.input).toBe(21);
    expect(u.output).toBe(36);
    expect(u.extras.service_tier).toBe("standard");
  });

  it("nova — Nova Lite", () => {
    const { modelId, response } = load("nova");
    const u = extractBedrockInvoke(response, modelId);
    expect(u.input).toBe(5);
    expect(u.output).toBe(18);
    expect(u.provider).toBe("amazon");
  });

  it("pixtral — request_count in extras", () => {
    const { modelId, response } = load("pixtral");
    const u = extractBedrockInvoke(response, modelId);
    expect(u.input).toBe(10);
    expect(u.output).toBe(21);
    expect("request_count" in u.extras).toBe(true);
  });

  it("mistral_legacy — _no_usage extras + zero numerics", () => {
    const { modelId, response } = load("mistral_legacy");
    const u = extractBedrockInvoke(response, modelId);
    expect(u.extras._no_usage).toBe(true);
    expect(u.input).toBe(0);
    expect(u.output).toBe(0);
    expect(u.provider).toBe("mistral");
  });

  it("survives non-dict usage", () => {
    expect(extractBedrockInvoke({ usage: true } as any, "eu.amazon.nova-lite-v1:0").input).toBe(0);
    expect(extractBedrockInvoke({ usage: "x" } as any, "eu.anthropic.claude-sonnet-4-6").input).toBe(0);
    expect(extractBedrockInvoke(null as any, "eu.anthropic.claude-sonnet-4-6").input).toBe(0);
  });
});
