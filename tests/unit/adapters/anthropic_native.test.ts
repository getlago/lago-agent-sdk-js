/** Anthropic native adapter — verified against real fixtures. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { extractAnthropicNative } from "../../../src/adapters/index.js";

const FIX = join(__dirname, "fixtures", "anthropic_native");

function load(name: string): { modelId: string; response: any } {
  const data = JSON.parse(readFileSync(join(FIX, name), "utf8"));
  return { modelId: data._model_id, response: data._response };
}

describe("Anthropic native adapter — fixtures (captured via @anthropic-ai/sdk)", () => {
  it("plain haiku", () => {
    const { modelId, response } = load("01_plain_haiku.json");
    const u = extractAnthropicNative(response, modelId);
    expect(u.input).toBeGreaterThan(0);
    expect(u.output).toBeGreaterThan(0);
    expect(u.cache_read).toBe(0);
    expect(u.cache_write).toBe(0);
    expect(u.tool_calls).toBe(0);
    expect(u.api).toBe("native");
    expect(u.provider).toBe("anthropic");
  });

  it("tool use — counts content blocks of type tool_use", () => {
    const { modelId, response } = load("02_tool_use.json");
    const u = extractAnthropicNative(response, modelId);
    expect(u.tool_calls).toBeGreaterThanOrEqual(1);
    expect(u.input).toBeGreaterThan(0);
  });

  it("cache create — populates cache_write + cache_write_5m", () => {
    const { modelId, response } = load("03_cache_create.json");
    const u = extractAnthropicNative(response, modelId);
    expect(u.cache_write).toBeGreaterThan(0);
    expect(u.cache_write_5m).toBeGreaterThan(0);
    expect(u.cache_write_1h).toBe(0);
  });

  it("unknown top-level usage fields land in extras (drift)", () => {
    const { modelId, response } = load("01_plain_haiku.json");
    const u = extractAnthropicNative(response, modelId);
    // service_tier / inference_geo are new fields not in the canonical map
    expect("service_tier" in u.extras || "inference_geo" in u.extras).toBe(true);
  });
});

describe("Anthropic native adapter — synthetic", () => {
  it("cache_creation nested 5m + 1h are extracted", () => {
    const resp = {
      model: "claude-sonnet-4-6",
      content: [{ type: "text", text: "hi" }],
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        cache_creation_input_tokens: 50,
        cache_read_input_tokens: 0,
        cache_creation: {
          ephemeral_5m_input_tokens: 30,
          ephemeral_1h_input_tokens: 20,
        },
      },
    };
    const u = extractAnthropicNative(resp, "claude-sonnet-4-6");
    expect(u.cache_write).toBe(50);
    expect(u.cache_write_5m).toBe(30);
    expect(u.cache_write_1h).toBe(20);
  });

  it("counts multiple tool_use blocks", () => {
    const resp = {
      content: [
        { type: "text" },
        { type: "tool_use", id: "t1" },
        { type: "tool_use", id: "t2" },
        { type: "tool_use", id: "t3" },
      ],
      usage: { input_tokens: 1, output_tokens: 2 },
    };
    const u = extractAnthropicNative(resp, "x");
    expect(u.tool_calls).toBe(3);
  });

  it("extended thinking doesn't separate reasoning — bundles into output", () => {
    const resp = {
      content: [
        { type: "thinking", thinking: "..." },
        { type: "text", text: "..." },
      ],
      usage: { input_tokens: 50, output_tokens: 800 },
    };
    const u = extractAnthropicNative(resp, "claude-sonnet-4-6");
    expect(u.output).toBe(800);
    expect(u.reasoning).toBe(0);
    expect(u.tool_calls).toBe(0); // thinking blocks aren't tool calls
  });

  it("survives non-dict usage and undefined", () => {
    expect(extractAnthropicNative({}).input).toBe(0);
    expect(extractAnthropicNative(null as any).output).toBe(0);
    expect(extractAnthropicNative({ usage: "bogus" } as any).input).toBe(0);
  });
});
